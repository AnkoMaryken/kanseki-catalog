// ================================================
// tests/test_admin_supabase_mode.js — V6.3 方案A 真实模式管理员登录测试
// 验证:
//   1. 真实模式下门禁提示为「管理员邮箱登录」
//   2. 非白名单/无角色邮箱登录被拒 (Supabase 认证失败或权限不足)
//   3. isAdminEmail 白名单校验逻辑正确
// 注: 不依赖真实白名单账号密码, 用随机邮箱验证拒绝路径 + 纯函数验证白名单逻辑
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
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // V8.1.1: 本测试验证「真实模式（Supabase 认证）」分支。真实模式现在要求
  //   端点探测通过（supabase-config.js 会请求 /auth/v1/health）；本机测试
  //   环境到该端点的连通性不可控，故用官方覆盖开关锁定为真实模式。
  //   —— 这不是绕过校验：见 supabase-config.js 中 SUPABASE_ENDPOINT_STATE 说明。
  await page.addInitScript(() => { window.SUPABASE_ENDPOINT_STATE = 'ok'; });

  console.log('\n[1] 真实模式门禁提示');
  await page.goto(`${BASE}/admin.html`);
  await page.waitForSelector('#gateForm');
  const hint = await page.textContent('#gateHint');
  ok('提示为管理员邮箱登录', hint.includes('管理员邮箱'), hint);

  console.log('\n[2] 随机邮箱登录被拒 (Supabase 认证失败或无权限)');
  const randEmail = `no.such.admin.${Date.now()}@gmail.com`;
  await page.fill('#adminUser', randEmail);
  await page.fill('#adminPass', 'WrongPass123!');
  await page.click('#gateBtn');
  // 等待结果: 要么错误提示, 要么仍在门 (两种都是拒绝)
  await page.waitForTimeout(6000);
  const errText = await page.textContent('#gateError').catch(() => '');
  const stillGate = await page.isVisible('#gate');
  const inDash = await page.isVisible('#dash');
  ok('登录被拒绝 (未进入工作台)', !inDash, `err=${errText}`);
  ok('错误提示或仍在门', errText.length > 0 || stillGate, `err=${errText}`);

  console.log('\n[3] isAdminEmail 白名单校验逻辑');
  const logic = await page.evaluate(() => {
    // 注入白名单 (含大小写/空格差异)
    window.ADMIN_CONFIG = { emails: ['admin@example.com', '  Boss@Example.COM  '] };
    // ADMIN_EMAILS 在页面加载时已初始化, 通过重新执行闭包内的判定函数验证
    // 由于 ADMIN_EMAILS 是 var 声明在脚本顶层, 可通过直接判定
    const fn = window.isAdminEmail;
    const results = {
      exact: fn ? fn('admin@example.com') : null,
      caseInsensitive: fn ? fn('ADMIN@EXAMPLE.COM') : null,
      trimSpace: fn ? fn('boss@example.com') : null,
      notInList: fn ? fn('other@example.com') : null,
      empty: fn ? fn('') : null
    };
    return results;
  });
  ok('白名单精确匹配', logic.exact === true, JSON.stringify(logic));
  ok('大小写不敏感', logic.caseInsensitive === true, JSON.stringify(logic));
  ok('白名单空格已 trim', logic.trimSpace === true, JSON.stringify(logic));
  ok('非白名单拒绝', logic.notInList === false, JSON.stringify(logic));
  ok('空邮箱拒绝', logic.empty === false, JSON.stringify(logic));

  console.log('\n[4] 白名单管理员登录成功分支 (mock SupabaseAuth.signIn)');
  await page.evaluate(() => {
    window.ADMIN_CONFIG = { emails: ['boss@example.com'] };
    window.SupabaseAuth.signIn = async (email, pass) => {
      return { data: { session: { user: { email: email, user_metadata: { name: '老板' } } } }, error: null };
    };
  });
  await page.fill('#adminUser', 'boss@example.com');
  await page.fill('#adminPass', 'whatever123');
  await page.click('#gateBtn');
  await page.waitForSelector('#dash.show', { timeout: 8000 });
  ok('白名单管理员进入工作台', await page.isVisible('#dash'));
  const dashUser = await page.textContent('#dashUser');
  ok('显示管理员名', dashUser.includes('老板'), dashUser);
  const sess = await page.evaluate(() => localStorage.getItem('kanseki_admin_session'));
  ok('会话含邮箱', sess && sess.includes('boss@example.com'), sess || '');

  console.log('\n[5] 非白名单登录被拒分支 (mock 返回普通用户)');
  await page.click('#logoutBtn');
  await page.waitForSelector('#gateForm');
  await page.evaluate(() => {
    window.SupabaseAuth.signIn = async (email, pass) => {
      return { data: { session: { user: { email: email, user_metadata: {} } } }, error: null };
    };
  });
  await page.fill('#adminUser', 'other@example.com');
  await page.fill('#adminPass', 'whatever123');
  await page.click('#gateBtn');
  await page.waitForTimeout(1500);
  ok('非白名单仍停留在门', await page.isVisible('#gate'));
  const err2 = await page.textContent('#gateError');
  ok('提示无管理员权限', err2.includes('无管理员权限'), err2);

  await browser.close();
  console.log(`\n==== Supabase 管理模式验证: ${passed} 通过, ${failed} 失败 ====`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
