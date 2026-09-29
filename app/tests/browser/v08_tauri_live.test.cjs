// ================================================
// app/tests/browser/v08_tauri_live.test.cjs — 真实桌面窗口实测（CDP 直连）
// -------------------------------------------------
// 不同于 v08_ui.test.cjs（浏览器里跑 dist/），本测试连的是
// **真正在运行的 kanseki-app.exe**，验证 Tauri 环境下的实际表现：
//   · isTauri = true 的分支（窗口三键、缩放热区、no-tauri 不加）
//   · 自绘标题栏在实际窗口中的布局与可点击性
//   · 品牌栏 / 弹窗 / 用户菜单在真实 WebView2 中的渲染
//
// 原理：以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   启动 exe，再用 playwright 的 connectOverCDP 接入 WebView2。
//
// 用法（须先确保 8766 静态服务与 dist 就绪）：
//   node app/tests/browser/v08_tauri_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9222;

// 本机存在系统代理（HTTP_PROXY 等）。Playwright 与 WebView2 连 127.0.0.1
// 的调试端口时必须直连，否则被代理截获返回 502 → 拿不到页面目标。
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  // 用 PowerShell 精确结束，避免残留影响下一轮
  try {
    execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' });
  } catch (_) { /* 无进程时 taskkill 返回非 0，忽略 */ }
}

function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', () => {
        if (Date.now() > deadline) resolve(null);
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  if (!require('fs').existsSync(EXE)) {
    console.log('!! 未找到 exe:', EXE);
    console.log('   请先构建：cd app/tauri && ../node_modules/.bin/tauri build --no-bundle');
    process.exit(2);
  }

  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  killApp();
  await new Promise(r => setTimeout(r, 1500));

  console.log('启动 exe（开启远程调试）...');
  // 关键：必须剔除 HTTP_PROXY 等代理变量。本机设有系统代理（如 127.0.0.1:47915），
  // 若继承给 WebView2，连本地调试端口 9222 的请求会被送去代理并返回 502，
  // 导致 CDP 能连通（/json/version 走直连时）但拿不到任何页面目标。
  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  // --no-sandbox：本机安全策略会拦截 WebView2 的沙箱子进程。
  // 若只禁 GPU 沙箱，渲染虽恢复，但承担 localStorage 落盘的 storage service
  // （utility 子进程）仍被拦截 —— 表现为「主题/侧栏状态/登录态切了没反应、重启复位」，
  // 即用户所报「打开后不能用」。故需整体免沙箱（内容均为本地内置，风险可控）。
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT + ' --no-sandbox';

  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const ver = await waitForCdp(35000);
  if (!ver) {
    console.log('!! 未能连上 CDP（WebView2 未开调试端口）');
    killApp();
    process.exit(1);
  }
  console.log('CDP 就绪:', ver.slice(0, 90));

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });

  // WebView2 的页面可能出现在任意 context；遍历所有 context 找应用页
  let page = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        if (/devtools/.test(p.url())) continue;
        try {
          const hasApp = await p.evaluate(() => !!document.getElementById('app'));
          if (hasApp) { page = p; break; }
        } catch (_) { /* 页面仍在导航，跳过 */ }
      }
      if (page) break;
    }
    if (page) break;
    await new Promise(r => setTimeout(r, 600));
  }
  if (!page) {
    const all = [];
    for (const c of browser.contexts()) {
      for (const p of c.pages()) all.push(p.url());
    }
    console.log('!! 未找到应用页面');
    console.log('   contexts=', browser.contexts().length, ' pages=', JSON.stringify(all));
    await browser.close(); killApp(); process.exit(1);
  }
  console.log('已接入页面:', page.url());
  await page.waitForTimeout(2500);

  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // ---------- 0. 复位持久化状态 ----------
  // 存储已能正常落盘（0.8.0 修复的关键成果），因此上一次运行留下的
  // 「侧栏已收起」「已切暗色」等状态会跨启动保留，导致后续断言受历史状态干扰。
  // 每次实测前先归零，保证结果可复现。
  console.log('\n[0] 复位持久化状态');
  const before = await page.evaluate(() => ({
    collapsed: localStorage.getItem('kanseki_app_sidebar_collapsed'),
    theme: localStorage.getItem('theme'),
  }));
  await page.evaluate(() => {
    localStorage.removeItem('kanseki_app_sidebar_collapsed');
    localStorage.removeItem('kanseki_user');
    localStorage.removeItem('theme');
  });
  // 重载一次，让应用从干净状态初始化（避免只改 DOM 类名与实际状态不一致）
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => ({
    collapsed: localStorage.getItem('kanseki_app_sidebar_collapsed'),
    theme: document.documentElement.getAttribute('data-theme'),
  }));
  console.log('   复位前:', JSON.stringify(before), '→ 复位后:', JSON.stringify(after));
  const sbCollapsed = await page.locator('.app-shell.sb-collapsed').count();
  ok('侧栏处于展开状态（底部按钮可点）', sbCollapsed === 0, 'collapsed=' + sbCollapsed);
  ok('侧栏底部按钮可交互', await page.locator('#sideUserBtn').isVisible());

  // ---------- 1. Tauri 环境识别 ----------
  console.log('\n[1] Tauri 环境识别');
  const isTauri = await page.evaluate(() => '__TAURI_INTERNALS__' in window);
  ok('isTauri 为真（真实桌面环境）', isTauri === true, 'isTauri=' + isTauri);
  ok('未标记 no-tauri', await page.locator('.app-shell.no-tauri').count() === 0);

  // ---------- 2. 自绘标题栏（真实窗口） ----------
  console.log('\n[2] 自绘标题栏');
  ok('标题栏存在且可见', await page.locator('.app-titlebar').isVisible());
  const tbBox = await page.locator('.app-titlebar').boundingBox();
  ok('标题栏高度接近 38px', tbBox && Math.abs(tbBox.height - 38) < 3,
    'h=' + (tbBox ? tbBox.height.toFixed(1) : '?'));
  // 标题栏应贴窗口最顶（无原生边框时 y≈0）
  ok('标题栏贴窗口顶部', tbBox && tbBox.y < 2, 'y=' + (tbBox ? tbBox.y : '?'));
  ok('收起侧栏按钮可见可点', await page.locator('#collapseBtn').isEnabled());
  ok('窗口按钮可见可点', await page.locator('#winBtn').isEnabled());
  ok('最小化键可见', await page.locator('#tbMin').isVisible());
  ok('最大化键可见', await page.locator('#tbMax').isVisible());
  ok('关闭键可见', await page.locator('#tbClose').isVisible());
  // 三键贴在窗口右上（right 接近窗口宽度）
  const closeBox = await page.locator('#tbClose').boundingBox();
  const vw = await page.evaluate(() => window.innerWidth);
  ok('关闭键贴右缘', closeBox && (vw - (closeBox.x + closeBox.width)) < 12,
    `gap=${closeBox ? (vw - closeBox.x - closeBox.width).toFixed(1) : '?'} vw=${vw}`);
  // 拖动区
  ok('标题栏有拖动区', await page.locator('[data-tauri-drag-region]').count() >= 1);

  // ---------- 3. 无边框缩放在真实环境生效 ----------
  console.log('\n[3] 缩放热区（真实环境应启用）');
  const rzDisplay = await page.evaluate(() => {
    const el = document.querySelector('#winResize');
    return el ? getComputedStyle(el).display : 'none';
  });
  ok('缩放热区在桌面环境启用', rzDisplay !== 'none', 'display=' + rzDisplay);
  const zones = await page.locator('#winResize [data-dir]').count();
  ok('八向热区齐备', zones === 8, '实际 ' + zones);

  // ---------- 4. 品牌栏 ----------
  console.log('\n[4] 品牌栏');
  ok('品牌栏存在', await page.locator('.side-title').isVisible());
  const brandTx = await page.locator('.side-title .st-tx').textContent();
  ok('品牌名完整', brandTx.trim() === '古代史及汉籍研究工具', brandTx);
  const brandIc = await page.locator('.side-title .st-ic').textContent();
  ok('品牌图标「漢」', brandIc.trim() === '漢', brandIc);

  // ---------- 5. 侧栏底部用户菜单向上弹出 ----------
  console.log('\n[5] 用户菜单方向');
  await page.evaluate(() => localStorage.removeItem('kanseki_user'));
  await page.waitForTimeout(400);
  await page.click('#sideUserBtn');
  await page.waitForTimeout(500);
  ok('用户菜单已展开', await page.locator('#sideUserMenu').isVisible());
  const geo = await page.evaluate(() => {
    const b = document.querySelector('#sideUserBtn').getBoundingClientRect();
    const m = document.querySelector('#sideUserMenu').getBoundingClientRect();
    return { btnTop: b.top, menuTop: m.top, menuBottom: m.bottom };
  });
  ok('菜单弹在按钮上方', geo.menuTop < geo.btnTop,
    `menuTop=${geo.menuTop.toFixed(0)} btnTop=${geo.btnTop.toFixed(0)}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---------- 6. 内容导览弹窗（真实 iframe 联动） ----------
  console.log('\n[6] 内容导览弹窗');
  await page.click('.nav-item[data-view="catalog"][data-tab="0"]');
  await page.waitForTimeout(3000);
  // 确认 iframe 真的加载了（真实环境路径为 pages/）
  const frameCount = page.frames().length;
  ok('存在 iframe 子框架', frameCount >= 2, 'frames=' + frameCount);
  await page.click('.nav-dir[data-dir-open="0"]');
  await page.waitForTimeout(1600);
  ok('弹窗已打开', await page.locator('#anchorPop').isVisible());
  const popN = await page.locator('#anchorPopBody .anchor-item').count();
  ok('弹窗内章节锚点已填充', popN > 5, 'anchor 数 ' + popN);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('Esc 关闭弹窗', await page.locator('#anchorPop').isHidden());

  // ---------- 7. 侧栏收起 / 展开 ----------
  console.log('\n[7] 侧栏收起 / 展开');
  await page.click('.nav-item[data-view="query"]');
  await page.waitForTimeout(2500);
  const beforeW = await page.evaluate(() => document.querySelector('.app-sidebar').getBoundingClientRect().width);
  await page.click('#collapseBtn');
  await page.waitForTimeout(700);
  ok('可收起侧栏', await page.locator('.app-shell.sb-collapsed').count() === 1);
  const afterW = await page.evaluate(() => document.querySelector('.app-sidebar').getBoundingClientRect().width);
  ok('收起后侧栏宽度为 0', afterW < 2, `${beforeW.toFixed(0)} -> ${afterW.toFixed(0)}`);
  await page.click('#collapseBtn');
  await page.waitForTimeout(700);
  ok('可重新展开', await page.locator('.app-shell.sb-collapsed').count() === 0);
  await page.evaluate(() => localStorage.removeItem('kanseki_app_sidebar_collapsed'));

  // ---------- 8. 查询页可用（关键：用户说「不能用」） ----------
  console.log('\n[8] 查询页可用性');
  const qFrame = page.frames().find(f => /pages\/index\.html|pages%2Findex/.test(f.url() || ''));
  ok('查询 iframe 已加载', !!qFrame, qFrame ? qFrame.url().slice(-40) : '未找到');
  if (qFrame) {
    await qFrame.waitForTimeout(1500);
    const input = qFrame.locator('#globalSearch');
    ok('搜索框存在', await input.count() === 1);
    if (await input.count()) {
      await input.fill('万历');
      await page.waitForTimeout(2200);
      const rows = await qFrame.locator('#tableBody tr').count();
      ok('搜索「万历」有结果', rows > 0, 'rows=' + rows);
      const firstCell = await qFrame.locator('#tableBody tr').first().textContent().catch(() => '');
      // 应用默认以繁体显示，故同时接受简繁两种字形
      ok('结果含「万历／萬曆」', /万[历曆]|萬[历曆]/.test(firstCell || ''),
        (firstCell || '').replace(/\s+/g, ' ').trim().slice(0, 40));
    }
    const errs = await qFrame.locator('body').textContent();
    ok('查询页无报错文本', !/undefined|NaN|Error/i.test(errs.slice(0, 3000)));
  }

  // ---------- 9. 主题切换在真实环境生效 ----------
  console.log('\n[9] 主题切换');
  // 起点归零，避免继承上一轮残留值导致「切一次看不出变化」
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(700);
  let th = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const cssTh = await page.evaluate(() => localStorage.getItem('theme'));
  ok('可切到暗色', th === 'dark', `data-theme=${th} localStorage=${cssTh}`);
  const tbBgDark = await page.evaluate(() => getComputedStyle(document.querySelector('.app-titlebar')).backgroundColor);
  ok('标题栏跟随暗色', !/250, 250, 250/.test(tbBgDark), tbBgDark);
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(700);
  th = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const cssTh2 = await page.evaluate(() => localStorage.getItem('theme'));
  ok('可切回亮色', th === 'light', `data-theme=${th} localStorage=${cssTh2}`);

  // ---------- 10. JS 错误 ----------
  const realErrors = errors.filter(e => !/favicon|ERR_|net::/.test(e));
  ok('0 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log(`\n==== 真实桌面窗口实测: ${results.length - fail} 通过, ${fail} 失败 ====`);

  await browser.close();
  killApp();
  setTimeout(() => process.exit(fail ? 1 : 0), 500).unref();
})();
