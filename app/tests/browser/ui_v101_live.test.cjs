// ================================================
// app/tests/browser/ui_v101_live.test.cjs — V10.1 三项调整真机实测（CDP 直连）
// ================================================
//   [1] 详细检索浮层展开时，「显示件数」按钮**不得**盖在浮层上面
//       （即浮层在上；收起浮层后按钮恢复可点、下拉可用）
//   [2] 使用介绍页内容完善：覆盖下载、批量、下载中心、托盘等章节
//   [3] 侧栏「分类表查询」旁有**红色「未调整」**标记
//
// 用法： node app/tests/browser/ui_v101_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9228;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const name = (line.split('","')[0] || '').replace(/^"/, '');
      if (!name) continue;
      if (/^kanseki-app\.exe$/i.test(name) || /古代史及汉籍研究工具/.test(name)) {
        try { execFileSync('taskkill', ['/F', '/IM', name], { stdio: 'ignore' }); } catch (_) { }
      }
    }
  } catch (_) { }
  try { execFileSync('taskkill', ['/F', '/IM', 'msedgewebview2.exe'], { stdio: 'ignore' }); } catch (_) { }
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
  if (!fs.existsSync(EXE)) { console.log('!! 未找到 exe:', EXE); process.exit(2); }
  {
    const newest = { t: 0, f: '' };
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { const t = fs.statSync(p).mtimeMs; if (t > newest.t) { newest.t = t; newest.f = p; } }
      }
    };
    for (const r of [path.join(__dirname, '..', '..', 'src'), path.join(__dirname, '..', '..', 'tauri', 'src')]) {
      if (fs.existsSync(r)) walk(r);
    }
    if (fs.statSync(EXE).mtimeMs < newest.t) { console.log('!! exe 早于源文件，请先重新打包'); process.exit(3); }
  }

  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
    console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  [' + extra + ']' : ''));
  };

  killApp();
  await new Promise((r) => setTimeout(r, 1500));
  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*'; env.no_proxy = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT + ' --no-sandbox';
  const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' });
  child.unref();

  if (!(await waitForCdp())) { console.log('!! 未能连上 CDP'); killApp(); process.exit(1); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });
  let page = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !page) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        if (/devtools/.test(p.url())) continue;
        try { if (await p.evaluate(() => !!document.getElementById('app'))) { page = p; break; } } catch (_) { }
      }
      if (page) break;
    }
    if (!page) await new Promise((r) => setTimeout(r, 600));
  }
  if (!page) { console.log('!! 未找到应用页面'); await browser.close(); killApp(); process.exit(1); }

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  try {
    // ---------- [1] 详细检索浮层 vs 显示件数按钮 ----------
    console.log('\n[1] 详细检索浮层展开时，显示件数按钮不得盖在浮层上');
    await page.click('.nav-item[data-view="najdb"]');
    await page.waitForTimeout(700);

    // 先确认收起状态下按钮可点、下拉可用
    await page.click('#najRowsBtn');
    await page.waitForTimeout(250);
    const menuOpen = await page.locator('#najRowsMenu:not([hidden])').count() === 1;
    ok('收起浮层时「显示件数」可点开下拉', menuOpen);
    if (menuOpen) { await page.click('#najRowsMenu [data-naj-rows="20"]'); await page.waitForTimeout(200); }

    await page.click('#najToggle');            // 展开详细检索
    await page.waitForTimeout(400);
    const cover = await page.evaluate(() => {
      const btn = document.getElementById('najRowsBtn');
      const adv = document.getElementById('najAdv');
      const r = btn.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const top = document.elementFromPoint(cx, cy);
      const advOpen = adv && !adv.hasAttribute('hidden');
      const advRect = adv ? adv.getBoundingClientRect() : null;
      return {
        advOpen,
        overlaps: !!(advRect && r.top < advRect.bottom && r.bottom > advRect.top && r.left < advRect.right && r.right > advRect.left),
        topIsButton: !!(top && (top.id === 'najRowsBtn' || top.closest('#najRowsWrap'))),
        topInAdv: !!(top && top.closest && top.closest('#najAdv')),
        topTag: top ? (top.id || top.className || top.tagName) : '',
      };
    });
    console.log('  层级探测:', JSON.stringify(cover));
    ok('浮层已展开', cover.advOpen === true);
    ok('★按钮不再盖在浮层之上（浮层在最上层）', cover.topIsButton === false && cover.topInAdv === true,
      `top=${cover.topTag}`);

    // 收起浮层后按钮应恢复可用
    await page.click('#najToggle');
    await page.waitForTimeout(400);
    await page.click('#najRowsBtn');
    await page.waitForTimeout(250);
    ok('收起浮层后按钮恢复可点', (await page.locator('#najRowsMenu:not([hidden])').count()) === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ---------- [3] 侧栏「未调整」红标 ----------
    console.log('\n[3] 侧栏「分类表查询」旁的红色「未调整」');
    const flag = await page.evaluate(() => {
      const item = document.querySelector('.nav-item[data-view="catalog"][data-tab="1"]');
      const f = item && item.querySelector('.nav-flag');
      if (!f) return null;
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      return {
        text: (f.textContent || '').trim(),
        color: cs.color,
        bg: cs.backgroundColor,
        visible: r.width > 8 && r.height > 6,
        insideItem: true,
      };
    });
    console.log('  红标样式:', JSON.stringify(flag));
    ok('分类表查询项里有「未调整」标记', !!flag && flag.text === '未调整', flag ? flag.text : 'missing');
    ok('标记为红色且可见', !!flag && flag.visible && /rgb\(2\d\d,\s*3\d,\s*3\d\)|rgb\(220,\s*38,\s*38\)/.test(flag.bg), flag ? flag.bg : '');

    // ---------- [2] 使用介绍内容 ----------
    console.log('\n[2] 使用介绍页内容完善');
    await page.click('.nav-item[data-view="guide"]');
    await page.waitForTimeout(1200);
    let guide = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      guide = await page.evaluate(() => {
        const f = document.getElementById('guideFrame');
        const d = f && f.contentDocument;
        if (!d || !d.body) return null;
        const text = d.body.innerText || '';
        return {
          sections: d.querySelectorAll('.g-section').length,
          len: text.length,
          hasDownload: /国立公文书馆下载/.test(text),
          hasBatch: /批量下载/.test(text),
          hasCenter: /下载中心/.test(text),
          hasTray: /托盘/.test(text),
          hasFaq: /常见问题/.test(text),
          hasToc: /内容导航/.test(text),
        };
      });
      if (guide && guide.sections >= 10) break;
      await page.waitForTimeout(700);
    }
    console.log('  指南页:', JSON.stringify(guide));
    ok('使用介绍含 12 个章节', !!guide && guide.sections >= 12, guide ? 'sections=' + guide.sections : 'null');
    ok('介绍了下载功能（单本/批量/下载中心/托盘）',
      !!guide && guide.hasDownload && guide.hasBatch && guide.hasCenter && guide.hasTray, JSON.stringify(guide));
    ok('含内容导航与常见问题', !!guide && guide.hasToc && guide.hasFaq);
    ok('正文体量明显扩充（>6000 字）', !!guide && guide.len > 6000, guide ? String(guide.len) : '');

    ok('全程无页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' ; '));
  } catch (e) {
    console.log('!! 实测异常：', e && e.message);
    results.push('FAIL | 实测异常 | ' + (e && e.message));
  }

  try { await browser.close(); } catch (_) { }
  killApp();

  console.log('\n================ 结果 ================');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n通过 ${results.length - failed} / ${results.length}`);
  process.exit(failed ? 1 : 0);
})();
