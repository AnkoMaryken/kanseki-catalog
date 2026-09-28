// ================================================
// app/tests/browser/app_shell.test.cjs — SPA 外壳 + 视图路由
// 对 app dev server（8766）验证
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const config = require('../../../tests/helpers/config.js');

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.launch(config.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  await page.goto(config.resolveAppUrl(), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. 外壳结构（V0.6：静态站顶部导航并入左侧栏后为 10 项 / 8 视图）
  check('侧边栏存在', await page.locator('.app-sidebar').count() === 1);
  check('导航项 10 个', await page.locator('.nav-item').count() === 10);
  check('视图 8 个', await page.locator('.view').count() === 8);
  check('侧栏可见导航项 10 个', await page.locator('.nav-item:visible').count() === 10);
  check('查询视图默认激活', await page.locator('#view-query.active').count() === 1);
  check('iframe 加载', await page.locator('#queryFrame').count() === 1);

  // 2. iframe 内静态站
  const frame = page.frame({ url: /pages\/index\.html/ });
  check('iframe 内搜索框', frame && (await frame.locator('#globalSearch').count()) === 1);
  if (frame) {
    await frame.locator('#globalSearch').fill('万历');
    await frame.locator('#searchBtn').click();
    await page.waitForTimeout(600);
    const total = await frame.locator('#totalCount').textContent();
    check('iframe 搜索"万历"→48', parseInt(total) === 48, '实际 ' + total);
  }

  // 3. 视图切换
  await page.click('a[data-view="records"]');
  await page.waitForTimeout(300);
  check('records 视图激活', await page.locator('#view-records.active').count() === 1);
  check('新增按钮禁用', await page.locator('#addRecordBtn').isDisabled());

  await page.click('a[data-view="sync"]');
  await page.waitForTimeout(300);
  check('sync 视图激活', await page.locator('#view-sync.active').count() === 1);
  check('sync 表单存在', await page.locator('#syncUser').count() === 1);

  await page.click('a[data-view="about"]');
  await page.waitForTimeout(300);
  check('about 视图激活', await page.locator('#view-about.active').count() === 1);

  await page.click('a[data-view="query"]');
  await page.waitForTimeout(300);
  check('query 视图恢复', await page.locator('#view-query.active').count() === 1);

  // 4. JS 错误
  check('0 JS 错误', errors.length === 0, errors.join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
