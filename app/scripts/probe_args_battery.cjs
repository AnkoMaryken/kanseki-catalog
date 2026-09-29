// ================================================
// app/scripts/probe_args_battery.cjs — 找「既修渲染、又保存储」的最小参数集
// -------------------------------------------------
// 背景：
//   · --disable-gpu-sandbox  修好了渲染（不再白屏），但 localStorage 跨调用全丢
//   · --no-sandbox           渲染与存储都正常
//   → 说明被拦截的不止 GPU 沙箱；存储服务（utility 子进程）同样受影响
//
// 本脚本对候选参数逐一实测，判据三项：
//   1. render   页面是否真的加载（URL = http://tauri.localhost/ 且存在 #app）
//   2. storage  localStorage 跨 evaluate 是否留存（关键：同调用内 set+get 会骗人）
//   3. dumps    是否新增崩溃转储
//
// 用法: node app/scripts/probe_args_battery.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const ROOT = path.join(__dirname, '..', '..');
const LOG = path.join(ROOT, 'args_battery.log');
const DUMP_DIR = path.join(os.homedir(), 'AppData', 'Local', 'cn.kanseki.catalog',
  'EBWebView', 'Crashpad', 'reports');

const DEFAULT_FEATURES = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection';

const CASES = [
  { name: '基线（仅默认 features）', args: DEFAULT_FEATURES },
  { name: 'GPU沙箱', args: `${DEFAULT_FEATURES} --disable-gpu-sandbox` },
  { name: '网络沙箱', args: `${DEFAULT_FEATURES} --disable-gpu-sandbox --disable-features=NetworkServiceSandbox` },
  { name: '单进程+GPU沙箱', args: `${DEFAULT_FEATURES} --disable-gpu-sandbox --single-process` },
  { name: '全免沙箱', args: `${DEFAULT_FEATURES} --no-sandbox` },
];

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

function dumpCount() {
  try { return fs.readdirSync(DUMP_DIR).filter(f => f.endsWith('.dmp')).length; } catch (_) { return -1; }
}

function waitForCdp(port, timeoutMs = 32000) {
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

async function runCase(c, idx, chromium) {
  const port = 9240 + idx;
  log(`\n${'='.repeat(66)}\n== ${c.name}\n   ${c.args}\n${'='.repeat(66)}`);

  killApp();
  await new Promise(r => setTimeout(r, 1800));
  const d0 = dumpCount();

  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} ${c.args}`;

  spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' }).unref();

  const res = { name: c.name, args: c.args, render: false, storage: false, url: '', dumps: null };

  if (!(await waitForCdp(port))) {
    log('  !! CDP 未就绪（WebView2 可能已崩溃）');
    res.dumps = dumpCount() - d0;
    killApp();
    return res;
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 20000 });
  } catch (e) {
    log('  !! CDP 连接失败: ' + String(e).slice(0, 100));
    res.dumps = dumpCount() - d0;
    killApp();
    return res;
  }

  let page = null;
  const deadline = Date.now() + 26000;
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

  if (!page) {
    const urls = [];
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) urls.push(p.url());
    log('  !! 未找到应用页; pages=' + JSON.stringify(urls.slice(0, 4)));
    res.dumps = dumpCount() - d0;
    await browser.close(); killApp();
    return res;
  }

  res.url = page.url();
  res.render = /^http:\/\/tauri\.localhost/.test(page.url());
  await page.waitForTimeout(2500);

  // 关键判据：同调用内 set+get 必然成功（内存），跨调用才检验落盘
  await page.evaluate(() => { localStorage.setItem('__bat', 'B1'); });
  await page.waitForTimeout(900);
  const readBack = await page.evaluate(() => localStorage.getItem('__bat'));
  res.storage = readBack === 'B1';

  // 再验证应用自身写 theme 是否留存
  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const themeNext = themeBefore === 'dark' ? 'light' : 'dark';
  await page.evaluate((t) => { localStorage.setItem('theme', t); }, themeNext);
  await page.waitForTimeout(800);
  const themeAfter = await page.evaluate(() => localStorage.getItem('theme'));
  res.appWrite = themeAfter === themeNext;

  log(`  页面 URL = ${res.url}`);
  log(`  跨调用 localStorage 回读 = ${JSON.stringify(readBack)}  → 存储${res.storage ? '正常 ✔' : '失效 ✘'}`);
  log(`  应用写入 theme 留存 = ${res.appWrite ? '是 ✔' : '否 ✘'}`);

  try { await browser.close(); } catch (_) {}
  killApp();
  await new Promise(r => setTimeout(r, 1200));
  res.dumps = dumpCount() - d0;
  log(`  新增崩溃转储 = ${res.dumps}`);
  return res;
}

(async () => {
  process.on('exit', flush);
  process.on('SIGTERM', () => { flush(); process.exit(1); });

  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  log('exe: ' + EXE);
  log('基线转储数 = ' + dumpCount());

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    results.push(await runCase(CASES[i], i, chromium));
    flush();
  }

  log(`\n${'='.repeat(66)}\n== 参数对照结论（渲染 / 存储 / 转储）\n${'='.repeat(66)}`);
  log('结果        渲染    存储    转储   参数');
  for (const r of results) {
    const good = r.render && r.storage;
    log(`${good ? '全好 ✔' : '有问题 ✘'}  ${(r.render ? 'OK ' : 'FAIL')}   ${(r.storage ? 'OK ' : 'FAIL')}   ${String(r.dumps).padStart(3)}   ${r.args.replace(DEFAULT_FEATURES + ' ', '')}`);
  }
  const winners = results.filter(r => r.render && r.storage);
  log('\n同时满足渲染与存储的参数: ' + (winners.length
    ? winners.map(w => w.args.replace(DEFAULT_FEATURES + ' ', '')).join(' | ')
    : '（无）'));
  flush();
  setTimeout(() => process.exit(0), 500).unref();
})();
