// ================================================
// app/scripts/probe_window.cjs — 诊断窗口功能失效
// -------------------------------------------------
// 用户反馈：① 最大化无法使用、UI 重复；② 窗口菜单很多操作无法使用。
//
// 本脚本在真实窗口里逐项调用窗口命令，记录每种调用的实际结果与错误信息，
// 并检查：权限是否生效、菜单是否被遮挡、是否有重复元素。
//
// 用法: node app/scripts/probe_window.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const ROOT = path.join(__dirname, '..', '..');
const LOG = path.join(ROOT, 'probe_window.log');
const PORT = 9270;

const lines = [];
const log = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };
const flush = () => { try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (_) {} };

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
  await page.waitForTimeout(2500);

  // 收集页面错误
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)));

  log(`页面 URL: ${page.url()}`);

  // ---------- 1. Tauri 桥是否可用 ----------
  log('\n[1] Tauri 桥与 label');
  const bridge = await page.evaluate(() => {
    const o = {};
    const I = window.__TAURI_INTERNALS__;
    o.hasInternals = !!I;
    o.hasInvoke = !!(I && typeof I.invoke === 'function');
    o.metadata = I && I.metadata ? JSON.stringify(I.metadata).slice(0, 200) : null;
    try {
      o.currentWindowLabel = I?.metadata?.currentWindow?.label ?? null;
      o.currentWebviewLabel = I?.metadata?.currentWebview?.label ?? null;
    } catch (e) { o.metaErr = String(e); }
    o.isTauriVar = typeof isTauri !== 'undefined' ? isTauri : 'n/a';
    return o;
  });
  log(JSON.stringify(bridge, null, 1));

  // ---------- 2. 逐条窗口命令实测（绕过 UI，直接调 IPC） ----------
  // 重要：Tauri 窗口命令名一律 snake_case（Rust generate_handler! 注册名）。
  //   传 camelCase 会被 ACL 拒绝：Command plugin:window|X not allowed by ACL。
  //   单词命令（minimize/maximize/unmaximize/center/close）两种写法同形，故曾「碰巧可用」。
  // 带参命令的参数名一律是 value（非 width/height/alwaysOnTop/direction）。
  log('\n[2] 窗口命令逐一实测（直接 IPC，命令名 snake_case）');
  const cmds = [
    ['is_maximized', {}],
    ['is_fullscreen', {}],
    ['is_always_on_top', {}],
    ['is_minimized', {}],
    ['maximize', {}],
    ['is_maximized', {}],
    ['unmaximize', {}],
    ['is_maximized', {}],
    ['toggle_maximize', {}],
    ['is_maximized', {}],
    ['toggle_maximize', {}],
    ['is_maximized', {}],
    ['center', {}],
    ['set_always_on_top', { value: true }],
    ['is_always_on_top', {}],
    ['set_always_on_top', { value: false }],
    // Size 枚举需 { Logical: { width, height } }（Rust serde 外部标签枚举）
    ['set_size', { value: { Logical: { width: 1300, height: 820 } } }],
    ['set_fullscreen', { value: true }],
    ['is_fullscreen', {}],
    ['set_fullscreen', { value: false }],
    ['start_dragging', {}],
    // start_resize_dragging 的方向值是 PascalCase（'North'|'SouthEast'…）
    ['start_resize_dragging', { value: 'SouthEast' }],
  ];
  for (const [cmd, args] of cmds) {
    const r = await page.evaluate(async ({ cmd, args }) => {
      const I = window.__TAURI_INTERNALS__;
      const label = I?.metadata?.currentWindow?.label ?? 'main';
      try {
        const v = await I.invoke('plugin:window|' + cmd, Object.assign({ label }, args));
        return { ok: true, val: typeof v === 'object' ? JSON.stringify(v) : String(v) };
      } catch (e) {
        return { ok: false, err: String(e && e.message ? e.message : e).slice(0, 220) };
      }
    }, { cmd, args });
    log(`  ${cmd.padEnd(18)} ${JSON.stringify(args).padEnd(26)} → ${r.ok ? 'OK  ' + (r.val ?? '') : 'FAIL  ' + r.err}`);
    await page.waitForTimeout(220);
  }

  // ---------- 3. UI 重复检查 ----------
  log('\n[3] UI 重复与元素计数');
  const dup = await page.evaluate(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return {
      appShell: q('.app-shell'), appTitlebar: q('.app-titlebar'),
      tbMin: q('#tbMin'), tbMax: q('#tbMax'), tbClose: q('#tbClose'),
      collapseBtn: q('#collapseBtn'), winBtn: q('#winBtn'), winMenu: q('#winMenu'),
      winDropdown: q('.st-dropdown'), sideTitle: q('.side-title'),
      tbLeft: q('.tb-left'), tbRight: q('.tb-right'),
      // 是否存在脱离 #app 的游离节点（重复 UI 的常见来源）
      bodyChildren: [...document.body.children].map(el => el.id || el.className || el.tagName),
      // 老式 .side-top / .expand-pill 是否残留
      sideTop: q('.side-top'), expandPill: q('#expandPill'),
    };
  });
  log(JSON.stringify(dup, null, 1));

  // ---------- 4. 菜单可见性与可点击性 ----------
  log('\n[4] 窗口菜单交互');
  await page.click('#winBtn');
  await page.waitForTimeout(400);
  const menuState = await page.evaluate(() => {
    const m = document.querySelector('#winMenu');
    if (!m) return { found: false };
    const cs = getComputedStyle(m);
    const r = m.getBoundingClientRect();
    return {
      found: true, hidden: m.hidden, display: cs.display, visibility: cs.visibility,
      zIndex: cs.zIndex, opacity: cs.opacity,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      itemCount: m.querySelectorAll('.st-menu-item').length,
    };
  });
  log('  菜单状态: ' + JSON.stringify(menuState));

  // 逐项点击菜单，看是否生效
  const items = await page.evaluate(() => [...document.querySelectorAll('#winMenu .st-menu-item')]
    .map(b => ({ win: b.dataset.win || null, size: b.dataset.size || null, text: b.textContent.trim().slice(0, 12) })));
  log('  菜单项: ' + JSON.stringify(items));

  // 检查菜单项中心是否被遮挡
  const occlusion = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('#winMenu .st-menu-item')) {
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      out.push({
        item: (b.dataset.win || b.dataset.size || b.textContent.trim().slice(0, 6)),
        centerEl: top ? (top.id || top.className || top.tagName) : null,
        ok: !!(top && (top === b || b.contains(top))),
      });
    }
    return out;
  });
  log('  遮挡检查: ' + JSON.stringify(occlusion, null, 1));

  // ---------- 5. 真实点击「最大化」菜单项 ----------
  log('\n[5] 点击菜单「最大化」实测');
  const before = await page.evaluate(() => window.innerWidth + 'x' + window.innerHeight);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#winMenu .st-menu-item')].find(x => x.dataset.win === 'max');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  const afterMax = await page.evaluate(() => ({
    size: window.innerWidth + 'x' + window.innerHeight,
    label: document.querySelector('#winMaxLabel')?.textContent,
    hasCls: document.querySelector('#app')?.classList.contains('is-maximized'),
  }));
  const realMax = await page.evaluate(async () => {
    try {
      const I = window.__TAURI_INTERNALS__;
      return String(await I.invoke('plugin:window|is_maximized', { label: 'main' }));
    } catch (e) { return 'ERR ' + String(e).slice(0, 80); }
  });
  log(`  点击前 ${before} → 点击后 ${JSON.stringify(afterMax)}；真实 isMaximized=${realMax}`);

  // ---------- 6. 点击标题栏三键 ----------
  log('\n[6] 标题栏三键实测');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  for (const id of ['#tbMax', '#tbMin']) {
    const r0 = await page.evaluate((sel) => {
      const b = document.querySelector(sel);
      if (!b) return null;
      const rc = b.getBoundingClientRect();
      return { x: rc.left + rc.width / 2, y: rc.top + rc.height / 2, vis: !!b.offsetWidth };
    }, id);
    if (!r0) { log(`  ${id}: 元素不存在`); continue; }
    await page.mouse.click(r0.x, r0.y);
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({
      size: window.innerWidth + 'x' + window.innerHeight,
      label: document.querySelector('#winMaxLabel')?.textContent,
    }));
    log(`  ${id} 点击后: ${JSON.stringify(st)}`);
  }

  log('\n[7] 页面 JS 错误: ' + JSON.stringify(pageErrors));

  flush();
  try { await browser.close(); } catch (_) {}
  killApp();
  setTimeout(() => process.exit(0), 500).unref();
})();
