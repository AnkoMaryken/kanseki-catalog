// ================================================
// tests/test_admin_smoke.js — V6.3 管理员工作台冒烟测试
// 验证: 登录门禁 / 错误密码 / 工作台统计 / 主题同步 / 数据分布
// 说明: 通过 addInitScript 注入 SUPABASE_CONFIG=null 强制演示模式,
//       使本地 admin/admin123 校验可用, 与真实 Supabase 解耦(稳定可复现)。
// ================================================
const { CHROME_PATH, PORT, playwrightCorePath } = require('./helpers/config');
const { chromium } = require(playwrightCorePath());

const BASE = `http://localhost:${PORT}`;
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
  // 强制演示模式: 即使已配置真实 Supabase 凭据, 测试也用本地 admin/admin123 校验
  await ctx.addInitScript(() => { window.SUPABASE_DEMO = true; });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);

  console.log('\n[1] 登录门禁');
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector('#gateForm');
  ok('初始显示登录门 (gate 可见)', await page.isVisible('#gate'));
  ok('工作台初始隐藏', !(await page.isVisible('#dash')));

  // 错误密码
  await page.fill('#adminUser', 'admin');
  await page.fill('#adminPass', 'wrongpass');
  await page.click('#gateBtn');
  await page.waitForSelector('#gateError.show');
  ok('错误密码显示错误提示', (await page.textContent('#gateError')).includes('错误'));
  ok('错误密码后仍停留在门', await page.isVisible('#gate'));

  // 正确密码
  await page.fill('#adminPass', 'admin123');
  await page.click('#gateBtn');
  await page.waitForSelector('#dash.show', { timeout: 5000 });
  ok('正确密码进入工作台', await page.isVisible('#dash'));
  ok('门已隐藏', !(await page.isVisible('#gate')));
  const dashUser = await page.textContent('#dashUser');
  ok('显示当前管理员', dashUser.includes('管理员'), dashUser);

  console.log('\n[2] 工作台数据统计');
  await page.waitForFunction(() => document.getElementById('mDynasty').textContent !== '0');
  const mDynasty = await page.textContent('#mDynasty');
  const mPeriod = await page.textContent('#mPeriod');
  const mTotal = await page.textContent('#mTotal');
  ok('中国朝代 = 22', mDynasty === '22', `实际 ${mDynasty}`);
  ok('日本时代 = 9', mPeriod === '9', `实际 ${mPeriod}`);
  ok('总记录 > 0 且为数字', /[\d,]+/.test(mTotal) && mTotal !== '0', `实际 ${mTotal}`);

  console.log('\n[3] 数据分布');
  const dynTop = await page.textContent('#dynTop');
  const perTop = await page.textContent('#perTop');
  ok('中国朝代分布已渲染', dynTop.includes('年号') && dynTop.includes('西周'), dynTop.slice(0, 60));
  ok('日本时代分布已渲染', perTop.includes('年号') && perTop.includes('飞鸟'), perTop.slice(0, 60));
  ok('周边政权分布已渲染', perTop.includes('周边') && perTop.includes('大理'), perTop.slice(0, 120));
  ok('其他朝代 metric 标签', (await page.textContent('body')).includes('其他朝代'), 'metric 与面板标题');
  const mPeriodSub = await page.textContent('#mPeriodSub');
  ok('周边政权数在 metric-sub', /日本 \d+ 时代 \+ 周边 \d+ 政权/.test(mPeriodSub), mPeriodSub);

  console.log('\n[4] 主题同步 (admin 页切深色 → index 页保持深色)');
  // admin 页当前主题
  const themeBefore = await page.evaluate(() => localStorage.getItem('theme') || 'light');
  ok('admin 页读取全站 theme 键', ['light', 'dark'].includes(themeBefore), `实际 ${themeBefore}`);
  // 切换主题
  await page.click('#themeToggle');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  const stored = await page.evaluate(() => localStorage.getItem('theme'));
  ok('切换后 localStorage.theme = dark', stored === 'dark', `实际 ${stored}`);
  // 跳到 index.html 验证同步
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector('body');
  const idxTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('index.html 同步为深色', idxTheme === 'dark', `实际 ${idxTheme}`);
  // 恢复浅色，避免影响后续测试
  await page.evaluate(() => { localStorage.setItem('theme', 'light'); document.documentElement.setAttribute('data-theme', 'light'); });

  console.log('\n[5] 会话持久化');
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector('#dash.show');
  ok('24h 会话保持登录态', await page.isVisible('#dash'), '重新打开应直接进工作台');
  // 清理会话
  await page.click('#logoutBtn');
  await page.waitForSelector('#gateForm');
  ok('退出登录回到门', await page.isVisible('#gate'));

  // 结果行先输出（console.log 后再关浏览器，避免 stdout 缓冲丢失）
  console.log(`\n==== 冒烟测试结果: ${passed} 通过, ${failed} 失败 ====`);
  try { await browser.close(); } catch (e) {}
  // 强制同步退出：避免 playwright 内部句柄产生的 unhandled rejection 覆盖退出码
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
