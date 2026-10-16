// 【测试 · 界面】检查引用来源和桌面/平板/手机四个页面，不调用问答模型。
// 先运行 serve.py，再执行 node tests/web_ui.mjs；默认检查本学习项目的 8766。
// Focused browser checks without running another model query or changing the user's index.
import assert from 'node:assert/strict';
import { Browser, sleep } from '/Users/chengyunbei/.codex/skills/taste-skill/scripts/lib/cdp.mjs';

const base = process.env.GRAPHRAG_TEST_URL || 'http://127.0.0.1:8766';
const health = await fetch(base + '/api/health').then(response => response.json());
assert.equal(health.online, true, health.message);
const overview = await fetch(base + '/api/overview').then(response => response.json());
assert.equal(overview.ready, true);
console.log('PASS current service, index and local models are ready');
const invalidUpload = await fetch(base + '/api/documents', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'not-supported.pdf',content:'validation only'})});
assert.equal(invalidUpload.status, 400);
const existing = overview.documents[0];
const existingDocument = await fetch(base + '/api/documents/' + encodeURIComponent(existing.name)).then(response => response.json());
const duplicateUpload = await fetch(base + '/api/documents', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:existing.name,content:existingDocument.text})});
assert.equal(duplicateUpload.status, 409);
console.log('PASS unsupported formats rejected; existing document preserved');
const browser = await Browser.launch();
try {
  const page = await browser.newPage({ width: 1440, height: 900 });
  await page.goto(base, { settleMs: 1200 });
  // References with the same numeric IDs in different tables must not mix records.
  const citation = await page.eval(() => {
    state.conversation = [{context:{relationships:[
      {id:0, description:'unrelated relationship'},
      {id:6, description:'the referenced relationship'},
    ], sources:[{id:0, text:'the referenced source'}]}}];
    showContext(0, null, 'Relationships (6); Sources (0)');
    const result = {count:document.querySelectorAll('.source-record').length, text:document.querySelector('#dialog-content').textContent};
    document.querySelector('#dialog-close').click();
    state.conversation = [];
    return result;
  });
  assert.equal(citation.count, 2);
  assert.equal(citation.text.includes('unrelated relationship'), false);
  console.log('PASS citation IDs are scoped to their own tables');
  // A newly imported but unindexed PDF must not relabel an older indexed text snippet.
  const previewSource = await page.eval(() => {
    const previous = state.data;
    state.data = {...previous, documents:[
      {id:null, name:'aaa-new.pdf.txt', display_name:'新导入.pdf'},
      {id:'indexed-document', name:'original.pdf.txt', display_name:'已索引.pdf'},
    ], text_units:[{text:'来自已索引文档的原文。', document_ids:['indexed-document']}]};
    renderPreviews();
    const result = document.querySelector('#source-preview .preview-file').textContent;
    state.data = previous; renderPreviews();
    return result;
  });
  assert.equal(previewSource, '已索引.pdf');
  console.log('PASS unindexed PDFs cannot be mistaken for an indexed snippet source');
  for (const width of [1440, 768, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000, mobile: width === 390 });
    for (const route of ['ask', 'graph', 'documents', 'reports']) {
      await page.eval(route => { location.hash = route; }, route);
      await sleep(400);
      const result = await page.eval(() => ({
        overflow:document.documentElement.scrollWidth - innerWidth,
        visible:[...document.querySelectorAll('.view')].filter(el => !el.hidden).length,
      }));
      assert.ok(result.overflow <= 1, `${width}px ${route}: ${result.overflow}px overflow`);
      assert.equal(result.visible, 1);
    }
    console.log(`PASS ${width}px: all four screens, no horizontal overflow`);
  }
  await page.setViewport({ width: 390, height: 844, mobile: true });
  await page.eval(() => { location.hash = 'ask'; });
  await sleep(400);
  assert.ok(await page.eval(() => document.querySelector('#send-button').getBoundingClientRect().bottom <= innerHeight));
  assert.deepEqual(page.consoleErrors, []);
  console.log('PASS mobile action visible; no JavaScript exceptions');
} finally {
  await browser.close();
}
