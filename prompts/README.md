# 输入资料

- `technology_companies_zh.txt`：从原学习项目复制的示例原文，保持内容不变。
- 新导入的 TXT：直接保存为 UTF-8 文本。
- 新导入的 PDF：确认后生成 `资料名.pdf.txt`，包含原文件名和逐页来源标记。
- PDF 原件和逐页元数据另外保存在项目根目录的 `source_documents/`。

GraphRAG 当前只匹配 `.txt`，不会把这份 Markdown 说明当作知识库内容。
改动原文或新增资料之后，需要重新构建索引才会参与问答。
