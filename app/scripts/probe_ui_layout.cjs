// ================================================
// app/scripts/probe_ui_layout.cjs — 诊断「UI 重复」
// -------------------------------------------------
// 用户反馈：窗口最大化无法使用，且「UI 也重复」。窗口命令失效已定位为
// 命令名大小写问题（见 probe_window.cjs）；本脚本专门取证 UI 是否重复：
//   · 外壳自身元素计数（标题栏 / 三键 / 侧栏品牌 / 窗口菜单）
//   · 各视图 iframe 内部仍可见的「网页版导航 / 品牌 / 顶栏」——这些在
//     APP 里与外壳重复，属真实重复 UI
//   · 顶部是否存在两条并排/叠放的横条（外壳标题栏 + 页面自带 header）
//
// 用法: node app/scripts/probe_ui_layout.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const ROOT = path.join(__dirname, '..', '..');
const LOG = path.join(ROOT, 'probe_ui.log');
const PORT = 9271;

const lines = [];
const log = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };
const flush = () => { try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (_) {} };

// 页面 JS 错误收集（须在 page 就绪前声明，见下方 page.on('pageerror')）
const pageErrors = [];

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';

const killApp = () => {
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); } catch (_) {}
};

function waitForCdp(port, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
      }).on('error', () => (Date.now() > deadline ? resolve(null) : setTimeout(tick, 400)));
    };
    tick();
  });
}

// 在指定文档里取元素几何 + 可见性
const GEOM_FN = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    position: cs.position,
    bg: cs.backgroundColor,
    color: cs.color,
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
  };
};

(async () => {
  process.on('exit', flush);
  process.on('SIGTERM', () => { flush(); process.exit(1); });

  killApp();
  await new Promise(r => setTimeout(r, 1800));

  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT;

  spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' }).unref();
  if (!(await waitForCdp(PORT))) { log('!! CDP 未就绪'); flush(); killApp(); process.exit(1); }

  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });

  let page = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !page) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (/devtools/.test(p.url())) continue;
        try { if (await p.evaluate(() => !!document.getElementById('app'))) { page = p; break; } } catch (_) {}
      }
      if (page) break;
    }
    if (!page) await new Promise(r => setTimeout(r, 600));
  }
  if (!page) { log('!! 未找到页面'); flush(); await browser.close(); killApp(); process.exit(1); }
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));

  // 复位持久化状态，保证初始态一致（侧栏展开、浅色）
  await page.evaluate(() => {
    try {
      localStorage.removeItem('kanseki_app_sidebar_collapsed');
      localStorage.removeItem('kanseki_user');
      localStorage.setItem('theme', 'light');
    } catch (_) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  log('页面 URL: ' + page.url());

  // ---------- 1. 外壳自身是否重复 ----------
  log('\n[1] 外壳元素计数（>1 即重复）');
  const shellCount = await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return {
      '#app': q('#app'), '.app-titlebar': q('.app-titlebar'),
      'tbMin/tbMax/tbClose': [q('#tbMin'), q('#tbMax'), q('#tbClose')],
      '#winBtn': q('#winBtn'), '#winMenu': q('#winMenu'),
      '.side-title': q('.side-title'), '.app-sidebar': q('#sidebar'),
      '主题按钮': q('#sideThemeBtn,#themeBtn,[data-theme-toggle]'),
      '登录入口': q('a[href="#/login"]'),
      'body直接子节点': [...document.body.children].map(e => e.tagName + (e.id ? '#' + e.id : '')),
    };
  });
  log(JSON.stringify(shellCount, null, 1));

  // ---------- 2. 外壳关键元素几何 ----------
  log('\n[2] 外壳几何（x,y,w,h）');
  for (const sel of ['.app-titlebar', '.app-body', '#sidebar', '#view-query', '#queryFrame', '#winResize']) {
    const g = await page.evaluate(GEOM_FN, sel);
    log('  ' + sel.padEnd(16) + ' -> ' + (g ? JSON.stringify(g.rect) + ' display=' + g.display + ' bg=' + g.bg : 'null'));
  }

  // ---------- 3. 查询视图 iframe 内仍可见的「网页版」元素 ----------
  log('\n[3] 查询视图 iframe 内可见的网页版顶栏（与外壳重叠即重复 UI）');
  const inFrame = await page.evaluate(() => {
    const out = {};
    const f = document.getElementById('queryFrame');
    let d = null;
    try { d = f && (f.contentDocument || null); } catch (e) { out.err = String(e); }
    if (!d || !d.body) { out.missing = true; return out; }
    const pick = (sel) => {
      const el = d.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = d.defaultView.getComputedStyle(el);
      return {
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display, visibility: cs.visibility, bg: cs.backgroundColor,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 36),
      };
    };
    for (const sel of ['.app-header', '.header-nav', '.header-brand', '.search-box', 'header']) {
      out[sel] = pick(sel);
    }
    // 视口顶部 60px 内、水平跨度 > 60% 视口的可见横条 = 可能的顶栏
    const vw = d.documentElement.clientWidth;
    const bars = [];
    d.querySelectorAll('*').forEach(el => {
      const cs = d.defaultView.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.height >= 24 && r.height <= 90 && r.width >= vw * 0.6 && r.top < 60) {
        bars.push({ tag: el.tagName, cls: el.className && el.className.toString().slice(0, 40),
          rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          pos: cs.position, bg: cs.backgroundColor });
      }
    });
    out.__topBars = bars.slice(0, 8);
    return out;
  });
  log(JSON.stringify(inFrame, null, 1));

  // ---------- 4. 账号视图（登录页）内仍可见的网页版元素 ----------
  log('\n[4] 登录视图 iframe 内的网页版外壳（与 APP 侧栏重复）');
  await page.evaluate(() => { location.hash = '#/login'; });
  await page.waitForTimeout(4500);
  const loginFrame = await page.evaluate(() => {
    const out = {};
    const f = document.getElementById('loginFrame');
    let d = null;
    try { d = f && (f.contentDocument || null); } catch (e) { out.err = String(e); }
    if (!d || !d.body) { out.missing = true; return out; }
    const pick = (sel) => {
      const el = d.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = d.defaultView.getComputedStyle(el);
      return {
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        display: cs.display, visibility: cs.visibility,
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
      };
    };
    out['.brand（Juvenile 品牌）'] = pick('.brand');
    out['.top-actions（游客访问/深色）'] = pick('.top-actions');
    out['.card'] = pick('.card');
    out['supabase 就绪'] = {
      ready: d.defaultView.SUPABASE_READY,
      hasClient: !!d.defaultView.supabaseClient,
      configured: d.defaultView.SupabaseAuth ? d.defaultView.SupabaseAuth.isConfigured() : null,
    };
    return out;
  });
  log(JSON.stringify(loginFrame, null, 1));

  // ---------- 5. 登录/注册可达性（真实网络） ----------
  log('\n[5] 账号后端可达性与注册/登录实测');
  const authProbe = await page.evaluate(async () => {
    const out = {};
    const f = document.getElementById('loginFrame');
    const w = f && f.contentWindow;
    if (!w) { out.missing = true; return out; }
    out.SUPABASE_READY = w.SUPABASE_READY;
    out.hasClient = !!w.supabaseClient;
    // 探测后端健康端点（超时 8s）
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await w.fetch('https://ndogqsjmkoeecoekmhod.supabase.co/auth/v1/health', { signal: ctl.signal });
      clearTimeout(timer);
      out.health = { status: r.status, ms: Date.now() - t0 };
    } catch (e) {
      out.health = { error: String((e && e.name) || e) + ': ' + String((e && e.message) || ''), ms: Date.now() - t0 };
    }
    // 实际注册（若后端不可达，应看到明确错误）
    try {
      const res = await w.SupabaseAuth.signUp('probe_' + Date.now() + '@example.com', 'probe12345', 'Probe');
      out.signUp = { error: res && res.error ? String(res.error.message || res.error) : null,
                     hasData: !!(res && res.data), hasUser: !!(res && res.data && res.data.user) };
    } catch (e) { out.signUp = { thrown: String(e && e.message || e) }; }
    return out;
  });
  log(JSON.stringify(authProbe, null, 1));

  log('\n[6] 页面 JS 错误: ' + JSON.stringify(pageErrors));
  flush();
  await browser.close();
  killApp();
})().catch(e => { log('!! 异常: ' + (e && e.stack || e)); flush(); killApp(); process.exit(1); });
