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
  const navCount = await page.locator('.nav-item').count();
  check('侧栏导航项 10 个', navCount === 10, '实际 ' + navCount);
  check('视图 8 个', await page.locator('.view').count() === 8);

  const labels = await page.locator('.nav-item span:not(.nav-badge)').allTextContents();
  // 注：APP 内 catalog 副本为繁体页面，故目录相关三项匹配简繁任一
  const need = [
    ['纪年查询'], ['快速跳转'],
    ['细则查阅', '細則查閱'], ['分类表查询', '分類表查詢'], ['工作手册', '工作手冊'],
    ['使用介绍'], ['更新日志'], ['编目记录'], ['同步设置'], ['关于'],
  ];
  const missing = need.filter(alias => !alias.some(t => labels.includes(t)));
  check('侧栏含全部入口文字', missing.length === 0,
    missing.length ? '缺 ' + missing.map(a => a[0]).join('、') : '共 ' + labels.length + ' 项');

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

  // ---------- 4. APP 侧栏镜像锚点（分类导航） ----------
  await page.waitForTimeout(900);
  const anchorVisible = await page.locator('#sideAnchors').isVisible().catch(() => false);
  check('侧栏锚点卡片显示', anchorVisible === true);

  const cats = await page.locator('#sideAnchors .cfb-side').allTextContents();
  check('侧栏镜像分类导航', cats.some(t => /經部|经部/.test(t)) && cats.some(t => /全部類目|全部类目/.test(t)),
    cats.length ? cats.join('/') : '（空）');

  const catActive = await page.locator('#sideAnchors .cfb-side.active').textContent().catch(() => null);
  check('分类导航高亮同步', /全部類目|全部类目/.test(catActive || ''), 'active=' + catActive);

  // 点击侧栏「史部」→ iframe 内分类导航联动
  const shiBtn = page.locator('#sideAnchors .cfb-side', { hasText: /史部/ }).first();
  if (await shiBtn.count()) {
    await shiBtn.click();
    await page.waitForTimeout(900);
    const nowActive = await page.locator('#sideAnchors .cfb-side.active').textContent().catch(() => null);
    check('点侧栏「史部」→ 高亮同步', /史部/.test(nowActive || ''), 'active=' + nowActive);
    const rows = fCat ? await fCat.locator('.ctbl tbody tr').count() : 0;
    check('分类表有数据行', rows > 0, 'rows=' + rows);
  }

  // ---------- 5. 切到细则查阅 → 章节锚点 ----------
  await page.click('.nav-item[data-view="catalog"][data-tab="0"]');
  await page.waitForTimeout(1800);
  const anchors = await page.locator('#sideAnchors .anchor-item').allTextContents();
  check('侧栏镜像章节导航', anchors.length > 5, 'anchor 数 ' + anchors.length);
  const anchorLabel = await page.locator('#sideAnchors .side-label').textContent().catch(() => '');
  check('章节导航标签含版本', /章節導航|章节导航/.test(anchorLabel), 'label=' + anchorLabel);

  // 点第一个章节锚点
  if (anchors.length) {
    const beforeTop = fCat ? await fCat.locator('#db').evaluate(el => el.scrollTop).catch(() => 0) : 0;
    await page.locator('#sideAnchors .anchor-item').nth(2).click();
    await page.waitForTimeout(1200);
    const afterTop = fCat ? await fCat.locator('#db').evaluate(el => el.scrollTop).catch(() => 0) : 0;
    check('点章节锚点 → iframe 内滚动', afterTop !== beforeTop || afterTop > 0,
      beforeTop + ' -> ' + afterTop);
    const act = await page.locator('#sideAnchors .anchor-item.active').count();
    check('章节锚点高亮存在', act >= 1, 'active ' + act);
  }

  // ---------- 6. 切到工作手册 → 信息卡 ----------
  await page.click('.nav-item[data-view="catalog"][data-tab="2"]');
  await page.waitForTimeout(1800);
  const cardRows = await page.locator('#sideAnchors .side-card .cr').count();
  check('侧栏镜像工作手册信息卡', cardRows === 4, 'cr 行数 ' + cardRows);
  const cardLabel = await page.locator('#sideAnchors .side-label').textContent().catch(() => '');
  check('手册卡标签正确', /工作手冊|工作手册/.test(cardLabel), 'label=' + cardLabel);

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
    const anchorHidden = await page.locator('#sideAnchors').isHidden().catch(() => false);
    check(name + ' 视图下锚点卡片收起', anchorHidden === true);
  }

  // ---------- 8. 非 iframe 视图回归 ----------
  await page.click('.nav-item[data-view="records"]');
  await page.waitForTimeout(400);
  check('编目记录视图激活', await page.locator('#view-records.active').count() === 1);
  await page.click('.nav-item[data-view="sync"]');
  await page.waitForTimeout(400);
  check('同步设置视图激活', await page.locator('#view-sync.active').count() === 1);
  await page.click('.nav-item[data-view="about"]');
  await page.waitForTimeout(400);
  check('关于视图激活', await page.locator('#view-about.active').count() === 1);

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

  // ---------- 10. 无 JS 错误 ----------
  const realErrors = errors.filter(e => !/favicon|ERR_/.test(e));
  check('0 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
})();
