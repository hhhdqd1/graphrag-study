// 【测试 · PDF 网页】真实浏览器走完上传、预览、确认、下载、取消和扫描件提示。
// 运行：node tests/web_pdf.mjs；会自动启动临时服务，不需要先运行 serve.py。
// 依赖本机 Node 和下方浏览器测试工具路径；这是开发验收，不是应用启动入口。
// Catches a broken upload -> preview -> explicit confirmation flow in a real browser.
// The service, documents, and PDF fixtures are disposable; the user's index is untouched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Browser, sleep } from '/Users/chengyunbei/.codex/skills/taste-skill/scripts/lib/cdp.mjs';

const server = spawn('.venv/bin/python', ['-u', 'tests/pdf_fixture_server.py'], {stdio:['pipe', 'pipe', 'pipe']});
let stderr = '';
server.stderr.on('data', bytes => { stderr += bytes; });
const lines = createInterface({input:server.stdout});
let browser;
try {
  const fixture = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture service startup timed out: ' + stderr)), 15000);
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited: ' + code + stderr)); });
  });
  browser = await Browser.launch();
  const page = await browser.newPage({width:1440, height:1000});
  await page.goto(fixture.url + '/#documents', {settleMs:600});
  const upload = async (data, name = 'company.pdf') => page.eval(({data, name}) => {
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, {type:'application/pdf'}));
    const input = document.querySelector('#file-input');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  }, {data, name});
  const until = async (fn, description) => {
    const start = Date.now();
    while (Date.now() - start < 12000) {
      if (await page.eval(fn)) return;
      await sleep(150);
    }
    throw new Error('Timed out: ' + description);
  };
  await upload(fixture.pdf);
  await until(() => !!document.querySelector('#confirm-import'), 'PDF preview appears');
  assert.equal((await fetch(fixture.url + '/api/overview').then(r => r.json())).documents.length, 0);
  assert.ok(await page.eval(() => document.querySelector('#dialog-content').textContent.includes('Ren Zhengfei')));
  assert.equal(await page.eval(() => document.querySelectorAll('.pdf-page').length), 2);
  console.log('PASS PDF upload displays real page text; preview does not add a document');
  mkdirSync('.taste-skill/verification', {recursive:true});
  await page.screenshot({path:'.taste-skill/verification/pdf-preview-desktop.jpg'});
  await page.setViewport({width:390, height:844, mobile:true});
  const mobile = await page.eval(() => {
    const dialog = document.querySelector('#detail-dialog');
    const button = document.querySelector('#confirm-import').getBoundingClientRect();
    return {overflow:dialog.scrollWidth - dialog.clientWidth, confirmVisible:button.top >= 0 && button.bottom <= innerHeight};
  });
  assert.ok(mobile.overflow <= 1);
  assert.equal(mobile.confirmVisible, true);
  await page.screenshot({path:'.taste-skill/verification/pdf-preview-mobile.jpg'});
  const saving = await page.eval(() => {
    const dialog = document.querySelector('#detail-dialog');
    document.querySelector('#confirm-import').click();
    // A backdrop click during the real save request must not act as cancellation.
    dialog.dispatchEvent(new MouseEvent('click', {clientX:0, clientY:0, bubbles:true}));
    return {open:dialog.open, closeDisabled:document.querySelector('#dialog-close').disabled};
  });
  assert.equal(saving.open, true, 'Saving must not close on a backdrop click');
  assert.equal(saving.closeDisabled, true);
  await until(() => document.querySelector('#document-reader').textContent.includes('company.pdf'), 'confirmed PDF reader');
  assert.ok(await page.eval(() => document.querySelector('#document-list').textContent.includes('待更新索引')));
  assert.equal(await page.eval(() => document.querySelectorAll('#document-reader .pdf-page').length), 2);
  await until(() => !document.querySelector('#import-button').disabled && !document.querySelector('#detail-dialog').open, 'first import finishes');
  const overview = await fetch(fixture.url + '/api/overview').then(r => r.json());
  assert.equal(overview.documents.length, 1);
  assert.equal(overview.ready, false);
  const original = await fetch(fixture.url + '/api/originals/' + encodeURIComponent(overview.documents[0].name));
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from(fixture.pdf, 'base64'));
  console.log('PASS confirmation persists page-marked text and byte-identical original PDF, without indexing');
  await page.setViewport({width:1440, height:1000});
  await page.screenshot({path:'.taste-skill/verification/pdf-reader-desktop.jpg', fullPage:true});
  await upload(fixture.mixed, 'mixed.pdf');
  await until(() => document.querySelector('#detail-dialog').open && document.querySelector('.pdf-import-summary')?.textContent.includes('mixed.pdf'), 'mixed PDF preview');
  assert.ok(await page.eval(() => document.querySelector('.pdf-warning').textContent.includes('2')));
  await page.eval(() => document.querySelector('#cancel-import').click());
  await until(() => !document.querySelector('#detail-dialog').open, 'cancel closes preview');
  await until(() => !document.querySelector('#import-button').disabled, 'cancellation finishes');
  assert.equal((await fetch(fixture.url + '/api/overview').then(r => r.json())).documents.length, 1);
  await upload(fixture.scanned, 'scanned.pdf');
  await until(() => document.querySelector('#toast').textContent.includes('OCR'), 'image-only PDF shows OCR guidance');
  assert.equal((await fetch(fixture.url + '/api/overview').then(r => r.json())).documents.length, 1);
  assert.deepEqual(page.consoleErrors, []);
  console.log('PASS empty-page warnings, cancellation, scan-only rejection, mobile layout, no JavaScript errors');
} finally {
  if (browser) await browser.close();
  server.stdin.end('stop\n');
  lines.close();
  await new Promise(resolve => {
    if (server.exitCode !== null) return resolve();
    const timer = setTimeout(() => { server.kill(); resolve(); }, 4000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
