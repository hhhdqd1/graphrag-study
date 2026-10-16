"""【02 · 后台入口】启动网页，并把网页操作交给 PDF 模块或 GraphRAG。

怎么运行：在 PyCharm 右键运行本文件，浏览器打开 http://127.0.0.1:8766。
输入：浏览器的 HTTP 请求、settings.yaml 配置、input/ 原文、output/ 索引。
输出：网页文件、JSON 数据、查询结果和后台任务进度。
调用关系：web/app.js → 本文件 → document_store.py 或 web_worker.py。
注意：这是本机学习服务，关闭本程序后网页接口会停止；问答还需要 Ollama。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote, unquote, urlparse
from urllib.request import ProxyHandler, build_opener

import pandas as pd
import yaml
from dotenv import load_dotenv
from document_store import (DocumentError, MAX_PDF_BYTES, discard_preview, document_metadata,
                            import_pdf, preview_pdf)

# __file__ 是本文件的位置；所有资料路径都从项目根目录计算。
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
PYTHON = ROOT / ".venv" / "bin" / "python"
load_dotenv(ROOT / ".env")
for key in ("NO_PROXY", "no_proxy"):
    previous = os.environ.get(key, "")
    os.environ[key] = ",".join(dict.fromkeys(filter(None, [*previous.split(","), "localhost", "127.0.0.1"])))

# 任务进度放在内存中；锁用来避免一边更新索引、一边查询或导入资料。
JOBS: dict[str, dict] = {}
JOB_LOCK = threading.Lock()
MODEL_CACHE: dict = {"expires": 0, "result": {}}
MAX_UPLOAD = 2 * 1024 * 1024
TABLE_NAMES = ("documents", "text_units", "entities", "relationships", "communities", "community_reports")


def settings() -> dict:
    """读取模型、输入输出目录等配置，不把密钥返回给网页。"""
    return yaml.safe_load((ROOT / "settings.yaml").read_text(encoding="utf-8"))


def output_dir() -> Path:
    """找到 GraphRAG 保存 Parquet 索引的目录。"""
    return ROOT / settings().get("output", {}).get("base_dir", "output")


def table(name: str) -> pd.DataFrame:
    """读取一张索引表；尚未建表时返回空表，让页面仍能打开。"""
    path = output_dir() / f"{name}.parquet"
    return pd.read_parquet(path) if path.is_file() else pd.DataFrame()


def records(frame: pd.DataFrame) -> list[dict]:
    """把 pandas 表格转换为可以通过 HTTP 传输的 JSON 记录。"""
    return json.loads(frame.to_json(orient="records", force_ascii=False, date_format="iso"))


def model_health() -> dict:
    """检查 Ollama 和所需模型是否就绪，短时间缓存结果以减少重复检查。"""
    if MODEL_CACHE["expires"] > time.monotonic():
        return MODEL_CACHE["result"]
    models = settings().get("models", {})
    chat = models.get("default_chat_model", {})
    embedding = models.get("default_embedding_model", {})
    base = chat.get("api_base", "http://localhost:11434/v1").rstrip("/")
    result = {
        "online": False,
        "chat_model": chat.get("model", ""),
        "embedding_model": embedding.get("model", ""),
        "api_base": base,
        "models": [],
        "message": "Ollama 暂未连接。请打开 Ollama 后刷新，仍可浏览现有图谱与文档。",
    }
    try:
        with build_opener(ProxyHandler({})).open(base + "/models", timeout=3) as response:
            payload = json.load(response)
        result["models"] = [entry["id"] for entry in payload.get("data", [])]
        installed = set(result["models"])
        def present(model: str) -> bool:
            return model in installed or model + ":latest" in installed
        result["online"] = present(result["chat_model"]) and present(result["embedding_model"])
        result["message"] = "本地模型已就绪" if result["online"] else "Ollama 已连接，但配置中的模型尚未全部安装。"
    except (OSError, ValueError, URLError):
        pass
    MODEL_CACHE.update(expires=time.monotonic() + 8, result=result)
    return result


def overview() -> dict:
    """汇总文档、实体、关系和社区报告；页面上的数量都来自实际数据。"""
    frames = {name: table(name) for name in TABLE_NAMES}
    directory = ROOT / settings().get("input", {}).get("base_dir", "input")
    indexed_docs = {str(row.get("title")): row for row in records(frames["documents"])}
    index_stamp = (output_dir() / "entities.parquet").stat().st_mtime if (output_dir() / "entities.parquet").is_file() else 0
    documents = []
    if directory.is_dir():
        for path in sorted(directory.glob("*.txt")):
            meta = path.stat()
            item = indexed_docs.get(path.name)
            # 同名文件存在不代表新内容已经建过索引，还要检查文件修改时间。
            indexed = item is not None and meta.st_mtime <= index_stamp
            source_meta = document_metadata(ROOT, path.name)
            documents.append({"name": path.name, "display_name": source_meta.get("display_name", path.name),
                              "format": source_meta.get("format", "TXT"), "page_count": source_meta.get("page_count"),
                              "source_size": source_meta.get("source_size", meta.st_size),
                              "size": meta.st_size, "modified": meta.st_mtime,
                              "indexed": indexed, "id": item.get("id") if item else None})
    return {
        "counts": {"documents": len(documents), "entities": len(frames["entities"]),
                   "relationships": len(frames["relationships"]), "reports": len(frames["community_reports"])},
        "entities": records(frames["entities"]), "relationships": records(frames["relationships"]),
        "communities": records(frames["communities"]), "reports": records(frames["community_reports"]),
        "documents": documents, "text_units": records(frames["text_units"]),
        "indexed_at": index_stamp, "ready": bool(len(frames["entities"]) and len(frames["relationships"])),
    }


def public_job(job: dict) -> dict:
    """只公开进度信息，隐藏进程对象和内部启动命令。"""
    return {key: value for key, value in job.items() if key not in ("process", "command")}


def run_job(job_id: str) -> None:
    """在独立进程里运行问答或建索引，处理超时并记录完成/失败状态。"""
    job = JOBS[job_id]
    try:
        process = subprocess.Popen(job["command"], cwd=ROOT, env=os.environ.copy(),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
        with JOB_LOCK:
            job["process"] = process
            cancelled = job["status"] == "cancelled"
        if cancelled:
            process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=1800 if job["kind"] == "index" else 600)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            raise RuntimeError("本地模型响应超时。请确认 Ollama 正在运行，并缩短问题后重试。")
        with JOB_LOCK:
            if job["status"] == "cancelled":
                return
        if process.returncode != 0:
            # 详细错误留在 PyCharm 运行窗口，网页只收到适合用户阅读的提示。
            print(stderr[-5000:], file=sys.stderr)
            if "Connection" in stderr or "connect" in stderr.lower():
                raise RuntimeError("无法连接本地模型。请先打开 Ollama，再重新发送问题。")
            raise RuntimeError("处理未完成。请查看运行 serve.py 的终端诊断信息，然后重试。")
        if job["kind"] == "query":
            result = json.loads(stdout)
            if not result.get("answer", "").strip():
                raise RuntimeError("模型没有返回答案，请换一种问法重试。")
        else:
            result = {"message": "索引更新完成，新文档现在可以参与问答。"}
        with JOB_LOCK:
            if job["status"] != "cancelled":
                job.update(status="completed", result=result, elapsed=round(time.monotonic() - job["started"], 1))
    except Exception as exc:
        with JOB_LOCK:
            if job["status"] != "cancelled":
                job.update(status="failed", error=str(exc), elapsed=round(time.monotonic() - job["started"], 1))


def create_job(kind: str, query: str = "", method: str = "local") -> dict:
    """创建一个后台任务；查询调用 web_worker.py，建索引调用 GraphRAG。"""
    with JOB_LOCK:
        if any(item["status"] == "running" for item in JOBS.values()):
            raise ValueError("已有任务正在运行。请等待完成，或停止当前查询。")
        # 内存里只保留有限的任务记录；网页提问历史不由服务写到磁盘。
        if len(JOBS) >= 100:
            for key in list(JOBS)[:-50]:
                if JOBS[key]["status"] != "running":
                    del JOBS[key]
        job_id = uuid.uuid4().hex
        if kind == "query":
            command = [str(PYTHON), str(ROOT / "web_worker.py"), "--method", method, "--query", query]
        else:
            command = [str(PYTHON), "-m", "graphrag", "index", "--root", str(ROOT), "--logger", "none"]
        job = {"id": job_id, "kind": kind, "status": "running", "started": time.monotonic(),
               "query": query, "method": method, "command": command}
        JOBS[job_id] = job
    threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
    return public_job(job)


class Handler(BaseHTTPRequestHandler):
    """HTTP 路由：GET 负责读取，POST 负责提问、导入、索引及任务控制。"""
    server_version = "GraphRAGLocal/1.0"

    def log_message(self, fmt, *args):
        """记录访问日志，但不反复打印网页轮询进度的请求。"""
        if "/api/jobs/" not in self.path:
            super().log_message(fmt, *args)

    def send_body(self, status: int, body: bytes, content_type: str, download_name: str | None = None) -> None:
        """统一返回内容和安全响应头；下载原件时额外设置文件名。"""
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if download_name:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(download_name))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json(self, value: dict, status: int = 200) -> None:
        """用 UTF-8 JSON 返回数据，保证中文在网页中正常显示。"""
        self.send_body(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"), "application/json; charset=utf-8")

    def valid_host(self) -> bool:
        """只接受本机地址，避免把学习服务当成公开网站使用。"""
        hostname = urlparse("http://" + self.headers.get("Host", "")).hostname
        return hostname in ("localhost", "127.0.0.1", "::1")

    def do_GET(self):
        """读取网页、模型状态、知识库、原文、PDF 原件或任务进度。"""
        if not self.valid_host():
            return self.json({"error": "仅允许通过本机地址访问。"}, 403)
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/overview":
                return self.json(overview())
            if path == "/api/health":
                return self.json(model_health())
            if path.startswith("/api/documents/"):
                name = path.removeprefix("/api/documents/")
                if Path(name).name != name or not name.endswith(".txt"):
                    return self.json({"error": "无效文档名称。"}, 400)
                source = ROOT / settings().get("input", {}).get("base_dir", "input") / name
                if not source.is_file():
                    return self.json({"error": "文档不存在。"}, 404)
                if source.stat().st_size > MAX_UPLOAD:
                    return self.json({"error": "该文档较大，请在编辑器中查看。"}, 413)
                meta = document_metadata(ROOT, name)
                return self.json({"name": name, "display_name": meta.get("display_name", name),
                                  "format": meta.get("format", "TXT"), "pages": meta.get("pages", []),
                                  "page_count": meta.get("page_count"), "warnings": meta.get("warnings", []),
                                  "source_size": meta.get("source_size", source.stat().st_size),
                                  "text": source.read_text(encoding="utf-8"), "size": source.stat().st_size})
            if path.startswith("/api/originals/"):
                name = path.removeprefix("/api/originals/")
                if Path(name).name != name or not name.endswith(".txt"):
                    return self.json({"error": "无效文档名称。"}, 400)
                source = ROOT / settings().get("input", {}).get("base_dir", "input") / name
                meta = document_metadata(ROOT, name) if source.is_file() else {}
                original = meta.get("original_file", "")
                if not re.fullmatch(r"[a-f0-9]{32}\.pdf", original):
                    return self.json({"error": "原始 PDF 不存在。"}, 404)
                return self.send_body(200, (ROOT / "source_documents" / original).read_bytes(),
                                      "application/pdf", meta["display_name"])
            if path.startswith("/api/jobs/"):
                job_id = path.removeprefix("/api/jobs/")
                with JOB_LOCK:
                    job = JOBS.get(job_id)
                    result = public_job(job) if job else None
                return self.json(result) if result else self.json({"error": "任务不存在。"}, 404)
            files = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/favicon.svg": "favicon.svg"}
            if path not in files:
                return self.json({"error": "页面不存在。"}, 404)
            file = WEB / files[path]
            mime = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            return self.send_body(200, file.read_bytes(), mime + ("; charset=utf-8" if mime.startswith("text/") or file.suffix == ".js" else ""))
        except Exception as exc:
            print(f"GET {path}: {exc}", file=sys.stderr)
            return self.json({"error": "读取项目数据失败。请查看终端中的诊断信息。"}, 500)

    def do_POST(self):
        """先校验来源与请求大小，再分发提问、PDF/TXT 导入等操作。"""
        if not self.valid_host():
            return self.json({"error": "仅允许通过本机地址访问。"}, 403)
        origin = self.headers.get("Origin")
        if origin and urlparse(origin).netloc != self.headers.get("Host"):
            return self.json({"error": "不允许跨站请求。"}, 403)
        if self.headers.get_content_type() != "application/json":
            return self.json({"error": "请求必须使用 JSON。"}, 415)
        try:
            path = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", "0"))
            limit = ((MAX_PDF_BYTES + 2) // 3 * 4 + 4096) if path == "/api/documents/preview" else MAX_UPLOAD * 2
            if not 0 < length <= limit:
                return self.json({"error": "请求过大或为空。"}, 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                return self.json({"error": "请求必须是 JSON 对象。"}, 400)
            if path == "/api/documents/preview":
                return self.json(preview_pdf(ROOT, body.get("name"), body.get("data")))
            if path == "/api/documents/discard":
                return self.json(discard_preview(ROOT, body.get("preview_id")))
            if path == "/api/documents/import":
                with JOB_LOCK:
                    if any(job["status"] == "running" and job["kind"] == "index" for job in JOBS.values()):
                        return self.json({"error": "正在构建索引，请完成后再导入新文档。"}, 409)
                    directory = ROOT / settings().get("input", {}).get("base_dir", "input")
                    return self.json(import_pdf(ROOT, directory, body.get("preview_id")), 201)
            if path == "/api/query":
                query, method = body.get("query", ""), body.get("method", "local")
                if not isinstance(query, str) or not 1 <= len(query.strip()) <= 2000:
                    return self.json({"error": "请输入 1 到 2000 个字符的问题。"}, 400)
                if method not in ("local", "global"):
                    return self.json({"error": "仅支持 local 或 global 检索。"}, 400)
                if not (output_dir() / "entities.parquet").is_file():
                    return self.json({"error": "请先在原始文档页面构建索引。"}, 409)
                return self.json(create_job("query", query.strip(), method), 202)
            if path == "/api/index":
                return self.json(create_job("index"), 202)
            if path.startswith("/api/jobs/") and path.endswith("/cancel"):
                job_id = path.split("/")[-2]
                with JOB_LOCK:
                    job = JOBS.get(job_id)
                    if not job:
                        return self.json({"error": "任务不存在。"}, 404)
                    if job["kind"] == "index":
                        return self.json({"error": "索引构建中，请等待完成。"}, 409)
                    if job["status"] == "running":
                        job["status"] = "cancelled"
                        process = job.get("process")
                        if process and process.poll() is None:
                            process.terminate()
                    result = public_job(job)
                return self.json(result)
            if path == "/api/documents":
                name, content = body.get("name", ""), body.get("content", "")
                if not isinstance(name, str) or not isinstance(content, str):
                    return self.json({"error": "文档名称和内容必须是文本。"}, 400)
                name = re.sub(r"[^\w.\-\u4e00-\u9fff ]", "_", Path(name).name)[:140]
                if not name.lower().endswith(".txt") or not name.strip(". "):
                    return self.json({"error": "当前支持 UTF-8 编码的 TXT 文档。"}, 400)
                name = str(Path(name).with_suffix(".txt"))
                if not content.strip() or len(content.encode("utf-8")) > MAX_UPLOAD:
                    return self.json({"error": "文档不能为空，且不能超过 2 MB。"}, 400)
                directory = ROOT / settings().get("input", {}).get("base_dir", "input")
                directory.mkdir(parents=True, exist_ok=True)
                destination = directory / name
                # x 模式仅允许创建新文件；已有同名资料时拒绝覆盖。
                try:
                    with destination.open("x", encoding="utf-8") as stream:
                        stream.write(content)
                except FileExistsError:
                    return self.json({"error": "已存在同名文档，请修改文件名后重新导入。"}, 409)
                return self.json({"name": name, "message": "文档已导入。更新索引后即可参与问答。"}, 201)
            return self.json({"error": "接口不存在。"}, 404)
        except DocumentError as exc:
            return self.json({"error": str(exc)}, exc.status)
        except (ValueError, json.JSONDecodeError) as exc:
            return self.json({"error": str(exc) if str(exc).startswith("已有任务") else "请求格式无效。"}, 409 if str(exc).startswith("已有任务") else 400)
        except Exception as exc:
            print(f"POST {self.path}: {exc}", file=sys.stderr)
            return self.json({"error": "操作未完成，请查看终端诊断信息。"}, 500)


def main() -> None:
    """程序启动点；学习项目默认用 8766，避开原项目的 8765。"""
    parser = argparse.ArgumentParser(description="启动 GraphRAG 本地知识工作台")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"\nGraphRAG 知识工作台：http://127.0.0.1:{args.port}\n使用 Ctrl+C 停止服务。\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with JOB_LOCK:
            for job in JOBS.values():
                process = job.get("process")
                if process and process.poll() is None:
                    process.terminate()
        server.server_close()


if __name__ == "__main__":
    main()
