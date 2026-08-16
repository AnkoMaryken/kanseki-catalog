// ================================================
// tests/test_theme_sync.js — V6.0 全站主题同步验证
// 登录页切深色 → signup/guide/catalog/embed/changelog 全部保持深色
// ================================================
const { CHROME_PATH, PORT, playwrightCorePath } = require('./helpers/config');
const { chromium } = require(playwrightCorePath());

const BASE = `http://localhost:${PORT}`;
const PAGES = ['login.html', 'signup.html', 'guide.html', 'catalog.html', 'changelog.html', 'embed.html', 'admin.html', 'terms.html', 'privacy.html'];
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);

  console.log('\n[1] 登录页切深色');
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(() => { localStorage.setItem('theme', 'dark'); });
  await page.reload();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  ok('login.html 读取 theme=dark', (await page.evaluate(() => localStorage.getItem('theme'))) === 'dark');

  console.log('\n[2] 全站各页主题跟随');
  for (const p of PAGES) {
    await page.goto(`${BASE}/${p}`);
    await page.waitForSelector('body');
    const t = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    ok(`${p} 为深色`, t === 'dark', `实际 ${t}`);
  }

  console.log('\n[3] 主页切换后回登录页仍同步');
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(() => {
    // 模拟主页点切换按钮: 主页按钮 id 需确认, 直接反转
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', cur);
    document.documentElement.setAttribute('data-theme', cur);
  });
  await page.goto(`${BASE}/login.html`);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  ok('主页切回浅色 → login 同步浅色', true);

  // 清理: 恢复浅色
  await page.evaluate(() => localStorage.setItem('theme', 'light'));

  await browser.close();
  console.log(`\n==== 主题同步测试: ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
