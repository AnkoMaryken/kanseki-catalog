/* ================================================
 * verify_portable.cjs — 验证「免安装版」可独立运行
 * -------------------------------------------------
 * 目的：发布给他人时，除安装包外还提供免安装版（单个 exe，双击即用）。
 *   本脚本把 exe 复制到**一个干净的临时目录**（目录内只有这一个文件，
 *   没有 dist / pages / 任何配套资源），启动后断言界面与数据正常，
 *   以证明前端资源确实已嵌入 exe、真正可独立运行。
 *
 * 用法：node scripts/verify_portable.cjs [exe路径]
 *   默认取 tauri/target/release/kanseki-app.exe
 *
 * 注意：须串行运行；运行前先 taskkill kanseki-app.exe。
 * ================================================ */
'use strict';
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../tests/helpers/config.js');

const SRC_EXE = process.argv[2] || path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9236;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + '  ' + (detail || '')); }
}

// ⚠️ V9.0 修复：本脚本会把 exe **改名**为「古代史及汉籍研究工具.exe」在临时目录启动，
//    但原先只 taskkill 原名 kanseki-app.exe → 改名副本不会被回收，它会持续占用
//    单实例互斥量（Local\cn.kanseki.catalog.singleinstance），导致**下一次任何启动
//    在 1 秒内以退出码 0 静默退出、CDP 永远连不上**（表现为「CDP 未就绪」）。
//    故两个进程名都要清。同名副本在临时目录里，taskkill /IM 按映像名即可命中。
const APP_IMAGE_NAMES = ['kanseki-app.exe', '古代史及汉籍研究工具.exe'];
function killApp() {
  for (const name of APP_IMAGE_NAMES) {
    try { execFileSync('taskkill', ['/F', '/IM', name], { stdio: 'ignore' }); } catch (e) { /* 未运行 */ }
  }
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
// 找到真正的应用页（接入时可能仍在导航）
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

(async () => {
  // ---------- 0. 准备干净目录 ----------
  if (!fs.existsSync(SRC_EXE)) throw new Error('exe 不存在：' + SRC_EXE);
  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanseki-portable-'));
  const exe = path.join(isoDir, '古代史及汉籍研究工具.exe');
  fs.copyFileSync(SRC_EXE, exe);
  console.log('隔离测试目录: ' + isoDir);
  console.log('目录内容: ' + JSON.stringify(fs.readdirSync(isoDir)));
  ok('隔离目录内仅 exe 一个文件（无任何配套资源）',
    fs.readdirSync(isoDir).length === 1, JSON.stringify(fs.readdirSync(isoDir)));

  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  killApp();
  await new Promise(r => setTimeout(r, 1200));
  spawn(exe, [], {
    env: Object.assign({}, process.env, {
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
    }),
    stdio: 'ignore',
  });
  await waitCdp(30000);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const ctx = browser.contexts()[0];
  const page = await pickAppPage(ctx, Date.now() + 20000);

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.message || e).slice(0, 200)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

  // 等外壳就绪
  await page.waitForFunction(() => window.__kansekiAppReady === true, null, { timeout: 20000 })
    .catch(() => console.log('  ⚠️ 就绪标记超时'));
  await page.waitForTimeout(2500);

  // ---------- 1. 外壳与标题栏 ----------
  console.log('\n[1] 外壳与标题栏');
  const shell = await page.evaluate(() => {
    const q = (s) => !!document.querySelector(s);
    const t = document.getElementById('tbMax');
    return {
      title: document.title,
      app: q('#app'), titlebar: q('.app-titlebar'),
      tbMin: q('#tbMin'), tbMax: q('#tbMax'), tbClose: q('#tbClose'),
      langBtn: q('#langToggleBtn'),
      sidebar: q('#sidebar'),
      // 最大化按钮只应有一个图标可见（本轮修复项，发布前再确认一次）
      maxVisibleIcons: t ? [...t.querySelectorAll('svg')].filter(s => {
        const cs = getComputedStyle(s);
        const r = s.getBoundingClientRect();
        return cs.display !== 'none' && r.width > 0;
      }).length : -1,
    };
  });
  ok('页面标题正确', /古代史及汉籍研究工具/.test(shell.title), shell.title);
  ok('外壳与标题栏已渲染', shell.app && shell.titlebar);
  ok('标题栏三键齐全', shell.tbMin && shell.tbMax && shell.tbClose);
  ok('一键简繁按钮存在', shell.langBtn === true);
  ok('侧栏已渲染', shell.sidebar === true);
  ok('最大化按钮仅 1 个图标可见', shell.maxVisibleIcons === 1, 'visible=' + shell.maxVisibleIcons);

  // ---------- 2. 内嵌页面（证明 pages/ 资源已嵌入） ----------
  console.log('\n[2] 内嵌页面资源（dist/pages 已嵌入 exe）');
  const frames = await page.evaluate(() => {
    const f = document.getElementById('queryFrame');
    let doc = null;
    try { doc = f && f.contentDocument; } catch (e) { /* 忽略 */ }
    const heads = doc ? [...doc.querySelectorAll('#tableHead th')].map(x => x.textContent.trim()) : [];
    // 数一下已渲染的数据行
    const rows = doc ? doc.querySelectorAll('tbody tr').length : -1;
    // 字形接口（证明 conv_tables 等脚本已载入）
    let langApi = false;
    try { langApi = !!(f.contentWindow && f.contentWindow.KansekiLang); } catch (e) { /* 忽略 */ }
    return { hasDoc: !!doc, heads: heads, rowCount: rows, langApi: langApi };
  });
  console.log('    查询页: ' + JSON.stringify({ heads: frames.heads.slice(0, 4), rowCount: frames.rowCount, langApi: frames.langApi }));
  ok('查询页已载入', frames.hasDoc === true);
  ok('表头已渲染（前端脚本已执行）', frames.heads.length > 0, frames.heads.join('|').slice(0, 60));
  ok('数据行已渲染', frames.rowCount > 0, 'rows=' + frames.rowCount);
  ok('简繁接口可用（conv_tables 已载入）', frames.langApi === true);

  // ---------- 3. 其它页面可达 ----------
  console.log('\n[3] 其它内嵌页面');
  const pages = await page.evaluate(async () => {
    const check = async (hash, frameId, marker) => {
      location.hash = hash;
      await new Promise(r => setTimeout(r, 2200));
      const f = document.getElementById(frameId);
      let doc = null;
      try { doc = f && f.contentDocument; } catch (e) { /* 忽略 */ }
      const url = (() => { try { return f.contentWindow.location.href; } catch (e) { return null; } })();
      return { hash, url, loaded: !!(doc && doc.body && doc.body.childElementCount > 0), marker: doc ? !!doc.querySelector(marker) : false };
    };
    return [
      await check('#/catalog', 'catalogFrame', '.tab-btn'),
      await check('#/guide', 'guideFrame', 'body'),
      await check('#/changelog', 'changelogFrame', 'body'),
    ];
  });
  pages.forEach(p => console.log('    ' + p.hash + ' → ' + (p.url || '(未加载)') + ' loaded=' + p.loaded));
  ok('编目规范页可加载', pages[0].loaded === true, String(pages[0].url));
  ok('使用介绍页可加载', pages[1].loaded === true, String(pages[1].url));
  ok('更新日志页可加载', pages[2].loaded === true, String(pages[2].url));

  // ---------- 4. 工作手册 PDF ----------
  console.log('\n[4] 工作手册 PDF');
  const pdf = await page.evaluate(async () => {
    try {
      const r = await fetch('pages/docs/manual.pdf');
      const b = await r.arrayBuffer();
      const head = new Uint8Array(b.slice(0, 4));
      return { status: r.status, size: b.byteLength, magic: String.fromCharCode(...head) };
    } catch (e) { return { error: String(e) }; }
  });
  console.log('    ' + JSON.stringify(pdf));
  ok('工作手册 PDF 已嵌入且可读', pdf.status === 200 && pdf.magic === '%PDF', JSON.stringify(pdf));

  // ---------- 5. 窗口命令仍可用 ----------
  console.log('\n[5] 窗口命令');
  const winCmd = await page.evaluate(async () => {
    try {
      const inv = (c, a) => window.__TAURI_INTERNALS__.invoke('plugin:window|' + c, a);
      const before = await inv('is_maximized', { label: 'main' });
      await inv('maximize', { label: 'main' });
      await new Promise(r => setTimeout(r, 900));
      const after = await inv('is_maximized', { label: 'main' });
      return { ok: true, before, after, size: window.innerWidth + 'x' + window.innerHeight };
    } catch (e) { return { ok: false, err: String(e).slice(0, 160) }; }
  });
  console.log('    ' + JSON.stringify(winCmd));
  ok('窗口命令可用（免安装版功能完整）', winCmd.ok === true && winCmd.after === true, JSON.stringify(winCmd));

  // 还原窗口
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|unmaximize', { label: 'main' }).catch(() => { }));
  await page.waitForTimeout(1200);

  // ---------- 6. JS 错误 ----------
  console.log('\n[6] 运行期 JS 错误');
  const real = errors.filter(e => !/favicon|ERR_FILE_NOT_FOUND.*favicon/i.test(e));
  console.log('    ' + (real.length ? '\n    ' + real.join('\n    ') : '无'));
  ok('0 JS 错误', real.length === 0, real.length ? real.length + ' 条' : '无');

  await browser.close();
  killApp();
  await new Promise(r => setTimeout(r, 500));
  // 清理自建临时目录（仅删本脚本刚创建的那一个）
  try { fs.rmSync(isoDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  console.log('\n' + '='.repeat(56));
  console.log(`  免安装版独立运行验证: ${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(56));
  if (fail) { console.log('失败项: ' + failures.join(', ')); process.exit(1); }
  setTimeout(() => process.exit(0), 300).unref();
})().catch(e => { console.error('验证异常: ' + (e && e.stack || e)); killApp(); process.exit(1); });
