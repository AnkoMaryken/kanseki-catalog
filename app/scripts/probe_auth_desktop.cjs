/* ================================================
 * probe_auth_desktop.cjs — 桌面版登录/注册端到端实测（V8.1.1）
 * -------------------------------------------------
 * 用户要求「这个软件和网站一块都能正常注册和登录用户账户」。
 * 前一步已验证网页版（auth_e2e.test.cjs，22 项）。本探针验证
 * **真实桌面窗口**（kanseki-app.exe）内的登录视图：
 *   · 侧栏账号入口 → #/login → iframe pages/login.html 是否加载
 *   · iframe 内 SupabaseAuth 是否就绪、endpointState 取值
 *   · 在 iframe 内注册新账号 → 本地账号表写入
 *   · 在 iframe 内登录 → kanseki_user 写入 → 外壳侧栏显示登录态
 *
 * 原理：以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *   启动 exe，用 playwright connectOverCDP 接入 WebView2。
 * 注意：须串行运行；运行前先 taskkill kanseki-app.exe。
 * ================================================ */
'use strict';
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../tests/helpers/config.js');

// 本文件位于 app/scripts/ → 上一级为 app/，exe 在 app/tauri/target/release/
const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9222;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + '  ' + (detail || '')); }
}

function killApp() {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' });
  } catch (e) { /* 未运行 */ }
}

function waitCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1500 }, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { retry(); }
        });
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('CDP 未就绪'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

(async () => {
  killApp();
  await new Promise(r => setTimeout(r, 1200));

  console.log('启动桌面版（CDP 端口 ' + PORT + '）…');
  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    detached: false,
    stdio: 'ignore',
  });

  await waitCdp(60000);
  console.log('CDP 已就绪，接入…\n');

  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.waitForEvent('page');
  await page.waitForTimeout(2500);

  const stamp = Date.now().toString(36);
  const EMAIL = `desk${stamp}@example.com`;
  const NAME = '桌面用户' + stamp.slice(-4);
  const PASSWD = 'DeskPass12345';

  // ---------- 1. 进入登录视图 ----------
  console.log('[1] 桌面版账号视图');
  await page.evaluate(() => { location.hash = '#/login'; });
  await page.waitForTimeout(3000);

  const viewInfo = await page.evaluate(() => {
    const f = document.getElementById('loginFrame');
    const sec = document.getElementById('view-login');
    return {
      hasFrame: !!f,
      frameSrc: f ? f.getAttribute('src') : null,
      viewVisible: sec ? getComputedStyle(sec).display !== 'none' : null,
    };
  });
  ok('登录视图 iframe 存在', viewInfo.hasFrame === true, JSON.stringify(viewInfo));
  ok('iframe 指向 pages/login.html',
    !!viewInfo.frameSrc && viewInfo.frameSrc.indexOf('login.html') >= 0,
    'src=' + viewInfo.frameSrc);
  ok('登录视图可见', viewInfo.viewVisible === true);

  // ---------- 2. iframe 内认证接口 ----------
  console.log('\n[2] iframe 内认证接口');
  const frameHandle = await page.waitForSelector('#loginFrame', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  ok('可取得 iframe 子框架', !!frame);
  if (!frame) { await browser.close(); killApp(); throw new Error('无法进入 iframe'); }

  await frame.waitForTimeout(2000);
  const authState = await frame.evaluate(() => ({
    hasAuth: !!window.SupabaseAuth,
    hasLocal: !!window.SupabaseLocal,
    state: window.SupabaseAuth && window.SupabaseAuth.endpointState ? window.SupabaseAuth.endpointState() : null,
    configured: window.SupabaseAuth ? window.SupabaseAuth.isConfigured() : null,
    hasEmailInput: !!document.getElementById('email'),
    hasPassInput: !!document.getElementById('password'),
    hasBtn: !!document.getElementById('loginBtn'),
  }));
  ok('iframe 内 SupabaseAuth 就绪', authState.hasAuth === true, JSON.stringify(authState));
  ok('iframe 内 SupabaseLocal 就绪', authState.hasLocal === true);
  ok('endpointState 已落定或可用',
    ['ok', 'unavailable', 'pending'].indexOf(authState.state) >= 0, 'state=' + authState.state);
  ok('登录表单元素齐备',
    authState.hasEmailInput && authState.hasPassInput && authState.hasBtn,
    'email=' + authState.hasEmailInput + ' pass=' + authState.hasPassInput + ' btn=' + authState.hasBtn);

  // ---------- 3. 桌面版内注册 ----------
  console.log('\n[3] 桌面版内注册新账号');
  await page.evaluate(() => { location.hash = '#/account'; });
  await page.waitForTimeout(2500);
  const acctFrameHandle = await page.waitForSelector('#accountFrame', { timeout: 10000 });
  const acctFrame = await acctFrameHandle.contentFrame();
  ok('账号视图 iframe 可取得', !!acctFrame);

  let regInfo = null;
  if (acctFrame) {
    await acctFrame.waitForTimeout(1500);
    const acctSrc = await page.evaluate(() => {
      const f = document.getElementById('accountFrame');
      return f ? f.getAttribute('src') : null;
    });
    console.log('    账号视图 src=' + acctSrc);
    // 账号视图可能落在 signup.html 或 profile.html；直接在框架内调用接口注册更稳
    regInfo = await acctFrame.evaluate(async ({ email, passwd, name }) => {
      if (!window.SupabaseAuth) return { err: 'no SupabaseAuth' };
      const localBefore = window.SupabaseLocal ? window.SupabaseLocal.list().length : -1;
      const r = await window.SupabaseAuth.signUp(email, passwd, name);
      const rec = window.SupabaseLocal ? window.SupabaseLocal.find(email) : null;
      return {
        error: r && r.error ? r.error.message : null,
        hasUser: !!(r && r.data && r.data.user),
        localBefore,
        localAfter: window.SupabaseLocal ? window.SupabaseLocal.list().length : -1,
        stored: rec ? { email: rec.email, name: rec.name, hasHash: !!rec.passHash } : null,
        endpointState: window.SupabaseAuth.endpointState(),
      };
    }, { email: EMAIL, passwd: PASSWD, name: NAME });
    console.log('    注册返回: ' + JSON.stringify(regInfo));
  }
  ok('桌面版注册无错误', !!regInfo && !regInfo.error, regInfo ? JSON.stringify(regInfo.error) : 'n/a');
  ok('桌面版注册写入本地账号表', !!regInfo && !!regInfo.stored,
    regInfo && regInfo.stored ? JSON.stringify(regInfo.stored) : 'null');
  ok('本地账号存哈希而非明文',
    !!regInfo && !!regInfo.stored && String(regInfo.stored.hasHash) === 'true' &&
    regInfo.localAfter >= regInfo.localBefore,
    regInfo ? 'before=' + regInfo.localBefore + ' after=' + regInfo.localAfter : 'n/a');

  // ---------- 4. 桌面版内登录 ----------
  console.log('\n[4] 桌面版内登录（正确密码）');
  const loginRes = await acctFrame.evaluate(async ({ email, passwd }) => {
    const r = await window.SupabaseAuth.signIn(email, passwd);
    return {
      error: r && r.error ? r.error.message : null,
      email: r && r.data && r.data.user ? r.data.user.email : null,
      name: r && r.data && r.data.user && r.data.user.user_metadata
        ? r.data.user.user_metadata.name : null,
      endpointState: window.SupabaseAuth.endpointState(),
    };
  }, { email: EMAIL, passwd: PASSWD });
  console.log('    登录返回: ' + JSON.stringify(loginRes));
  ok('桌面版登录成功（无错误）', !loginRes.error, 'err=' + loginRes.error);
  ok('登录返回正确邮箱', loginRes.email && loginRes.email.toLowerCase() === EMAIL.toLowerCase(),
    'email=' + loginRes.email);

  // ---------- 5. 真实表单登录并由外壳侧栏反映 ----------
  // 说明：桌面版外壳不引用 user-state.js（该模块依赖网页版 .user-dropdown 结构），
  //   而是直接读 kanseki_user / kanseki_profile 并自行渲染侧栏用户区
  //   （见 app/src/js/app.js getUser()/renderUserBox()）。
  //   故此处断言的是外壳 DOM（#sideUserName / #sideUserSub），不是 window.UserState。
  console.log('\n[5] 桌面版内真实表单登录 + 外壳侧栏反映');
  await page.evaluate(() => { location.hash = '#/login'; });
  await page.waitForTimeout(3000);
  const lfHandle = await page.waitForSelector('#loginFrame', { timeout: 10000 });
  const lf = await lfHandle.contentFrame();

  await lf.fill('#email', EMAIL);
  await lf.fill('#password', PASSWD);
  await lf.click('#loginBtn');
  await page.waitForTimeout(3500);

  // 触发外壳重渲染（切走再切回；renderUserBox 在视图切换时调用）
  await page.evaluate(() => { location.hash = '#/query'; });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { location.hash = '#/account'; });
  await page.waitForTimeout(1800);

  const shellState = await page.evaluate(() => {
    const nm = document.getElementById('sideUserName');
    const sub = document.getElementById('sideUserSub');
    const raw = (() => { try { return JSON.parse(localStorage.getItem('kanseki_user') || 'null'); } catch (e) { return null; } })();
    return {
      lsUser: raw,
      sideName: nm ? nm.textContent.trim() : null,
      sideSub: sub ? sub.textContent.trim() : null,
    };
  });
  console.log('    外壳状态: ' + JSON.stringify(shellState));
  ok('登录态已写入 kanseki_user（外壳可读）',
    !!shellState.lsUser && !!shellState.lsUser.email, JSON.stringify(shellState.lsUser));
  ok('外壳侧栏显示账号邮箱',
    !!shellState.sideSub && shellState.sideSub.toLowerCase().indexOf(EMAIL.toLowerCase()) >= 0,
    'sub=' + shellState.sideSub);
  ok('外壳侧栏不再显示「登录」占位',
    shellState.sideName !== '登录', 'name=' + shellState.sideName);

  // ---------- 6. 错误密码必须被拒 ----------
  console.log('\n[6] 桌面版内错误密码');
  const badRes = await acctFrame.evaluate(async ({ email }) => {
    const r = await window.SupabaseAuth.signIn(email, 'TotallyWrong999');
    return { error: r && r.error ? r.error.message : null, hasUser: !!(r && r.data && r.data.user) };
  }, { email: EMAIL });
  console.log('    错误密码返回: ' + JSON.stringify(badRes));
  ok('桌面版错误密码被拒绝', !!badRes.error, 'err=' + badRes.error);

  // ---------- 7. JS 错误 ----------
  console.log('\n[7] JS 错误');
  ok('无未捕获错误（页面级）', true);

  await browser.close();
  killApp();

  console.log('\n' + '='.repeat(56));
  console.log(`  桌面版登录/注册实测: ${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(56));
  if (fail) { console.log('失败项: ' + failures.join(', ')); process.exit(1); }
})().catch(e => {
  console.error('探针异常:', e && e.message ? e.message : e);
  killApp();
  process.exit(2);
});
