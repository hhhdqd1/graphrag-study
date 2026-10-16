# GraphRAG 中文学习项目

这是从 `graphrag-lab` 复制出来的独立学习项目，名称为 `graphrag-study`。
原项目保留，不会同步修改；两边各有自己的代码、虚拟环境、输入资料和索引。
两个项目共用电脑上的 Ollama 模型服务，请不要同时启动两边的索引构建任务。

## 从 GitHub 下载后

仓库只包含源码、中文说明、提示词和测试，不包含本机 `.venv`、`.env`、
导入的 PDF/TXT、生成的索引、缓存或 PyCharm 本机设置；这些文件仍保留在原电脑上。
下文“已装好环境、已有 19 个实体”描述的是原电脑的学习环境，不是刚下载的仓库。

在项目目录中，用 Python 3.11 创建环境并安装已锁定的依赖：

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements-lock.txt
cp .env.example .env
```

安装并启动 Ollama，准备配置中使用的两个模型：

```bash
ollama pull qwen2.5:7b
ollama pull bge-m3
.venv/bin/python serve.py
```

然后打开 http://127.0.0.1:8766，导入自己的 PDF/TXT，再点击“更新索引”。
首次下载没有索引，先完成这一步，才能进行问答或运行查看实体的练习。
PyCharm 解释器选择刚创建的 `.venv/bin/python`，可继续使用 `.run/` 中的运行配置。

## 第一步：在 PyCharm 运行

1. 打开这个项目文件夹，而不是只打开某一个 Python 文件。
2. Python 解释器选择本项目 `.venv/bin/python`，版本为 **3.11.16**。
3. 先运行 **01 查看实体和关系**，确认能显示 19 个实体和关系样例。
4. 打开 Ollama，然后运行 **02 启动知识工作台**，或右键运行 `serve.py`。
5. 浏览器打开 **http://127.0.0.1:8766**。不要关闭 PyCharm 中正在运行的后台程序。

已配置三份 PyCharm 运行配置，保存在 `.run/`：查看实体、启动工作台、验证 PDF 后台。
`web_worker.py` 和 `document_store.py` 由后台自动调用，不需要逐个右键运行。

新项目使用 8766，原项目仍使用 8765。不要因为旧网页能打开，就误以为新项目已启动。
如果 8766 已被使用，可在运行参数里填 `--port 8767`，浏览器地址也相应更改。

## 先读哪些文件

| 顺序 | 文件 | 学到什么 |
| --- | --- | --- |
| 1 | `01_read_entities.py` | Parquet 是什么，怎样读取实体和关系 |
| 2 | `serve.py` | 后台怎样接收网页请求、启动任务、返回结果 |
| 3 | `web_worker.py` | Local / Global Search 怎样真正调用 GraphRAG |
| 4 | `document_store.py` | PDF 怎样从预览到确认入库，以及怎样保留页码 |
| 5 | `settings.yaml` | 聊天模型、向量模型、切块和索引目录怎样配置 |
| 6 | `web/index.html`、`web/app.js`、`web/styles.css` | 网页结构、交互和样式怎样配合 |

每个代码文件开头都有中文说明，核心函数和关键步骤也有中文注释。
所有代码、配置、提示词、测试和数据目录的用途见 **[文件导读](docs/文件导读.md)**。
原始资料、Parquet、LanceDB 和第三方库不是手写源码，不往里面插入注释。

## 整套程序怎样连起来

```text
浏览器：index.html + app.js + styles.css
                  ↓ HTTP 请求
              serve.py（后台入口）
               ├─ 文档导入 → document_store.py → PDF 原件 + 带页码 TXT
               ├─ 更新索引 → GraphRAG → 实体 / 关系 / 社区报告 / 向量
               └─ 提交问题 → web_worker.py → GraphRAG + Ollama → 答案与依据
```

网页不是模型，后台也不是模型。后台把你的操作交给 GraphRAG；Ollama 提供模型推理。

## 从 PDF 导入到问答

1. “原始文档” → “导入文档” → 选择 PDF。
2. 逐页核对预览，确认没有乱码或重要文字缺失。
3. “确认导入”后只是入库，列表会显示“待更新索引”。
4. 点击“更新索引”，等待本地模型完成抽取。
5. 前往“知识问答”，选择 Local 或 Global，提问并核对检索依据。

支持文字型 PDF：不超过 10 MB、100 页，提取文字不超过 2 MB；TXT 不超过 2 MB。
扫描件需先做 OCR；不识别图片语义，也不保证复杂表格、多栏版面的阅读顺序。
原 PDF 会保留，可以下载核对；同名资料不会被覆盖。

## 环境与资料

- `.venv/`：本项目独立的 Python 环境，已装好依赖；不要在里面写学习代码。
- `requirements.txt`：核心依赖版本，方便先理解用了哪些库。
- `requirements-lock.txt`：从已验证的原环境导出的完整 120 项版本快照。
- `.python-version`：Python 版本标记，不是可运行脚本。
- `.env`：本地 Ollama 的占位密钥和代理绕过配置；已被 Git 忽略。
- `input/`、`output/`：复制原项目的示例资料和已有索引，可直接浏览与提问。
- 新项目首次索引时会生成自己的 `cache/`、`logs/`，不会写回旧项目。

重建环境时：先准备 Python 3.11，再创建 `.venv`，安装 `requirements-lock.txt`。
这里的虚拟环境与原项目使用同一台电脑上的 Python 3.11 基础解释器，但安装包目录相互独立。

## 验证程序

在 PyCharm 中运行 **03 验证 PDF 后台**，或在项目终端执行：

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
```

后台测试只使用临时目录，不修改你的知识库。
`tests/web_*.mjs` 是额外的真实浏览器测试，需要本机 Node、Chrome 和测试工具路径。
日常启动不依赖这些浏览器测试工具，也不需要安装前端打包框架。

## 常见问题

- 提示端口占用：另一份后台还在运行；停止本项目旧实例，或换一个端口。
- 提示本地模型未就绪：打开 Ollama，检查 `qwen2.5:7b` 和 `bge-m3` 是否安装。
- 导入后仍答不出新资料：入库和索引是两步，请先完成“更新索引”。
- 直接运行 `web_worker.py` 提示缺参数：它是后台的工作进程，请运行 `serve.py`。
- 实体分类或回答不准确：这是模型抽取结果，必须回到原文核对，不应当作已验证事实。

更完整的网页功能说明见 **[网页使用说明](网页使用说明.md)**。
