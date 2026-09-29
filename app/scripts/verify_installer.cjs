/* ================================================
 * verify_installer.cjs — 实测「安装版」能否正常安装并运行
 * -------------------------------------------------
 * 为什么必须实测：安装包是本软件分享给他人时的**首选方式**，但打包成功
 *   不等于装得上、装得上不等于能用。本脚本在**临时目录**里静默安装一份，
 *   然后启动装出来的程序验证功能，最后卸载并清理 —— 全程不污染系统。
 *
 * 覆盖：
 *   ① 静默安装能成功（退出码 0 + 目标 exe 落盘）
 *   ② 装出来的程序能启动、界面与数据正常
 *   ③ 安装目录内是否有卸载程序
 *   ④ 卸载后文件被清理
 *
 * 用法：node scripts/verify_installer.cjs [setup.exe 路径]
 *   NSIS 的 /D= 必须是**最后一个参数**且**不加引号**（NSIS 的硬性规定）。
 *   注意：须串行运行。
 * ================================================ */
'use strict';
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync, spawnSync } = require('child_process');
const http = require('http');
const config = require('../../tests/helpers/config.js');

const SETUP = process.argv[2] || (() => {
  const dir = path.join(__dirname, '..', 'tauri', 'target', 'release', 'bundle', 'nsis');
  const f = fs.readdirSync(dir).find(x => x.endsWith('-setup.exe'));
  return path.join(dir, f);
})();
const PORT = 9237;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + '  ' + (detail || '')); }
}
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
async function pickAppPage(ctx, deadline) {
  while (Date.now() < deadline) {
    for (const p of ctx.pages()) {
      let has = false;
      try { has = await p.evaluate(() => !!document.getElementById('app')); } catch (_) { /* 导航中 */ }
      if (has) return p;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('未找到应用页');
}
// 递归查找文件（用于找 exe 与卸载程序）
function findFiles(root, test, out = [], depth = 0) {
  if (depth > 4 || !fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) findFiles(p, test, out, depth + 1);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  if (!fs.existsSync(SETUP)) throw new Error('安装包不存在：' + SETUP);
  const setupSize = (fs.statSync(SETUP).size / 1024 / 1024).toFixed(2);
  console.log(`安装包: ${path.basename(SETUP)}（${setupSize} MB）`);

  // 安装到临时目录，避免污染系统（也便于之后整目录删除）
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanseki-inst-'));
  console.log(`安装目标目录: ${installDir}`);
  ok('安装目标目录为空（干净起点）', fs.readdirSync(installDir).length === 0);

  // ---------- ① 静默安装 ----------
  // NSIS 参数：/S 静默，/D=目标目录（必须是最后一个参数，且不能加引号）
  console.log('\n[1] 静默安装');
  killApp();
  const t0 = Date.now();
  const r = spawnSync(SETUP, ['/S', `/D=${installDir}`], {
    stdio: 'ignore', windowsHide: true, timeout: 180000,
  });
  const elapsed = Date.now() - t0;
  console.log(`    安装返回码: ${r.status}  耗时 ${elapsed}ms`);
  ok('安装器正常退出（退出码 0）', r.status === 0, 'status=' + r.status);

  // NSIS 静默安装会立即返回、后台继续解压，需等文件落盘稳定
  let exes = [], installStable = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(res => setTimeout(res, 1000));
    exes = findFiles(installDir, n => n.toLowerCase().endsWith('.exe'));
    if (exes.length) {
      // 连续两次探测文件数一致，认为解压完成
      const before = exes.length + fs.statSync(exes[0]).size;
      await new Promise(res => setTimeout(res, 800));
      if (before === exes.length + fs.statSync(exes[0]).size) { installStable++; if (installStable >= 1) break; }
    }
  }
  console.log('    安装目录内 exe: ' + JSON.stringify(exes.map(p => path.basename(p))));
  ok('安装后主程序 exe 已落盘', exes.length > 0, exes.length + ' 个 exe');

  const mainExe = exes.find(p => /kanseki-app/i.test(path.basename(p)))
    || exes.find(p => !/uninst/i.test(path.basename(p)));
  ok('找到主程序（非卸载程序）', !!mainExe, mainExe ? path.basename(mainExe) : '无');
  if (!mainExe) throw new Error('未找到主程序，无法继续');

  // 安装目录内应包含卸载程序
  const uninstallers = findFiles(installDir, n => /uninst/i.test(n));
  console.log('    卸载程序: ' + JSON.stringify(uninstallers.map(p => path.basename(p))));
  ok('安装目录内有卸载程序', uninstallers.length > 0, uninstallers.map(p => path.basename(p)).join(','));

  // 前端资源应已随包安装（用于确认不是「装了个空壳」）
  const hasPages = fs.existsSync(path.join(installDir, 'pages')) || findFiles(installDir, n => n === 'catalog.html').length > 0;
  console.log('    是否含 pages 资源: ' + hasPages + '（Tauri 版资源通常已嵌入 exe，不含也正常）');

  // ---------- ② 启动装出来的程序 ----------
  console.log('\n[2] 启动安装后的程序');
  const size = (fs.statSync(mainExe).size / 1024 / 1024).toFixed(2);
  console.log(`    主程序: ${path.basename(mainExe)}（${size} MB）`);
  spawn(mainExe, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    stdio: 'ignore',
  });
  await waitCdp(40000);
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await pickAppPage(ctx, Date.now() + 20000);

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.message || e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

  await page.waitForFunction(() => window.__kansekiAppReady === true, null, { timeout: 20000 })
    .catch(() => console.log('    ⚠️ 就绪标记超时'));
  await page.waitForTimeout(2500);

  const ui = await page.evaluate(() => {
    const t = document.getElementById('tbMax');
    const f = document.getElementById('queryFrame');
    let doc = null;
    try { doc = f && f.contentDocument; } catch (e) { /* 忽略 */ }
    return {
      title: document.title,
      titlebar: !!document.querySelector('.app-titlebar'),
      langBtn: !!document.getElementById('langToggleBtn'),
      maxVisibleIcons: t ? [...t.querySelectorAll('svg')].filter(s => {
        const cs = getComputedStyle(s); const r = s.getBoundingClientRect();
        return cs.display !== 'none' && r.width > 0;
      }).length : -1,
      heads: doc ? [...doc.querySelectorAll('#tableHead th')].map(x => x.textContent.trim()).slice(0, 4) : [],
      rows: doc ? doc.querySelectorAll('tbody tr').length : -1,
    };
  });
  console.log('    ' + JSON.stringify({ title: ui.title, rows: ui.rows, heads: ui.heads }));
  ok('安装后的程序能启动', !!ui.title, ui.title);
  ok('界面已渲染（标题栏 + 简繁按钮）', ui.titlebar && ui.langBtn);
  ok('查询数据已加载', ui.rows > 0, 'rows=' + ui.rows);
  ok('最大化按钮仍只有 1 个图标（本轮修复已生效）', ui.maxVisibleIcons === 1, 'visible=' + ui.maxVisibleIcons);

  // 窗口命令（确认装出来的版本功能完整）
  const winOk = await page.evaluate(async () => {
    try {
      const inv = (c, a) => window.__TAURI_INTERNALS__.invoke('plugin:window|' + c, a);
      await inv('maximize', { label: 'main' });
      await new Promise(r => setTimeout(r, 900));
      const m = await inv('is_maximized', { label: 'main' });
      await inv('unmaximize', { label: 'main' });
      return { ok: true, maximized: m };
    } catch (e) { return { ok: false, err: String(e).slice(0, 150) }; }
  });
  ok('窗口命令在安装版中可用', winOk.ok === true && winOk.maximized === true, JSON.stringify(winOk));

  const real = errors.filter(e => !/favicon/i.test(e));
  ok('运行期 0 JS 错误', real.length === 0, real.length ? real.join(' | ').slice(0, 200) : '无');

  await browser.close();
  killApp();
  await new Promise(res => setTimeout(res, 800));

  // ---------- ③ 卸载测试 ----------
  console.log('\n[3] 卸载');
  let mainGone = false, selfLeft = null, uninstDetail = '';
  if (uninstallers.length) {
    try {
      const u = uninstallers[0];
      // NSIS 卸载器同样支持 /S 静默；_?= 指定安装目录
      const ur = spawnSync(u, ['/S', `_?=${installDir}`], { stdio: 'ignore', windowsHide: true, timeout: 120000 });
      uninstDetail = 'status=' + ur.status;
      // 静默卸载后台执行，稍等再看目录是否清空
      for (let i = 0; i < 30; i++) {
        await new Promise(res => setTimeout(res, 1000));
        const remain = findFiles(installDir, n => n.toLowerCase().endsWith('.exe'));
        if (remain.length === 0) break;
      }
      const remain = findFiles(installDir, n => n.toLowerCase().endsWith('.exe'));
      const remainNames = remain.map(p => path.basename(p));
      mainGone = !remainNames.some(n => /kanseki-app/i.test(n));
      selfLeft = remainNames.find(n => /uninst/i.test(n)) || null;
      uninstDetail += ` 残留=[${remainNames.join(',')}]`;
    } catch (e) { uninstDetail = String(e).slice(0, 150); }
  }
  console.log('    卸载结果: ' + uninstDetail);
  // 断言「主程序被移除」——这才是用户关心的。
  // 卸载器自身（uninstall.exe，约 80KB）常常留在原地，属 NSIS 的固有行为：
  // 程序运行期间无法删除自己，通常留待重启后清理（微软商店/微信等大量软件同样如此）。
  // 故只把残留卸载器作为**提示信息**记录，不作为失败项，避免误报。
  ok('卸载后主程序已移除', mainGone, uninstDetail);
  if (selfLeft) {
    console.log(`    注：残留卸载器 ${selfLeft}（NSIS 固有行为，程序运行中无法自删，通常重启后清理）`);
  }

  // 清理临时安装目录
  try { fs.rmSync(installDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  console.log('\n' + '='.repeat(56));
  console.log(`  安装版实测（静默装到临时目录，未污染系统）: ${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(56));
  if (fail) { console.log('失败项: ' + failures.join(', ')); process.exit(1); }
  setTimeout(() => process.exit(0), 300).unref();
})().catch(e => { console.error('验证异常: ' + (e && e.stack || e)); killApp(); process.exit(1); });
