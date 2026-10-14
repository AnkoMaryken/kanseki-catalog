// ================================================
// app/tests/browser/najdl_v102_live.test.cjs — V10.2 四项修改真机实测（CDP 直连）
// ================================================
//   [1] 断网/解析失败时**不得**静默按「单册」处理（这是「每本书只下了一册」的根因）：
//       故障注入（让 /file/ 请求抛错）后，面板必须报错并禁用「开始下载」，且不产生任务目录
//   [2] 批量下载：三套命名各自带「▾」浮动下拉，可点字段组合，且互不串台、预览实时更新
//   [3] 古籍类目查询：检索历史按钮已移除，改为**点击检索框**显示历史；
//       且历史与「纪年查询」分开存储（两个 localStorage key 互不干扰）
//   [4] 古籍类目查询：新增**批量查询**（每行一条，逐条给命中数与示例）
//
// 用法： node app/tests/browser/najdl_v102_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9229;
const OUT_DIR = path.join(__dirname, '..', '.tmp-najdl-v102');

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
    // ---------- [1] 解析失败时不得按「单册」开工 ----------
    console.log('\n[1] 解析失败（等价断网）时不得按「单册」开工');
    await page.click('.nav-item[data-view="najdb"]');
    await page.waitForTimeout(700);

    // 真故障注入：让 resolveBookPlan 去请求 /file/.. ——
    // 这会被 Rust 端白名单直接拒绝（含上跳段），invoke 当场 reject，
    // 与「断网/请求失败」在 JS 侧是同一条代码路径（__TAURI_INTERNALS__.invoke 不可写，
    // 无法 monkey-patch，这是能找到的真实失败路径）。
    const injected = await page.evaluate(async () => {
      const m = await import('./js/ui/naj-dl.js');
      try {
        await m.resolveBookPlan({ id: '..', title: '故障注入' });
        return 'no-throw';
      } catch (e) { return 'throw:' + ((e && e.message) || e); }
    });
    console.log('  注入结果:', injected);
    ok('★请求失败时 resolveBookPlan 直接抛错（不再回落单册）', /^throw:/.test(injected), injected);
    ok('★错误信息点明网络/重试，并说明未开始下载', /网络|重试/.test(injected), injected.slice(0, 120));

    // 同一失败再走一遍界面：面板必须报错并禁用「开始下载」
    await page.evaluate(async () => {
      const m = await import('./js/ui/naj-dl.js');
      m.openBookDownload({ id: '..', title: '故障注入·非法ID' });
    });
    await page.waitForTimeout(2500);
    const broken = await page.evaluate(() => ({
      overlayOpen: !document.getElementById('najDlOverlay').hidden,
      startDisabled: !!document.getElementById('najDlStart').disabled,
      estText: (document.getElementById('najDlEstimate') || {}).textContent || '',
      runHidden: (document.getElementById('najDlRun') || {}).hidden !== false,
      planText: (document.getElementById('najDlPreview') || {}).textContent || '',
    }));
    console.log('  界面状态:', JSON.stringify(broken));
    ok('界面明确报错、且「开始下载」被禁用',
      broken.overlayOpen && broken.startDisabled === true && /读取书目|网络|重试/.test(broken.estText),
      broken.estText.replace(/\s+/g, ' ').slice(0, 90));
    ok('未当成「1 册」直接开工（没有出现册清单预览/未进入下载）',
      broken.runHidden === true && !/1 册/.test(broken.estText), JSON.stringify({ run: broken.runHidden }));
    await page.click('#najDlOverlay [data-dl-close]');

    // ---------- [2] 批量：三套命名的字段下拉 ----------
    console.log('\n[2] 批量下载：三套命名的「▾」浮动下拉');
    await page.click('#najBatchBtn');
    await page.waitForSelector('#dlbOverlay:not([hidden])', { timeout: 10000 });
    await page.fill('#dlbInput', '# 下拉实测\n591227\n');
    await page.fill('#dlbOut', OUT_DIR.replace(/\\/g, '/'));
    await page.click('#dlbRead');
    const tR = Date.now();
    while (Date.now() - tR < 120000) {
      const txt = await page.evaluate(() => {
        const it = document.querySelector('.dlb-item');
        return it ? it.textContent.replace(/\s+/g, ' ').trim() : '';
      });
      if (txt && !/读取中|待读取/.test(txt)) break;
      await page.waitForTimeout(1000);
    }
    const btns = await page.locator('.dlb-tok-btn').count();
    ok('三套命名各有一个「▾」按钮', btns === 3, 'count=' + btns);

    // 给「每册文件名」插入 {册名} 与分隔符
    await page.fill('#dlbTplFile', '');
    await page.click('.dlb-tok-btn[data-dlb-tok="dlbTplFile"]');
    await page.waitForSelector('#dlbTokMenu:not([hidden])', { timeout: 5000 });
    const menu = await page.evaluate(() => ({
      fields: document.querySelectorAll('#dlbTokMenu [data-dlb-tok-ins]').length,
      hasBookName: !!Array.from(document.querySelectorAll('#dlbTokMenu [data-dlb-tok-ins]')).find((b) => b.dataset.dlbTokIns === '{册名}'),
      hasPad: !!Array.from(document.querySelectorAll('#dlbTokMenu [data-dlb-tok-ins]')).find((b) => b.dataset.dlbTokIns === '{册次:03}'),
    }));
    console.log('  下拉内容:', JSON.stringify(menu));
    ok('下拉里含字段与补零项', menu.fields >= 10 && menu.hasBookName && menu.hasPad, JSON.stringify(menu));

    await page.click('#dlbTokMenu [data-dlb-tok-ins="{册次:03}"]');
    await page.click('#dlbTokMenu [data-dlb-tok-ins="_"]');
    await page.click('#dlbTokMenu [data-dlb-tok-ins="{册名}"]');
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      file: document.getElementById('dlbTplFile').value,
      folder: document.getElementById('dlbTplFolder').value,
      preview: (document.getElementById('dlbTplPreview') || {}).textContent || '',
      menuStillOpen: !document.getElementById('dlbTokMenu').hidden,
    }));
    console.log('  插入后:', JSON.stringify(after));
    ok('字段插入到「每册文件名」，且不串到别的框',
      after.file === '{册次:03}_{册名}' && after.folder.indexOf('{册次') < 0, JSON.stringify(after));
    ok('预览随之更新（显示补零后的文件名）', /\d{3}_/.test(after.preview), after.preview.replace(/\s+/g, ' ').slice(0, 90));

    // 换一个输入框：目录名
    await page.fill('#dlbTplFolder', '');
    await page.click('.dlb-tok-btn[data-dlb-tok="dlbTplFolder"]');
    await page.waitForSelector('#dlbTokMenu:not([hidden])', { timeout: 5000 });
    await page.click('#dlbTokMenu [data-dlb-tok-ins="{书名}"]');
    await page.waitForTimeout(200);
    const two = await page.evaluate(() => ({
      folder: document.getElementById('dlbTplFolder').value,
      file: document.getElementById('dlbTplFile').value,
    }));
    ok('切到「目录名」后只改目录名（互不串台）',
      two.folder === '{书名}' && two.file === '{册次:03}_{册名}', JSON.stringify(two));
    await page.click('#dlbOverlay [data-dlb-close]');

    // ---------- [3] 古籍类目：历史改版 + 分开存储 ----------
    console.log('\n[3] 古籍类目查询：历史按钮已移除、点击检索框显示、与纪年分开存储');
    await page.click('.nav-item[data-view="kanseki"]');
    await page.waitForTimeout(1500);
    // 等 iframe 里的数据加载完
    let ksReady = false;
    const tk = Date.now();
    while (Date.now() - tk < 90000) {
      ksReady = await page.evaluate(() => {
        const f = document.getElementById('kansekiFrame');
        const w = f && f.contentWindow;
        const d = f && f.contentDocument;
        return !!(w && d && d.getElementById('ksApp') && !d.getElementById('ksApp').hidden);
      });
      if (ksReady) break;
      await page.waitForTimeout(1000);
    }
    ok('古籍类目页面已就绪', ksReady === true);
    if (ksReady) {
      const hist = await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        const w = document.getElementById('kansekiFrame').contentWindow;
        // 预先在「纪年查询」的历史键里放一个哨兵，确认类目页不会动它
        w.localStorage.setItem('kanseki_search_history', JSON.stringify(['纪年哨兵']));
        const input = d.getElementById('ksSearch');
        return {
          histBtnGone: !d.getElementById('ksHistBtn'),
          panelHiddenBefore: d.getElementById('ksHistPanel').hidden,
          inputExists: !!input,
        };
      });
      ok('「历史」按钮已移除', hist.histBtnGone === true, JSON.stringify(hist));

      // 执行一次检索 → 记录历史（类目页自己的键）
      await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        const w = document.getElementById('kansekiFrame').contentWindow;
        const inp = d.getElementById('ksSearch');
        inp.value = '周易';
        d.getElementById('ksGo').click();
      });
      await page.waitForTimeout(1800);
      const keys = await page.evaluate(() => {
        const w = document.getElementById('kansekiFrame').contentWindow;
        return {
          cat: w.localStorage.getItem('kanseki_cat_search_history'),
          year: w.localStorage.getItem('kanseki_search_history'),
        };
      });
      console.log('  历史键:', JSON.stringify(keys));
      ok('记录了类目页自己的历史（kanseki_cat_search_history）', !!keys.cat && keys.cat.indexOf('周易') >= 0, String(keys.cat));
      ok('★未污染纪年查询的历史（kanseki_search_history 原样）', keys.year === JSON.stringify(['纪年哨兵']), String(keys.year));

      // 点击检索框 → 历史浮层出现
      await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        const inp = d.getElementById('ksSearch');
        inp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForTimeout(400);
      const shown = await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        const p = d.getElementById('ksHistPanel');
        return { hidden: p.hidden, text: p.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) };
      });
      console.log('  历史浮层:', JSON.stringify(shown));
      ok('点击检索框即显示历史', shown.hidden === false && /周易/.test(shown.text), JSON.stringify(shown));

      // ---------- [4] 古籍类目：批量查询 ----------
      console.log('\n[4] 古籍类目查询：批量查询');
      await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        d.getElementById('ksBatchBtn').click();
      });
      await page.waitForTimeout(300);
      const p1 = await page.evaluate(() => !document.getElementById('kansekiFrame').contentDocument.getElementById('ksBatchPanel').hidden);
      ok('批量查询面板可打开', p1 === true);

      await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        d.getElementById('ksBatchInput').value = '# 注释行\n周易\n論語\nzzz不存在的书名zzz';
        d.getElementById('ksBatchRun').click();
      });
      await page.waitForTimeout(4000);
      const batch = await page.evaluate(() => {
        const d = document.getElementById('kansekiFrame').contentDocument;
        const rows = Array.from(d.querySelectorAll('#ksBatchBody .ks-batch-table tbody tr'))
          .map((tr) => tr.textContent.replace(/\s+/g, ' ').trim());
        return { rows: rows, status: (d.getElementById('ksBatchStatus') || {}).textContent || '' };
      });
      console.log('  批量结果:', JSON.stringify(batch).slice(0, 400));
      ok('三条查询各出一行（注释行被跳过）', batch.rows.length === 3, JSON.stringify(batch.rows.length));
      ok('有命中的至少两条', batch.rows.filter((r) => / [1-9]\d* /.test(r)).length >= 2, JSON.stringify(batch.rows).slice(0, 200));
      ok('状态行给出完成统计', /完成/.test(batch.status) && /\d/.test(batch.status), batch.status);
    }

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
