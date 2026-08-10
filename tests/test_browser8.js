// v1.4 收尾验证: 四页导航统一 + 更新日志 v1.4 条目 + 编目页回归
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const BASE = 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  const check = (n, c, e = '') => results.push((c ? 'PASS' : 'FAIL') + ' | ' + n + (e ? ' | ' + e : ''));

  // 四页导航
  const pages = ['guide.html', 'index.html', 'catalog.html', 'changelog.html'];
  for (const p of pages) {
    await page.goto(BASE + p, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(300);
    const nav = await page.locator('.header-nav a').allTextContents();
    const ok4 = nav.length === 4;
    const hasGuide = nav.some(t => t.includes('使用介绍') || t.includes('使用介紹'));
    const hasCat = nav.some(t => t.includes('编目规范') || t.includes('編目規範'));
    const hasCl = nav.some(t => t.includes('更新日志') || t.includes('更新日誌'));
    check(p + ' 导航4项', ok4 && hasGuide && hasCat && hasCl, JSON.stringify(nav));
  }

  // changelog 页条目检查（v1.4 起：首条为最新版本，条目数随版本递增）
  await page.goto(BASE + 'changelog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(300);
  const firstVer = await page.locator('.cl-entry').first().locator('.cl-ver').textContent();
  check('更新日志首条为最新版本', /^v\d+\.\d+/.test(firstVer.trim()), firstVer);
  const firstDate = await page.locator('.cl-entry').first().locator('.cl-date').textContent();
  check('首条日期为 2026-08', firstDate.includes('2026-08'), firstDate);
  const entries = await page.locator('.cl-entry').count();
  check('日志条目 >= 7', entries >= 7, 'entries=' + entries);
  // 找 v1.4 条目（可能不是首条）验证其内容完整
  const v14Text = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.cl-entry')];
    const el = els.find(e => e.querySelector('.cl-ver') && e.querySelector('.cl-ver').textContent.trim() === 'v1.4');
    return el ? el.textContent : '';
  });
  check('v1.4 条目存在', v14Text.includes('2023 舊版細則全文更新'), v14Text ? 'ok' : 'missing');
  check('v1.4 含标题居中说明', v14Text.includes('大标题居中'));
  check('v1.4 含引号规范说明', v14Text.includes('引号规范') || v14Text.includes('引號規範'));

  // 编目页导航点击跳转
  await page.goto(BASE + 'catalog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(300);
  await page.click('.header-nav a[href="changelog.html"]');
  await page.waitForTimeout(600);
  check('catalog 导航可跳转 changelog', page.url().includes('changelog.html'), page.url());

  console.log('\n===== v1.4 收尾验证 =====');
  results.forEach(r => console.log('  ' + r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\nTOTAL:', results.length, ' PASS:', results.length - fails.length, ' FAIL:', fails.length);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
