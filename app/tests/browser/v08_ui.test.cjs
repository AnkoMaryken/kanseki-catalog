// ================================================
// app/tests/browser/v08_ui.test.cjs — V0.8 用户反馈 5 项修改验证
// -------------------------------------------------
// 覆盖：
//   1. 品牌栏已恢复（侧栏顶部「漢」+ 名称 + 桌面版）
//      且「收起侧栏 / 窗口」按钮移到自绘标题栏（原系统标题栏位置）
//   2. 图标/ favicon 底色改为黑 #101012（不再藏青 #2b3a67）
//   3. 编目规范三项的「内容导览」改为浮层弹窗（不再在侧栏内展开）
//   4. 侧栏底部用户菜单向上弹出（不再把「登录」按钮顶上去）
//   5. 无边框窗口：自绘标题栏三键 + 八向缩放热区 + .no-tauri 降级
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
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  await page.goto(config.resolveAppUrl(), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);

  // ---------- 1. 品牌栏恢复 ----------
  console.log('\n[1] 品牌栏恢复 + 标题栏承载功能键');
  ok('品牌栏 .side-title 存在', await page.locator('.side-title').count() === 1);
  const brandIc = await page.locator('.side-title .st-ic').textContent().catch(() => '');
  ok('品牌图标为「漢」', brandIc.trim() === '漢', 'st-ic=' + brandIc);
  const brandTx = await page.locator('.side-title .st-tx').textContent().catch(() => '');
  ok('品牌名称完整', brandTx.trim() === '古代史及汉籍研究工具', 'st-tx=' + brandTx);
  const brandSub = await page.locator('.side-title .st-sub').textContent().catch(() => '');
  ok('副标题为「Windows 桌面版」', brandSub.trim() === 'Windows 桌面版', 'st-sub=' + brandSub);
  // 品牌栏应位于侧栏内部（而非标题栏）
  ok('品牌栏在侧栏内', await page.locator('.app-sidebar .side-title').count() === 1);
  // 品牌栏在侧栏最顶部（第一个子元素）
  const brandIsFirst = await page.evaluate(() => {
    const sb = document.querySelector('.app-sidebar');
    return sb && sb.firstElementChild && sb.firstElementChild.classList.contains('side-title');
  });
  ok('品牌栏位于侧栏顶部', brandIsFirst === true);

  // 侧栏内不应再有工具按钮（已移到标题栏）
  ok('侧栏内无收起按钮', await page.locator('.app-sidebar #collapseBtn').count() === 0);
  ok('侧栏内无窗口按钮', await page.locator('.app-sidebar #winBtn').count() === 0);

  // ---------- 2. 自绘标题栏 ----------
  console.log('\n[2] 自绘标题栏（原系统标题栏位置）');
  ok('标题栏存在', await page.locator('.app-titlebar').count() === 1);
  ok('收起侧栏按钮在标题栏内', await page.locator('.app-titlebar #collapseBtn').count() === 1);
  ok('窗口按钮在标题栏内', await page.locator('.app-titlebar #winBtn').count() === 1);
  ok('最小化键存在', await page.locator('#tbMin').count() === 1);
  ok('最大化键存在', await page.locator('#tbMax').count() === 1);
  ok('关闭键存在', await page.locator('#tbClose').count() === 1);
  // 标题栏在最顶部（先于侧栏）
  const tbFirst = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    return shell && shell.firstElementChild && shell.firstElementChild.classList.contains('app-titlebar');
  });
  ok('标题栏为外壳首元素', tbFirst === true);
  // 拖动区域
  ok('标题栏含拖动区', await page.locator('[data-tauri-drag-region]').count() >= 1);
  // 中间标题文字
  const tbTx = await page.locator('.tb-title-tx').textContent().catch(() => '');
  ok('标题栏显示程序名', tbTx.trim() === '古代史及汉籍研究工具', tbTx);
  // 关闭键悬停变红（CSS 生效性粗检）
  const closeBg = await page.evaluate(() => {
    const el = document.querySelector('#tbClose');
    return el ? getComputedStyle(el).backgroundColor : '';
  });
  ok('关闭键默认透明背景', /rgba\(0, 0, 0, 0\)|transparent/.test(closeBg), closeBg);

  // ---------- 3. 无边框缩放热区 ----------
  console.log('\n[3] 无边框窗口缩放热区');
  const zones = await page.locator('#winResize [data-dir]').count();
  ok('八向缩放热区齐备', zones === 8, '实际 ' + zones);
  for (const dir of ['North', 'South', 'East', 'West', 'NorthWest', 'NorthEast', 'SouthWest', 'SouthEast']) {
    ok('含 ' + dir + ' 热区', await page.locator(`#winResize [data-dir="${dir}"]`).count() === 1);
  }
  // 浏览器环境应加 .no-tauri（隐藏热区，避免遮挡点击）
  ok('浏览器环境标记 no-tauri', await page.locator('.app-shell.no-tauri').count() === 1);
  const rzDisplay = await page.evaluate(() => {
    const el = document.querySelector('#winResize');
    return el ? getComputedStyle(el).display : '';
  });
  ok('浏览器环境隐藏热区', rzDisplay === 'none', 'display=' + rzDisplay);

  // ---------- 4. 窗口菜单（仍可用） ----------
  console.log('\n[4] 窗口菜单');
  ok('菜单初始隐藏', await page.locator('#winMenu').isHidden());
  await page.click('#winBtn');
  await page.waitForTimeout(300);
  ok('菜单可展开', await page.locator('#winMenu').isVisible());
  const winItems = await page.locator('#winMenu .st-menu-item').allTextContents();
  const flat = winItems.join(' ');
  ok('含最小化', flat.includes('最小化'));
  ok('含最大化', flat.includes('最大化'));
  ok('含关闭窗口', flat.includes('关闭窗口'));
  ok('含置顶', flat.includes('窗口置顶'));
  ok('含全屏', flat.includes('全屏'));
  ok('含窗口居中', flat.includes('窗口居中'));
  ok('含尺寸预设 3 档',
    flat.includes('1280×800') && flat.includes('1600×1000') && flat.includes('1100×720'),
    winItems.length + ' 项');
  ok('aria-expanded 同步', (await page.getAttribute('#winBtn', 'aria-expanded')) === 'true');
  // 亮色主题下菜单应为浅色底（原先固定深色 #1b1b1f）
  const menuBg = await page.evaluate(() => {
    const el = document.querySelector('#winMenu');
    return el ? getComputedStyle(el).backgroundColor : '';
  });
  ok('窗口菜单跟随主题（亮色浅底）', /250, 250, 250|255, 255, 255/.test(menuBg), menuBg);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 可关闭菜单', await page.locator('#winMenu').isHidden());

  // ---------- 5. 品牌底色改黑 ----------
  console.log('\n[5] logo / favicon 底色改黑');
  const favicon = await page.getAttribute('link[rel="icon"]', 'href');
  ok('favicon 用黑色 #101012', /%23101012/i.test(favicon || ''), (favicon || '').slice(0, 80));
  ok('favicon 不再用藏青 #2b3a67', !/2b3a67/i.test(favicon || ''));

  // 关于页 SVG logo
  await page.click('.nav-item[data-view="about"]');
  await page.waitForTimeout(500);
  const logoFill = await page.getAttribute('#view-about .av-logo svg rect', 'fill');
  ok('关于页 logo 底色为黑', (logoFill || '').toLowerCase() === '#101012', 'fill=' + logoFill);
  ok('关于页 logo 不用藏青', !/2b3a67/i.test(logoFill || ''));

  // 图标文件已重新生成（字节数应与藏青版不同）
  const fs = require('fs');
  const iconPath = path.join(__dirname, '..', '..', 'tauri', 'icons', '128x128.png');
  if (fs.existsSync(iconPath)) {
    const sz = fs.statSync(iconPath).size;
    ok('128x128.png 已重新生成（9470B·黑底版）', sz === 9470, 'size=' + sz);
  } else {
    ok('128x128.png 存在', false, '文件缺失');
  }

  // ---------- 6. 内容导览弹窗 ----------
  console.log('\n[6] 编目规范「内容导览」弹窗');
  // 侧栏不应显示锚点卡片
  await page.click('.nav-item[data-view="catalog"][data-tab="0"]');
  await page.waitForTimeout(2200);
  const sideAnchorHidden = await page.evaluate(() => {
    const el = document.querySelector('#sideAnchors');
    return el ? getComputedStyle(el).display === 'none' : true;
  });
  ok('侧栏不再显示锚点卡片', sideAnchorHidden === true);
  // 三个导航项各有 ▸ 触发按钮
  ok('触发按钮 3 个', await page.locator('.nav-dir').count() === 3,
    '实际 ' + await page.locator('.nav-dir').count());

  // 弹窗初始隐藏
  ok('弹窗初始隐藏', await page.locator('#anchorPop').isHidden());
  // 点「细则查阅」的 ▸
  await page.click('.nav-dir[data-dir-open="0"]');
  await page.waitForTimeout(900);
  ok('弹窗已打开', await page.locator('#anchorPop').isVisible());
  const popBoxVisible = await page.locator('.anchor-pop-box').isVisible();
  ok('弹窗面板可见', popBoxVisible === true);
  const popTitle = await page.textContent('#anchorPopTitle');
  ok('弹窗标题为「章节导航」', popTitle.trim() === '章节导航', popTitle);
  const popAnchors = await page.locator('#anchorPopBody .anchor-item').allTextContents();
  ok('弹窗内章节锚点已填充', popAnchors.length > 5, 'anchor 数 ' + popAnchors.length);
  // 弹窗为 fixed 浮层，不挤压侧栏
  const popPos = await page.evaluate(() => {
    const el = document.querySelector('#anchorPop');
    return el ? getComputedStyle(el).position : '';
  });
  ok('弹窗为浮层定位', popPos === 'fixed', 'position=' + popPos);
  // 侧栏底部按钮仍可见（未被弹窗挤压）
  const footerVisible = await page.evaluate(() => {
    const sb = document.querySelector('.app-sidebar');
    const ft = document.querySelector('.side-footer');
    const sr = sb.getBoundingClientRect();
    const fr = ft.getBoundingClientRect();
    return fr.bottom <= sr.bottom + 1 && fr.height > 10;
  });
  ok('侧栏底部按钮仍可见', footerVisible === true);

  // 点弹窗条目 → iframe 内滚动（转发生效）
  const fCat = page.frames().find(f => /pages\/catalog\.html/.test(f.url() || ''));
  if (fCat) {
    const before = await fCat.locator('#db').evaluate(el => el.scrollTop).catch(() => 0);
    await page.locator('#anchorPopBody .anchor-item').nth(3).click();
    await page.waitForTimeout(1200);
    const after = await fCat.locator('#db').evaluate(el => el.scrollTop).catch(() => 0);
    ok('点弹窗条目 → iframe 滚动', after !== before || after > 0, before + ' -> ' + after);
    // 点击后应自动收起
    ok('点击条目后弹窗收起', await page.locator('#anchorPop').isHidden());
  } else {
    ok('catalog iframe 已加载', false, '未找到 frame');
  }

  // Esc 关闭
  await page.click('.nav-dir[data-dir-open="0"]');
  await page.waitForTimeout(900);
  ok('可再次打开', await page.locator('#anchorPop').isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Esc 关闭弹窗', await page.locator('#anchorPop').isHidden());

  // 分类表查询 → 分类导航
  await page.click('.nav-dir[data-dir-open="1"]');
  await page.waitForTimeout(1800);
  ok('切到分类表并弹出', await page.locator('#anchorPop').isVisible());
  const popTitle2 = await page.textContent('#anchorPopTitle');
  ok('弹窗标题为「分类导航」', popTitle2.trim() === '分类导航', popTitle2);
  const cats = await page.locator('#anchorPopBody .cfb-side').allTextContents();
  ok('弹窗内分类导航已填充', cats.length > 3, '项数 ' + cats.length);
  await page.click('#anchorPopClose');
  await page.waitForTimeout(300);
  ok('关闭键可关弹窗', await page.locator('#anchorPop').isHidden());

  // 工作手册 → 信息卡
  await page.click('.nav-dir[data-dir-open="2"]');
  await page.waitForTimeout(1800);
  ok('工作手册弹窗打开', await page.locator('#anchorPop').isVisible());
  const cardRows = await page.locator('#anchorPopBody .side-card .cr').count();
  ok('弹窗内信息卡 4 行', cardRows === 4, 'cr 行数 ' + cardRows);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 非编目规范视图下不应弹出
  await page.click('.nav-item[data-view="records"]');
  await page.waitForTimeout(400);
  ok('离开编目规范后弹窗关闭', await page.locator('#anchorPop').isHidden());

  // ---------- 7. 用户菜单向上弹出 ----------
  console.log('\n[7] 侧栏用户菜单向上弹出');
  await page.evaluate(() => localStorage.removeItem('kanseki_user'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const footerTopBefore = await page.evaluate(() => {
    const el = document.querySelector('.side-footer');
    return el.getBoundingClientRect().top;
  });
  ok('菜单初始隐藏', await page.locator('#sideUserMenu').isHidden());
  await page.click('#sideUserBtn');
  await page.waitForTimeout(400);
  ok('用户菜单可展开', await page.locator('#sideUserMenu').isVisible());
  // 菜单应在按钮上方（bottom 对齐），即菜单 top < 按钮 top
  const geo = await page.evaluate(() => {
    const btn = document.querySelector('#sideUserBtn');
    const menu = document.querySelector('#sideUserMenu');
    const br = btn.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    const fr = document.querySelector('.side-footer').getBoundingClientRect();
    return { btnTop: br.top, menuTop: mr.top, menuBottom: mr.bottom, footerTop: fr.top };
  });
  ok('菜单在按钮上方', geo.menuTop < geo.btnTop,
    'menuTop=' + Math.round(geo.menuTop) + ' btnTop=' + Math.round(geo.btnTop));
  ok('菜单底边贴近按钮顶边', Math.abs(geo.menuBottom - geo.btnTop) < 20,
    'menuBottom=' + Math.round(geo.menuBottom) + ' btnTop=' + Math.round(geo.btnTop));
  // 关键：按钮本身不被顶上去
  const footerTopAfter = await page.evaluate(() => {
    const el = document.querySelector('.side-footer');
    return el.getBoundingClientRect().top;
  });
  ok('「登录」按钮未被顶上去', Math.abs(footerTopAfter - footerTopBefore) < 2,
    'before=' + Math.round(footerTopBefore) + ' after=' + Math.round(footerTopAfter));
  const absPos = await page.evaluate(() => {
    const el = document.querySelector('#sideUserMenu');
    return getComputedStyle(el).position;
  });
  ok('菜单为绝对定位浮层', absPos === 'absolute', 'position=' + absPos);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 关闭用户菜单', await page.locator('#sideUserMenu').isHidden());

  // ---------- 8. 侧栏收起 / 展开（按钮在标题栏） ----------
  console.log('\n[8] 侧栏收起 / 展开');
  await page.evaluate(() => localStorage.removeItem('kanseki_app_sidebar_collapsed'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  ok('初始未收起', await page.locator('.app-shell.sb-collapsed').count() === 0);
  await page.click('#collapseBtn');
  await page.waitForTimeout(600);
  ok('可收起侧栏', await page.locator('.app-shell.sb-collapsed').count() === 1);
  const sbWidth = await page.evaluate(() => document.querySelector('.app-sidebar').getBoundingClientRect().width);
  ok('收起后侧栏宽度为 0', sbWidth < 2, 'width=' + sbWidth);
  // 标题栏按钮仍在原处（供再次点开）
  ok('收起后标题栏按钮仍在', await page.locator('#collapseBtn').isVisible());
  const btnLabel = await page.getAttribute('#collapseBtn', 'aria-label');
  ok('按钮变为「展开侧边栏」', btnLabel === '展开侧边栏', btnLabel);
  const mainW = await page.evaluate(() => document.querySelector('.app-main').getBoundingClientRect().width);
  ok('主内容区铺满', mainW > 1300, 'mainWidth=' + mainW);
  await page.click('#collapseBtn');
  await page.waitForTimeout(600);
  ok('可重新展开', await page.locator('.app-shell.sb-collapsed').count() === 0);
  const sbWidth2 = await page.evaluate(() => document.querySelector('.app-sidebar').getBoundingClientRect().width);
  ok('展开后侧栏恢复宽度', sbWidth2 > 200, 'width=' + sbWidth2);
  await page.evaluate(() => localStorage.removeItem('kanseki_app_sidebar_collapsed'));

  // ---------- 9. 侧栏不溢出（新增标题栏后仍成立） ----------
  console.log('\n[9] 矮窗口侧栏不溢出');
  for (const vp of [{ width: 1280, height: 800 }, { width: 960, height: 600 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const sb = document.querySelector('.app-sidebar');
      return sb.scrollHeight - sb.clientHeight;
    });
    ok('侧栏不溢出（' + vp.width + '×' + vp.height + '）', m <= 0, '溢出=' + m);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);

  // ---------- 10. 无 JS 错误 ----------
  const realErrors = errors.filter(e => !/favicon|ERR_|net::/.test(e));
  ok('0 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log(`\n==== V0.8 UI 验证: ${results.length - fail} 通过, ${fail} 失败 ====`);
  await browser.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
})();
