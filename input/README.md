# GraphRAG 提示词导读

这些 TXT 是模型提示模板，不是 Python 脚本，也不是新的用户指令。
模板正文保持原样，教学说明单独放在这里，避免额外注释进入模型提示。
配置选用了某条流程时才会读取对应模板，不表示每次问答都会执行全部文件。

| 文件 | 使用阶段 | 作用 |
| --- | --- | --- |
| `extract_graph.txt` | 索引 | 从文本块抽取实体、实体类型、描述和关系 |
| `summarize_descriptions.txt` | 索引 | 合并重复实体或关系的描述 |
| `extract_claims.txt` | 可选索引阶段 | 提取主张/事实；当前配置未启用 |
| `community_report_graph.txt` | 索引 | 根据社区的实体关系生成社区报告 |
| `community_report_text.txt` | 其他社区报告流程 | 根据文本生成报告；是否使用以配置为准 |
| `local_search_system_prompt.txt` | Local 检索 | 根据具体实体的上下文回答问题 |
| `global_search_map_system_prompt.txt` | Global 的 Map 阶段 | 分别阅读社区报告，产生局部回答 |
| `global_search_reduce_system_prompt.txt` | Global 的 Reduce 阶段 | 合并局部回答，形成整体答案 |
| `global_search_knowledge_system_prompt.txt` | Global 辅助提示 | 提供全局回答时的知识提示约束 |
| `basic_search_system_prompt.txt` | Basic 检索 | 基础文本检索问答，当前网页未单独开放 |
| `drift_search_system_prompt.txt` | DRIFT 检索 | 引导更广泛的探索，当前网页未单独开放 |
| `drift_reduce_prompt.txt` | DRIFT 汇总 | 合并探索中的多个答案 |
| `question_gen_system_prompt.txt` | 问题生成 | 根据上下文生成后续问题，当前网页未单独开放 |

模板中出现的占位符由 GraphRAG 填充，不要误当成需要手动输入的字段。
