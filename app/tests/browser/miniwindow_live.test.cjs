// ================================================
// app/tests/browser/miniwindow_live.test.cjs — 「纪年小窗」真机实测（CDP 直连）
// -------------------------------------------------
// 验证的是**真链路**：主窗口点「纪年小窗」行尾按钮 → Rust open_mini_window
// → 第二窗口按 tauri.conf.json 的 mini 配置创建（460x620、decorations:false、
// always_on_top:true）→ 小窗页面查年份、复制、切换置顶、关闭（隐藏）。
//
// 用例：
//   [1] 主窗口存在「纪年小窗」行尾按钮（.nav-mini）
//   [2] 点击后真的出现第二窗口（URL = mini.html）
//   [3] 小窗首屏自动出当年结果
//   [4] 查 1587 → 万历十五年 / 丁亥 / 明神宗
//   [5] 点行复制 → window.__miniLastCopied 形如「万历十五年（1587）」
//   [6] 置顶开关：配置为 alwaysOnTop → 回读 aria-pressed=true；点击后能翻转（ACL+命令可用）
//   [7] 窗口尺寸接近配置值（460x620）
//   [8] 点关闭：窗口被隐藏而非销毁（再次点主窗口按钮能重新打开，无报错）
//   [9] 全程无页面脚本错误
//
// 用法： node app/tests/browser/miniwindow_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9229;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); }
  catch (_) { /* 无进程时忽略 */ }
  // 一并清理 WebView2 子进程：强杀应用会留下孤儿 msedgewebview2，
  // 它们锁住用户数据目录后，下一次启动会 panic（failed to create webview 0x8007139F）。
  try { execFileSync('taskkill', ['/F', '/IM', 'msedgewebview2.exe'], { stdio: 'ignore' }); }
  catch (_) { /* 无进程时忽略 */ }
}

function waitForCdp(timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', () => { if (Date.now() > deadline) resolve(null); else setTimeout(tick, 500); });
    };
    tick();
  });
}

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  if (!require('fs').existsSync(EXE)) { console.log('!! 未找到 exe:', EXE); process.exit(2); }

  // 发布门禁：exe 必须晚于全部前端/Rust 源文件
  {
    const fs2 = require('fs');
    const newest = { t: 0, f: '' };
    const walk = (d) => {
      for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { const t = fs2.statSync(p).mtimeMs; if (t > newest.t) { newest.t = t; newest.f = p; } }
      }
    };
    for (const r of [path.join(__dirname, '..', '..', 'src'), path.join(__dirname, '..', '..', 'tauri', 'src')]) {
      if (fs2.existsSync(r)) walk(r);
    }
    const exeT = fs2.statSync(EXE).mtimeMs;
    if (exeT < newest.t) {
      console.log('!! exe 早于源文件，必须先重新打包');
      console.log('   exe = ' + new Date(exeT).toISOString() + ' / 最新源 = ' + newest.f + ' @ ' + new Date(newest.t).toISOString());
      process.exit(3);
    }
    console.log('exe 新鲜度检查通过（晚于 ' + path.relative(path.join(__dirname, '..', '..'), newest.f) + '）');
  }

  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
    console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  [' + extra + ']' : ''));
  };

  killApp();
  await new Promise((r) => setTimeout(r, 1500));

  console.log('启动 exe（远程调试 ' + PORT + '）...');
  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT + ' --no-sandbox';
  spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' }).unref();

  if (!await waitForCdp()) { console.log('!! 未能连上 CDP'); killApp(); process.exit(1); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });

  // 找主窗口页面
  let main = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !main) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        if (/devtools/.test(p.url())) continue;
        try { if (await p.evaluate(() => !!document.getElementById('app'))) { main = p; break; } } catch (_) { /* 导航中 */ }
      }
      if (main) break;
    }
    if (!main) await new Promise((r) => setTimeout(r, 600));
  }
  if (!main) { console.log('!! 未找到主窗口页面'); await browser.close(); killApp(); process.exit(1); }
  console.log('已接入主窗口:', main.url());

  const errors = [];
  main.on('pageerror', (e) => errors.push('MAIN: ' + e.message));

  const findMini = async (timeoutMs = 20000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      for (const c of browser.contexts()) {
        for (const p of c.pages()) {
          if (/mini\.html/.test(p.url())) return p;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };

  // ---------- 1. 入口按钮 ----------
  console.log('\n[1] 主窗口入口');
  ok('存在「纪年小窗」行尾按钮', (await main.locator('#miniYearBtn.nav-mini').count()) === 1);
  // 配置里 visible:false，启动时该窗口可能已创建但处于隐藏态（与设置窗口同一机制）
  const preMini = await findMini(2500);
  const preVis = preMini ? await preMini.evaluate(() => document.visibilityState) : 'absent';
  ok('启动时小窗未显示（隐藏或尚未创建）', preVis === 'absent' || preVis === 'hidden', String(preVis));

  // ---------- 2. 点击 → 显示/创建第二窗口 ----------
  console.log('\n[2] 打开小窗（Rust open_mini_window + 配置窗口）');
  await main.click('#miniYearBtn');
  const mini = await findMini();
  ok('存在 mini 窗口', !!mini, mini ? mini.url() : '未出现');
  if (!mini) { await browser.close(); killApp(); process.exit(1); }
  const miniErrors = [];
  mini.on('pageerror', (e) => miniErrors.push('MINI: ' + e.message));
  await mini.waitForTimeout(1500);
  ok('小窗已显示（visibilityState=visible）',
    (await mini.evaluate(() => document.visibilityState)) === 'visible',
    await mini.evaluate(() => document.visibilityState));

  // ---------- 3. 首屏自动出结果 ----------
  console.log('\n[3] 小窗首屏');
  ok('页面已就绪（__miniReady）', await mini.evaluate(() => !!window.__miniReady));
  ok('纪年数据已加载（2868 行）', (await mini.evaluate(() => window.__miniRowCount || 0)) >= 2000,
    String(await mini.evaluate(() => window.__miniRowCount || 0)));
  const firstRows = await mini.locator('#miniTbody tr').count();
  ok('首屏自动出当年结果', firstRows > 0, 'rows=' + firstRows);
  ok('非 Tauri 判定为 false（真窗口）', !(await mini.evaluate(() => document.documentElement.classList.contains('mini-no-tauri'))));

  // ---------- 4. 检索 ----------
  console.log('\n[4] 检索 1587');
  await mini.fill('#miniInput', '1587');
  await mini.click('#miniBtn');
  await mini.waitForTimeout(800);
  const tbl = (await mini.locator('#miniTbody').textContent()) || '';
  // 页面按用户当前的简繁偏好渲染（本机偏好可能是繁体），两种字形都接受
  ok('含「万历十五年」', tbl.includes('万历十五年') || tbl.includes('萬曆十五年'), tbl.replace(/\s+/g, ' ').slice(0, 60));
  ok('含干支「丁亥」', tbl.includes('丁亥'));
  ok('含「明神宗」', tbl.includes('明神宗'));
  ok('含日本年号「天正十五年」', tbl.includes('天正十五年'));

  // ---------- 5. 复制 ----------
  console.log('\n[5] 复制');
  await mini.locator('#miniTbody tr').first().click();
  await mini.waitForTimeout(400);
  const copied = await mini.evaluate(() => window.__miniLastCopied || '');
  ok('复制内容形如「万历十五年（1587）」（简繁皆可）',
    /(万历|萬曆)十五年（1587）/.test(copied), copied);

  // ---------- 6. 置顶 ----------
  console.log('\n[6] 置顶开关（配置 alwaysOnTop:true → ACL/命令可用）');
  const topAttr = await mini.getAttribute('#miniTop', 'aria-pressed');
  ok('初始为置顶（配置生效）', topAttr === 'true', String(topAttr));
  await mini.click('#miniTop');
  await mini.waitForTimeout(700);
  const topAfter = await mini.getAttribute('#miniTop', 'aria-pressed');
  ok('点击后可取消置顶', topAfter === 'false', String(topAfter));
  await mini.click('#miniTop');
  await mini.waitForTimeout(700);
  ok('可再置顶', (await mini.getAttribute('#miniTop', 'aria-pressed')) === 'true');

  // ---------- 7. 窗口尺寸 ----------
  console.log('\n[7] 尺寸（配置 460x620）');
  const box = await mini.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  ok('宽接近 460', Math.abs(box.w - 460) <= 24, JSON.stringify(box));
  ok('高接近 620', Math.abs(box.h - 620) <= 24, JSON.stringify(box));

  // ---------- 8. 关闭 = 隐藏，可再打开 ----------
  console.log('\n[8] 关闭应为隐藏（可反复打开）');
  // 从**主窗口**那边查 mini 窗口的真实可见性（ACL 已允许 is-visible）——
  // 比只读 document.visibilityState 可靠：WebView2 隐藏窗口时该值未必立刻翻转。
  const isVisibleMini = async () => {
    try {
      return await main.evaluate(async () => {
        try { return await window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'mini' }); }
        catch (e) { return 'ERR:' + (e && e.message ? e.message : e); }
      });
    } catch (_) { return 'ERR'; }
  };
  ok('关闭前 mini 窗口可见', (await isVisibleMini()) === true, String(await isVisibleMini()));
  await mini.click('#miniClose');
  await mini.waitForTimeout(1500);
  const visAfter = await isVisibleMini();
  ok('关闭后 mini 窗口被隐藏（未销毁）', visAfter === false, String(visAfter));
  await main.click('#miniYearBtn');
  await main.waitForTimeout(1800);
  const mini2 = await findMini(8000);
  ok('可再次打开小窗', !!mini2);
  ok('再次打开后 mini 窗口可见', (await isVisibleMini()) === true, String(await isVisibleMini()));

  // ---------- 9. 错误 ----------
  ok('主窗口 0 脚本错误', errors.length === 0, errors.slice(0, 3).join(' ;; '));
  ok('小窗 0 脚本错误', miniErrors.length === 0, miniErrors.slice(0, 3).join(' ;; '));

  let fail = 0;
  for (const r of results) if (r.startsWith('FAIL')) fail++;
  console.log('\nTOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close().catch(() => {});
  killApp();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('!! 测试异常：' + (e && e.stack ? e.stack : e));
  killApp();
  process.exit(1);
});
