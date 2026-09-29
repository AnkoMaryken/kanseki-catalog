/* ================================================
 * auth_e2e.test.cjs — 登录/注册端到端测试（V8.1.1）
 * -------------------------------------------------
 * 背景：用户反馈「登录和注册功能都用不了」。
 *   根因：项目填写的 Supabase 端点 ndogqsjmkoeecoekmhod.supabase.co
 *         经 DoH 查询为 NXDOMAIN（子域不存在），而 isPlaceholder() 判据
 *         过窄使它仍被判为「已配置」→ 走真实模式 → 每次 signUp/signIn
 *         都在 fetch 阶段抛 TypeError: Failed to fetch。
 *   修复：supabase-config.js 启动时探测 /auth/v1/health，
 *         不可用则整体退回「本地账号模式」，注册/登录照常可用。
 *
 * 本测试覆盖：
 *   A. 配置层：endpointState 取值、isConfigured 与之一致、本地账号表接口
 *   B. 注册页：填表提交 → 成功提示 → 本地账号表写入
 *   C. 登录页：用刚注册的账号登录 → 写入 kanseki_user → 跳转 index.html
 *   D. 首页：登录态在侧栏/表头生效
 *   E. 错误路径：错误密码应给出提示而非静默成功
 * ================================================ */
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const config = require('../../../tests/helpers/config.js');

const BASE = process.env.KANSEKI_BASE || `http://localhost:${config.PORT}`;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + '  ' + (detail || '')); }
}
function section(t) { console.log('\n' + t); }

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.launch(config.launchOptions);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  // 唯一邮箱，避免与历史数据冲突
  const stamp = Date.now().toString(36);
  const EMAIL = `t${stamp}@example.com`;
  const NAME = '测试用户' + stamp.slice(-4);
  const PASSWD = 'TestPass12345';

  // ============ A. 配置层 ============
  section('A. 配置层状态');
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const cfg = await page.evaluate(() => ({
    hasAuth: !!window.SupabaseAuth,
    hasLocal: !!window.SupabaseLocal,
    state: window.SupabaseAuth && window.SupabaseAuth.endpointState
      ? window.SupabaseAuth.endpointState() : null,
    configured: window.SupabaseAuth ? window.SupabaseAuth.isConfigured() : null,
  }));
  ok('SupabaseAuth 接口存在', cfg.hasAuth === true, JSON.stringify(cfg));
  ok('SupabaseLocal 接口存在', cfg.hasLocal === true);
  ok('endpointState 为三态之一', ['pending', 'ok', 'unavailable'].indexOf(cfg.state) >= 0, 'state=' + cfg.state);
  ok('isConfigured 与 endpointState 一致',
    cfg.configured === (cfg.state === 'ok'),
    `configured=${cfg.configured} state=${cfg.state}`);

  // 等待探测落定（最长 6s）
  let finalState = cfg.state;
  for (let i = 0; i < 12 && finalState === 'pending'; i++) {
    await page.waitForTimeout(600);
    finalState = await page.evaluate(() => window.SupabaseAuth.endpointState());
  }
  ok('端点探测已落定（非 pending）', finalState !== 'pending', 'state=' + finalState);
  if (finalState === 'unavailable') {
    console.log('    \u2139 端点不可用 → 已按预期退回本地账号模式（这正是本次修复的目标路径）');
  } else if (finalState === 'ok') {
    console.log('    \u2139 端点可用 → 走真实 Supabase 模式');
  }

  // 本地账号表可读写
  const localApi = await page.evaluate(async () => {
    const before = window.SupabaseLocal.list().length;
    await window.SupabaseLocal.upsert('probe-only@example.com', 'probe', 'probe');
    const after = window.SupabaseLocal.list().length;
    const found = !!window.SupabaseLocal.find('probe-only@example.com');
    return { before, after, found };
  });
  ok('本地账号表可写入并查回', localApi.found && localApi.after >= localApi.before, JSON.stringify(localApi));

  // ============ B. 注册 ============
  section('B. 注册页');
  await page.goto(BASE + '/signup.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  await page.fill('#name', NAME);
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWD);
  await page.fill('#confirmPassword', PASSWD);
  await page.click('#signupBtn');

  // 等待跳转或成功提示
  let regOutcome = null;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => {
      const eb = document.getElementById('formError');
      return { url: location.pathname, err: eb && eb.classList.contains('show') ? eb.textContent : '' };
    });
    if (st.url.indexOf('login.html') >= 0) { regOutcome = { kind: 'redirect', ...st }; break; }
    if (st.err) { regOutcome = { kind: 'msg', ...st }; break; }
  }
  ok('注册提交后未出现「注册失败」',
    !!regOutcome && String(regOutcome.err).indexOf('注册失败') < 0,
    JSON.stringify(regOutcome));
  ok('注册有明确结果（跳转或提示）', !!regOutcome,
    regOutcome ? regOutcome.kind + ' / ' + (regOutcome.err || regOutcome.url) : '无响应');

  // 本地账号表应已含该账号
  const regRec = await page.evaluate((e) => {
    const r = window.SupabaseLocal ? window.SupabaseLocal.find(e) : null;
    return r ? { email: r.email, name: r.name, hasHash: !!r.passHash } : null;
  }, EMAIL);
  ok('账号已写入本地账号表', !!regRec, JSON.stringify(regRec));
  ok('本地账号存的是哈希而非明文密码',
    !!regRec && regRec.hasHash && String(regRec.passHash) !== PASSWD,
    regRec ? 'len=' + String(regRec.passHash).length : 'n/a');

  // ============ C. 登录 ============
  section('C. 登录页');
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // C1: 正确密码
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWD);
  await page.click('#loginBtn');
  let loginOk = false, loginErr = '';
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => ({
      url: location.pathname,
      err: (document.getElementById('formError') || {}).textContent || '',
      errShown: !!(document.getElementById('formError') || {}).classList,
      user: localStorage.getItem('kanseki_user'),
    }));
    if (st.url.indexOf('index.html') >= 0) { loginOk = true; break; }
    const eb = await page.evaluate(() => {
      const e = document.getElementById('formError');
      return e && e.classList.contains('show') ? e.textContent : '';
    });
    if (eb) { loginErr = eb; break; }
  }
  ok('正确密码可登录并跳转首页', loginOk, loginOk ? '' : ('err=' + loginErr));

  const storedUser = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('kanseki_user') || 'null'); } catch (e) { return null; }
  });
  ok('登录态已写入 kanseki_user', !!storedUser && !!storedUser.email, JSON.stringify(storedUser));
  ok('登录态邮箱与注册邮箱一致',
    !!storedUser && String(storedUser.email).toLowerCase() === EMAIL.toLowerCase(),
    storedUser ? storedUser.email : 'null');

  // ============ D. 首页登录态生效 ============
  section('D. 首页登录态');
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const homeState = await page.evaluate(() => {
    const U = window.UserState;
    const menu = document.getElementById('userMenu');
    const txt = menu ? menu.textContent.replace(/\s+/g, ' ').trim() : '';
    return {
      loggedIn: U && U.isLoggedIn ? U.isLoggedIn() : null,
      user: U && U.getUser ? (U.getUser() || {}).email : null,
      menuText: txt,
    };
  });
  ok('UserState 报告已登录', homeState.loggedIn === true, JSON.stringify(homeState));
  ok('首页用户菜单显示账号相关项（非「登录/注册」）',
    homeState.menuText.indexOf('登录') < 0 || homeState.menuText.indexOf('退出') >= 0,
    'menu=' + homeState.menuText);

  // ============ E. 错误路径 ============
  section('E. 错误路径（错误密码）');
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.fill('#email', EMAIL);
  await page.fill('#password', 'WrongPass99999');
  await page.click('#loginBtn');
  let badErr = '', badUrl = '';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    // 用 try 包裹：成功登录会触发导航，evaluate 上下文随之销毁
    let st = null;
    try {
      st = await page.evaluate(() => {
        const e = document.getElementById('formError');
        return { shown: !!(e && e.classList.contains('show')), txt: (e && e.textContent) || '', url: location.pathname };
      });
    } catch (navErr) {
      badUrl = 'navigated';
      break;
    }
    badUrl = st.url;
    if (st.shown && st.txt) { badErr = st.txt; break; }
    if (st.url.indexOf('index.html') >= 0) break;
  }
  const badReachedHome = badUrl.indexOf('index.html') >= 0 || badUrl === 'navigated';
  // 关键安全断言：错误密码绝不能登录成功
  ok('错误密码被拒绝（未登录成功）', !badReachedHome,
    'url=' + badUrl + ' err=' + badErr);
  ok('错误密码给出明确提示', !!badErr, 'err=' + badErr);
  if (badErr) {
    console.log('    \u2139 提示文案: ' + badErr);
  }

  // E2: 未注册邮箱应被拒绝并引导注册
  const UNREG = `nobody${stamp}@example.com`;
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.fill('#email', UNREG);
  await page.fill('#password', PASSWD);
  await page.click('#loginBtn');
  let unregErr = '', unregUrl = '';
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    let st = null;
    try {
      st = await page.evaluate(() => {
        const e = document.getElementById('formError');
        return { shown: !!(e && e.classList.contains('show')), txt: (e && e.textContent) || '', url: location.pathname };
      });
    } catch (e) { unregUrl = 'navigated'; break; }
    unregUrl = st.url;
    if (st.shown && st.txt) { unregErr = st.txt; break; }
    if (st.url.indexOf('index.html') >= 0) break;
  }
  const unregReachedHome = unregUrl.indexOf('index.html') >= 0 || unregUrl === 'navigated';
  ok('未注册邮箱被拒绝（未登录成功）', !unregReachedHome, 'url=' + unregUrl + ' err=' + unregErr);
  if (finalState === 'unavailable') {
    ok('未注册邮箱给出「尚未注册」类提示', /尚未注册/.test(unregErr), 'err=' + unregErr);
  } else {
    ok('未注册邮箱给出错误提示', !!unregErr, 'err=' + unregErr);
  }

  // ============ F. 注册成功回跳提示 ============
  section('F. 注册成功后回跳登录页提示');
  await page.goto(BASE + '/login.html?registered=1&email=' + encodeURIComponent(EMAIL),
    { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const backMsg = await page.evaluate(() => {
    const e = document.getElementById('formError');
    return {
      shown: !!(e && e.classList.contains('show')),
      txt: (e && e.textContent) || '',
      email: (document.getElementById('email') || {}).value || '',
    };
  });
  ok('回跳后显示注册成功提示', backMsg.shown && backMsg.txt.indexOf('注册成功') >= 0,
    JSON.stringify(backMsg));
  ok('邮箱已自动回填', backMsg.email.toLowerCase() === EMAIL.toLowerCase(), 'email=' + backMsg.email);

  // ============ G. 无 JS 错误 ============
  section('F. 页面 JS 错误');
  const realErrors = pageErrors.filter(e => !/favicon|ResizeObserver/i.test(e));
  ok('无未捕获 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await browser.close();

  console.log('\n' + '='.repeat(56));
  console.log(`  登录/注册端到端: ${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(56));
  if (fail) { console.log('失败项: ' + failures.join(', ')); process.exit(1); }
})().catch(e => { console.error('测试运行异常:', e); process.exit(2); });
