"""【测试 · PDF 后台】在临时知识库中验证真实 HTTP 导入，不修改学习资料。

运行：python -m unittest discover -s tests -p 'test_*.py' -v。
覆盖：页码、确认、取消、防覆盖、扫描件、加密、资源预算与 GraphRAG 兼容性。
sample_pdf 只制造测试数据；每个测试结束都会清理自己的临时目录。
"""

import base64
import asyncio
import http.client
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import serve
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject


def sample_pdf(lines=("Ren Zhengfei founded Huawei.", "Huawei is based in Shenzhen."), password=None,
               padding_bytes=0):
    """Small text-layer fixture, including an empty page when a line is empty."""
    writer = PdfWriter()
    for line in lines:
        page = writer.add_blank_page(width=600, height=800)
        if line:
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                     NameObject("/Subtype"): NameObject("/Type1"),
                                     NameObject("/BaseFont"): NameObject("/Helvetica")})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
            stream = DecodedStreamObject()
            stream.set_data(b" " * padding_bytes + f"BT /F1 12 Tf 50 700 Td ({line}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(stream.flate_encode() if padding_bytes else stream)
    if password:
        writer.encrypt(password)
    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


class PDFImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="graphrag-pdf-test-")
        self.root = Path(self.temp.name)
        self.old_root = serve.ROOT
        serve.ROOT = self.root
        (self.root / "input").mkdir()
        (self.root / "settings.yaml").write_text("input:\n  base_dir: input\noutput:\n  base_dir: output\n", encoding="utf-8")
        self.server = serve.ThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        serve.ROOT = self.old_root
        self.temp.cleanup()

    def call(self, route, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=40)
        connection.request("GET" if body is None else "POST", route,
                           body=None if body is None else json.dumps(body),
                           headers={} if body is None else {"Content-Type": "application/json"})
        response = connection.getresponse()
        status, data, mime = response.status, response.read(), response.getheader("Content-Type")
        connection.close()
        return status, json.loads(data) if "json" in mime else data

    def preview(self, data=None, name="company.pdf"):
        return self.call("/api/documents/preview", {"name": name, "data": base64.b64encode(sample_pdf() if data is None else data).decode()})

    def test_preview_keeps_page_numbers_and_does_not_import_before_confirmation(self):
        # Catches missing extraction, lost page boundaries, or importing on preview.
        status, result = self.preview()
        self.assertEqual(status, 200, result)
        self.assertEqual(result["page_count"], 2)
        self.assertEqual([page["number"] for page in result["pages"]], [1, 2])
        self.assertIn("Ren Zhengfei founded Huawei.", result["pages"][0]["text"])
        self.assertIn("Shenzhen", result["pages"][1]["text"])
        self.assertEqual(list((self.root / "input").iterdir()), [])
        self.assertFalse((self.root / "source_documents").exists())

    def test_confirmation_preserves_pdf_and_adds_page_marked_text_for_graphrag(self):
        # Catches a fake import which never writes GraphRAG-compatible input or drops the PDF.
        original = sample_pdf()
        status, preview = self.preview(original)
        self.assertEqual(status, 200, preview)
        status, result = self.call("/api/documents/import", {"preview_id": preview["preview_id"]})
        self.assertEqual(status, 201, result)
        text = (self.root / "input" / result["name"]).read_text(encoding="utf-8")
        self.assertIn("company.pdf", text)
        self.assertIn("第 1 页", text)
        self.assertIn("第 2 页", text)
        self.assertIn("Ren Zhengfei founded Huawei.", text)
        _, detail = self.call("/api/documents/" + result["name"])
        self.assertEqual(detail["format"], "PDF")
        self.assertEqual(detail["display_name"], "company.pdf")
        self.assertEqual(detail["pages"][1]["number"], 2)
        status, pdf = self.call("/api/originals/" + result["name"])
        self.assertEqual(status, 200)
        self.assertEqual(pdf, original)
        _, overview = self.call("/api/overview")
        self.assertEqual(overview["documents"][0]["format"], "PDF")
        self.assertFalse(overview["documents"][0]["indexed"])
        self.assertFalse((self.root / "output").exists(), "Import must not silently rebuild the index")

    def test_duplicates_preserve_existing_input_and_original(self):
        # Catches overwriting an existing document when importing a same-named PDF.
        status, first = self.preview()
        self.assertEqual(status, 200, first)
        _, imported = self.call("/api/documents/import", {"preview_id": first["preview_id"]})
        before = (self.root / "input" / imported["name"]).read_bytes()
        _, second = self.preview(sample_pdf(("Different content",)))
        status, _ = self.call("/api/documents/import", {"preview_id": second["preview_id"]})
        self.assertEqual(status, 409)
        self.assertEqual((self.root / "input" / imported["name"]).read_bytes(), before)
        self.assertEqual(len(list((self.root / "source_documents").glob("*.pdf"))), 1)

    def test_image_only_pdf_rejected_with_ocr_guidance(self):
        status, result = self.preview(sample_pdf(("",)))
        self.assertEqual(status, 422, result)
        self.assertIn("OCR", result["error"])

    def test_mixed_pdf_warns_about_pages_without_text(self):
        status, result = self.preview(sample_pdf(("A readable page", "")))
        self.assertEqual(status, 200, result)
        self.assertEqual(result["empty_pages"], [2])
        self.assertTrue(result["warnings"])

    def test_corrupt_encrypted_bad_base64_and_path_inputs_rejected(self):
        for data in (b"not a pdf", b"%PDF-1.7 broken", sample_pdf(password="secret")):
            with self.subTest(data=data[:20]):
                status, _ = self.preview(data)
                self.assertEqual(status, 422)
        for body in ({"name": "bad.pdf", "data": "not base64!"},
                     {"name": "../unsafe.pdf", "data": "YQ=="},
                     {"name": "bad.exe", "data": "YQ=="}):
            with self.subTest(body=body):
                status, _ = self.call("/api/documents/preview", body)
                self.assertEqual(status, 400)
        status, _ = self.call("/api/documents/import", {"preview_id": "does-not-exist"})
        self.assertEqual(status, 410)

    def test_cancel_discards_preview_and_cannot_later_import_it(self):
        status, preview = self.preview()
        self.assertEqual(status, 200, preview)
        status, _ = self.call("/api/documents/discard", {"preview_id": preview["preview_id"]})
        self.assertEqual(status, 200)
        status, _ = self.call("/api/documents/import", {"preview_id": preview["preview_id"]})
        self.assertEqual(status, 410)
        self.assertEqual(list((self.root / "input").iterdir()), [])

    def test_existing_txt_flow_still_works_and_private_sources_are_not_public(self):
        status, result = self.call("/api/documents", {"name": "notes.TXT", "content": "原有 TXT 导入仍然可用。"})
        self.assertEqual(status, 201, result)
        _, detail = self.call("/api/documents/notes.txt")
        self.assertIn("原有 TXT", detail["text"])
        status, _ = self.call("/source_documents/private.pdf")
        self.assertEqual(status, 404)

    def test_long_names_and_limits_rejected_without_partial_imports(self):
        # Catches unbounded metadata/header names, oversized uploads, or excessive page counts.
        status, _ = self.preview(name="a" * 250 + ".pdf")
        self.assertEqual(status, 400)
        status, _ = self.preview(b"%PDF-" + b" " * (10 * 1024 * 1024))
        self.assertEqual(status, 413)
        status, _ = self.preview(sample_pdf(("",) * 101))
        self.assertEqual(status, 422)
        self.assertEqual(list((self.root / "input").iterdir()), [])

    def test_index_in_progress_blocks_import_until_snapshot_is_finished(self):
        # Catches changes to input while GraphRAG is constructing its current snapshot.
        status, preview = self.preview()
        self.assertEqual(status, 200, preview)
        serve.JOBS["test-index"] = {"kind": "index", "status": "running"}
        try:
            status, _ = self.call("/api/documents/import", {"preview_id": preview["preview_id"]})
            self.assertEqual(status, 409)
            self.assertEqual(list((self.root / "input").iterdir()), [])
        finally:
            del serve.JOBS["test-index"]
        status, _ = self.call("/api/documents/import", {"preview_id": preview["preview_id"]})
        self.assertEqual(status, 201)

    def test_graphrag_text_loader_reads_imported_pdf_with_page_provenance(self):
        # Tests the real installed GraphRAG loader, not a mock of the indexer.
        from graphrag.config.models.input_config import InputConfig
        from graphrag.index.input.text import load
        from graphrag.storage.file_pipeline_storage import FilePipelineStorage
        _, preview = self.preview()
        _, result = self.call("/api/documents/import", {"preview_id": preview["preview_id"]})
        config = InputConfig(base_dir=str(self.root / "input"), file_pattern=r".*\.txt$")
        frame = asyncio.run(load(config, None, FilePipelineStorage(str(self.root / "input"))))
        self.assertEqual(frame["title"].tolist(), [result["name"]])
        self.assertIn("第 1 页", frame.iloc[0]["text"])
        self.assertIn("第 2 页", frame.iloc[0]["text"])
        self.assertIn("Shenzhen", frame.iloc[0]["text"])

    def test_small_pdf_with_excessive_cumulative_decompression_is_rejected(self):
        # 18 distinct 4-MiB content streams compress to a small PDF with only 18 short lines.
        # Catches trusting upload bytes/final text instead of bounding intermediate decoded data.
        compressed = sample_pdf(tuple(f"Short line {n}" for n in range(18)), padding_bytes=4 * 1024 * 1024)
        self.assertLess(len(compressed), 150000)
        status, result = self.preview(compressed)
        self.assertEqual(status, 422, result)
        self.assertEqual(list((self.root / "input").iterdir()), [])

    def test_resource_failure_inside_form_does_not_silently_import_partial_text(self):
        # pypdf catches Form extraction exceptions internally; a readable page header must not mask it.
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(sample_pdf(("Readable header",)))))
        page = writer.pages[0]
        form = DecodedStreamObject()
        form.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
                     NameObject("/BBox"): ArrayObject([NumberObject(n) for n in (0, 0, 600, 800)]),
                     NameObject("/Resources"): DictionaryObject({NameObject("/Font"): page["/Resources"]["/Font"]})})
        form.set_data(b" " * (33 * 1024 * 1024) + b"BT /F1 12 Tf 50 650 Td (Hidden form text) Tj ET")
        page["/Resources"][NameObject("/XObject")] = DictionaryObject({NameObject("/Heavy"): writer._add_object(form.flate_encode())})
        content = DecodedStreamObject()
        content.set_data(page["/Contents"].get_data() + b"\n/Heavy Do\n")
        page[NameObject("/Contents")] = writer._add_object(content)
        result = io.BytesIO()
        writer.write(result)
        status, body = self.preview(result.getvalue())
        self.assertEqual(status, 422, body)
        self.assertIn("资源", body["error"])
        self.assertEqual(list((self.root / "input").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
