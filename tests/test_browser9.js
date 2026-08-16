// v1.5 工作手册 PDF 嵌入专项验证
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const URL = 'http://localhost:8765/catalog.html';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  page.on('requestfailed', r => { if (r.url().includes('manual.pdf')) errs.push('PDFFAIL: ' + r.url()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);

  const results = [];
  const check = (n, c, e = '') => results.push((c ? 'PASS' : 'FAIL') + ' | ' + n + (e ? ' | ' + e : ''));

  // ===== 1. 三个 tab 按钮 =====
  const tabs = await page.locator('.tab-btn').allTextContents();
  check('三个 tab 按钮', tabs.length === 3, JSON.stringify(tabs));
  check('tab 含"工作手册"', tabs.some(t => t.includes('工作手册')), JSON.stringify(tabs));

  // ===== 2. 默认 tab 0 细则正常 =====
  check('默认细则 tab 渲染', await page.locator('#db').count() > 0);

  // ===== 3. 切到工作手册 tab =====
  await page.click('.tab-btn[data-tab="2"]');
  await page.waitForTimeout(600);
  check('工作手册 tab 激活', await page.locator('.tab-btn[data-tab="2"].active').count() > 0);
  const iframe = page.locator('.pdf-frame');
  check('iframe 存在', await iframe.count() === 1);
  const src = await iframe.getAttribute('src');
  check('iframe src 为 docs/manual.pdf', src === 'docs/manual.pdf', src);
  const pdfName = await page.locator('.pdf-name').textContent();
  check('工具栏标题含"整理工作手册"', pdfName.includes('整理工作手册'), pdfName);
  check('新窗口打开链接存在', await page.locator('.pdf-open[href="docs/manual.pdf"]').count() > 0);

  // iframe 内 PDF 加载：headless Chrome 内置 PDF 查看器（mhjfbmdgcfjbbpaeojofohoefgiehjai）
  // 由插件进程渲染，contentDocument 仅含 pdf_embedder.css 壳——出现该扩展标识即加载成功
  const pdfLoaded = await page.evaluate(() => {
    const f = document.querySelector('.pdf-frame');
    if (!f || !f.contentDocument) return 'no-doc';
    try {
      const doc = f.contentDocument;
      if (doc.querySelector('embed[type="application/pdf"]')) return 'embed';
      const html = doc.documentElement ? doc.documentElement.innerHTML : '';
      if (html.includes('pdf_embedder.css')) return 'chrome-pdf-embedder';
      if (html.includes('pdf-viewer')) return 'pdf-viewer';
      return 'unknown:' + html.slice(0, 150);
    } catch (e) { return 'err:' + e.message; }
  });
  check('PDF 查看器加载 (' + pdfLoaded + ')', pdfLoaded === 'embed' || pdfLoaded === 'chrome-pdf-embedder' || pdfLoaded === 'pdf-viewer', pdfLoaded);

  // ===== 4. iframe 尺寸 =====
  const box = await iframe.boundingBox();
  check('iframe 有实际高度', box && box.height > 400, box ? 'h=' + Math.round(box.height) : 'null');

  // ===== 5. PDF 网络请求 200 =====
  const resp = await page.evaluate(async () => {
    try {
      const r = await fetch('docs/manual.pdf');
      const buf = await r.arrayBuffer();
      // PDF 魔数 %PDF 检查
      const magic = new Uint8Array(buf.slice(0, 4));
      const isPdf = magic[0] === 0x25 && magic[1] === 0x50 && magic[2] === 0x44 && magic[3] === 0x46;
      return r.status + '|' + (r.headers.get('content-type') || 'none') + '|bytes=' + buf.byteLength + '|magic=' + (isPdf ? 'PDF-OK' : 'NOT-PDF');
    } catch (e) { return 'ERR:' + e.message; }
  });
  check('PDF 请求 200 且为有效 PDF', resp.startsWith('200') && resp.includes('PDF-OK'), resp);

  // ===== 6. 切回细则/分类表 tab 回归 =====
  await page.click('.tab-btn[data-tab="0"]');
  await page.waitForTimeout(300);
  check('切回细则 tab', await page.locator('#db').count() > 0);
  await page.click('.tab-btn[data-tab="1"]');
  await page.waitForTimeout(300);
  check('切回分类表 tab', await page.locator('.ctbl').count() > 0);

  // ===== 7. 无 JS 错误 =====
  check('无 JS 错误', errs.length === 0, errs.join(' ; '));

  console.log('\n===== v1.5 PDF 嵌入浏览器实测 =====');
  results.forEach(r => console.log('  ' + r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\nTOTAL:', results.length, ' PASS:', results.length - fails.length, ' FAIL:', fails.length);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
