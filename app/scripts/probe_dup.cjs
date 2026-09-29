// ================================================
// app/scripts/probe_dup.cjs — 取证「UI 重复」的具体位置
// -------------------------------------------------
// probe_ui_layout.cjs 已确认：外壳自身无重复元素（各元素计数均为 1）。
// 因此「UI 重复」只可能来自「外壳 chrome + iframe 内网页 chrome」叠加。
//
// 本脚本：逐视图统计「顶部可见横条」（wide bands）——即横向跨度大、
// 高度 24~90px、位于视口顶部的可见块，分别在外壳文档与各 iframe 内统计；
// 同时输出 Playwright 精确截图（不含窗口边框/阴影），供后续像素分析。
//
// 用法: node app/scripts/probe_dup.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const ROOT = path.join(__dirname, '..', '..');
const LOG = path.join(ROOT, 'probe_dup.log');
const SHOT = path.join(__dirname, '..', '.shot_pw.png');
const PORT = 9272;

const lines = [];
const log = (...a) => { const s = a.map(String).join(' '); lines.push(s); console.log(s); };
const flush = () => { try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (_) {} };
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

// 在某个文档里找「顶部宽横条」
const BANDS_FN = () => {
  const out = [];
  const vw = document.documentElement.clientWidth;
  document.querySelectorAll('header, nav, div, section, aside, footer').forEach(el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.55) return;
    if (r.height < 24 || r.height > 96) return;
    if (r.top > 130) return;
    out.push({
      tag: el.tagName,
      id: el.id || null,
      cls: (el.className || '').toString().slice(0, 46),
      y: Math.round(r.top), x: Math.round(r.left),
      w: Math.round(r.width), h: Math.round(r.height),
      pos: cs.position, bg: cs.backgroundColor,
      txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 34),
    });
  });
  // 去重 + 按 y 排序
  const seen = new Set();
  return out.filter(b => {
    const k = b.tag + '|' + b.cls + '|' + b.y + '|' + b.h;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a, b) => a.y - b.y);
};

const VIS_FN = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    vis: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0,
    display: cs.display, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
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

  await page.evaluate(() => {
    try {
      localStorage.removeItem('kanseki_app_sidebar_collapsed');
      localStorage.removeItem('kanseki_user');
      localStorage.setItem('theme', 'light');
    } catch (_) {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  log('页面 URL: ' + page.url());
  log('视口: ' + JSON.stringify(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])));

  // 外壳侧的关键元素可见性
  log('\n[1] 外壳关键元素可见性');
  for (const sel of ['.app-titlebar', '.tb-title-tx', '.side-title', '.side-sub', '#sidebar', '.app-body']) {
    log('  ' + sel.padEnd(16) + ' -> ' + JSON.stringify(await page.evaluate(VIS_FN, sel)));
  }

  // 主视图截图（精确、不含窗口边框）
  await page.screenshot({ path: SHOT });
  log('\n[2] 已截图: ' + SHOT);

  // 逐视图统计顶部宽横条
  const VIEWS = [
    ['query', '#/query', 'queryFrame'],
    ['jump', '#/jump', 'jumpFrame'],
    ['catalog', '#/catalog', 'catalogFrame'],
    ['guide', '#/guide', 'guideFrame'],
    ['changelog', '#/changelog', 'changelogFrame'],
    ['login', '#/login', 'loginFrame'],
  ];
  for (const [name, hash, frameId] of VIEWS) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForTimeout(4200);
    const app = await page.evaluate(BANDS_FN);
    // 在同源 iframe 内执行同样的统计（contentDocument 可直读）
    const bands = await page.evaluate((id) => {
      const f = document.getElementById(id);
      let d = null;
      try { d = f && f.contentDocument; } catch (_) {}
      if (!d || !d.body) return { missing: true, url: f ? f.getAttribute('src') : null };
      const out = [];
      const vw = d.documentElement.clientWidth;
      d.querySelectorAll('header, nav, div, section, aside, footer').forEach(el => {
        const cs = d.defaultView.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
        const r = el.getBoundingClientRect();
        if (r.width < vw * 0.55) return;
        if (r.height < 24 || r.height > 96) return;
        if (r.top > 130) return;
        out.push({
          tag: el.tagName, id: el.id || null, cls: (el.className || '').toString().slice(0, 44),
          y: Math.round(r.top), x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height),
          pos: cs.position, txt: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30),
        });
      });
      const seen = new Set();
      return {
        viewport: [vw, d.documentElement.clientHeight],
        bands: out.filter(b => { const k = b.tag + b.cls + b.y + b.h; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.y - b.y),
      };
    }, frameId).catch(e => ({ err: String(e && e.message || e) }));

    log('\n===== 视图: ' + name + ' (' + hash + ') =====');
    log('  外壳顶部宽横条: ' + app.length);
    app.forEach(b => log('    y=' + b.y + ' h=' + b.h + ' w=' + b.w + ' ' + b.pos + ' ' +
      b.tag + (b.id ? '#' + b.id : '') + '.' + b.cls + '  «' + b.txt + '»'));
    log('  iframe(' + frameId + ') 顶部宽横条: ' + JSON.stringify(bands, null, 1));
  }

  await page.evaluate(() => { location.hash = '#/query'; });
  await page.waitForTimeout(2500);
  log('\n[3] 页面 JS 错误: ' + JSON.stringify(pageErrors));
  flush();
  await browser.close();
  killApp();
})().catch(e => { log('!! 异常: ' + (e && e.stack || e)); flush(); killApp(); process.exit(1); });
