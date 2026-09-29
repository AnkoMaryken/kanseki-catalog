/* ================================================
 * probe_v082.cjs — 桌面版 V0.8.2 三项修复实测
 * -------------------------------------------------
 * 对应本轮用户反馈：
 *   1a. 最大化按钮图标重复（两个图标堆叠）→ 现应只可见 1 个
 *   1b. 左上角「窗口」按钮旁新增一键简繁切换按钮 → 应存在且能切字形
 *   2.  登录后点「账号」应进个人中心 → 路由随登录态变化
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

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9223;

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
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); }
  catch (e) { /* 未运行 */ }
}

function waitCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1500 }, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { retry(); } });
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

  await waitCdp(30000);
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.waitForTimeout(2500);

  // ---------- 等待外壳就绪（V0.8.2） ----------
  // ⚠️ 本探针历史上的间歇失败（约 1/3 概率）根因就在这里：
  //    标题栏三键的 click 监听由 js/app.js 在 init() 里绑定，而 app.js 是
  //    ES 模块，须等模块图拉取完才执行 —— 实测（app/scripts/diag_boot.cjs）
  //    页面时间线：+404ms DOM 就绪（按钮已可见）→ +3007ms 监听才出现，
  //    中间这段「看得见但点不动」的空窗长达约 3s（主因是内嵌查询页的
  //    大量同步脚本占用主线程）。而本探针恰好在 +2.5s 介入点击，
  //    于是约三分之一的轮次点在了空窗里：事件送达按钮却无人处理，
  //    表现为「图标从未变化、窗口尺寸也不变」。
  //    更早的排查曾把这误判为「命令被静默丢弃」「图标被改回去」，皆非真因。
  //    现在 app.js 在 init() 末尾会置 __kansekiAppReady = true，此处必须等它。
  await page.waitForFunction(() => window.__kansekiAppReady === true, null, { timeout: 20000 })
    .catch(() => console.log('    ⚠️ 等待就绪标记超时（将继续，但结果可能不稳定）'));

  // 顺带断言：正式监听确实已挂上（这才是「可交互」的硬证据）
  const readyInfo = await page.evaluate(() => ({
    ready: window.__kansekiAppReady === true,
    // 早期接管器若仍在监听，说明 app.js 的 detach 没跑到
    earlyPending: (window.__kansekiEarlyClicks && window.__kansekiEarlyClicks.pending)
      ? window.__kansekiEarlyClicks.pending() : null,
  }));
  console.log('    就绪标记: ' + readyInfo.ready + '  早期暂存残留: ' + JSON.stringify(readyInfo.earlyPending));
  ok('外壳已就绪（__kansekiAppReady，标题栏已可交互）', readyInfo.ready === true,
    'ready=' + readyInfo.ready);
  ok('早期点击暂存器已卸下且无残留（无双重处理）',
    readyInfo.earlyPending !== null && readyInfo.earlyPending.length === 0,
    JSON.stringify(readyInfo.earlyPending));

  // ---------- 1a. 最大化按钮图标只可见一个 ----------
  console.log('\n[1a] 最大化按钮图标（此前两个图标堆叠）');
  const maxIcons = await page.evaluate(() => {
    const btn = document.getElementById('tbMax');
    if (!btn) return null;
    const svgs = [...btn.querySelectorAll('svg')];
    return {
      total: svgs.length,
      visible: svgs.filter(s => {
        const cs = getComputedStyle(s);
        const r = s.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).map(s => s.getAttribute('class')),
      // 两个图标是否重叠在同一位置（堆叠的直接证据）
      rects: svgs.map(s => {
        const r = s.getBoundingClientRect();
        return { cls: s.getAttribute('class'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
      }),
    };
  });
  console.log('    图标情况: ' + JSON.stringify(maxIcons));
  ok('最大化按钮存在', !!maxIcons);
  ok('按钮内共 2 个 SVG（最大化+还原）', !!maxIcons && maxIcons.total === 2,
    maxIcons ? 'total=' + maxIcons.total : '');
  ok('同时可见的图标仅 1 个（修复图标堆叠）',
    !!maxIcons && maxIcons.visible.length === 1,
    maxIcons ? 'visible=' + JSON.stringify(maxIcons.visible) : '');
  ok('可见的是「最大化」图标（未最大化时）',
    !!maxIcons && maxIcons.visible[0] === 'tb-ico-max',
    maxIcons ? String(maxIcons.visible[0]) : '');

  // 点击最大化后应切换为「还原」图标（仍只 1 个可见）
  //
  // ⚠️ 不能用「点击 + 固定等待 + 一次性读取」：Windows 最大化有动画，
  //    且状态同步链（下发命令 → 回读确认）本身是异步的，
  //    固定等待在不同机器/负载下会踩到中间态（历史失败项的成因）。
  //
  // ⚠️⚠️ 更关键：本项历史失败并非「点击无效」，而是**图标被改回**。
  //    曾观测到序列：+121ms 变「还原」→ +195ms 又被改回「最大化」，
  //    而窗口尺寸已是 1440×912（窗口确实最大化了，只是图标错了）。
  //    成因是窗口动画期间尺寸变化事件读到旧值后覆盖了界面。
  //    因此这里必须**等到动画与同步都结束**（约 2.5s）再判定，
  //    过早读取反而会「读对了又错、读错了又对」，结果随机。
  //
  // 打开页面内的图标改写追踪，便于失败时直接从断言输出里看到调用栈线索
  await page.evaluate(() => {
    window.__KANSEKI_MAX_TRACE = true;
    window.__kansekiMaxTrace = [];
  });
  await page.evaluate(() => document.getElementById('tbMax')?.click());
  const readMax = () => page.evaluate(() => {
    const btn = document.getElementById('tbMax');
    const svgs = [...btn.querySelectorAll('svg')];
    return {
      visible: svgs.filter(s => {
        const cs = getComputedStyle(s);
        const r = s.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      }).map(s => s.getAttribute('class')),
      title: btn.getAttribute('title'),
      inner: window.innerWidth + 'x' + window.innerHeight,
    };
  });

  // 先轮询等到「还原」（最多 6s），再静置到动画与同步彻底结束
  let afterMax = null;
  const maxDeadline = Date.now() + 6000;
  while (Date.now() < maxDeadline) {
    afterMax = await readMax();
    if (afterMax.visible[0] === 'tb-ico-restore') break;
    await page.waitForTimeout(200);
  }
  // 静置 2.5s：覆盖动画（约 0.5s）+ 状态同步保护期（1.8s），
  // 之后任何回写都应已停止 —— 此刻的读数才是用户最终看到的界面
  await page.waitForTimeout(2500);
  const settled = await readMax();
  const trace = await page.evaluate(() => window.__kansekiMaxTrace || []);
  console.log('    最大化后: ' + JSON.stringify(afterMax) + ' → 静置后: ' + JSON.stringify(settled));
  if (trace.length) {
    console.log('    图标改写轨迹（时刻/状态）：');
    trace.forEach(x => console.log(`      +${x.t}ms → ${x.max ? '最大化' : '未最大化'}`));
  }
  afterMax = settled;
  ok('最大化后仍只 1 个图标可见', afterMax.visible.length === 1,
    JSON.stringify(afterMax.visible));
  ok('最大化后显示「还原」图标', afterMax.visible[0] === 'tb-ico-restore',
    String(afterMax.visible[0]) + ' inner=' + afterMax.inner);
  // 窗口尺寸须真的变大（区分「图标变了但窗口没变」）
  ok('最大化后窗口尺寸确实变大', afterMax.inner !== '1280x800', afterMax.inner);
  // 还原窗口，避免影响后续
  await page.evaluate(() => document.getElementById('tbMax')?.click());
  await page.waitForTimeout(1200);

  // ---------- 1b. 一键简繁切换按钮 ----------
  console.log('\n[1b] 标题栏一键简繁切换按钮');
  const btnInfo = await page.evaluate(() => {
    const b = document.getElementById('langToggleBtn');
    if (!b) return null;
    const win = document.getElementById('winBtn');
    const rb = b.getBoundingClientRect();
    const wr = win ? win.getBoundingClientRect() : null;
    return {
      exists: true,
      text: (document.getElementById('langToggleTx') || {}).textContent,
      title: b.getAttribute('title'),
      visible: getComputedStyle(b).display !== 'none' && rb.width > 0,
      // 位置：应紧邻「窗口」按钮右侧（同属 .tb-left）
      inTbLeft: !!b.closest('.tb-left'),
      byWinBtn: !!wr && rb.left >= wr.right - 2,
      sameRow: !!wr && Math.abs(rb.top - wr.top) < 12,
    };
  });
  console.log('    按钮情况: ' + JSON.stringify(btnInfo));
  ok('繁简切换按钮存在', !!(btnInfo && btnInfo.exists));
  ok('按钮位于左上角 .tb-left 内', !!(btnInfo && btnInfo.inTbLeft));
  ok('按钮紧邻「窗口」按钮右侧', !!(btnInfo && btnInfo.byWinBtn), btnInfo ? 'byWinBtn=' + btnInfo.byWinBtn : '');
  ok('与「窗口」按钮同一行', !!(btnInfo && btnInfo.sameRow));
  ok('按钮可见', !!(btnInfo && btnInfo.visible));

  // 实测切换：读取查询页 iframe 内的字形，点击后应变化
  const langFlow = await page.evaluate(async () => {
    const readFrame = () => {
      const f = document.getElementById('queryFrame');
      try {
        const api = f && f.contentWindow && f.contentWindow.KansekiLang;
        return api ? api.get() : null;
      } catch (e) { return null; }
    };
    const before = readFrame();
    document.getElementById('langToggleBtn').click();
    await new Promise(r => setTimeout(r, 1200));
    const after = readFrame();
    const btnTx = (document.getElementById('langToggleTx') || {}).textContent;
    const ls = localStorage.getItem('kanseki_lang');
    // 再点一次应回退
    document.getElementById('langToggleBtn').click();
    await new Promise(r => setTimeout(r, 1200));
    const back = readFrame();
    return { before, after, back, btnTx, ls };
  });
  console.log('    切换流程: ' + JSON.stringify(langFlow));
  ok('查询页字形接口可用（拿到切换前状态）',
    langFlow.before === 's' || langFlow.before === 't', String(langFlow.before));
  ok('点击后字形确实切换', langFlow.after !== langFlow.before,
    langFlow.before + ' -> ' + langFlow.after);
  ok('再点一次切回原字形', langFlow.back === langFlow.before,
    langFlow.after + ' -> ' + langFlow.back);
  ok('按钮文字随状态更新（简/繁）',
    langFlow.btnTx === '简' || langFlow.btnTx === '繁', String(langFlow.btnTx));

  // 页面表头应真的变更（不只看状态变量）
  const headCheck = await page.evaluate(async () => {
    const f = document.getElementById('queryFrame');
    const fdoc = f && f.contentDocument;
    if (!fdoc) return null;
    const heads = () => [...fdoc.querySelectorAll('#tableHead th')].map(t => t.textContent.trim()).join('|');
    const h0 = heads();
    document.getElementById('langToggleBtn').click();
    await new Promise(r => setTimeout(r, 1300));
    const h1 = heads();
    return { h0: h0.slice(0, 60), h1: h1.slice(0, 60), changed: h0 !== h1 };
  });
  console.log('    表头变化: ' + JSON.stringify(headCheck));
  ok('表头文字随按钮实际变化', !!(headCheck && headCheck.changed),
    headCheck ? headCheck.h0 + ' => ' + headCheck.h1 : '未取到');

  // ---------- 2. 账号路由随登录态 ----------
  console.log('\n[2] 「账号」项随登录态路由');
  const guestNav = await page.evaluate(() => {
    localStorage.removeItem('kanseki_user');
    return true;
  });
  void guestNav;
  await page.evaluate(() => { location.hash = '#/query'; });
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForTimeout(2200);
  const navGuest = await page.evaluate(() => {
    const a = document.getElementById('navAccount');
    return a ? { view: a.dataset.view, href: a.getAttribute('href') } : null;
  });
  console.log('    未登录: ' + JSON.stringify(navGuest));
  ok('未登录时「账号」→ login', !!(navGuest && navGuest.view === 'login'),
    JSON.stringify(navGuest));

  // 模拟登录（写 kanseki_user）后，「账号」应指向 account
  await page.evaluate(() => {
    localStorage.setItem('kanseki_user', JSON.stringify({
      email: 'probe@example.com', name: '探针用户', id: 'u-probe'
    }));
  });
  await page.reload();
  await page.waitForTimeout(2200);
  const navLogged = await page.evaluate(() => {
    const a = document.getElementById('navAccount');
    return a ? { view: a.dataset.view, href: a.getAttribute('href') } : null;
  });
  console.log('    已登录: ' + JSON.stringify(navLogged));
  ok('已登录时「账号」→ account', !!(navLogged && navLogged.view === 'account'),
    JSON.stringify(navLogged));
  ok('已登录时 href 为 #/account', !!(navLogged && navLogged.href === '#/account'),
    navLogged ? String(navLogged.href) : '');

  // 点击应真的进入个人中心视图
  await page.evaluate(() => document.getElementById('navAccount')?.click());
  await page.waitForTimeout(2200);
  const viewState = await page.evaluate(() => ({
    accountActive: !!document.querySelector('#view-account.active'),
    loginActive: !!document.querySelector('#view-login.active'),
    hash: location.hash,
  }));
  console.log('    点击后视图: ' + JSON.stringify(viewState));
  ok('点击「账号」进入个人中心视图', viewState.accountActive === true,
    JSON.stringify(viewState));
  ok('未停留在登录视图', viewState.loginActive === false, JSON.stringify(viewState));
  // 个人中心 iframe 应真的加载（未被登录门禁弹回登录页）
  await page.waitForTimeout(1500);
  const accFrameUrl = await page.evaluate(() => {
    const f = document.getElementById('accountFrame');
    try { return f.contentWindow.location.href; } catch (e) { return null; }
  });
  console.log('    个人中心 iframe URL: ' + accFrameUrl);
  ok('个人中心 iframe 停在 profile.html（未被弹回登录页）',
    !!accFrameUrl && /pages\/profile\.html/.test(accFrameUrl), String(accFrameUrl));

  // ---------- 3. 退出登录后回到登录页路由 ----------
  console.log('\n[3] 退出登录后路由回落');
  await page.evaluate(() => {
    document.getElementById('sideUserBtn')?.click();
    document.getElementById('sideLogoutBtn')?.click();
  });
  await page.waitForTimeout(1500);
  const afterLogout = await page.evaluate(() => {
    const a = document.getElementById('navAccount');
    return {
      view: a && a.dataset.view,
      hash: location.hash,
      loginActive: !!document.querySelector('#view-login.active'),
    };
  });
  console.log('    退出后: ' + JSON.stringify(afterLogout));
  ok('退出后「账号」回到 login 路由', afterLogout.view === 'login', JSON.stringify(afterLogout));
  ok('退出后离开个人中心（回登录页）', afterLogout.loginActive === true,
    JSON.stringify(afterLogout));

  // ---------- 4. 真实表单登录 → 自动进个人中心 ----------
  // 关键路径：登录页在 iframe 内，登录成功后应通知外壳切到个人中心，
  // 而不是让 iframe 自己跳去首页（那会在框架里塞进一整份首页）。
  console.log('\n[4] 真实表单登录 → 自动进入个人中心');
  const EMAIL = 'probe-v082@example.com';
  const PASSWD = 'Probe082Pass!';
  await page.evaluate(() => { location.hash = '#/login'; });
  await page.waitForTimeout(2500);
  const lfHandle = await page.waitForSelector('#loginFrame', { timeout: 10000 });
  const lf = await lfHandle.contentFrame();

  // 先在该 iframe 内注册（本地账号模式），确保有可用账号
  const regRes = await lf.evaluate(async ({ email, passwd }) => {
    if (!window.SupabaseAuth) return { error: 'SupabaseAuth 未就绪' };
    const r = await window.SupabaseAuth.signUp(email, passwd, '探针V082');
    return { error: r && r.error ? r.error.message : null };
  }, { email: EMAIL, passwd: PASSWD });
  console.log('    注册返回: ' + JSON.stringify(regRes));

  await lf.fill('#email', EMAIL);
  await lf.fill('#password', PASSWD);
  await lf.click('#loginBtn');
  await page.waitForTimeout(4500);

  const afterLogin = await page.evaluate(() => {
    const f = document.getElementById('loginFrame');
    let frameUrl = null;
    try { frameUrl = f && f.contentWindow && f.contentWindow.location.href; } catch (e) { /* 忽略 */ }
    return {
      hash: location.hash,
      accountActive: !!document.querySelector('#view-account.active'),
      loginActive: !!document.querySelector('#view-login.active'),
      loginFrameUrl: frameUrl,
      sideName: (document.getElementById('sideUserName') || {}).textContent,
      navView: (document.getElementById('navAccount') || {}).dataset?.view,
      hasUser: !!localStorage.getItem('kanseki_user'),
    };
  });
  console.log('    登录后外壳: ' + JSON.stringify(afterLogin));
  ok('登录态已写入', afterLogin.hasUser === true, JSON.stringify(afterLogin.hasUser));
  ok('登录后自动切到个人中心视图', afterLogin.accountActive === true,
    JSON.stringify(afterLogin));
  ok('登录页 iframe 未被跳去首页', !afterLogin.loginFrameUrl ||
    /pages\/login\.html/.test(afterLogin.loginFrameUrl),
    String(afterLogin.loginFrameUrl));
  ok('侧栏显示已登录（非「登录」占位）', afterLogin.sideName !== '登录', String(afterLogin.sideName));
  ok('「账号」项已指向 account', afterLogin.navView === 'account', String(afterLogin.navView));

  // 再点一次「账号」应仍在个人中心（而非回到登录页）
  await page.evaluate(() => document.getElementById('navAccount')?.click());
  await page.waitForTimeout(2000);
  const reClick = await page.evaluate(() => ({
    accountActive: !!document.querySelector('#view-account.active'),
    hash: location.hash,
  }));
  console.log('    再点「账号」: ' + JSON.stringify(reClick));
  ok('登录后再点「账号」仍在个人中心', reClick.accountActive === true, JSON.stringify(reClick));

  // ---------- 5. 启动早期点击不再丢失（V0.8.2） ----------
  // 这项验证的是「真实用户在启动前几秒点标题栏」这一场景：
  // DOM 已可见但 app.js 尚未执行（实测空窗约 3s），此时点击必须被接住、
  // 待外壳就绪后补发，最终效果与稍后点击一致。
  // 手法：重建文档（reload）→ 在 DOM 就绪后的极早时刻点一次最大化 →
  // 等就绪补发 → 断言最终进到最大化态。
  console.log('\n[5] 启动早期点击标题栏（此前约 3s 空窗内点了没反应）');
  await page.evaluate(() => { location.hash = '#/query'; }).catch(() => { /* 忽略 */ });
  await page.waitForTimeout(400);
  // ⚠️ 必须用 waitUntil:'commit'（文档一提交就返回）。默认的 'load' 要等到
  //    load 事件（实测 +2910ms），那时 init() 都快跑完了，本项就退化成
  //    「普通点击」，测不出空窗问题。
  await page.reload({ waitUntil: 'commit' });
  // 等到早期暂存器与按钮都出现（解析阶段就绪，远早于 app.js 执行）
  await page.waitForFunction(
    () => !!window.__kansekiEarlyClicks && !!document.getElementById('tbMax'),
    null, { timeout: 15000 });

  // 此刻立即点击——外壳（app.js）通常还没跑
  const earlyClick = await page.evaluate(() => {
    const alreadyReady = window.__kansekiAppReady === true;
    const tClick = Math.round(performance.now());
    document.getElementById('tbMax').click();
    return {
      hasEarly: !!window.__kansekiEarlyClicks,
      // 关键：点击时外壳尚未就绪 = 确实落在空窗内（否则本项退化为普通点击）
      clickedInWindow: !alreadyReady,
      tClick: tClick,
    };
  });
  console.log('    早期点击: ' + JSON.stringify(earlyClick));
  ok('点击时处于「DOM 已就绪但外壳未就绪」的空窗内（测试前提成立）',
    earlyClick.hasEarly === true && earlyClick.clickedInWindow === true,
    JSON.stringify(earlyClick));

  // 等外壳就绪并完成补发
  await page.waitForFunction(() => window.__kansekiAppReady === true, null, { timeout: 20000 })
    .catch(() => console.log('    ⚠️ 就绪标记超时'));
  await page.waitForTimeout(3500);   // 覆盖最大化动画（约 0.5s）+ 同步保护期（1.8s）

  const earlyResult = await page.evaluate(() => {
    const btn = document.getElementById('tbMax');
    const svgs = [...btn.querySelectorAll('svg')].filter(s => {
      const cs = getComputedStyle(s);
      const r = s.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0;
    }).map(s => s.getAttribute('class'));
    return {
      visible: svgs,
      inner: window.innerWidth + 'x' + window.innerHeight,
      // 暂存器应已卸下且清空（否则说明补发/解绑逻辑有问题）
      pending: (window.__kansekiEarlyClicks && window.__kansekiEarlyClicks.pending)
        ? window.__kansekiEarlyClicks.pending() : null,
      earlyLog: (window.__kansekiEarlyClicks && window.__kansekiEarlyClicks.log)
        ? window.__kansekiEarlyClicks.log() : null,
    };
  });
  console.log('    补发结果: ' + JSON.stringify(earlyResult));
  ok('启动早期的那次点击被补发且生效（窗口已最大化）',
    earlyResult.visible[0] === 'tb-ico-restore' && earlyResult.inner !== '1280x800',
    JSON.stringify({ visible: earlyResult.visible, inner: earlyResult.inner }));
  ok('补发后暂存器无残留（不会重复触发）',
    Array.isArray(earlyResult.pending) && earlyResult.pending.length === 0,
    JSON.stringify(earlyResult.pending));

  // 收尾：还原窗口，避免影响后续
  await page.evaluate(() => document.getElementById('tbMax')?.click());
  await page.waitForTimeout(1500);

  // 收尾：退登，避免残留影响
  await page.evaluate(() => { localStorage.removeItem('kanseki_user'); });

  await browser.close();
  killApp();
  console.log('\n' + '='.repeat(56));
  console.log(`  桌面版 V0.8.2 三项修复实测: ${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(56));
  if (fail) { console.log('失败项: ' + failures.join(', ')); process.exit(1); }
  setTimeout(() => process.exit(0), 300).unref();
})().catch(e => {
  console.error('探针异常: ' + (e && e.stack || e));
  killApp();
  process.exit(1);
});
