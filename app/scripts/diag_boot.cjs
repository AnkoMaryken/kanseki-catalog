/* ================================================
 * diag_boot.cjs — 桌面版外壳「标题栏按钮何时可用」时间线取证
 * -------------------------------------------------
 * 背景（diag_cold2 结论）：探针点击 #tbMax 时该按钮尚未绑定监听
 *   （失败轮 CDP 读出 click 监听数 0、成功轮 1）。
 *
 * 【已结案】本脚本给出的实测时间线（页面时间原点 = 文档导航开始）：
 *   +404ms        DOM 解析完成，三键已在页面上可见
 *   +123→2775ms   内嵌查询页 pages/index.html 独占主线程
 *                 （其 conv_tables / pinyin_data / knowledge 等同步脚本）
 *   +3007ms       app.js 模块图才被拉起 → 三键 click 监听**此刻才出现**
 *   资源实测：index.html 自 +123ms 起耗时 2652ms；四个 ES 模块
 *   （store-indexeddb / sync-engine / provider-webdav / records）
 *   均在 +2457ms 才开始加载。
 *
 * 结论：启动后约 3 秒内点标题栏「看得见但点不动」——这是**真实交互缺陷**，
 *   不只是测试脚本的时序问题。修复见：
 *   · app/src/index.html 的早期点击暂存脚本（解析阶段即接住点击）
 *   · app/src/js/app.js init() 里 takeAll() 补发 + 末尾 __kansekiAppReady
 *   修复后 probe_v082.cjs 第 5 组专门覆盖该场景（在约 +120ms 处点击，
 *   断言窗口最终确实最大化）。
 *
 * 复现手法：接入后 100ms 一档高频采样，每档记录
 *   { 页面时间, readyState, #tbMax 是否存在, click 监听数, 就绪标记 }
 * 并打印 Navigation Timing 与资源时间线，便于日后回归定位。
 * 注意：不包装 __TAURI_INTERNALS__.invoke（历史上包装会干扰页面本身）。
 * ================================================ */
'use strict';
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9234;
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

// 找到真正的应用页：不断遍历上下文里的页，直到某个页的 DOM 里出现 #tbMax
async function pickAppPage(ctx, deadline, t0) {
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      let url = '';
      try { url = p.url(); } catch (_) { /* 忽略 */ }
      let has = false;
      try {
        has = await p.evaluate(() => !!document.getElementById('tbMax'));
      } catch (_) { /* 仍在导航/上下文已销毁 */ }
      if (has) {
        console.log(`找到应用页（进程启动后 ${Date.now() - t0}ms）: url=${url || '(空)'}`);
        return p;
      }
      console.log(`  跳过页面（进程启动后 ${Date.now() - t0}ms）: url=${url || '(空)'} 有 tbMax=${has}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('未找到应用页');
}

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  killApp();
  await new Promise(r => setTimeout(r, 1200));
  const t0 = Date.now();
  spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    stdio: 'ignore',
  });
  await waitCdp(30000);
  console.log('CDP 可连接: 进程启动后 ' + (Date.now() - t0) + 'ms');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  console.log('playwright 接入完成: 进程启动后 ' + (Date.now() - t0) + 'ms');
  const ctx = browser.contexts()[0];
  const page = await pickAppPage(ctx, Date.now() + 20000, t0);

  // 高频采样：直到按钮绑定出现（或 12s 超时）
  console.log('\n=== 标题栏按钮绑定时间线（页面时间原点 = 文档导航开始） ===');
  const client = await page.context().newCDPSession(page);
  let bindAt = null;
  const samples = [];
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    let snap = null;
    try {
      snap = await page.evaluate(() => {
        const t = document.getElementById('tbMax');
        return {
          now: Math.round(performance.now()),
          readyState: document.readyState,
          hasTbMax: !!t,
          pressed: t ? t.getAttribute('aria-pressed') : null,
          langBtn: !!document.getElementById('langToggleBtn'),
          // 就绪标记（修复后应由 app.js 暴露）
          appReady: window.__kansekiAppReady === true,
        };
      });
    } catch (_) { await new Promise(r => setTimeout(r, 100)); continue; }

    // CDP 读监听数（与页面时间同档采集）
    let n = -1;
    try {
      const ev = await client.send('Runtime.evaluate', { expression: "document.getElementById('tbMax')" });
      if (ev.result && ev.result.objectId) {
        const ls = await client.send('DOMDebugger.getEventListeners', { objectId: ev.result.objectId });
        n = ls.listeners.filter(l => l.type === 'click').length;
      } else {
        n = -2;   // 元素不存在
      }
    } catch (e) { n = -3; }

    samples.push({ ...snap, listeners: n });
    if (n >= 1 && bindAt === null) bindAt = snap.now;

    // 只在状态变化时打印，保持输出清爽
    const prev = samples[samples.length - 2];
    if (!prev || prev.readyState !== snap.readyState || prev.hasTbMax !== snap.hasTbMax
      || prev.listeners !== n || prev.appReady !== snap.appReady || prev.pressed !== snap.pressed) {
      console.log(`  +${String(snap.now).padStart(5)}ms  ready=${snap.readyState.padEnd(9)}`
        + ` tbMax=${snap.hasTbMax ? 'Y' : 'N'} click监听=${n < 0 ? '(' + n + ')' : n}`
        + ` aria-pressed=${snap.pressed} appReady=${snap.appReady}`);
    }
    if (bindAt !== null && samples.length > 4 && Date.now() > deadline - 11000) break;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n=== 结论 ===');
  if (bindAt === null) {
    console.log('  ✗ 12s 内始终未读到 click 监听（异常，需进一步排查）');
  } else {
    console.log(`  #tbMax 的 click 监听出现于页面时间 ≈ +${bindAt}ms（进程启动后约 ${bindAt + (t0 ? 0 : 0)}ms+）`);
  }
  const last = samples[samples.length - 1];
  console.log('  末次采样: ' + JSON.stringify(last));

  // Navigation Timing + 资源时间线（相对页面时间原点）
  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    return {
      nav: {
        startTime: Math.round(nav.startTime || 0),
        responseEnd: Math.round(nav.responseEnd || 0),
        domInteractive: Math.round(nav.domInteractive || 0),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0),
      },
      res: performance.getEntriesByType('resource').map(r => ({
        name: String(r.name).replace(/^.*\//, ''),
        start: Math.round(r.startTime),
        dur: Math.round(r.duration),
        size: r.transferSize || 0,
      })).sort((a, b) => a.start - b.start),
    };
  });
  console.log('\n=== Navigation Timing ===');
  console.log('  responseEnd      : ' + perf.nav.responseEnd + 'ms');
  console.log('  domInteractive   : ' + perf.nav.domInteractive + 'ms');
  console.log('  DOMContentLoaded : ' + perf.nav.domContentLoaded + 'ms');
  console.log('  load             : ' + perf.nav.load + 'ms');
  console.log('\n=== 资源（start + 耗时） ===');
  perf.res.forEach(r => console.log(
    `  ${String(r.start).padStart(6)}ms +${String(r.dur).padStart(5)}ms  ${String(Math.round(r.size / 1024)).padStart(4)}KB  ${r.name}`));

  await browser.close();
  killApp();
  setTimeout(() => process.exit(0), 300).unref();
})().catch(e => { console.error('异常: ' + (e && e.stack || e)); killApp(); process.exit(1); });
