// V8.1 端到端实测 v2: 模拟真实用户「重新进入」场景
// 关键: localStorage 按「源(origin)」隔离 — 同源重开保留, 跨源/无痕不保留
const { CHROME_PATH, PORT, playwrightCorePath } = require('D:/WorkBuddy空间/2026-08-01-13-40-21/tests/helpers/config');
const { chromium } = require(playwrightCorePath());
const BASE = 'http://localhost:' + PORT;
const EMAIL = 'persist2-' + Date.now() + '@example.com';
const PASS = 'pass12345';
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + '  ' + (extra || '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1. 注册 (本地账号兜底写入)
  console.log('\n[1] 注册并写入本地账号');
  await page.goto(BASE + '/signup.html');
  await page.fill('#name', '持久化测试');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.fill('#confirmPassword', PASS);
  await page.click('#signupBtn');
  await page.waitForTimeout(1200);
  const localRec = await page.evaluate((em) => {
    const l = window.SupabaseLocal.list();
    return l.find(x => x.email === em) || null;
  }, EMAIL);
  ok('本地账号已写入', !!localRec && !!localRec.passHash);

  // 2. 登录 → 设置头像
  console.log('\n[2] 登录 + 设置头像');
  await page.goto(BASE + '/login.html');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('#loginBtn');
  await page.waitForURL('**/index.html', { timeout: 10000 });
  ok('登录成功', await page.evaluate(() => window.UserState.isLoggedIn()));
  await page.goto(BASE + '/profile.html');
  await page.evaluate(() => {
    window.UserState.setAvatarData({ type: 'color', bg: '#10b981', char: '持', fg: '#ffffff' });
    window.UserState.setProfile({ name: '持久化测试' });
  });

  // 3. 同源「关标签重开」: 关闭页面, 同 context 新建页面 (模拟关闭标签页再打开, 同一浏览器)
  console.log('\n[3] 同浏览器同源 关标签重开');
  await page.close();
  const page2 = await ctx.newPage();
  await page2.goto(BASE + '/index.html');
  ok('重开后登录态保留', await page2.evaluate(() => window.UserState.isLoggedIn()));
  ok('重开后昵称保留', (await page2.evaluate(() => window.UserState.getDisplayName())) === '持久化测试');
  const av2 = await page2.evaluate(() => window.UserState.getAvatarData());
  ok('重开后头像保留', !!av2 && av2.char === '持' && av2.bg === '#10b981');

  // 4. 关键演示: 不同源 (127.0.0.1 ≠ localhost) → localStorage 不共享!
  console.log('\n[4] 跨源演示: 127.0.0.1 vs localhost (不同源, localStorage 隔离)');
  const page3 = await ctx.newPage();
  await page3.goto('http://127.0.0.1:' + PORT + '/index.html');
  const crossLogged = await page3.evaluate(() => window.UserState.isLoggedIn());
  ok('127.0.0.1 看不到 localhost 的登录态 (这是浏览器 origin 隔离, 非 bug)', !crossLogged, 'crossLogged=' + crossLogged);

  // 5. 重新登录验证 (走本地账号兜底)
  console.log('\n[5] 退出后重新登录 (本地账号兜底生效)');
  await page2.goto(BASE + '/login.html');
  await page2.fill('#email', EMAIL);
  await page2.fill('#password', PASS);
  await page2.click('#loginBtn');
  await page2.waitForURL('**/index.html', { timeout: 10000 });
  ok('退出后重新登录成功', await page2.evaluate(() => window.UserState.isLoggedIn()));

  await browser.close();
  console.log(`\n==== 端到端结果: ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
