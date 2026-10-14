// ================================================
// app/tests/browser/najdl_v10_live.test.cjs — V10.0 五项改动真机实测（CDP 直连）
// ================================================
//   [1] 检索行按钮文字单行；「显示件数」移到检索栏与结果栏之间、分页左侧，
//       点按钮弹出浮动下拉，选择后生效
//   [2] >50 页的册：下载后**自动合并成一个 PDF**（真实下载 爾雅３ = 86 页，站方分 50+36）
//   [3] 批量下载能导入**索书号**（子046-0012 → 傷寒意珠篇，且不被"件名番号撞车"的记录骗到）
//   [4] 三套命名（目录/每册/压缩包）自定义后**落盘名字确实照改**
//   [5] 关闭窗口不退出（转后台/托盘），可再唤回
//
// 用法： node app/tests/browser/najdl_v10_live.test.cjs
// 说明：会真实下载 86 页（约 60MB，2 次请求），耗时数分钟。
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9227;
const OUT_DIR = path.join(__dirname, '..', '.tmp-najdl-v10');
const DEEP_ID = '591091';        // 爾雅３：86 页 → 站方分 50 + 36，两批
const DEEP_PAGES = 86;
const REF_CODE = '子046-0012';   // 半数写法；原站著录为 子０４６－００１２

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

function appAlive() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return out.split(/\r?\n/).some((l) => /^"kanseki-app\.exe"/i.test(l.trim()));
  } catch (_) { return false; }
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

function countDct(file) {
  const buf = fs.readFileSync(file);
  const needle = Buffer.from('/DCTDecode', 'latin1');
  let n = 0, i = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
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

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

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
    // ---------- [1] 检索行与显示件数 ----------
    console.log('\n[1] 检索行单行显示 + 显示件数移到分页左侧');
    await page.click('.nav-item[data-view="najdb"]');
    await page.waitForTimeout(700);
    const layout = await page.evaluate(() => {
      const main = document.querySelector('.naj-main');
      const btns = [...main.querySelectorAll('button')];
      const heights = btns.map((b) => Math.round(b.getBoundingClientRect().height));
      const tops = btns.map((b) => Math.round(b.getBoundingClientRect().top));
      return {
        btnCount: btns.length,
        maxH: Math.max(...heights),
        sameRow: new Set(tops).size === 1,
        rowsInsideMain: !!main.querySelector('#najRows'),
        rowsBtnInStatus: !!document.querySelector('.kdb-statusbar #najRowsBtn'),
      };
    });
    ok('检索行按钮都在同一行', layout.sameRow, JSON.stringify(layout));
    ok('按钮没有折成两行（高度正常）', layout.maxH <= 40, 'maxH=' + layout.maxH);
    ok('「显示件数」已不在检索行里', layout.rowsInsideMain === false);
    ok('「显示件数」在检索栏与结果栏之间的状态栏内', layout.rowsBtnInStatus === true);

    await page.fill('#najKw', '古逸叢書叙目');
    await page.click('#najSearchBtn');
    await page.waitForSelector('#najResults .naj-row', { timeout: 150000 });
    const order = await page.evaluate(() => {
      const wrap = document.getElementById('najRowsWrap').getBoundingClientRect();
      const pager = document.getElementById('najPager').getBoundingClientRect();
      return { wrapRight: Math.round(wrap.right), pagerLeft: Math.round(pager.left), wrapTop: Math.round(wrap.top), pagerTop: Math.round(pager.top) };
    });
    ok('显示件数在分页按钮左侧', order.wrapRight <= order.pagerLeft + 4, JSON.stringify(order));

    await page.click('#najRowsBtn');
    await page.waitForTimeout(250);
    ok('点按钮弹出浮动下拉', (await page.locator('#najRowsMenu:not([hidden])').count()) === 1);
    await page.click('#najRowsMenu [data-naj-rows="50"]');
    await page.waitForTimeout(250);
    const rowsVal = await page.evaluate(() => ({
      v: document.getElementById('najRows').value,
      label: document.getElementById('najRowsLabel').textContent,
      menuHidden: document.getElementById('najRowsMenu').hasAttribute('hidden'),
    }));
    ok('选择后生效且菜单收起', rowsVal.v === '50' && rowsVal.label === '50' && rowsVal.menuHidden, JSON.stringify(rowsVal));

    // ---------- [3] 批量：索书号 ----------
    console.log('\n[3] 批量下载导入索书号（子046-0012）');
    await page.click('#najBatchBtn');
    await page.waitForSelector('#dlbOverlay:not([hidden])', { timeout: 10000 });
    await page.fill('#dlbInput', `# 索书号实测\n${REF_CODE}\n`);
    await page.fill('#dlbOut', OUT_DIR.replace(/\\/g, '/'));
    await page.click('#dlbRead');
    const t0 = Date.now();
    let items = null;
    while (Date.now() - t0 < 180000) {
      items = await page.evaluate(() => [...document.querySelectorAll('.dlb-item')].map((it) => it.textContent.replace(/\s+/g, ' ').trim()));
      if (items.length === 1 && !/读取中|待读取/.test(items[0])) break;
      await page.waitForTimeout(1000);
    }
    console.log('  清单:', JSON.stringify(items));
    ok('索书号能解析出记录（不再 0 命中）', !!items && /傷寒意珠篇/.test(items[0]), (items || []).join(''));
    const candSel = await page.locator('.dlb-cand').count();
    ok('命中多条时给出候选下拉（可核对）', candSel >= 1, 'candidates=' + candSel);
    await page.click('#dlbOverlay [data-dlb-close]');
    await page.waitForTimeout(300);

    // ---------- [4]+[2] 三套命名 + >50 页自动合并 ----------
    // 用**批量面板**按 ID 精确取书（关键词检索 591091 会命中别的书，实测踩过）
    console.log('\n[4] 三套命名自定义 + [2] 86 页自动合并为一个 PDF');
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.click('.nav-item[data-view="najdb"]');
    await page.waitForTimeout(500);
    await page.click('#najBatchBtn');
    await page.waitForSelector('#dlbOverlay:not([hidden])', { timeout: 10000 });
    await page.fill('#dlbInput', `# 合并实测\n${DEEP_ID}\n`);
    await page.fill('#dlbOut', OUT_DIR.replace(/\\/g, '/'));
    await page.fill('#dlbTplFolder', 'DIR_{书名}_{主册ID}');
    await page.fill('#dlbTplFile', 'VOL{册次:02}_{册ID}');
    await page.fill('#dlbTplZip', 'ZIP_{书名}_{日期}');
    await page.click('#dlbRead');
    const tRead = Date.now();
    let it1 = null;
    while (Date.now() - tRead < 180000) {
      it1 = await page.evaluate(() => {
        const it = document.querySelector('.dlb-item');
        return it ? it.textContent.replace(/\s+/g, ' ').trim() : null;
      });
      if (it1 && !/读取中|待读取/.test(it1)) break;
      await page.waitForTimeout(1000);
    }
    console.log('  书目:', JSON.stringify(it1));
    ok('按 ID 读到书名与册数', !!it1 && /爾雅/.test(it1), it1 || '');

    // 完成横幅一闪而过（下一本／整批结束就替换了），用 MutationObserver 把每一次都记下来
    await page.evaluate(() => {
      window.__bannerLog = [];
      const b = document.getElementById('dlcBanner');
      if (!b) return;
      const grab = () => {
        if (b.hidden) return;
        const t = ((document.getElementById('dlcBannerTitle') || {}).textContent || '')
          + '｜' + ((document.getElementById('dlcBannerText') || {}).textContent || '');
        if (t && window.__bannerLog.indexOf(t) < 0) window.__bannerLog.push(t);
      };
      grab();
      new MutationObserver(grab).observe(b, {
        attributes: true, childList: true, subtree: true, characterData: true,
      });
    });

    await page.click('#dlbStart');
    const t1 = Date.now();
    let final = null;
    const banners = [];      // 轮询到的（MutationObserver 之外的兜底）
    while (Date.now() - t1 < 900000) {
      final = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#dlcQueue .dlc-qitem')];
        const b = document.getElementById('dlcBanner');
        return {
          queue: items.map((i) => i.textContent.replace(/\s+/g, ' ').trim()),
          banner: (b && !b.hidden)
            ? (document.getElementById('dlcBannerTitle') || {}).textContent + '｜' + (document.getElementById('dlcBannerText') || {}).textContent
            : '',
          log: (window.__bannerLog || []).slice(),
        };
      });
      if (final.banner) banners.push(final.banner);
      if (final.queue.length && final.queue.some((q) => /完成|失败|已略过/.test(q))) break;
      await page.waitForTimeout(2500);
    }
    for (const t of (final && final.log) || []) banners.push(t);
    console.log('  队列:', JSON.stringify(final));
    ok('86 页那一本下载完成', !!final && final.queue.some((q) => /爾雅/.test(q) && /完成/.test(q)), JSON.stringify(final));

    // 等收尾（合并 → 打包 → 清理任务文件）；V10.2 起完成后目录里只留 PDF 与压缩包
    const dirs = () => fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(OUT_DIR, d.name));
    let dir = null, files = [];
    const snapshots = [];      // 诊断：目录内容随时间的变化（排查分卷残留）
    const t2 = Date.now();
    while (Date.now() - t2 < 300000) {
      const ds = dirs();
      if (ds.length) {
        dir = ds[0];
        files = fs.readdirSync(dir);
        snapshots.push(`+${Math.round((Date.now() - t2) / 1000)}s ${JSON.stringify(files)}`);
        if (files.some((f) => /\.pdf$/i.test(f)) && files.some((f) => /\.zip$/i.test(f)) && !files.includes('_任务.json')) break;
      }
      await page.waitForTimeout(2000);
    }
    console.log('  目录快照:\n    ' + snapshots.join('\n    '));

    ok('目录名按自定义模板（DIR_…）', !!dir && /^DIR_/.test(path.basename(dir)), path.basename(dir || ''));
    const pdfs = files.filter((f) => /\.pdf$/i.test(f));
    const zips = files.filter((f) => /\.zip$/i.test(f));
    console.log('  目录内容:', JSON.stringify(files));
    ok('每册文件名按自定义模板（VOL01_591091.pdf）', pdfs.includes('VOL01_591091.pdf'), pdfs.join(' / '));
    ok('★86 页只产出一个 PDF（分卷已自动合并，无 _1-50/_51-86）',
      pdfs.length === 1 && !pdfs.some((f) => /_\d+-\d+\.pdf$/.test(f)), pdfs.join(' / '));
    ok('压缩包按自定义模板（ZIP_…）', zips.length === 1 && /^ZIP_/.test(zips[0]), zips.join(','));
    ok('★完成后目录里只剩 PDF 与压缩包（无报告、无任务文件）',
      files.every((f) => /\.pdf$|\.zip$/i.test(f)), files.join(' / '));
    if (pdfs.length === 1) {
      const n = countDct(path.join(dir, pdfs[0]));
      ok('★合并后 PDF 页数 = 86（独立复核 /DCTDecode）', n === DEEP_PAGES, `实测 ${n} 页`);
    } else {
      ok('★合并后 PDF 页数 = 86（独立复核 /DCTDecode）', false, '未能产出单一 PDF');
    }
    // 合并成功也能从「这一本下载完成」的提醒看出来（1 册 / 86 页，而不是两个分卷各几十页）
    const joinBanners = banners.join(' ;; ');
    ok('完成提醒里出现「86 页」（佐证已合并为一册）', /86\s*页/.test(joinBanners), joinBanners.slice(-200));

    ok('全程无页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' ; '));

    // ---------- [5] 关闭不退出（转后台/托盘） ----------
    console.log('\n[5] 关闭窗口 → 留后台，可再唤回');
    await page.evaluate(() => document.getElementById('najDlOverlay')?.setAttribute('hidden', ''));
    await page.click('#tbClose');
    await page.waitForTimeout(2500);
    ok('点关闭后进程仍在（未退出）', appAlive());
    const stillWorks = await page.evaluate(() => 1 + 1).catch(() => null);
    ok('后台页面仍可响应（下载可继续）', stillWorks === 2);
    const shown = await page.evaluate(async () => {
      try { await window.__TAURI_INTERNALS__.invoke('app_show_main'); return 'ok'; } catch (e) { return String(e); }
    });
    ok('可通过命令把窗口唤回', shown === 'ok', shown);
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
