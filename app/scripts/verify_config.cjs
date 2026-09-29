// ================================================
// app/scripts/verify_config.cjs — 验证「只靠内置配置」的真实表现
// -------------------------------------------------
// 关键：不注入任何 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS（除调试端口外），
//   因为环境变量与配置究竟「合并」还是「替换」必须靠实测确定。
//   若替换：调试端口会顶掉 --no-sandbox → 本脚本会失败 → 说明必须另寻办法。
//   若合并：本脚本通过 → 配置已生效，可放心发布。
//
// 三条判据：
//   1. 渲染   URL = http://tauri.localhost/ 且存在 #app
//   2. 存储   localStorage 跨 evaluate 留存（关键）
//   3. 稳定   20s 内不被杀、无新增崩溃转储
//
// 用法: node app/scripts/verify_config.cjs
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
const LOG = path.join(ROOT, 'verify_config.log');
const DUMP_DIR = path.join(os.homedir(), 'AppData', 'Local', 'cn.kanseki.catalog',
  'EBWebView', 'Crashpad', 'reports');

const PORT = 9260;
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
const dumpCount = () => {
  try { return fs.readdirSync(DUMP_DIR).filter(f => f.endsWith('.dmp')).length; } catch (_) { return -1; }
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

  log('exe: ' + EXE);
  log('基线转储数 = ' + dumpCount());

  killApp();
  await new Promise(r => setTimeout(r, 1800));
  const d0 = dumpCount();

  // 关键点：只加调试端口，沙箱参数完全依赖 tauri.conf.json
  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT;
  log('注入的环境变量 = ' + env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS);
  log('（沙箱参数不在其中，全靠 tauri.conf.json 的 additionalBrowserArgs）');

  const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' });
  child.unref();

  const ver = await waitForCdp(PORT);
  if (!ver) { log('!! CDP 未就绪'); flush(); killApp(); process.exit(1); }
  log('CDP 就绪: ' + ver.replace(/\s+/g, ' ').slice(0, 100));

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
  if (!page) {
    log('!! 未找到应用页面');
    const urls = [];
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) urls.push(p.url());
    log('   pages=' + JSON.stringify(urls.slice(0, 5)));
    flush(); try { await browser.close(); } catch (_) {}
    killApp(); process.exit(1);
  }

  await page.waitForTimeout(2600);
  const results = [];

  // ---- 判据 1：渲染 ----
  const url = page.url();
  const hasApp = await page.evaluate(() => !!document.getElementById('app'));
  const r1 = /^http:\/\/tauri\.localhost/.test(url) && hasApp;
  results.push(['渲染真实页面', r1, url + ' #app=' + hasApp]);
  log(`\n[1] 渲染: ${url}  #app=${hasApp}  → ${r1 ? '✔' : '✘'}`);

  // ---- 判据 2：localStorage 跨调用留存 ----
  await page.evaluate(() => { localStorage.setItem('__vc', 'VC1'); });
  await page.waitForTimeout(1000);
  const back = await page.evaluate(() => localStorage.getItem('__vc'));
  const r2 = back === 'VC1';
  results.push(['localStorage 跨调用留存', r2, '读回=' + JSON.stringify(back)]);
  log(`[2] localStorage 回读 = ${JSON.stringify(back)}  → ${r2 ? '✔' : '✘'}`);

  // 应用自身写入（主题）
  const th0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const thNext = th0 === 'dark' ? 'light' : 'dark';
  await page.evaluate((t) => localStorage.setItem('theme', t), thNext);
  await page.waitForTimeout(900);
  const thStored = await page.evaluate(() => localStorage.getItem('theme'));
  const r2b = thStored === thNext;
  results.push(['应用写入 theme 留存', r2b, `set=${thNext} 读回=${thStored}`]);
  log(`[2b] theme 写入 ${thNext} → 读回 ${thStored}  → ${r2b ? '✔' : '✘'}`);

  // 真实点击主题按钮，验证 UI 状态跨点击正确
  await page.evaluate(() => localStorage.removeItem('theme'));
  await page.evaluate(() => document.querySelector('#themeToggleBtn').click());
  await page.waitForTimeout(800);
  const thA = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.evaluate(() => document.querySelector('#themeToggleBtn').click());
  await page.waitForTimeout(800);
  const thB = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const r2c = thA === 'dark' && thB === 'light';
  results.push(['连点两次主题可正常来回', r2c, `${th0} → ${thA} → ${thB}`]);
  log(`[2c] 连点主题: ${th0} → ${thA} → ${thB}  → ${r2c ? '✔' : '✘'}`);

  // ---- 判据 3：稳定性（20s） ----
  log('\n[3] 稳定性观测 20s...');
  let alive = true;
  for (let i = 5; i <= 20; i += 5) {
    await page.waitForTimeout(5000);
    const resp = await page.evaluate(() => !!document.getElementById('app')).catch(() => false);
    log(`   T+${i}s 页面响应=${resp}`);
    if (!resp) alive = false;
  }
  results.push(['20s 内持续响应', alive, '']);

  const dt = dumpCount() - d0;
  const r3 = alive && dt === 0;
  results.push(['无新增崩溃转储', dt === 0, '新增=' + dt]);
  log(`[3] 新增崩溃转储 = ${dt}  → ${dt === 0 ? '✔' : '✘'}`);

  // 顺手验证几个依赖 localStorage 的功能
  log('\n[4] 依赖存储的功能');
  const mech = await page.evaluate(() => {
    // 侧栏收起状态依赖 localStorage
    const before = document.querySelector('.app-shell').className;
    document.querySelector('#collapseBtn').click();
    const after = document.querySelector('.app-shell').className;
    return { before, after, ls: localStorage.getItem('kanseki_app_sidebar_collapsed') };
  });
  const r4 = /sb-collapsed/.test(mech.after) && mech.ls === '1';
  results.push(['侧栏收起状态落盘', r4, JSON.stringify(mech)]);
  log('   侧栏收起: ' + JSON.stringify(mech) + ' → ' + (r4 ? '✔' : '✘'));

  log(`\n${'='.repeat(62)}\n== 结论（仅内置配置 + 调试端口）\n${'='.repeat(62)}`);
  let fail = 0;
  for (const [n, pass, extra] of results) {
    log(`${pass ? 'PASS' : 'FAIL'} | ${n}${extra ? ' | ' + extra : ''}`);
    if (!pass) fail++;
  }
  log(`\n${results.length - fail} 通过, ${fail} 失败`);
  if (fail === 0) {
    log('\n→ 内置配置已足够：环境变量与配置参数可共存，发布可信。');
  } else {
    log('\n→ 存在失败项！说明环境变量可能替换了配置参数，需改用其他注入方式。');
  }

  flush();
  try { await browser.close(); } catch (_) {}
  killApp();
  setTimeout(() => process.exit(fail ? 1 : 0), 500).unref();
})();
