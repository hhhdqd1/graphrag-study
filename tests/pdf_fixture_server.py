"""【测试辅助】为 web_pdf.mjs 提供临时服务和 PDF 样例，不是日常启动入口。

浏览器测试自动启动本文件，收到结束信号后清理临时知识库。
不会在本项目 input/ 或 output/ 中写测试资料。
"""
import base64
import json
import shutil
from test_pdf_import import PDFImportTests, sample_pdf

fixture = PDFImportTests()
fixture.setUp()
try:
    shutil.copyfile(fixture.old_root / "settings.yaml", fixture.root / "settings.yaml")
    print(json.dumps({"url": f"http://127.0.0.1:{fixture.server.server_port}",
                      "pdf": base64.b64encode(sample_pdf()).decode(),
                      "mixed": base64.b64encode(sample_pdf(("A readable page", ""))).decode(),
                      "scanned": base64.b64encode(sample_pdf(("",))).decode()}), flush=True)
    input()
finally:
    fixture.tearDown()
