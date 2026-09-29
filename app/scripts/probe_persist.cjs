// ================================================
// app/scripts/probe_persist.cjs — 判定 localStorage 丢失的机理
// -------------------------------------------------
// 两种可能：
//   A. 页面在两次 evaluate 之间重载（文档被销毁 → 未落盘的写入丢失）
//   B. 存储层本身不持久（写入从未提交）
//
// 判别手段：
//   · window 全局变量是否留存（不同文档必丢；同文档必留）
//   · performance.timeOrigin / 文档标识是否变化（变化即重载）
//   · 监听 framenavigated 记录导航次数
//   · 读 localStorage 长度变化
//
// 用法: node app/scripts/probe_persist.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9229;
const LOG = path.join(__dirname, '..', '..', 'persist_probe.log');

const lines = [];
const log = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const flush = () => { try { fs.writeFileSync(LOG, lines.join('\n'), 'utf8'); } catch (_) {} };

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';

const killApp = () => {
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); } catch (_) {}
};

function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
        let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
      }).on('error', () => (Date.now() > deadline ? resolve(null) : setTimeout(tick, 400)));
    };
    tick();
  });
}

(async () => {
  process.on('exit', flush);
  process.on('SIGTERM', () => { flush(); process.exit(1); });

  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  killApp();
  await new Promise(r => setTimeout(r, 1500));

  const env = Object.assign({}, process.env);
  env.NO_PROXY = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
    '--remote-debugging-port=' + PORT + ' --disable-gpu-sandbox';

  spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' }).unref();

  if (!(await waitForCdp())) { log('!! CDP 未就绪'); flush(); killApp(); process.exit(1); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });

  let page = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !page) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        if (/devtools/.test(p.url())) continue;
        try { if (await p.evaluate(() => !!document.getElementById('app'))) { page = p; break; } } catch (_) {}
      }
      if (page) break;
    }
    if (!page) await new Promise(r => setTimeout(r, 600));
  }
  if (!page) { log('!! 未找到页面'); flush(); await browser.close(); killApp(); process.exit(1); }
  await page.waitForTimeout(2500);

  // 记录导航
  let navs = 0;
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) { navs++; log(`  [nav #${navs}] ${f.url()}`); } });
  page.on('load', () => log('  [load] 文档加载完成'));

  const marker = () => page.evaluate(() => ({
    timeOrigin: Math.round(performance.timeOrigin),
    // 给当前文档打标记（全局变量）
    hasW: typeof window.__probeW !== 'undefined' ? window.__probeW : null,
    lsLen: localStorage.length,
    lsTheme: localStorage.getItem('theme'),
    lsProbe: localStorage.getItem('__probe_p'),
    url: location.href,
    ready: document.readyState,
  }));

  log('页面 URL:', page.url());
  log('\n== 阶段 1：首次打标记 ==');
  log(JSON.stringify(await page.evaluate(() => {
    window.__probeW = 'W1';
    localStorage.setItem('__probe_p', 'P1');
    return { w: window.__probeW, p: localStorage.getItem('__probe_p'), len: localStorage.length };
  })));

  log('\n== 阶段 2：立即回读（应保留） ==');
  log(JSON.stringify(await marker()));

  log('\n== 阶段 3：等 3s 后回读 ==');
  await page.waitForTimeout(3000);
  log(JSON.stringify(await marker()));

  log('\n== 阶段 4：再等 3s 后回读 ==');
  await page.waitForTimeout(3000);
  log(JSON.stringify(await marker()));

  log('\n== 阶段 5：模拟真实点击主题（应用自身写 localStorage） ==');
  await page.evaluate(() => document.querySelector('#themeToggleBtn').click());
  await page.waitForTimeout(800);
  log('  点击后本页 data-theme = ' + await page.evaluate(() => document.documentElement.getAttribute('data-theme')));
  log(JSON.stringify(await marker()));

  log('\n== 阶段 6：调用后等 4s 再读 localStorage.theme ==');
  await page.waitForTimeout(4000);
  log(JSON.stringify(await marker()));

  log('\n== 阶段 7：storage 落盘探测（DOMStorage via CDP） ==');
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOMStorage.enable');
    const got = [];
    cdp.on('DOMStorage.domStorageItemAdded', (e) => got.push('added ' + JSON.stringify(e.key)));
    await cdp.send('DOMStorage.setDOMStorageItem', {
      storageId: { securityOrigin: 'http://tauri.localhost', isLocalStorage: true },
      key: '__probe_cdp', value: 'CDP1',
    });
    await page.waitForTimeout(1200);
    const r = await cdp.send('DOMStorage.getDOMStorageItems', {
      storageId: { securityOrigin: 'http://tauri.localhost', isLocalStorage: true },
    });
    log('  CDP 写入后直接读 items: ' + JSON.stringify(r.entries).slice(0, 300));
    log('  事件:' + JSON.stringify(got));
  } catch (e) {
    log('  CDP DOMStorage 探测失败: ' + String(e).slice(0, 200));
  }

  log('\n== 阶段 8：读回（经 JS） ==');
  log(JSON.stringify(await marker()));

  log('\n== 阶段 9：把页面导航到 about:blank 再回来，看 theme 是否留存 ==');
  try {
    await page.goto('http://tauri.localhost/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2500);
    log('  导航回应用后: ' + JSON.stringify(await page.evaluate(() => ({
      lsTheme: localStorage.getItem('theme'),
      lsProbe: localStorage.getItem('__probe_p'),
      len: localStorage.length,
    }))));
  } catch (e) {
    log('  导航失败: ' + String(e).slice(0, 160));
  }

  log('\n总导航次数(含内部跳转): ' + navs);
  flush();
  await browser.close();
  killApp();
  setTimeout(() => process.exit(0), 400).unref();
})();
