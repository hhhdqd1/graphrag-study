"""【04 · PDF 导入模块】逐页提取、预览、确认保存，并保留原始文件。

由谁调用：serve.py 的 /api/documents/preview、import、discard 等接口。
输入：PDF 文件名和 Base64 文件内容；确认时使用预览编号 preview_id。
输出：页码与文字预览；确认后写入 input/*.pdf.txt 和 source_documents/。
学习重点：预览不等于入库，入库不等于已建索引；同名文件不会被覆盖。
限制：不做 OCR；纯图片 PDF 会提示先识别文字，复杂文件可能需要拆分。
不要直接运行：末尾的 --extract 分支由后台自动调用，是隔离解析的子进程。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import re
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

# 这些限制分别保护上传大小、提取文字、页数、解码过程和预览有效期。
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_PAGES = 100
MAX_DECODED_BYTES = 64 * 1024 * 1024
PREVIEW_TTL = 15 * 60
_PREVIEWS: dict[str, dict] = {}
_LOCK = threading.RLock()
_PARSER_LOCK = threading.Lock()


class DocumentError(Exception):
    """可展示给用户的导入错误，附带合适的 HTTP 状态码。"""
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@contextmanager
def _decode_budget():
    """限制 PDF 解码数据量；只在隔离解析进程中临时包装 pypdf 的解码函数。"""
    import pypdf.filters as filters
    from pypdf.errors import LimitReachedError
    from pypdf.generic import EncodedStreamObject

    original = EncodedStreamObject.get_data
    names = ("ZLIB_MAX_OUTPUT_LENGTH", "LZW_MAX_OUTPUT_LENGTH", "RUN_LENGTH_MAX_OUTPUT_LENGTH",
             "JBIG2_MAX_OUTPUT_LENGTH", "MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH")
    previous = {name: getattr(filters, name) for name in names}
    used, seen, exhausted = 0, set(), False

    def check():
        """记住资源超限状态，防止第三方库吞掉异常后返回残缺文字。"""
        if exhausted:
            raise DocumentError("PDF 解码数据量过大，已停止解析以保护本机资源。请拆分或重新导出后再试。", 422)

    def bounded_get_data(stream):
        nonlocal used, exhausted
        check()
        if id(stream) in seen:
            return original(stream)
        remaining = MAX_DECODED_BYTES - used
        if remaining <= 0:
            exhausted = True
            check()
        for name in names:
            setattr(filters, name, min(32 * 1024 * 1024, remaining))
        try:
            decoded = original(stream)
        except LimitReachedError:
            exhausted = True
            check()
        if len(decoded) > MAX_DECODED_BYTES - used:
            exhausted = True
            check()
        used += len(decoded)
        seen.add(id(stream))
        return decoded

    EncodedStreamObject.get_data = bounded_get_data
    try:
        yield check
    finally:
        EncodedStreamObject.get_data = original
        for name, value in previous.items():
            setattr(filters, name, value)


def extract_pdf(data: bytes) -> dict:
    """在资源预算内解析一份 PDF，不调用模型，也不执行 OCR。"""
    with _decode_budget() as check:
        return _read_pdf(data, check)


def _read_pdf(data: bytes, check) -> dict:
    """逐页读取文字，检查空页、编码问题、加密与提取量限制。"""
    from pypdf import PdfReader

    if not data.startswith(b"%PDF-"):
        raise DocumentError("这不是有效的 PDF 文件，请检查文件格式。", 422)
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise DocumentError("此 PDF 已加密，请先在本机解密并另存为无密码 PDF。", 422)
    if not 1 <= len(reader.pages) <= MAX_PAGES:
        raise DocumentError("单份 PDF 请控制在 1–100 页；较长资料请拆分后导入。", 422)
    pages, total = [], 0
    for number, page in enumerate(reader.pages, 1):
        text = (page.extract_text() or "").replace("\x00", "").strip()
        # pypdf 可能内部捕获异常，因此每页后都要再次确认没有发生资源超限。
        check()
        total += len(text.encode("utf-8"))
        if total > MAX_TEXT_BYTES:
            raise DocumentError("提取文字超过 2 MB，请将 PDF 拆分后导入。", 422)
        pages.append({"number": number, "text": text})
    empty = [page["number"] for page in pages if not page["text"]]
    if len(empty) == len(pages):
        raise DocumentError("没有提取到文字：这可能是扫描件或图片 PDF。当前尚未接入 OCR，请先识别文字后再导入。", 422)
    warnings = []
    if empty:
        listed = "、".join(map(str, empty))
        warnings.append(f"第 {listed} 页未提取到文字，可能为空白页或扫描图片；这些页的图片内容不会参与问答。需要时请先使用 OCR。")
    if any("\ufffd" in page["text"] for page in pages):
        warnings.append("部分文字可能存在编码问题，请核对预览；若出现乱码，请先重新导出 PDF 或使用 OCR。")
    check()
    return {"pages": pages, "page_count": len(pages), "empty_pages": empty, "warnings": warnings}


def _prune() -> None:
    """在下一次 PDF 操作时，清理过期或所属项目已不存在的预览。"""
    for token, item in list(_PREVIEWS.items()):
        if time.monotonic() - item["created"] >= PREVIEW_TTL or not Path(item["root"]).is_dir():
            del _PREVIEWS[token]


def preview_pdf(root: Path, name, encoded) -> dict:
    """校验上传并启动隔离解析；只生成内存预览，不写入知识库。"""
    if (not isinstance(name, str) or not name or Path(name).name != name
            or "\\" in name or "\x00" in name or not name.lower().endswith(".pdf")
            or len(name.encode("utf-8")) > 240):
        raise DocumentError("请选择有效的 PDF 文件名，不要包含路径。")
    if not isinstance(encoded, str) or not encoded:
        raise DocumentError("PDF 内容不能为空。")
    if len(encoded) > (MAX_PDF_BYTES + 2) // 3 * 4:
        raise DocumentError("单份 PDF 不能超过 10 MB。", 413)
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise DocumentError("PDF 上传内容无效，请重新选择文件。") from None
    if not data or len(data) > MAX_PDF_BYTES:
        raise DocumentError("PDF 不能为空，且单份不能超过 10 MB。", 413)
    if not _PARSER_LOCK.acquire(blocking=False):
        raise DocumentError("已有 PDF 正在解析，请稍后再试。", 409)
    try:
        try:
            process = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--extract"],
                                     input=data, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            raise DocumentError("PDF 解析超过 30 秒，请拆分资料或重新导出后再试。", 422) from None
        if process.returncode != 0:
            raise DocumentError("PDF 解析未完成，请拆分资料或重新导出后再试。", 422)
        result = json.loads(process.stdout)
        if "error" in result:
            raise DocumentError(result["error"], 422)
    finally:
        _PARSER_LOCK.release()
    safe = re.sub(r"[^\w.\-\u4e00-\u9fff ]", "_", name[:-4]).strip(". ") or "document"
    while len(safe.encode("utf-8")) > 180:
        safe = safe[:-1]
    index_name = safe + ".pdf.txt"
    text = f"来源文件：{name}\n\n" + "\n\n".join(
        f"【来源：{name} · 第 {page['number']} 页】\n{page['text']}"
        for page in result["pages"] if page["text"])
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise DocumentError("提取文字超过 2 MB，请将 PDF 拆分后导入。", 422)
    token = uuid.uuid4().hex
    public = {**result, "preview_id": token, "name": index_name, "display_name": name,
              "format": "PDF", "source_size": len(data), "characters": sum(len(page["text"]) for page in result["pages"])}
    with _LOCK:
        _prune()
        # 最多保留四份内存预览；用户确认之前不把 PDF 或文字保存到磁盘。
        while len(_PREVIEWS) >= 4:
            del _PREVIEWS[next(iter(_PREVIEWS))]
        _PREVIEWS[token] = {"root": str(root.resolve()), "created": time.monotonic(),
                            "data": data, "text": text, "public": public}
    return public


def _preview(root: Path, token) -> dict:
    """根据编号取得本项目的有效预览；过期、取消或跨项目编号都会拒绝。"""
    _prune()
    item = _PREVIEWS.get(token) if isinstance(token, str) else None
    if not item or item["root"] != str(root.resolve()):
        raise DocumentError("预览已过期或已取消，请重新选择 PDF。", 410)
    return item


def discard_preview(root: Path, token) -> dict:
    """取消导入并释放该预览，不增加 input/ 中的文档。"""
    with _LOCK:
        _preview(root, token)
        del _PREVIEWS[token]
    return {"message": "已取消，未加入知识库。"}


def import_pdf(root: Path, input_dir: Path, token) -> dict:
    """确认导入：保存带页码文字、原 PDF 和元数据；失败时回滚本次新文件。"""
    with _LOCK:
        item = _preview(root, token)
        public = item["public"]
        input_dir.mkdir(parents=True, exist_ok=True)
        sources = root / "source_documents"
        sources.mkdir(parents=True, exist_ok=True)
        destination = input_dir / public["name"]
        original = sources / (token + ".pdf")
        metadata = sources / (public["name"] + ".json")
        saved = []
        try:
            # 先以排他模式占用文档名；同名资料存在时立即停止，不覆盖原件。
            with destination.open("xb") as stream:
                saved.append(destination)
                stream.write(item["text"].encode("utf-8"))
            with original.open("xb") as stream:
                saved.append(original)
                stream.write(item["data"])
            meta = {key: value for key, value in public.items() if key != "preview_id"}
            meta.update(original_file=original.name, sha256=hashlib.sha256(item["data"]).hexdigest())
            with metadata.open("x", encoding="utf-8") as stream:
                saved.append(metadata)
                json.dump(meta, stream, ensure_ascii=False)
        except Exception as exc:
            # 只回滚本次刚创建的文件，绝不删除用户原有资料。
            for file in reversed(saved):
                file.unlink()
            if isinstance(exc, FileExistsError):
                raise DocumentError("已存在同名文档，请修改 PDF 文件名后重新导入。", 409) from None
            raise
        del _PREVIEWS[token]
        return {"name": public["name"], "display_name": public["display_name"],
                "message": "PDF 已导入，原文件已保留。点击“更新索引”后才会参与问答。"}


def document_metadata(root: Path, name: str) -> dict:
    """读取已导入 PDF 的来源信息，供文件列表、逐页阅读和原件下载使用。"""
    if Path(name).name != name or not name.endswith(".txt"):
        return {}
    file = root / "source_documents" / (name + ".json")
    return json.loads(file.read_text(encoding="utf-8")) if file.is_file() else {}


if __name__ == "__main__" and "--extract" in sys.argv:
    try:
        # CPU 限制配合父进程 30 秒超时，避免复杂 PDF 长时间占用后台。
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
        parsed = extract_pdf(sys.stdin.buffer.read(MAX_PDF_BYTES + 1))
    except DocumentError as exc:
        parsed = {"error": str(exc)}
    except Exception:
        parsed = {"error": "无法解析这份 PDF，文件可能损坏、格式特殊或内容过于复杂。请重新导出或拆分后再试。"}
    print(json.dumps(parsed, ensure_ascii=False))
