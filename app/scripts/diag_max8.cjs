/* ================================================
 * diag_max8.cjs — 抓「点击监听是否被注册两次」
 * -------------------------------------------------
 * 线索：diag_max6 的图标序列为 restore → max → restore → max，
 * 窗口尺寸也随之反复变化（最后真的退出了最大化）。单次点击不可能
 * 产生两次完整翻转 —— 除非 **同一个按钮上挂了两个 click 监听**：
 *   · 监听#1：applyMaxUI(true)  + setMaximized(true)
 *   · 监听#2：applyMaxUI(false) + setMaximized(false)
 * 两者并发重试（各 3 轮 ≈ 6 秒），正好解释「点了没反应」「来回抖」
 * 「6 秒后才停」这些现象。
 *
 * 本脚本用 CDP DOMDebugger.getEventListeners 直接读 #tbMax 上挂了几个
 * click 监听，并统计页面上 <script> 是否有重复引入；随后用
 * defineProperty 强制装上 invoke 记录器，点击一次，打印完整指令流。
 * ================================================ */
'use strict';
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9231;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';

function killApp() {
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); } catch (e) { /* 未运行 */ }
}
function waitCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1500 }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { retry(); } });
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => { if (Date.now() > deadline) return reject(new Error('CDP 未就绪')); setTimeout(tick, 500); };
    tick();
  });
}

(async () => {
  killApp();
  await new Promise(r => setTimeout(r, 1200));
  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    stdio: 'ignore',
  });
  await waitCdp(30000);
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.waitForTimeout(2500);

  // ---------- 1. 脚本是否被重复引入 ----------
  console.log('=== 页面脚本清单 ===');
  const scripts = await page.evaluate(() => [...document.querySelectorAll('script')]
    .map(s => ({ src: s.src || '(inline)', len: (s.textContent || '').length })));
  scripts.forEach(s => console.log('  ' + JSON.stringify(s)));
  const srcDup = scripts.filter(s => s.src && s.src !== '(inline)')
    .map(s => s.src).filter((v, i, a) => a.indexOf(v) !== i);
  console.log('  重复引入的脚本: ' + (srcDup.length ? JSON.stringify(srcDup) : '无'));

  // ---------- 2. #tbMax 上挂了几个 click 监听 ----------
  const client = await page.context().newCDPSession(page);
  const evalRes = await client.send('Runtime.evaluate', { expression: "document.getElementById('tbMax')" });
  const objectId = evalRes.result.objectId;
  const listeners = await client.send('DOMDebugger.getEventListeners', { objectId });
  console.log('\n=== #tbMax 事件监听 ===');
  listeners.listeners.forEach(l => {
    console.log(`  type=${l.type}  useCapture=${l.useCapture}  passive=${l.passive}  once=${l.once}`);
  });
  const clickCount = listeners.listeners.filter(l => l.type === 'click').length;
  console.log(`  → click 监听数量: ${clickCount}`);

  // document 上的 click 监听（用于对照）
  const docRes = await client.send('Runtime.evaluate', { expression: "document" });
  const docListeners = await client.send('DOMDebugger.getEventListeners', { objectId: docRes.result.objectId });
  console.log('\n=== document 事件监听 ===');
  docListeners.listeners.forEach(l => {
    console.log(`  type=${l.type}  useCapture=${l.useCapture}`);
  });

  // ---------- 3. 强制装 invoke 记录器（defineProperty 保证生效）----------
  const installed = await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    const desc = Object.getOwnPropertyDescriptor(internals, 'invoke');
    window.__invLog = [];
    const orig = internals.invoke.bind(internals);
    try {
      Object.defineProperty(internals, 'invoke', {
        value: async function (cmd, args) {
          const t = Math.round(performance.now());
          const name = String(cmd).replace('plugin:window|', '');
          let ret, err = null;
          try { ret = await orig(cmd, args); } catch (e) { err = String(e && e.message || e); }
          if (/^(is_maximized|maximize|unmaximize|toggle_maximize|set_size)$/.test(name)) {
            window.__invLog.push({ t, name, ret: err ? 'ERR:' + err : JSON.stringify(ret) });
          }
          if (err) throw new Error(err);
          return ret;
        },
        writable: true,
        configurable: true,
        enumerable: desc ? desc.enumerable : true,
      });
      return { ok: true, hadDesc: !!desc, descWritable: desc ? desc.writable : null,
               descConfigurable: desc ? desc.configurable : null };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  });
  console.log('\n=== invoke 记录器安装 ===');
  console.log('  ' + JSON.stringify(installed));

  // ---------- 4. 点击一次，高频采样 ----------
  console.log('\n=== 点击一次 + 60ms 高频采样（最多 12s）===');
  await page.evaluate(() => { window.__clickT = performance.now(); document.getElementById('tbMax').click(); });
  const seq = [];
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(60);
    const s = await page.evaluate(() => {
      const b = document.getElementById('tbMax');
      const vis = b ? [...b.querySelectorAll('svg')]
        .filter(x => getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().width > 0)
        .map(x => x.getAttribute('class')).join(',') : null;
      return { vis, inner: window.innerWidth + 'x' + window.innerHeight,
               t: Math.round(performance.now() - window.__clickT) };
    });
    const key = s.vis + '@' + s.inner;
    if (!seq.length || seq[seq.length - 1].key !== key) {
      seq.push({ key, t: s.t });
      console.log(`  +${String(s.t).padStart(5)}ms  ${s.vis}  ${s.inner}`);
    }
    // 稳定 3s 后提前结束
    if (seq.length && s.t - seq[seq.length - 1].t > 3000 && s.t > 8000) break;
  }

  const invLog = await page.evaluate(() => window.__invLog);
  console.log('\n=== invoke 指令流（窗口相关）===');
  invLog.forEach(l => console.log(`  +${String(l.t).padStart(5)}ms  ${l.name.padEnd(16)} → ${l.ret}`));

  await browser.close();
  killApp();
  setTimeout(() => process.exit(0), 300).unref();
})().catch(e => { console.error('异常: ' + (e && e.stack || e)); killApp(); process.exit(1); });
