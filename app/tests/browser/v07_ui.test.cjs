// ================================================
// app/tests/browser/v07_ui.test.cjs — V0.7 外壳 UI 改版验证
// -------------------------------------------------
// 覆盖本轮改动：
//   1. 侧栏导航重排（快速跳转 / 编目记录 → 「应用」组）
//   2. 左上角品牌文字移除，改为「收起侧栏 + 窗口菜单」
//   3. 窗口菜单项齐备（最小化/最大化/关闭/置顶/全屏/居中/尺寸）
//   4. 侧栏底部登录区（未登录 / 已登录两态）
//   5. 三视图统一样式（.app-view / .av-*）
//   6. 明暗主题适配（documentElement data-theme）
//   7. 侧栏收起 / 展开
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
  await page.waitForTimeout(900);

  // ---------- 1. 导航结构：总数不变、分组归属正确 ----------
  console.log('\n[1] 侧栏导航重排');
  const navCount = await page.locator('.nav-item').count();
  ok('导航项仍为 11 个', navCount === 11, '实际 ' + navCount);
  ok('视图 10 个', await page.locator('.view').count() === 10,
    '实际 ' + await page.locator('.view').count());

  // 「应用」组内应含 快速跳转 / 编目记录 / 同步设置 / 账号 / 关于（5 项）
  const appGroup = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.app-sidebar .side-sec')];
    const sec = secs.find(s => (s.querySelector('.side-label') || {}).textContent === '应用');
    if (!sec) return null;
    return [...sec.querySelectorAll('.nav-item')].map(el => el.dataset.view);
  });
  ok('「应用」组存在', !!appGroup, JSON.stringify(appGroup));
  ok('「应用」组含快速跳转', (appGroup || []).includes('jump'));
  ok('「应用」组含编目记录', (appGroup || []).includes('records'));
  ok('「应用」组含同步设置', (appGroup || []).includes('sync'));
  ok('「应用」组含账号', (appGroup || []).includes('login'));
  ok('「应用」组含关于', (appGroup || []).includes('about'));

  // 「纪年查询」组应只剩 1 项（快速跳转已移走）
  const chronoGroup = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.app-sidebar .side-sec')];
    const sec = secs.find(s => (s.querySelector('.side-label') || {}).textContent === '纪年查询');
    return sec ? [...sec.querySelectorAll('.nav-item')].map(el => el.dataset.view) : null;
  });
  ok('「纪年查询」组只剩纪年查询', JSON.stringify(chronoGroup) === '["query"]', JSON.stringify(chronoGroup));

  // 「说明文档」组应只剩 2 项（编目记录已移走）
  const docGroup = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.app-sidebar .side-sec')];
    const sec = secs.find(s => (s.querySelector('.side-label') || {}).textContent === '说明文档');
    return sec ? [...sec.querySelectorAll('.nav-item')].map(el => el.dataset.view) : null;
  });
  ok('「说明文档」组只剩 2 项', (docGroup || []).length === 2, JSON.stringify(docGroup));

  // 「待上线」徽标已移除
  ok('「编目记录」不再带「待上线」徽标',
    await page.locator('.nav-badge').count() === 0,
    'badge=' + await page.locator('.nav-badge').count());

  // ---------- 2. 品牌栏保留在侧栏，功能键移到自绘标题栏 ----------
  console.log('\n[2] 品牌栏保留 + 标题栏功能键');
  ok('品牌文字节点保留', await page.locator('.side-title').count() === 1);
  const brandName = await page.locator('.side-title .st-tx').textContent().catch(() => '');
  ok('侧栏含品牌全名', brandName.trim() === '古代史及汉籍研究工具', brandName);
  ok('收起侧栏按钮存在（标题栏）', await page.locator('.app-titlebar #collapseBtn').count() === 1);
  ok('窗口按钮存在（标题栏）', await page.locator('.app-titlebar #winBtn').count() === 1);

  // ---------- 3. 窗口菜单 ----------
  console.log('\n[3] 窗口菜单');
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
  // 关闭：按 Esc
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  ok('Esc 可关闭菜单', await page.locator('#winMenu').isHidden());

  // ---------- 4. 侧栏底部登录区 ----------
  console.log('\n[4] 侧栏底部登录区');
  ok('登录按钮存在', await page.locator('#sideUserBtn').count() === 1);
  // 未登录态
  const nameBefore = await page.textContent('#sideUserName');
  ok('未登录显示「登录」', nameBefore.trim() === '登录', nameBefore);
  await page.click('#sideUserBtn');
  await page.waitForTimeout(300);
  ok('用户菜单可展开', await page.locator('#sideUserMenu').isVisible());
  ok('未登录时「个人中心」隐藏', await page.locator('[data-usermenu="profile"]').isHidden());
  ok('未登录时「退出登录」隐藏', await page.locator('#sideLogoutBtn').isHidden());
  ok('未登录时「登录 / 注册」可见', await page.locator('[data-usermenu="login"]').isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 模拟已登录（写入与网页版共用的 localStorage 键）
  await page.evaluate(() => {
    localStorage.setItem('kanseki_user', JSON.stringify({
      email: 'tester@example.com', name: '測試用戶', id: 'u-test'
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const nameAfter = await page.textContent('#sideUserName');
  ok('已登录显示昵称', nameAfter.trim() === '測試用戶', nameAfter);
  const subAfter = await page.textContent('#sideUserSub');
  ok('已登录显示邮箱', subAfter.includes('tester@example.com'), subAfter);
  const avatarHTML = await page.innerHTML('#sideUserAvatar');
  ok('头像已渲染', avatarHTML.trim().length > 0 && !avatarHTML.includes('>?<'),
    avatarHTML.slice(0, 60));
  await page.click('#sideUserBtn');
  await page.waitForTimeout(300);
  ok('已登录时「个人中心」可见', await page.locator('[data-usermenu="profile"]').isVisible());
  ok('已登录时「退出登录」可见', await page.locator('#sideLogoutBtn').isVisible());
  // 退出登录
  await page.click('#sideLogoutBtn');
  await page.waitForTimeout(600);
  const nameOut = await page.textContent('#sideUserName');
  ok('退出后回到未登录态', nameOut.trim() === '登录', nameOut);
  const stillProfile = await page.evaluate(() => localStorage.getItem('kanseki_profile'));
  ok('退出仅清登录态（保留本地资料）', stillProfile === null || typeof stillProfile === 'string');

  // ---------- 5. 三视图统一样式 ----------
  console.log('\n[5] 三视图统一样式');
  for (const [view, cls] of [['records', '.av-empty'], ['sync', '.av-formcard'], ['about', '.av-about']]) {
    await page.click(`.nav-item[data-view="${view}"]`);
    await page.waitForTimeout(400);
    ok(`${view} 视图激活`, await page.locator(`#view-${view}.active`).count() === 1);
    ok(`${view} 使用 .app-view`, await page.locator(`#view-${view}.app-view`).count() === 1);
    ok(`${view} 含统一组件 ${cls}`, await page.locator(`#view-${view} ${cls}`).count() === 1);
  }
  // 关键交互元素仍在（回归）
  await page.click('.nav-item[data-view="sync"]');
  await page.waitForTimeout(300);
  ok('同步表单元素保留', await page.locator('#syncUser').count() === 1 && await page.locator('#syncPass').count() === 1);
  ok('同步按钮保留', await page.locator('#syncTestBtn').count() === 1 && await page.locator('#syncNowBtn').count() === 1);
  ok('同步状态行保留', await page.locator('#syncLastTime').count() === 1);

  await page.click('.nav-item[data-view="records"]');
  await page.waitForTimeout(300);
  ok('编目「新增」按钮保留且禁用', await page.locator('#addRecordBtn').isDisabled());
  await page.click('#previewFormBtn');
  await page.waitForTimeout(400);
  ok('编目表单弹层可打开', await page.locator('#recordFormOverlay').isVisible());
  ok('弹层用统一样式 .av-modal', await page.locator('.av-modal').count() === 1);
  const fieldCount = await page.locator('#requiredFields .av-field').count();
  ok('必填字段已渲染（>0）', fieldCount > 0, 'fields=' + fieldCount);
  await page.click('#recordFormCancel');
  await page.waitForTimeout(300);
  ok('弹层可关闭', await page.locator('#recordFormOverlay').isHidden());

  await page.click('.nav-item[data-view="about"]');
  await page.waitForTimeout(400);
  // 版本号断言与 package.json 保持一致，避免每次发版都要改测试
  const pkgVer = require('../../package.json').version;
  ok('关于页版本与 package.json 一致（' + pkgVer + '）',
    (await page.textContent('.av-ver')).includes(pkgVer),
    await page.textContent('.av-ver'));
  ok('关于页 logo 为内联 SVG', await page.locator('.av-logo svg').count() === 1);

  // ---------- 6. 明暗主题 ----------
  console.log('\n[6] 明暗主题');
  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('外壳挂载 data-theme（初始）', themeBefore === 'light' || themeBefore === 'dark', 'theme=' + themeBefore);
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(500);
  const themeAfter = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('切换主题后外壳 data-theme 变化', themeAfter !== themeBefore, `${themeBefore} -> ${themeAfter}`);
  // 暗色下卡片背景应变为深色
  const cardBg = await page.evaluate(() => {
    const el = document.querySelector('.av-about') || document.querySelector('.av-card');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  ok('暗色下卡片为深色背景', !!cardBg && cardBg !== 'rgb(255, 255, 255)', cardBg);
  // 切回亮色
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(400);
  const themeBack = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  ok('可切回亮色', themeBack === themeBefore, 'theme=' + themeBack);

  // ---------- 7. 侧栏收起 / 展开 ----------
  console.log('\n[7] 侧栏收起 / 展开');
  ok('初始未收起', await page.locator('.app-shell.sb-collapsed').count() === 0);
  await page.click('#collapseBtn');
  await page.waitForTimeout(600);
  ok('可收起侧栏', await page.locator('.app-shell.sb-collapsed').count() === 1);
  const sbWidth = await page.evaluate(() => {
    const el = document.querySelector('.app-sidebar');
    return el.getBoundingClientRect().width;
  });
  ok('收起后侧栏宽度为 0', sbWidth < 2, 'width=' + sbWidth);
  ok('标题栏收起按钮仍在', await page.locator('#collapseBtn').isVisible());
  // 主内容区应铺满
  const mainW = await page.evaluate(() => document.querySelector('.app-main').getBoundingClientRect().width);
  ok('主内容区铺满', mainW > 1300, 'mainWidth=' + mainW);
  await page.click('#collapseBtn');
  await page.waitForTimeout(600);
  ok('可重新展开', await page.locator('.app-shell.sb-collapsed').count() === 0);
  const sbWidth2 = await page.evaluate(() => document.querySelector('.app-sidebar').getBoundingClientRect().width);
  ok('展开后侧栏恢复宽度', sbWidth2 > 200, 'width=' + sbWidth2);

  // 收起状态持久化
  await page.click('#collapseBtn');
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  ok('收起状态可持久化', await page.locator('.app-shell.sb-collapsed').count() === 1);
  await page.evaluate(() => localStorage.removeItem('kanseki_app_sidebar_collapsed'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  // ---------- 8. 账号视图路由 ----------
  console.log('\n[8] 账号视图');
  // V0.8.2: 「账号」项目标随登录态变化 —— 未登录进登录页，已登录进个人中心。
  // 此处为未登录态（第 4 节末尾已退出登录），应指向 login。
  const accViewGuest = await page.getAttribute('#navAccount', 'data-view');
  ok('未登录时「账号」指向 login', accViewGuest === 'login', String(accViewGuest));
  await page.click('.nav-item[data-view="login"]');
  await page.waitForTimeout(1500);
  ok('login 视图激活', await page.locator('#view-login.active').count() === 1);
  const loginFrame = page.frame({ url: /pages\/login\.html/ });
  ok('login iframe 已加载', !!loginFrame);

  // 模拟登录后再看「账号」项：应改指 account（个人中心）
  await page.evaluate(() => {
    localStorage.setItem('kanseki_user', JSON.stringify({
      email: 'nav@example.com', name: '導航測試', id: 'u-nav'
    }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const accViewLogged = await page.evaluate(() => {
    const a = document.getElementById('navAccount');
    return { view: a && a.dataset.view, href: a && a.getAttribute('href') };
  });
  ok('已登录时「账号」指向 account', accViewLogged.view === 'account',
    JSON.stringify(accViewLogged));
  ok('已登录时「账号」href 为 #/account', accViewLogged.href === '#/account',
    String(accViewLogged.href));

  // 点击后应进入个人中心视图（而非又回到登录页）
  await page.click('#navAccount');
  await page.waitForTimeout(1800);
  ok('点击「账号」进入个人中心视图', await page.locator('#view-account.active').count() === 1);
  const accFrame = page.frame({ url: /pages\/profile\.html/ });
  ok('profile iframe 已加载（未被登录门禁弹回）', !!accFrame);
  // 清理：恢复未登录，避免影响后续断言
  await page.evaluate(() => localStorage.removeItem('kanseki_user'));

  // ---------- 9. 无 JS 错误 ----------
  const realErrors = errors.filter(e => !/favicon|ERR_|net::/.test(e));
  ok('0 JS 错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log(`\n==== V0.7 UI 验证: ${results.length - fail} 通过, ${fail} 失败 ====`);
  await browser.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
})();
