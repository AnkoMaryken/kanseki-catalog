// ================================================
// app/tests/browser/kansekidb_live.test.cjs — 「日本藏本检索」真实窗口实测（CDP 直连）
// -------------------------------------------------
// 与 v08_tauri_live.test.cjs 同一套手法：以 --remote-debugging-port 启动真 exe，
// 用 playwright connectOverCDP 接入 WebView2，直接驱动界面。
//
// 本测试验证的是**真链路**：
//   界面 → (invoke) → Rust kanseki_db::kanseki_fetch → (reqwest) → 京都大学原站
// 因此它会真实联网检索一次（著者=陶潛，约 60–120 秒），并核对命中数。
//
// 用例：
//   [1] 视图可达、机构列表已填充
//   [2] 空条件检索被拦下（原站只选机构不检索，本地先提示）
//   [3] 真实检索 陶潛 → 命中 954 条、结果列表渲染
//   [4] 点击记录 → 详情字段（记录号/收藏机构/书名）与操作按钮
//   [5] 安全：站外 URL 被 Rust 侧白名单拒绝
//   [6] 全程无页面脚本错误
//
// 用法：
//   node app/tests/browser/kansekidb_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9223;
const SEARCH_TIMEOUT_MS = 240000;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' });
  } catch (_) { /* 无进程时 taskkill 返回非 0，忽略 */ }
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

  if (!require('fs').existsSync(EXE)) {
    console.log('!! 未找到 exe:', EXE);
    process.exit(2);
  }

  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
    console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  [' + extra + ']' : ''));
  };

  killApp();
  await new Promise((r) => setTimeout(r, 1500));

  console.log('启动 exe（开启远程调试 ' + PORT + '）...');
  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT + ' --no-sandbox';

  const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' });
  child.unref();

  const ver = await waitForCdp();
  if (!ver) { console.log('!! 未能连上 CDP'); killApp(); process.exit(1); }
  console.log('CDP 就绪');

  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });

  let page = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        if (/devtools/.test(p.url())) continue;
        try {
          if (await p.evaluate(() => !!document.getElementById('app'))) { page = p; break; }
        } catch (_) { /* 导航中 */ }
      }
      if (page) break;
    }
    if (page) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!page) {
    console.log('!! 未找到应用页面');
    await browser.close(); killApp(); process.exit(1);
  }
  console.log('已接入页面:', page.url());

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  // 复位持久化状态，保证可复现
  await page.evaluate(() => {
    localStorage.removeItem('kanseki_app_sidebar_collapsed');
    localStorage.removeItem('theme');
  });
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(2500);

  // ---------- 1. 视图可达 ----------
  console.log('\n[1] 进入「汉籍检索（日本）」视图');
  const navCount = await page.locator('.nav-item[data-view="kansekidb"]').count();
  ok('侧栏存在「汉籍检索（日本）」入口', navCount === 1, 'count=' + navCount);

  await page.locator('.nav-item[data-view="kansekidb"]').click();
  await page.waitForTimeout(1200);
  const viewActive = await page.locator('#view-kansekidb.active').count();
  ok('视图已激活', viewActive === 1);

  const optCount = await page.locator('#kdbOr option').count();
  ok('所藏机构列表已填充', optCount >= 76, 'options=' + optCount);

  for (const id of ['#kdbTi', '#kdbAu', '#kdbYr', '#kdbPb', '#kdbKo', '#kdbFr', '#kdbTimeout']) {
    if (!(await page.locator(id).count())) ok('表单控件存在 ' + id, false);
  }
  ok('六个检索字段与超时选择齐备',
    (await page.locator('#kdbTi').count()) === 1 && (await page.locator('#kdbAu').count()) === 1 &&
    (await page.locator('#kdbYr').count()) === 1 && (await page.locator('#kdbPb').count()) === 1 &&
    (await page.locator('#kdbKo').count()) === 1 && (await page.locator('#kdbFr').count()) === 1 &&
    (await page.locator('#kdbTimeout').count()) === 1);

  // 样式表必须真的加载到：只有 CSS 里的 .kdb-* 规则才会把这两处设为预期布局。
  // （曾有「JS/HTML 已构建但 app.css 未同步」导致面板挤成一行的实测事故，故设此断言。）
  // V9.4.1：结果与详情改为**单栏全宽切换**，.kdb-split 由 grid 改为 block。
  const styles = await page.evaluate(() => {
    const g = getComputedStyle(document.querySelector('.kdb-grid')).display;
    const sp = document.querySelector('.kdb-split');
    const s = getComputedStyle(sp).display;
    const results = document.querySelector('#kdbResults');
    return {
      grid: g, split: s,
      splitW: Math.round(sp.getBoundingClientRect().width),
      resultsW: Math.round(results.getBoundingClientRect().width),
    };
  });
  ok('检索栅格样式已生效（.kdb-grid 为 grid）', styles.grid === 'grid', JSON.stringify(styles));
  ok('结果区为单栏（不再是左右并排的两栏 grid）', styles.split === 'flex', styles.split);
  ok('结果面板占满可用宽度', styles.splitW > 0 && Math.abs(styles.splitW - styles.resultsW) <= 2,
    styles.resultsW + ' / ' + styles.splitW);

  // ---------- 2. 空条件被拦下 ----------
  console.log('\n[2] 空条件检索的本地拦截');
  await page.locator('#kdbForm button[type="submit"]').click();
  await page.waitForTimeout(600);
  const statusEmpty = (await page.locator('#kdbStatus').innerText()).trim();
  ok('未填条件时给出提示且不发起请求', /至少填写一个检索条件/.test(statusEmpty), statusEmpty.slice(0, 40));

  // ---------- 3. 真实检索 ----------
  console.log('\n[3] 真实检索：著者 = 陶潛（联网，可能需 1–3 分钟）');
  // 著者名在「高级筛选」里，默认收起 —— 先展开再填
  await page.locator('#kdbToggle').click();
  await page.waitForTimeout(300);
  await page.fill('#kdbAu', '陶潛');
  const t0 = Date.now();
  await page.locator('#kdbForm button[type="submit"]').click();
  let rows = 0;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#kdbResults .kdb-row').length > 0,
      null, { timeout: SEARCH_TIMEOUT_MS });
    rows = await page.locator('#kdbResults .kdb-row').count();
  } catch (_) { rows = await page.locator('#kdbResults .kdb-row').count(); }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const status = (await page.locator('#kdbStatus').innerText()).replace(/\s+/g, ' ').trim();
  console.log('   状态栏:', status, '| 用时', elapsed, 's');

  ok('检索返回结果（网络 + Rust 桥链路通）', rows > 0, 'rows=' + rows);
  ok('命中数与原站一致（954）', /命中\s*954/.test(status), status.slice(0, 60));
  ok('结果行数与命中数相符', rows === 954, 'rows=' + rows);
  const firstTitle = rows ? (await page.locator('#kdbResults .kdb-row-title').first().innerText()).trim() : '';
  ok('首条题名非空', !!firstTitle, firstTitle);

  // 诊断：检索刚结束时，表单字段与摘要到底是什么状态
  const afterSearch = await page.evaluate(() => {
    const T = window.__kdbTest__;
    return {
      auValue: (document.getElementById('kdbAu') || {}).value,
      fields: T ? T.currentFields() : null,
      summaryText: T ? T.summaryText() : null,
      summaryDom: (document.getElementById('kdbSummary') || {}).innerText,
      advOpen: T ? T.isAdvOpen() : null,
      advHidden: document.getElementById('kdbAdv').hidden,
    };
  });
  console.log('   [诊断] 检索后表单状态:', JSON.stringify(afterSearch));

  // ---------- 4. 详情 ----------
  console.log('\n[4] 点击记录读取详情');
  await page.locator('#kdbResults .kdb-row').first().click();
  try {
    await page.waitForFunction(() => document.querySelectorAll('#kdbDetail .kdb-kv').length > 3,
      null, { timeout: 60000 });
  } catch (_) { /* 下方断言会给出结论 */ }
  const kvCount = await page.locator('#kdbDetail .kdb-kv').count();
  const detailText = (await page.locator('#kdbDetail').innerText()).replace(/\s+/g, ' ');
  ok('详情字段已渲染', kvCount > 3, 'kv=' + kvCount);
  ok('详情含「记录号」', /记录号/.test(detailText));
  ok('详情含「收藏机构」', /收藏机构/.test(detailText));
  ok('详情含「书名」', /书名/.test(detailText));
  ok('详情操作按钮齐备',
    (await page.locator('#kdbCopy').count()) === 1 && (await page.locator('#kdbOpen').count()) === 1);
  console.log('   详情摘要:', detailText.slice(0, 160));

  // ---------- 4b. V9.4.2 交互：筛选可折叠 + 结果为主 + 全宽切换 + 返回 ----------
  console.log('\n[4b] 高级筛选折叠 / 结果占满 / 全宽切换 / 返回');
  const collapse = await page.evaluate(() => {
    const adv = document.querySelector('#kdbAdv');
    const sum = document.querySelector('#kdbSummary');
    const badge = document.querySelector('#kdbFilterCount');
    const split = document.querySelector('#kdbSplit');
    // 当前显示的是哪一个面板（此刻通常已在详情视图）
    const visSel = split.classList.contains('view-detail') ? '#kdbDetail' : '#kdbResults';
    const vis = document.querySelector(visSel);
    return {
      visSel,
      advHidden: adv.hidden,
      summaryShown: !!sum && !sum.hidden,
      summaryText: sum ? sum.innerText.replace(/\s+/g, ' ').trim() : '',
      badgeHidden: badge.hidden,
      badge: badge.textContent,
      visH: Math.round(vis.getBoundingClientRect().height),
      splitH: Math.round(split.getBoundingClientRect().height),
      winH: window.innerHeight
    };
  });
  ok('检索后高级筛选自动收起', collapse.advHidden === true, JSON.stringify(collapse));
  ok('收起时显示一行条件摘要', collapse.summaryShown === true && collapse.summaryText.length > 0,
    collapse.summaryText.slice(0, 60));
  ok('摘要里回显了检索条件', /陶潛/.test(collapse.summaryText), collapse.summaryText.slice(0, 50));
  ok('筛选开关带条件计数徽标', collapse.badgeHidden === false && collapse.badge === '1', collapse.badge);
  ok('面板占满结果区高度', collapse.visH >= collapse.splitH - 2,
    collapse.visH + ' / ' + collapse.splitH);
  // 核心诉求：页面以结果为主 —— 结果区应占视口一半以上
  ok('结果区占据视口一半以上（页面以结果为主）', collapse.splitH >= collapse.winH * 0.5,
    'splitH=' + collapse.splitH + ' winH=' + collapse.winH);
  console.log('   摘要:', collapse.summaryText, '| 徽标:', collapse.badge,
    '|', collapse.visSel, '高:', collapse.visH, 'px / 视口', collapse.winH, 'px');

  // 「筛选 ↓」可展开/收起
  await page.locator('#kdbToggle').click();
  await page.waitForTimeout(300);
  const advOpen = await page.evaluate(() => {
    const T = window.__kdbTest__;
    const adv = document.querySelector('#kdbAdv');
    return {
      open: !adv.hidden,
      aria: document.querySelector('#kdbToggle').getAttribute('aria-expanded'),
      summaryHidden: document.querySelector('#kdbSummary').hidden,
      // 展开后条件可见：著者名输入框在视口内
      auVisible: document.querySelector('#kdbAu').getBoundingClientRect().height > 0,
      isOpenApi: T ? T.isAdvOpen() : null
    };
  });
  ok('点「筛选 ↓」展开高级条件', advOpen.open === true && advOpen.isOpenApi === true, JSON.stringify(advOpen));
  ok('展开后 aria-expanded 正确', advOpen.aria === 'true', advOpen.aria);
  ok('展开后条件字段可见', advOpen.auVisible === true);
  ok('展开时隐藏那一行摘要（避免重复）', advOpen.summaryHidden === true);
  await page.locator('#kdbToggle').click();
  await page.waitForTimeout(300);
  ok('再次点击可收起', await page.evaluate(() => document.getElementById('kdbAdv').hidden === true));

  const inDetail = await page.evaluate(() => ({
    viewDetail: document.querySelector('#kdbSplit').classList.contains('view-detail'),
    resultsHidden: getComputedStyle(document.querySelector('#kdbResults')).display === 'none',
    detailVisible: getComputedStyle(document.querySelector('#kdbDetail')).display !== 'none',
    back: !!document.querySelector('#kdbBack'),
    detailW: Math.round(document.querySelector('#kdbDetail').getBoundingClientRect().width),
    splitW: Math.round(document.querySelector('#kdbSplit').getBoundingClientRect().width)
  }));
  ok('点条目后切换到详情视图', inDetail.viewDetail && inDetail.resultsHidden && inDetail.detailVisible,
    JSON.stringify(inDetail));
  ok('详情面板同样占满全宽', Math.abs(inDetail.detailW - inDetail.splitW) <= 2,
    inDetail.detailW + ' / ' + inDetail.splitW);
  ok('详情顶部有「返回结果」按钮', inDetail.back === true);

  await page.locator('#kdbBack').click();
  await page.waitForTimeout(400);
  const backState = await page.evaluate(() => ({
    viewResults: document.querySelector('#kdbSplit').classList.contains('view-results'),
    resultsVisible: getComputedStyle(document.querySelector('#kdbResults')).display !== 'none',
    detailHidden: getComputedStyle(document.querySelector('#kdbDetail')).display === 'none',
    activeRows: document.querySelectorAll('#kdbResults .kdb-row.active').length
  }));
  ok('点「返回结果」回到结果列表', backState.viewResults && backState.resultsVisible && backState.detailHidden,
    JSON.stringify(backState));
  ok('返回后原选中行保持高亮', backState.activeRows === 1, String(backState.activeRows));

  // 展开筛选后条件仍在（未丢失已填内容）
  await page.locator('#kdbToggle').click();
  await page.waitForTimeout(300);
  const expanded = await page.evaluate(() => ({
    advShown: !document.querySelector('#kdbAdv').hidden,
    summaryHidden: document.querySelector('#kdbSummary').hidden
  }));
  ok('展开筛选后条件字段仍在（未丢失已填内容）',
    expanded.advShown === true && expanded.summaryHidden === true, JSON.stringify(expanded));
  ok('已填的著者名仍在', (await page.inputValue('#kdbAu')).trim() === '陶潛', await page.inputValue('#kdbAu'));
  // 复原成收起态，避免影响后续步骤
  await page.locator('#kdbToggle').click();
  await page.waitForTimeout(250);

  // ---------- 5. 安全：站外 URL 被拒 ----------
  console.log('\n[5] Rust 侧主机白名单');
  const denied = await page.evaluate(async () => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const out = {};
    for (const u of ['http://evil.example.com/kanseki?ti=x',
                     'http://kanji.zinbun.kyoto-u.ac.jp/other',
                     'https://kanji.zinbun.kyoto-u.ac.jp/kanseki?ti=x']) {
      try { await inv('kanseki_fetch', { url: u, timeoutSecs: 5 }); out[u] = 'ALLOWED'; }
      catch (e) { out[u] = 'DENIED'; }
    }
    return out;
  });
  ok('站外域名被拒绝', denied['http://evil.example.com/kanseki?ti=x'] === 'DENIED',
    JSON.stringify(denied['http://evil.example.com/kanseki?ti=x']));
  ok('本站非 /kanseki 路径被拒绝', denied['http://kanji.zinbun.kyoto-u.ac.jp/other'] === 'DENIED');
  ok('https 访问被拒绝（该站仅 http）', denied['https://kanji.zinbun.kyoto-u.ac.jp/kanseki?ti=x'] === 'DENIED');

  // ---------- 6. 页面错误 ----------
  console.log('\n[6] 页面脚本错误');
  ok('无未捕获页面错误', errors.length === 0, errors.slice(0, 3).join(' ; '));

  // ---------- 汇总 ----------
  const pass = results.filter((r) => r.startsWith('PASS')).length;
  const fail = results.length - pass;
  console.log('\n===== 活体测试：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  results.filter((r) => r.startsWith('FAIL')).forEach((r) => console.log('  ' + r));

  await browser.close().catch(() => {});
  killApp();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('!! 测试异常:', e && e.message);
  killApp();
  process.exit(1);
});
