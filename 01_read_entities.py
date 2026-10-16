"""【01 · 第一个学习练习】读取现有索引，打印实体和前五条关系。

运行：PyCharm 中右键运行本文件，工作目录设为本项目根目录。
输入：output/entities.parquet 和 output/relationships.parquet。
输出：Python 版本、解释器路径、实体列表、实体数量和关系样例。
本练习只读文件，不会调用模型、导入文档或重新构建索引。
"""

import sys
import pandas as pd

print("Python 版本：", sys.version.split()[0])
print("Python 所在位置：", sys.executable)

# pandas 把 Parquet 读成 DataFrame，可以把它理解为一张带列名的表。
entities = pd.read_parquet("output/entities.parquet")

print(entities[["title", "type"]].to_string(index=False))
print("实体数量：", len(entities))
# 实体表回答“有哪些节点”，关系表回答“节点之间有什么联系”。
relationships = pd.read_parquet("output/relationships.parquet")

print("\n前 5 条关系：")
print(
    relationships[["source", "target", "description"]]
    .head(5)
    .to_string(index=False)
)
