// ================================================
// app/tests/browser/najdb_live.test.cjs — 「国立公文书馆」真实窗口实测（CDP 直连）
// -------------------------------------------------
// 与 kansekidb_live.test.cjs 同一套手法：以 --remote-debugging-port 启动真 exe，
// 用 playwright connectOverCDP 接入 WebView2，直接驱动界面。
//
// 验证的是**真链路**：
//   界面 → (invoke naj_fetch) → Rust naj_db.rs → (reqwest) → 国立公文書館デジタルアーカイブ
// 因此会真实联网检索一次（キーワード=論語），并核对命中数与「原链接」渲染。
//
// 用例：
//   [1] 侧栏入口 + 字母 DA 图标
//   [2] 视图与表单（検索範囲/表示件数）就位
//   [3] 空关键词被本地拦下
//   [4] 真实检索 論語 → 命中数、结果条目、**每条末尾的原链接**
//   [5] 点击条目 → JSON-LD 详情（URI/レファレンスコード/标题）+ 引用例 + 原链接
//   [6] 「参考此记录新建编目记录」→ 跳编目记录并带入書名
//   [7] 安全：站外 URL 被 Rust 白名单拒绝
//   [8] 全程无页面脚本错误
//
// 用法： node app/tests/browser/najdb_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9224;                 // 与 kansekidb_live(9223) 错开，避免撞端口
const SEARCH_TIMEOUT_MS = 180000;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); }
  catch (_) { /* 无进程时非 0，忽略 */ }
  // 一并清理 WebView2 子进程：强杀应用留下的孤儿会锁住用户数据目录，
  // 导致下一次启动 panic（failed to create webview HRESULT 0x8007139F）。
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

  // ---------- 发布门禁：exe 必须晚于全部前端/Rust 源文件 ----------
  // 本次上线前真实发生过「改完源码没重新打包」（exe 比 naj_db.rs 早 6m54s），
  // 故把新鲜度检查做成硬门禁，避免再次拿旧 exe 验证/分发。
  {
    const fs2 = require('fs');
    const newest = { t: 0, f: '' };
    const walk = (d) => {
      for (const e of fs2.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const t = fs2.statSync(p).mtimeMs;
          if (t > newest.t) { newest.t = t; newest.f = p; }
        }
      }
    };
    for (const r of [path.join(__dirname, '..', '..', 'src'), path.join(__dirname, '..', '..', 'tauri', 'src')]) {
      if (fs2.existsSync(r)) walk(r);
    }
    const exeT = fs2.statSync(EXE).mtimeMs;
    if (exeT < newest.t) {
      console.log('!! exe 早于源文件，必须先重新打包（node scripts/build.mjs + tauri build --no-bundle）');
      console.log('   exe = ' + new Date(exeT).toISOString());
      console.log('   最新源文件 = ' + newest.f + ' @ ' + new Date(newest.t).toISOString());
      process.exit(3);
    }
    console.log('exe 新鲜度检查通过（晚于最新源文件 ' + path.relative(path.join(__dirname, '..', '..'), newest.f) + '）');
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
        try { if (await p.evaluate(() => !!document.getElementById('app'))) { page = p; break; } }
        catch (_) { /* 导航中 */ }
      }
      if (page) break;
    }
    if (page) break;
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!page) { console.log('!! 未找到应用页面'); await browser.close(); killApp(); process.exit(1); }
  console.log('已接入页面:', page.url());

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  // ---------- 1. 侧栏入口 + DA 图标 ----------
  console.log('\n[1] 侧栏入口与字母 DA 图标');
  ok('侧栏存在国立公文书馆入口',
    (await page.locator('.nav-item[data-view="najdb"]').count()) === 1);
  const daText = (await page.locator('.nav-item[data-view="najdb"] .nav-ico-da').textContent().catch(() => '')) || '';
  ok('图标为字母 DA', daText.trim() === 'DA', 'text=' + JSON.stringify(daText.trim()));
  const daBox = await page.evaluate(() => {
    const el = document.querySelector('.nav-item[data-view="najdb"] .nav-ico-da');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok('DA 图标已渲染（非 0 尺寸）', !!daBox && daBox.w > 12 && daBox.h > 10, JSON.stringify(daBox));

  // ---------- 2. 视图与表单 ----------
  console.log('\n[2] 视图与检索表单');
  await page.locator('.nav-item[data-view="najdb"]').click();
  await page.waitForTimeout(900);
  ok('视图已激活', (await page.locator('#view-najdb.active').count()) === 1);
  ok('検索範囲 5 项（与原站一致）',
    (await page.locator('#najScope option').count()) === 5,
    'count=' + await page.locator('#najScope option').count());
  const scopeVals = await page.locator('#najScope option').evaluateAll((els) => els.map((e) => e.value));
  ok('範囲取值 kw_all/kw_title/kw_creator/kw_item/kw_id',
    JSON.stringify(scopeVals) === JSON.stringify(['kw_all', 'kw_title', 'kw_creator', 'kw_item', 'kw_id']),
    scopeVals.join(','));
  ok('表示件数选择器存在（20/50/100/200）', (await page.locator('#najRows option').count()) === 4);
  ok('检索按钮可用', !(await page.locator('#najSearchBtn').isDisabled()));

  // ---------- 3. 空关键词本地拦下 ----------
  console.log('\n[3] 空关键词拦截');
  await page.fill('#najKw', '');
  await page.click('#najSearchBtn');
  await page.waitForTimeout(400);
  const toastText = (await page.locator('#toast').textContent().catch(() => '')) || '';
  ok('提示需输入关键词', /关键词/.test(toastText), 'toast=' + toastText.trim());
  ok('未发起检索（状态行无命中数）',
    !/命中/.test((await page.locator('#najStatus').textContent().catch(() => '')) || ''));

  // ---------- 4. 真实检索 ----------
  console.log('\n[4] 真实检索 論語（走 Rust 桥 → 原站）');
  await page.fill('#najKw', '論語');
  await page.selectOption('#najScope', 'kw_all');
  await page.selectOption('#najRows', '20');
  await page.click('#najSearchBtn');

  const started = Date.now();
  let total = 0, itemCount = 0;
  while (Date.now() - started < SEARCH_TIMEOUT_MS) {
    const status = (await page.locator('#najStatus').textContent().catch(() => '')) || '';
    itemCount = await page.locator('.naj-row').count();
    const m = status.match(/命中\s*(\d+)\s*件/);
    if (m) { total = parseInt(m[1], 10); if (itemCount > 0) break; }
    if (/检索失败/.test(status)) {
      console.log('   （首次失败，原站会偶发重置；等 3 秒后重试一次）');
      await page.waitForTimeout(3000);
      await page.click('#najSearchBtn');
    }
    await page.waitForTimeout(1500);
  }
  ok('取得命中数', total > 0, 'total=' + total);
  ok('命中数量级合理（論語 ≥ 300）', total >= 300, 'total=' + total);
  ok('结果列表已渲染', itemCount > 0, 'items=' + itemCount);
  ok('状态行显示用时', /用时/.test((await page.locator('#najStatus').textContent()) || ''),
    ((await page.locator('#najStatus').textContent()) || '').trim());

  // 每条结果末尾必须有原链接（用户明确要求）——不仅要有，而且必须在**末尾**
  const srcCount = await page.locator('.naj-row .naj-src .naj-link').count();
  ok('每条结果末尾都有原链接', srcCount === itemCount && srcCount > 0,
    'links=' + srcCount + ' items=' + itemCount);
  const tailOk = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.naj-row')];
    return rows.every((r) => {
      const last = r.lastElementChild;
      return last && last.classList.contains('naj-src')
        && last.querySelector('a[href^="https://www.digital.archives.go.jp/"]');
    });
  });
  ok('原链接确为每条结果 DOM 的最后一个子元素', tailOk === true, String(tailOk));
  const firstHref = await page.locator('.naj-row').first().locator('.naj-src .naj-link').getAttribute('href');
  ok('原链接指向原站记录页', /^https:\/\/www\.digital\.archives\.go\.jp\/(file|item|fonds)\/\d+$/.test(firstHref || ''),
    firstHref || '');
  const firstPair = await page.locator('.naj-row').first().locator('.naj-kv').first().textContent();
  ok('结果含著录字段（請求番号等）', /請求番号|数量|媒体|作成|関連/.test(firstPair || ''), (firstPair || '').trim());

  // 分页信息
  ok('分页条显示第 1 / N 页', /第\s*1\s*\/\s*\d+\s*页/.test((await page.locator('#najPageInfo').textContent()) || ''),
    ((await page.locator('#najPageInfo').textContent()) || '').trim());

  // ---------- 4b. 详细检索：资料种别（只筛簿册） ----------
  console.log('\n[4b] 详细检索：资料种别=簿册（用户要求可筛簿册/件名）');
  const waitResults = async (ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const n = await page.locator('.naj-row').count();
      const st = (await page.locator('#najStatus').textContent().catch(() => '')) || '';
      const m = st.match(/命中\s*(\d+)/);
      if (n > 0 && m) return { n, total: Number(m[1]) };
      if (/检索失败/.test(st)) { await page.waitForTimeout(2500); await page.click('#najSearchBtn'); }
      await page.waitForTimeout(1200);
    }
    return { n: await page.locator('.naj-row').count(), total: -1 };
  };

  await page.click('#najToggle');
  await page.waitForTimeout(300);
  ok('详细检索面板可展开', await page.locator('#najAdv').isVisible());
  await page.check('#najTypes input[value="da22"]');
  await page.fill('#najKw', '漢書');
  await page.selectOption('#najRows', '20');
  await page.click('#najSearchBtn');
  const r22 = await waitResults();
  ok('限定簿册后有结果', r22.n > 0, 'items=' + r22.n + ' total=' + r22.total);
  const kinds22 = await page.locator('.naj-row .kdb-badge').allTextContents();
  ok('结果全部为簿册', kinds22.length > 0 && kinds22.every((k) => k.includes('簿冊') || k.includes('簿册')), kinds22.slice(0, 3).join('/'));
  const sum22 = (await page.locator('#najCondSummary').textContent()) || '';
  ok('条件摘要回显「资料种别：簿册」', sum22.includes('资料种别') && sum22.includes('簿册'), sum22.trim());

  // ---------- 4c. 内閣文庫 汉籍分类（已并入「详细检索」浮层，用户要求） ----------
  console.log('\n[4c] 内閣文庫 汉籍分类（在详细检索浮层内）：限定「漢籍（漢書部）」检索');
  ok('分类区位于详细检索浮层内', (await page.locator('#najAdv #najNaikakuChips').count()) === 1);
  if (await page.locator('#najAdv').isHidden()) { await page.click('#najToggle'); await page.waitForTimeout(300); }
  ok('详细检索浮层已展开', await page.locator('#najAdv').isVisible());
  const chips = await page.locator('#najNaikakuChips .naj-chip').allTextContents();
  ok('分类按钮齐备（9 个）', chips.length === 9, chips.join('/'));
  // 取消「簿册」勾选：用 evaluate 直接改状态（不依赖可见性）
  await page.evaluate(() => {
    const i = document.querySelector('#najTypes input[value="da22"]');
    if (i) { i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  // 已有关键词（漢書）→ 点分类会立即重检并收起浮层
  await page.click('#najNaikakuChips .naj-chip[data-naj-fond="3602612"]');
  await page.waitForTimeout(600);
  ok('选分类后浮层收起（已有关键词会自动检索）', await page.locator('#najAdv').isHidden());
  const rFond = await waitResults();
  ok('限定漢書部后有结果', rFond.n > 0, 'items=' + rFond.n + ' total=' + rFond.total);
  const sumFond = (await page.locator('#najCondSummary').textContent()) || '';
  ok('条件摘要回显分类', sumFond.includes('分类') && sumFond.includes('漢籍'), sumFond.trim());
  const urlFond = await page.evaluate(() => window.__najLastUrl || '');
  ok('检索 URL 带 fond=3602612', (urlFond || '').includes('fond=3602612'), String(urlFond).slice(0, 120));
  ok('详细条件角标计入分类（=1）', ((await page.locator('#najFilterCount').textContent()) || '').trim() === '1',
    await page.locator('#najFilterCount').textContent());
  // 重新展开：已选状态 + ↗ 指向原站分类页
  await page.click('#najToggle');
  await page.waitForTimeout(300);
  ok('分类按钮显示为已选', (await page.locator('#najNaikakuChips .naj-chip.on').count()) === 1);
  const pageHref = await page.locator('#najNaikakuChips .naj-chip-wrap:nth-child(2) .naj-chip-page').getAttribute('href');
  ok('分类页入口指向原站 /fonds/3602612', pageHref === 'https://www.digital.archives.go.jp/fonds/3602612', String(pageHref));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 收起详细检索浮层', await page.locator('#najAdv').isHidden());

  // ---------- 5. 详情（JSON-LD） ----------
  console.log('\n[5] 打开记录详情（JSON-LD）');
  const firstTitle = ((await page.locator('.naj-row').first().locator('.naj-row-title').textContent()) || '').trim();
  await page.locator('.naj-row').first().click();
  let detailOk = false;
  for (let i = 0; i < 20 && !detailOk; i++) {
    await page.waitForTimeout(700);
    detailOk = (await page.locator('#najDetail .kdb-kv').count()) > 3;
  }
  ok('详情字段已渲染', detailOk);
  ok('详情显示返回按钮', (await page.locator('#najDetail [data-naj-back]').count()) === 1);
  const detailText = (await page.locator('#najDetail').textContent()) || '';
  ok('详情含 URI', /URI/.test(detailText));
  ok('详情含标题', detailText.includes(firstTitle) || firstTitle === '', 'title=' + firstTitle);
  ok('详情含引用例', /引用例/.test(detailText) && /国立公文書館所蔵/.test(detailText));
  const detailSrc = await page.locator('#najDetail .naj-src-foot .naj-link').getAttribute('href');
  ok('详情末尾原链接存在', /^https:\/\/www\.digital\.archives\.go\.jp\//.test(detailSrc || ''), detailSrc || '');
  const detailTail = await page.evaluate(() => {
    const d = document.getElementById('najDetail');
    const last = d && d.lastElementChild;
    return !!(last && last.classList.contains('naj-src')
      && last.querySelector('a[href^="https://www.digital.archives.go.jp/"]'));
  });
  ok('详情末尾亦为原链接（DOM 最后子元素）', detailTail === true, String(detailTail));
  ok('详情有「打开原网页」入口', (await page.locator('#najDetail a[data-naj-out]').count()) >= 1);
  ok('详情有「复制引用例」', (await page.locator('#najDetail [data-naj-copy]').count()) === 1);

  // ---------- 6. 转入编目记录 ----------
  console.log('\n[6] 参考此记录新建编目记录');
  await page.click('#najDetail [data-naj-torecord]');
  await page.waitForTimeout(900);
  ok('已跳到编目记录视图', (await page.locator('#view-records.active').count()) === 1);
  ok('编目表单已打开', await page.locator('#recordFormOverlay').isVisible());
  const recTitle = await page.inputValue('#rec-title').catch(() => '');
  ok('書名已带入（且非臆造）', recTitle.length > 0, 'title=' + recTitle);
  ok('带入书名与检索到的标题一致', recTitle === firstTitle, 'rec=' + recTitle + ' / list=' + firstTitle);
  const recShelf = await page.inputValue('#rec-shelf').catch(() => '');
  const recAppendix = await page.inputValue('#rec-appendix').catch(() => '');
  ok('附録写入引用例', /国立公文書館所蔵/.test(recAppendix || ''), (recAppendix || '').slice(0, 40));
  await page.click('#recordFormCancel');
  await page.waitForTimeout(300);

  // ---------- 7. 白名单 ----------
  console.log('\n[7] Rust 侧白名单（站外 URL 必须被拒）');
  const deny = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('naj_fetch', { url: 'https://example.com/search?kw0=x' });
      return 'ALLOWED';
    } catch (e) { return String(e && e.message ? e.message : e); }
  });
  ok('站外域名被拒绝', deny !== 'ALLOWED' && /仅允许/.test(deny), deny.slice(0, 60));
  const denyPath = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('naj_fetch', { url: 'https://www.digital.archives.go.jp/contentDownload/a.pdf' });
      return 'ALLOWED';
    } catch (e) { return String(e && e.message ? e.message : e); }
  });
  ok('站内非白名单路径被拒绝', denyPath !== 'ALLOWED' && /仅允许/.test(denyPath), denyPath.slice(0, 60));

  // ---------- 8. 脚本错误 ----------
  ok('0 页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' ;; '));

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
