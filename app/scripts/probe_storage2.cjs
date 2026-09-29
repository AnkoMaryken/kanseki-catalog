// ================================================
// app/scripts/probe_storage2.cjs — 定位 localStorage 失效原因
// -------------------------------------------------
// 假设：profile 的 Local Storage leveldb 受损/被锁（000003.log 自 14:51 起未再写入，
//   而 History/Favicons 仍在 15:09 更新），导致写入无法提交。
//
// 非破坏性验证：用 WEBVIEW2_USER_DATA_FOLDER 指向一个全新临时目录，
//   若新目录下 storage 正常 → 是旧 profile 存储损坏，清理即可
//   若仍不正常 → 是环境层面的存储禁用
//
// 同时对照 sessionStorage，判断「整个存储层失效」还是「仅 local」
//
// 用法: node app/scripts/probe_storage2.cjs
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
const LOG = path.join(ROOT, 'storage2_probe.log');

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

let PORT = 9230;

async function runCase(title, envExtra) {
  log(`\n${'='.repeat(60)}\n== ${title}\n${'='.repeat(60)}`);
  killApp();
  await new Promise(r => setTimeout(r, 1800));

  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${PORT} --disable-gpu-sandbox`;
  Object.assign(env, envExtra || {});

  spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' }).unref();

  if (!(await waitForCdp(32000))) { log('!! CDP 未就绪'); return null; }
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
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
  if (!page) { log('!! 未找到页面'); await browser.close(); return null; }
  await page.waitForTimeout(2500);

  // A. 同一次 evaluate 内 set+get
  const a = await page.evaluate(() => {
    const o = {};
    try { localStorage.setItem('__s2', 'L1'); o.lSame = localStorage.getItem('__s2'); } catch (e) { o.lErr = String(e); }
    try { sessionStorage.setItem('__s2', 'S1'); o.sSame = sessionStorage.getItem('__s2'); } catch (e) { o.sErr = String(e); }
    return o;
  });
  log('A 同调用内 set+get      :', JSON.stringify(a));

  // B. 下一次 evaluate 回读
  const b = await page.evaluate(() => ({
    l: localStorage.getItem('__s2'),
    s: sessionStorage.getItem('__s2'),
    lLen: localStorage.length,
    sLen: sessionStorage.length,
  }));
  log('B 跨调用回读            :', JSON.stringify(b));

  // C. 真实点击主题，看应用自身的写入是否留存
  await page.evaluate(() => document.querySelector('#themeToggleBtn').click());
  await page.waitForTimeout(900);
  const c1 = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.getItem('theme'),
  }));
  await page.waitForTimeout(2500);
  const c2 = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.getItem('theme'),
  }));
  log('C 点击主题后立刻        :', JSON.stringify(c1));
  log('C 点击主题 2.5s 后      :', JSON.stringify(c2));

  const verdict = {
    localWorks: b.l === 'L1',
    sessionWorks: b.s === 'S1',
    themePersists: !!c2.ls,
    themeApplied: c1.attr === 'dark',
  };
  log('判定:', JSON.stringify(verdict));

  await browser.close();
  killApp();
  await new Promise(r => setTimeout(r, 1200));
  return verdict;
}

(async () => {
  process.on('exit', flush);
  process.on('SIGTERM', () => { flush(); process.exit(1); });

  const results = {};

  // 用例1：当前 profile（预期：storage 失效）
  results['当前 profile'] = await runCase('用例 1：现行 profile（AppData\\Local\\cn.kanseki.catalog）', {});

  // 用例2：全新临时 profile（非破坏性）
  PORT = 9231;
  const fresh = path.join(os.tmpdir(), 'kanseki_fresh_profile_' + Date.now());
  fs.mkdirSync(fresh, { recursive: true });
  log('\n临时 profile 目录: ' + fresh);
  results['全新 profile'] = await runCase('用例 2：全新临时 profile（WEBVIEW2_USER_DATA_FOLDER）',
    { WEBVIEW2_USER_DATA_FOLDER: fresh });

  // 用例3：当前 profile + 禁用存储压缩特性，排除 feature 干扰
  PORT = 9232;
  results['当前 profile + 免沙箱'] = await runCase('用例 3：当前 profile + --no-sandbox',
    { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --no-sandbox` });

  log(`\n${'='.repeat(60)}\n== 结论\n${'='.repeat(60)}`);
  for (const [k, v] of Object.entries(results)) {
    log(`${k}: ${v ? JSON.stringify(v) : '运行失败'}`);
  }
  flush();
  setTimeout(() => process.exit(0), 500).unref();
})();
