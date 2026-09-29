// ================================================
// app/scripts/probe_top.cjs — 列出屏幕上方的实际可见堆叠
// -------------------------------------------------
// probe_dup.cjs 已确认外壳自身元素无重复（计数均为 1），
// 且 query 视图 iframe 内仍保留 62px 的网页版 .app-header（搜索框）。
//
// 本脚本回答：用户眼里的「UI 重复」到底是什么 ——
//   1. 逐像素行列出「顶部 160px」内所有可见元素的矩形与文字（按 y 排序）
//   2. 找出「同一段文字在两个不同可见元素里同时出现」——真正的视觉重复
//   3. 输出各可见元素的 z 序与实际遮挡关系
//
// 用法: node app/scripts/probe_top.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const ROOT = path.join(__dirname, '..', '..');
const LOG = path.join(ROOT, 'probe_top.log');
const SHOT = path.join(__dirname, '..', '.shot_top.png');
const PORT = 9273;

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

  // ---------- 1. 顶部 160px 内所有可见元素（含 iframe 内），按 y 排序 ----------
  const dump = await page.evaluate(() => {
    const rows = [];
    const APP_NAME = '古代史及汉籍研究工具';

    function walk(doc, originX, originY, docName) {
      const all = doc.querySelectorAll('*');
      for (const el of all) {
        const cs = doc.defaultView.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const y = r.top + originY;
        if (y > 160) continue;
        // 只关心有文字 或 是明显的条/块
        const own = [...el.childNodes]
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.replace(/\s+/g, ' ').trim())
          .join(' ').trim();
        const isBand = r.width > 300 && r.height >= 24;
        if (!own && !isBand) continue;
        rows.push({
          doc: docName,
          y: Math.round(y), x: Math.round(r.left + originX),
          w: Math.round(r.width), h: Math.round(r.height),
          tag: el.tagName, id: el.id || null,
          cls: (el.className || '').toString().slice(0, 34),
          bg: cs.backgroundColor, pos: cs.position, z: cs.zIndex,
          own: own.slice(0, 34),
          hasAppName: own.indexOf(APP_NAME) >= 0,
        });
      }
    }

    walk(document, 0, 0, 'APP外壳');

    // iframe：把 iframe 自身位置作为原点
    document.querySelectorAll('iframe').forEach(f => {
      let d = null;
      try { d = f.contentDocument; } catch (_) {}
      if (!d || !d.body) return;
      const fr = f.getBoundingClientRect();
      const id = f.id || f.getAttribute('src') || 'iframe';
      if (fr.width === 0) return;  // 非活动视图
      walk(d, fr.left, fr.top, id);
    });

    return rows.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  });

  log('\n[1] 顶部 160px 内可见元素（按 y 排序）');
  log('  y     x     w     h    文档               元素                      底色                文字');
  dump.forEach(r => {
    log('  ' + String(r.y).padStart(4) + '  ' + String(r.x).padStart(4) + '  ' +
        String(r.w).padStart(5) + '  ' + String(r.h).padStart(4) + '  ' +
        r.doc.padEnd(16) + '  ' +
        (r.tag + (r.id ? '#' + r.id : '') + '.' + r.cls).slice(0, 24).padEnd(24) + '  ' +
        r.bg.slice(0, 18).padEnd(18) + '  «' + r.own + '»');
  });

  // ---------- 2. 应用名同时出现在哪些可见元素里 ----------
  const appNameEls = dump.filter(r => r.hasAppName);
  log('\n[2] 「' + '古代史及汉籍研究工具' + '」同时可见的位置（>1 即视觉重复）: ' + appNameEls.length);
  appNameEls.forEach(r => log('    y=' + r.y + ' x=' + r.x + ' ' + r.doc + ' ' + r.tag +
    (r.id ? '#' + r.id : '') + '.' + r.cls + '  h=' + r.h));

  // ---------- 3. 相同文字在两个不同元素同时可见 ----------
  const byText = {};
  dump.forEach(r => {
    const t = r.own;
    if (!t || t.length < 3) return;
    (byText[t] = byText[t] || []).push(r);
  });
  log('\n[3] 同段文字出现在多个可见元素（真正的重复 UI）');
  let dupCount = 0;
  Object.keys(byText).forEach(t => {
    const list = byText[t];
    const docs = new Set(list.map(r => r.doc));
    if (list.length > 1) {
      dupCount++;
      log('  «' + t + '» x' + list.length + '  跨文档=' + (docs.size > 1) +
        '  ->  ' + list.map(r => r.doc + ':' + r.tag + '.' + r.cls + '@y' + r.y).join(' | '));
    }
  });
  if (!dupCount) log('  （无）');

  // ---------- 4. 精确截图 ----------
  await page.screenshot({ path: SHOT, clip: { x: 0, y: 0, width: 1280, height: 220 } });
  log('\n[4] 已截图（顶部 220px）: ' + SHOT);

  log('\n[5] 页面 JS 错误: ' + JSON.stringify(pageErrors));
  flush();
  await browser.close();
  killApp();
})().catch(e => { log('!! 异常: ' + (e && e.stack || e)); flush(); killApp(); process.exit(1); });
