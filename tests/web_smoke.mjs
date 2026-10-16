// 【测试 · 完整问答】验证真实图谱、原文、Local/Global 问答及引用弹窗。
// 先启动 serve.py 和 Ollama，再运行 node tests/web_smoke.mjs；会实际调用本地模型。
// 不导入新文档、不重建索引。默认检查 8766，可用 GRAPHRAG_TEST_URL 覆盖。
// Real local-service and browser smoke checks. Does not import documents or rebuild the index.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Browser, sleep } from '/Users/chengyunbei/.codex/skills/taste-skill/scripts/lib/cdp.mjs';

const base = process.env.GRAPHRAG_TEST_URL || 'http://127.0.0.1:8766';
const out = '.taste-skill/verification';
mkdirSync(out, { recursive: true });
const results = [];
const checked = (name, detail = '') => { results.push({ name, detail, passed: true }); console.log(`PASS ${name}${detail ? ': ' + detail : ''}`); };
const call = async (path, body, headers = {}) => fetch(base + path, body === undefined ? undefined : {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

const status = await call('/api/health').then(r => r.json());
assert.equal(status.online, true, status.message);
checked('Ollama models ready', `${status.chat_model}, ${status.embedding_model}`);
const data = await call('/api/overview').then(r => r.json());
assert.equal(data.counts.entities, data.entities.length);
assert.equal(data.counts.relationships, data.relationships.length);
assert.ok(data.ready && data.documents.length > 0);
checked('real index data', JSON.stringify(data.counts));
assert.equal((await call('/api/query', { query: '   ', method: 'local' })).status, 400);
assert.equal((await call('/api/query', { query: 'test', method: 'invalid' })).status, 400);
assert.equal((await call('/api/query', [], {})).status, 400);
assert.equal((await call('/api/query', { query: 'test' }, { origin: 'https://other.example' })).status, 403);
assert.equal((await call('/.env')).status, 404);
assert.equal((await call('/settings.yaml')).status, 404);
assert.equal((await call('/api/documents/..%2F.env')).status, 400);
checked('request validation and private-file boundaries');

const browser = await Browser.launch();
try {
  const page = await browser.newPage({ width: 1440, height: 1000 });
  await page.goto(base, { settleMs: 1400 });
  assert.equal(await page.eval(() => document.querySelectorAll('#preview-svg .graph-node').length > 0), true);
  await page.eval(() => document.querySelector('#preview-svg .graph-node').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(300);
  assert.equal(await page.eval(() => location.hash), '#graph');
  assert.ok(await page.eval(() => document.querySelector('#entity-detail .entity-original')?.textContent));
  await page.screenshot({ path: `${out}/graph-desktop.jpg`, fullPage: true });
  await page.eval(() => document.querySelector('#entity-source-button').click());
  assert.equal(await page.eval(() => document.querySelector('#detail-dialog').open), true);
  assert.ok(await page.eval(() => document.querySelector('#dialog-content').textContent.includes('华为')));
  await page.eval(() => document.querySelector('#dialog-close').click());
  checked('graph navigation, actual node detail, source dialog');

  await page.eval(() => { location.hash = 'documents'; });
  await sleep(700);
  assert.ok(await page.eval(() => document.querySelector('#document-reader').textContent.includes('任正非')));
  await page.screenshot({ path: `${out}/documents-desktop.jpg`, fullPage: true });
  await page.eval(() => { location.hash = 'reports'; });
  await sleep(300);
  assert.equal(await page.eval(() => document.querySelectorAll('.report-card').length), data.reports.length);
  await page.screenshot({ path: `${out}/reports-desktop.jpg`, fullPage: true });
  checked('document reader and community reports');

  await page.setViewport({ width: 390, height: 844, mobile: true });
  await page.eval(() => { location.hash = 'ask'; });
  await sleep(500);
  const mobile = await page.eval(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
    sendBottom: document.querySelector('#send-button').getBoundingClientRect().bottom,
    height: innerHeight,
  }));
  assert.equal(mobile.overflow, false);
  assert.ok(mobile.sendBottom <= mobile.height, `send button outside first screen: ${JSON.stringify(mobile)}`);
  await page.screenshot({ path: `${out}/mobile-home.jpg`, fullPage: true });
  checked('mobile first-screen action and no horizontal overflow');

  await page.setViewport({ width: 1440, height: 1000 });
  for (const [method, query] of [
    ['local', '任正非与华为是什么关系？请用一句中文回答并保留依据。'],
    ['global', '这些科技企业的发展有哪些共同趋势？用中文简要列出三点，保留依据。'],
  ]) {
    await page.eval(({ method, query }) => {
      document.querySelector(`[data-mode="${method}"]`).click();
      document.querySelector('#query-input').value = query;
      document.querySelector('#query-form').requestSubmit();
    }, { method, query });
    const start = Date.now();
    let complete = false;
    while (Date.now() - start < 600000) {
      await sleep(1000);
      const current = await page.eval(() => {
        const last = [...document.querySelectorAll('.message-answer')].at(-1);
        return { pending: !!last?.querySelector('.pending-answer'), error: last?.querySelector('.answer-error')?.textContent,
          answer: last?.querySelector('.answer-body')?.textContent, sources: last?.querySelectorAll('.source-chip').length || 0 };
      });
      if (current.error) throw new Error(`${method}: ${current.error}`);
      if (!current.pending && current.answer) {
        assert.ok(current.answer.length > 8);
        if (method === 'local') assert.ok(current.answer.includes('任正非') && current.answer.includes('华为'));
        assert.ok(current.sources > 0, 'retrieval context is empty');
        checked(`live ${method} query`, current.answer.slice(0, 180));
        await page.screenshot({ path: `${out}/${method}-answer.jpg`, fullPage: true });
        complete = true; break;
      }
      if (Math.floor((Date.now() - start) / 1000) % 30 === 0) console.log(`WAIT ${method} model response`);
    }
    assert.ok(complete, `${method} query timed out`);
  }
  await page.eval(() => document.querySelector('.source-chip').click());
  assert.equal(await page.eval(() => document.querySelector('#detail-dialog').open), true);
  assert.ok(await page.eval(() => document.querySelector('#dialog-content').textContent.length > 20));
  await page.eval(() => document.querySelector('#dialog-close').click());
  checked('query evidence dialog');
  assert.deepEqual(page.consoleErrors, []);
  checked('no browser runtime exceptions');
} finally {
  writeFileSync(`${out}/smoke-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
