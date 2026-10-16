"""【03 · 问答执行器】真正调用 GraphRAG 的 Local / Global Search。

由谁运行：serve.py 收到网页问题后自动启动本文件，不需要单独双击运行。
输入：--method local/global、--query 问题，以及 output/ 中的索引。
输出：JSON，包括 answer 答案、context 检索依据、method 模式、elapsed 用时。
调用关系：网页 → serve.py → 本文件 → GraphRAG Python API → 本地 Ollama。
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import sys
import time
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent


async def search(method: str, query: str) -> dict:
    """读取索引并执行一次检索；保留真实依据，方便网页展示来源。"""
    import graphrag.api as api
    from graphrag.config.load_config import load_config

    # 第一步：加载本项目配置，不修改原项目的文件。
    load_dotenv(ROOT / ".env")
    config = load_config(ROOT)
    for model in config.models.values():
        model.max_retries = 2
    directory = Path(config.output.base_dir)
    # lambda 是简写的小函数：给表名，就读取对应的 Parquet 文件。
    read = lambda name: pd.read_parquet(directory / f"{name}.parquet")
    args = dict(config=config, entities=read("entities"), communities=read("communities"),
                community_reports=read("community_reports"), community_level=2,
                response_type="使用中文回答，清晰简洁，保留真实的数据引用。", query=query)
    started = time.monotonic()
    # 第二步：Global 汇总社区报告；Local 围绕实体关系与原文检索。
    if method == "global":
        answer, context = await api.global_search(**args, dynamic_community_selection=False)
    else:
        answer, context = await api.local_search(**args, text_units=read("text_units"),
                                               relationships=read("relationships"), covariates=None)
    # 第三步：把检索依据转换为 JSON；每张依据表最多带回 40 条记录。
    sources = {}
    if isinstance(context, dict):
        for key, value in context.items():
            if isinstance(value, pd.DataFrame):
                sources[key] = json.loads(value.head(40).to_json(orient="records", force_ascii=False))
            elif isinstance(value, list):
                sources[key] = value[:40]
    return {"answer": str(answer), "context": sources, "method": method,
            "elapsed": round(time.monotonic() - started, 1)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--method", choices=("local", "global"), required=True)
    parser.add_argument("--query", required=True)
    options = parser.parse_args()
    # 标准输出只留给 JSON；库自身的日志走标准错误，避免污染网页结果。
    with contextlib.redirect_stdout(sys.stderr):
        result = asyncio.run(search(options.method, options.query))
    print(json.dumps(result, ensure_ascii=False))
