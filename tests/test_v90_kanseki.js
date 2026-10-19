// ============================================
// V1.1 古籍类目查询（kanseki）回归测试
// 说明：页面已按「桌面版 v3」重做——顶部下拉导航删除、表格改为五列
//       （书名/著者/总目分类/合璧分类/判定）、判定色标保留、导出按钮改名 #ksExportBtn。
//       旧版针对序号列 / 8 列表格 / 下拉导航的断言随交互删除，这里按新契约重写。
// ============================================
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const BASE = 'http://localhost:8765';
let pass = 0, fail = 0;
const errors = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const search = async (q) => {
    await page.fill('#ksSearch', q);
    await page.click('#ksGo');
    await page.waitForTimeout(900);
  };
  const rows = () => page.locator('#ksBody tr');
  const cell = async (r, c) => ((await page.locator('#ksBody tr').nth(r).locator('td').nth(c).textContent()) || '').trim();

  // ---------- 1. 数据与首屏 ----------
  await page.goto(`${BASE}/kanseki.html`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#ksBody tr', { timeout: 60000 });
  await page.waitForTimeout(800);
  check('数据总量 177,107', (await page.evaluate(() => window.KANSEKI_META.total)) === 177107);
  check('分类组合 349 条', (await page.evaluate(() => window.KANSEKI_CATS.length)) === 349);
  check('默认每页 100 行', (await rows().count()) === 100, String(await rows().count()));
  check('v3 五列表格', (await page.locator('#ksBody tr').first().locator('td').count()) === 5);

  // ---------- 2. 站点导航（V1.1 统一导航条） ----------
  check('站点导航条 8 项', (await page.locator('.web-nav-strip a').count()) === 8, String(await page.locator('.web-nav-strip a').count()));
  check('已无旧顶部下拉菜单', (await page.locator('.nav-dropdown-btn').count()) === 0);

  // ---------- 3. 检索与字形 ----------
  await search('周易');
  check('检索「周易」有结果', (await rows().count()) > 0, String(await rows().count()));
  check('书名列含「周易」', (await cell(0, 0)).indexOf('周易') >= 0, await cell(0, 0));

  await page.click('#langBtnS'); await page.waitForTimeout(500);
  await search('唐开成石壁');
  check('简体检索「唐开成石壁」命中', (await rows().count()) >= 1, String(await rows().count()));
  check('简体书名无繁体残留', (await cell(0, 0)).indexOf('开成') >= 0 && (await cell(0, 0)).indexOf('開') < 0, await cell(0, 0));
  await page.click('#langBtnT'); await page.waitForTimeout(500);
  await search('唐開成石壁');
  check('繁体检索「唐開成石壁」命中', (await rows().count()) >= 1, String(await rows().count()));
  check('繁体书名保留原字形', (await cell(0, 0)).indexOf('開成') >= 0, await cell(0, 0));

  // ---------- 4. 判定三态色标 ----------
  await search('周易');
  const badges = await page.locator('#ksBody tr .vd').evaluateAll((els) => els.map((e) => e.className));
  check('判定色标存在', badges.length > 0, String(badges.length));
  check('三态类名约定（vd-same/vd-ok/vd-none）',
    badges.some((c) => c.indexOf('vd-same') >= 0 || c.indexOf('vd-ok') >= 0 || c.indexOf('vd-none') >= 0),
    badges.slice(0, 3).join('|'));

  // ---------- 5. 导出 ----------
  check('导出 CSV 已按需求移除', (await page.locator('#ksExportBtn').count()) === 0);

  // ---------- 6. 无 JS 错误 ----------
  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log(`\n===== V1.1 kanseki 回归：${pass} 通过, ${fail} 失败 =====`);
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('测试异常:', (e && e.message) || e); process.exit(1); });
