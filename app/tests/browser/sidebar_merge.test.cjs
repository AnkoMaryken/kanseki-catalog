// ================================================
// app/tests/browser/sidebar_merge.test.cjs — V0.6 侧栏合并
// 验证：静态站顶部导航全部并入 APP 左侧栏
//       1. iframe 内自带 header / 编目规范侧栏已隐藏
//       2. APP 侧栏含 8 项入口，可切换 iframe 视图
//       3. 编目规范「内容导览」三项 tab 由 APP 侧栏驱动
//       4. 章节/分类/手册导航镜像到 APP 侧栏且可点击滚动
//       5. 侧栏「切换主题」与 iframe 同步
// 对 app dev server（8766）验证；须串行运行
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const config = require('../../../tests/helpers/config.js');

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.launch(config.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  const APP = config.resolveAppUrl();
  await page.goto(APP, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);

  // ---------- 1. 侧栏结构 ----------
  // V9.2.1：侧栏移除了「同步设置 / 账号 / 关于」三项跳转（统一以设置窗口为准）
  // V9.4：新增「日本藏本检索」分组 → 9 → 10 项、11 → 12 视图
  const navCount = await page.locator('.nav-item').count();
  check('侧栏导航项 10 个', navCount === 10, '实际 ' + navCount);
  check('视图 12 个', await page.locator('.view').count() === 12);

  const labels = await page.locator('.nav-item span:not(.nav-badge)').allTextContents();
  // 注：APP 内 catalog 副本为繁体页面，故目录相关三项匹配简繁任一
  const need = [
    ['纪年查询'], ['快速跳转'],
    ['细则查阅', '細則查閱'], ['分类表查询', '分類表查詢'], ['工作手册', '工作手冊'],
    ['古籍类目查询', '古籍類目查詢'],
    ['汉籍检索（日本）', '漢籍檢索（日本）'],
    ['使用介绍'], ['更新日志'], ['编目记录'],
  ];
  const missing = need.filter(alias => !alias.some(t => labels.includes(t)));
  check('侧栏含全部入口文字', missing.length === 0,
    missing.length ? '缺 ' + missing.map(a => a[0]).join('、') : '共 ' + labels.length + ' 项');

  // V9.2.1：这三项已移交设置窗口，侧栏不应再有它们的跳转
  const gone = ['同步设置', '账号', '关于'].filter(t => labels.includes(t));
  check('侧栏已移除「同步设置/账号/关于」跳转', gone.length === 0, gone.join('、') || '已全部移除');
  check('侧栏仍保留同步状态指示', await page.locator('#syncStatusDot').count() === 1);

  check('侧栏分组数 ≥5', await page.locator('.app-sidebar .side-sec').count() >= 5,
    '实际 ' + await page.locator('.app-sidebar .side-sec').count());
  check('侧栏含「切换主题」', await page.locator('#themeToggleBtn').count() === 1);
  check('侧栏含「打开网页版」', await page.locator('#openWebBtn').count() === 1);

  // ---------- 2. iframe 内 header 已隐藏 ----------
  const fQuery = page.frame({ url: /pages\/index\.html/ });
  check('查询 iframe 存在', !!fQuery);
  if (fQuery) {
    const navVisible = await fQuery.locator('.app-header .header-nav').isVisible().catch(() => null);
    check('查询页顶部导航已隐藏', navVisible === false, 'isVisible=' + navVisible);
    const brandVisible = await fQuery.locator('.app-header .header-brand').isVisible().catch(() => null);
    check('查询页品牌区已隐藏', brandVisible === false, 'isVisible=' + brandVisible);
    const searchVisible = await fQuery.locator('#globalSearch').isVisible().catch(() => null);
    check('查询页搜索框保留', searchVisible === true, 'isVisible=' + searchVisible);
    const filterTop = await fQuery.locator('.filter-bar').first().evaluate(
      el => getComputedStyle(el).top).catch(() => null);
    check('筛选条吸附偏移归零', filterTop === '0px', 'top=' + filterTop);
  }

  // ---------- 3. 切到编目规范 ----------
  await page.click('.nav-item[data-view="catalog"][data-tab="1"]');
  await page.waitForTimeout(1600);
  check('catalog 视图激活', await page.locator('#view-catalog.active').count() === 1);
  check('catalog hash 带 tab', page.url().includes('tab=1'), page.url().split('#')[1] || '');

  const fCat = page.frames().find(f => /pages\/catalog\.html/.test(f.url() || ''));
  check('catalog iframe 已加载', !!fCat);
  if (fCat) {
    const hdrVisible = await fCat.locator('.app-header').isVisible().catch(() => null);
    check('编目规范页 header 已隐藏', hdrVisible === false, 'isVisible=' + hdrVisible);
    const asideVisible = await fCat.locator('.docs-sidebar').isVisible().catch(() => null);
    check('编目规范自带侧栏已隐藏', asideVisible === false, 'isVisible=' + asideVisible);

    const cols = await fCat.locator('.docs-layout').evaluate(
      el => getComputedStyle(el).gridTemplateColumns).catch(() => null);
    const colCount = cols ? cols.split(' ').length : 0;
    check('编目规范改为两栏布局', colCount === 2, 'cols=' + cols);

    const activeTab = await fCat.locator('.tab-btn.active').getAttribute('data-tab').catch(() => null);
    check('iframe 内切到「分类表查询」', activeTab === '1', 'tab=' + activeTab);
  }

  // ---------- 4. 内容导览弹窗（分类导航） ----------
  // V0.8：锚点不再于侧栏内联展开，改为浮层弹窗
  await page.waitForTimeout(900);
  const anchorSideHidden = await page.evaluate(() => {
    const el = document.querySelector('#sideAnchors');
    return el ? getComputedStyle(el).display === 'none' : true;
  });
  check('侧栏不再内联显示锚点卡片', anchorSideHidden === true);

  // 点「分类表查询」右侧 ▸ 弹出分类导航
  await page.click('.nav-dir[data-dir-open="1"]');
  await page.waitForTimeout(1600);
  check('分类导航弹窗已打开', await page.locator('#anchorPop').isVisible());

  const cats = await page.locator('#anchorPopBody .cfb-side').allTextContents();
  check('弹窗内分类导航齐备', cats.some(t => /經部|经部/.test(t)) && cats.some(t => /全部類目|全部类目/.test(t)),
    cats.length ? cats.join('/') : '（空）');

  const catActive = await page.locator('#anchorPopBody .cfb-side.active').textContent().catch(() => null);
  check('分类导航高亮同步', /全部類目|全部类目/.test(catActive || ''), 'active=' + catActive);

  // 点击弹窗「史部」→ iframe 内分类导航联动
  const shiBtn = page.locator('#anchorPopBody .cfb-side', { hasText: /史部/ }).first();
  if (await shiBtn.count()) {
    await shiBtn.click();
    await page.waitForTimeout(1000);
    // 点击后弹窗自动收起，需重新打开读取高亮
    await page.click('.nav-dir[data-dir-open="1"]');
    await page.waitForTimeout(1000);
    const nowActive = await page.locator('#anchorPopBody .cfb-side.active').textContent().catch(() => null);
    check('点「史部」→ 高亮同步', /史部/.test(nowActive || ''), 'active=' + nowActive);
    const rows = fCat ? await fCat.locator('.ctbl tbody tr').count() : 0;
    check('分类表有数据行', rows > 0, 'rows=' + rows);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // ---------- 5. 切到细则查阅 → 章节锚点弹窗 ----------
  await page.click('.nav-item[data-view="catalog"][data-tab="0"]');
  await page.waitForTimeout(1800);
  await page.click('.nav-dir[data-dir-open="0"]');
  await page.waitForTimeout(1200);
  check('章节导航弹窗已打开', await page.locator('#anchorPop').isVisible());
  const anchors = await page.locator('#anchorPopBody .anchor-item').allTextContents();
  check('弹窗内章节导航齐备', anchors.length > 5, 'anchor 数 ' + anchors.length);
  const anchorLabel = await page.textContent('#anchorPopTitle').catch(() => '');
  check('弹窗标题为章节导航', /章節導航|章节导航/.test(anchorLabel), 'title=' + anchorLabel);

  // 点章节锚点 → iframe 内滚动
  if (anchors.length) {
    const beforeTop = fCat ? await fCat.locator('#db').evaluate(el => el.scrollTop).catch(() => 0) : 0;
    await page.locator('#anchorPopBody .anchor-item').nth(2).click();
    await page.waitForTimeout(1400);
    const afterTop = fCat ? await fCat.locator('#db').evaluate(el => el.scrollTop).catch(() => 0) : 0;
    check('点章节锚点 → iframe 内滚动', afterTop !== beforeTop || afterTop > 0,
      beforeTop + ' -> ' + afterTop);
    // 重新打开看高亮是否回同步
    await page.click('.nav-dir[data-dir-open="0"]');
    await page.waitForTimeout(1200);
    const act = await page.locator('#anchorPopBody .anchor-item.active').count();
    check('章节锚点高亮存在', act >= 1, 'active ' + act);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // ---------- 6. 切到工作手册 → 信息卡弹窗 ----------
  await page.click('.nav-dir[data-dir-open="2"]');
  await page.waitForTimeout(1800);
  check('工作手册弹窗已打开', await page.locator('#anchorPop').isVisible());
  const cardRows = await page.locator('#anchorPopBody .side-card .cr').count();
  check('弹窗内工作手册信息卡 4 行', cardRows === 4, 'cr 行数 ' + cardRows);
  const cardLabel = await page.textContent('#anchorPopTitle').catch(() => '');
  check('弹窗标题为工作手册', /工作手冊|工作手册/.test(cardLabel), 'title=' + cardLabel);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc 可关弹窗', await page.locator('#anchorPop').isHidden());

  // ---------- 7. 其他 iframe 视图 ----------
  const viewCases = [
    ['jump', /pages\/embed\.html/, '#view-jump', '快速跳转'],
    ['guide', /pages\/guide\.html/, '#view-guide', '使用介绍'],
    ['changelog', /pages\/changelog\.html/, '#view-changelog', '更新日志'],
  ];
  for (const [view, re, sel, name] of viewCases) {
    await page.click('.nav-item[data-view="' + view + '"]');
    await page.waitForTimeout(1300);
    check(name + ' 视图激活', await page.locator(sel + '.active').count() === 1);
    const fr = page.frames().find(f => re.test(f.url() || ''));
    check(name + ' iframe 加载', !!fr, fr ? '' : '未找到 frame');
    if (fr) {
      const hv = await fr.locator('.app-header').isVisible().catch(() => null);
      check(name + ' 页 header 已隐藏', hv === false, 'isVisible=' + hv);
    }
    const anchorPopHidden = await page.locator('#anchorPop').isHidden().catch(() => false);
    check(name + ' 视图下导览弹窗关闭', anchorPopHidden === true);
  }

  // ---------- 7b. 古籍类目查询视图（V9.0） ----------
  await page.click('.nav-item[data-view="kanseki"]');
  await page.waitForTimeout(1800);
  check('古籍类目查询视图激活', await page.locator('#view-kanseki.active').count() === 1);
  const fKans = page.frames().find(f => /pages\/kanseki\.html/.test(f.url() || ''));
  check('古籍类目查询 iframe 已加载', !!fKans, fKans ? '' : '未找到 frame');
  const kansBox = await page.evaluate(() => {
    const fr = document.getElementById('kansekiFrame');
    const main = document.querySelector('.app-main');
    if (!fr) return null;
    const r = fr.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), mainH: Math.round(mr.height) };
  });
  check('古籍类目查询 iframe 撑满视图', !!kansBox && kansBox.h > 400 && Math.abs(kansBox.h - kansBox.mainH) <= 2,
    kansBox ? kansBox.w + 'x' + kansBox.h + ' (main ' + kansBox.mainH + ')' : '未找到');

  // ---------- 8. 非 iframe 视图回归 ----------
  await page.click('.nav-item[data-view="records"]');
  await page.waitForTimeout(400);
  check('编目记录视图激活', await page.locator('#view-records.active').count() === 1);
  // V9.2.1：sync/about 侧栏入口已移除，改用 hash 直达（视图本身仍保留）
  await page.evaluate(() => { location.hash = '#/sync'; });
  await page.waitForTimeout(500);
  check('同步设置视图激活（hash 直达）', await page.locator('#view-sync.active').count() === 1);
  await page.evaluate(() => { location.hash = '#/about'; });
  await page.waitForTimeout(500);
  check('关于视图激活（hash 直达）', await page.locator('#view-about.active').count() === 1);

  // 关于页按钮改为 APP 内跳转
  await page.click('#openChangelogBtn');
  await page.waitForTimeout(1000);
  check('关于页「更新日志」→ APP 内跳转', await page.locator('#view-changelog.active').count() === 1);

  // ---------- 9. 主题同步 ----------
  await page.click('.nav-item[data-view="query"]');
  await page.waitForTimeout(900);
  const t0 = await page.evaluate(() => localStorage.getItem('theme') || 'light');
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(700);
  const t1 = await page.evaluate(() => localStorage.getItem('theme'));
  check('侧栏可切换主题', t1 !== t0, t0 + ' -> ' + t1);
  const fq = page.frames().find(f => /pages\/index\.html/.test(f.url() || ''));
  if (fq) {
    const ifrTheme = await fq.evaluate(() => document.documentElement.getAttribute('data-theme')).catch(() => null);
    check('iframe 内主题同步', ifrTheme === t1, 'iframe=' + ifrTheme + ' app=' + t1);
  }
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(600);

  // ---------- 10. iframe 尺寸（防「显示不全」回归） ----------
  // 历史 bug：尺寸规则只绑 #view-query，其余视图的 iframe 退化为浏览器默认 150px
  const frameSizes = [];
  const sizeCases = [
    ['query', 'queryFrame', '.nav-item[data-view="query"]'],
    ['catalog', 'catalogFrame', '.nav-item[data-view="catalog"][data-tab="0"]'],
    ['kanseki', 'kansekiFrame', '.nav-item[data-view="kanseki"]'],
    ['jump', 'jumpFrame', '.nav-item[data-view="jump"]'],
    ['guide', 'guideFrame', '.nav-item[data-view="guide"]'],
    ['changelog', 'changelogFrame', '.nav-item[data-view="changelog"]'],
  ];
  for (const [view, fid, sel] of sizeCases) {
    await page.click(sel);
    await page.waitForTimeout(1000);
    const box = await page.evaluate(({ view, fid }) => {
      const fr = document.getElementById(fid);
      const main = document.querySelector('.app-main');
      if (!fr) return null;
      const r = fr.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), mainH: Math.round(mr.height) };
    }, { view, fid });
    frameSizes.push({ view, ...(box || { w: 0, h: 0, mainH: 0 }) });
    const ok = box && box.h > 400 && Math.abs(box.h - box.mainH) <= 2;
    check('iframe 撑满视图：' + view, ok,
      box ? box.w + 'x' + box.h + ' (main ' + box.mainH + ')' : '未找到');
  }
  check('全部 iframe 高度 > 400px', frameSizes.every(f => f.h > 400),
    frameSizes.map(f => f.view + '=' + f.h).join(' '));

  // ---------- 11. 内嵌页高度链校正 ----------
  await page.click('.nav-item[data-view="catalog"][data-tab="0"]');
  await page.waitForTimeout(2000);
  const fCat2 = page.frames().find(f => /pages\/catalog\.html/.test(f.url() || ''));
  if (fCat2) {
    const inner = await fCat2.evaluate(() => {
      const db = document.getElementById('db');
      const r = db ? db.getBoundingClientRect() : null;
      return { innerH: window.innerHeight, dbH: r ? Math.round(r.height) : 0, dbTop: r ? Math.round(r.top) : 0 };
    });
    // 隐藏顶栏后正文区应占满大部分视口（旧值仅约 62px，修复后约 744px）
    check('细则正文区高度合理', inner.dbH > inner.innerH * 0.7,
      'db=' + inner.dbH + ' / innerH=' + inner.innerH);
    check('细则正文区顶部偏移 < 120px', inner.dbTop < 120, 'top=' + inner.dbTop);
  }

  await page.click('.nav-item[data-view="catalog"][data-tab="2"]');
  await page.waitForTimeout(2000);
  const fPdf = page.frames().find(f => /pages\/catalog\.html/.test(f.url() || ''));
  if (fPdf) {
    const pdf = await fPdf.evaluate(() => {
      const el = document.querySelector('.pdf-frame');
      return el ? { h: Math.round(el.getBoundingClientRect().height), innerH: window.innerHeight } : null;
    });
    check('PDF 手册高度合理', !!pdf && pdf.h > pdf.innerH * 0.7,
      pdf ? pdf.h + ' / ' + pdf.innerH : '未找到');
  }

  // ---------- 12. 快速跳转浮动栏不得悬空 ----------
  await page.click('.nav-item[data-view="jump"]');
  await page.waitForTimeout(1600);
  const fj = page.frames().find(f => /pages\/embed\.html/.test(f.url() || ''));
  if (fj) {
    const bar = await fj.evaluate(() => {
      const el = document.querySelector('.jump-bar');
      return el ? { top: Math.round(el.getBoundingClientRect().top) } : null;
    });
    check('跳转浮动栏贴近顶部', !!bar && bar.top < 40, bar ? 'top=' + bar.top : '未找到');
  }

  // ---------- 13. 侧栏底部按钮吸底（低矮窗口下不得被挤出） ----------
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  for (const [name, sel] of [
    ['查询', '.nav-item[data-view="query"]'],
    ['细则查阅', '.nav-item[data-view="catalog"][data-tab="0"]'],
    ['工作手册', '.nav-item[data-view="catalog"][data-tab="2"]'],
  ]) {
    await page.click(sel);
    await page.waitForTimeout(2000);
    const vis = await page.evaluate(() => {
      const sb = document.querySelector('.app-sidebar');
      const ft = document.querySelector('.side-footer');
      const sr = sb.getBoundingClientRect();
      const fr = ft.getBoundingClientRect();
      return fr.bottom <= sr.bottom + 1 && fr.top >= sr.top - 1 && fr.height > 10;
    });
    check('底部按钮可见（' + name + '）', vis === true);
  }

  // ---------- 13b. Tauri 真实窗口尺寸下侧栏不溢出 ----------
  // 主窗口 1280x800，最小窗口 960x600（见 tauri.conf.json）
  for (const vp of [{ width: 1280, height: 800 }, { width: 960, height: 600 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    for (const [name, sel] of [
      ['查询', '.nav-item[data-view="query"]'],
      ['细则查阅', '.nav-item[data-view="catalog"][data-tab="0"]'],
      ['分类表', '.nav-item[data-view="catalog"][data-tab="1"]'],
      ['手册', '.nav-item[data-view="catalog"][data-tab="2"]'],
    ]) {
      await page.click(sel);
      await page.waitForTimeout(1800);
      const m = await page.evaluate(() => {
        const sb = document.querySelector('.app-sidebar');
        const sr = sb.getBoundingClientRect();
        const items = [...document.querySelectorAll('.nav-item')];
        const vis = items.filter(el => {
          const b = el.getBoundingClientRect();
          return b.top >= sr.top - 1 && b.bottom <= sr.bottom + 1;
        }).length;
        return { overflow: sb.scrollHeight - sb.clientHeight, vis, total: items.length };
      });
      const tag = `${vp.width}x${vp.height} ${name}`;
      check('侧栏不溢出（' + tag + '）', m.overflow <= 0, '溢出=' + m.overflow);
      check('导航项全部可见（' + tag + '）', m.vis === m.total, `${m.vis}/${m.total}`);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // ---------- 15. 内容新鲜度（防 src/pages 历史副本回退） ----------
  // 历史坑：src/pages/ 曾是 v6.0 一次性快照，落后根目录 7 个版本，
  // 桌面版跑旧内容。现由 build.mjs 从仓库根实时同步，此处守卫不得回退。
  const fresh = await page.evaluate(async () => {
    const get = async (u) => (await fetch(u, { cache: 'no-store' })).text();
    const idx = await get('pages/index.html');
    const cat = await get('pages/catalog.html');
    return {
      hasOtherStates: idx.includes('OTHER_STATES'),          // V8.0 周边政权
      hasUserState: idx.includes('user-state.js'),           // V7.0 用户态
      hasMobileNav: idx.includes('mobile-nav.js'),           // V8.2 移动端
      hasSideAnchors: cat.includes('id="sideAnchors"'),      // 侧栏镜像源
      embedInjected: idx.includes('kanseki-app-embed'),      // APP 样式已注入
    };
  });
  check('内容含 V8.0 周边政权数据', fresh.hasOtherStates === true);
  check('内容含 user-state.js（V7.0）', fresh.hasUserState === true);
  check('内容含 mobile-nav.js（V8.2）', fresh.hasMobileNav === true);
  check('catalog 保留 #sideAnchors 镜像源', fresh.hasSideAnchors === true);
  check('APP 嵌入样式已注入', fresh.embedInjected === true);

  // 账号页与依赖脚本就位（页内登录链接否则会 404）
  const assets = await page.evaluate(async () => {
    const paths = ['pages/login.html', 'pages/signup.html', 'pages/terms.html',
      'pages/privacy.html', 'pages/profile.html', 'pages/user-state.js',
      'pages/overlay.js', 'pages/mobile-nav.js', 'pages/docs/manual.pdf'];
    const out = {};
    for (const p of paths) {
      try { out[p] = (await fetch(p, { method: 'HEAD' })).ok; } catch (e) { out[p] = false; }
    }
    return out;
  });
  const missingAssets = Object.entries(assets).filter(([, ok]) => !ok).map(([p]) => p);
  check('账号页与依赖脚本齐备', missingAssets.length === 0, missingAssets.join(', ') || '全部就位');

  // ---------- 14. 无 JS 错误 ----------
  const realErrors = errors.filter(e => !/favicon|ERR_/.test(e));
  check('0 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
})();
