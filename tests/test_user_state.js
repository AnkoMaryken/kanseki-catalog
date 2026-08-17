// V7.0: 个人中心 + 登录头像 — 表头渲染/登录态/个人中心门禁/退出/资料编辑
const { CHROME_PATH, PORT, playwrightCorePath } = require('./helpers/config');
const { chromium } = require(playwrightCorePath());

const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + '  ' + extra); }
}

const PAGES = ['index.html', 'guide.html', 'catalog.html', 'changelog.html', 'embed.html'];

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);

  // 登录页走演示模式 (真实凭据已写入, 避免网络请求)
  const demoCtx = await browser.newContext();
  await demoCtx.addInitScript(() => { window.SUPABASE_DEMO = true; });
  const demoPage = await demoCtx.newPage();
  demoPage.setDefaultTimeout(10000);

  console.log('\n[1] 未登录: 五页表头均显示「登录」链接');
  for (const p of PAGES) {
    await page.goto(`${BASE}/${p}`);
    await page.waitForSelector('.user-dropdown .user-login-link', { timeout: 8000 });
    const txt = (await page.textContent('.user-dropdown .user-login-link')).trim();
    ok(`${p} 表头显示「登录」`, txt === '登录', txt);
  }

  console.log('\n[2] 模拟登录 → index 表头渲染头像+昵称');
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(() => {
    localStorage.setItem('kanseki_user', JSON.stringify({ email: 'test@example.com', id: 'u1', name: '测试用户' }));
  });
  await page.reload();
  await page.waitForSelector('.user-dropdown .user-avatar');
  const nameTxt = (await page.textContent('.user-dropdown .user-btn-name')).trim();
  ok('已登录显示头像', await page.$('.user-dropdown .user-avatar') !== null);
  ok('已登录显示昵称「测试用户」', nameTxt === '测试用户', nameTxt);
  const avatarBg = await page.$eval('.user-dropdown .user-avatar', el => getComputedStyle(el).backgroundColor);
  ok('默认头像有背景色(非透明)', avatarBg && avatarBg !== 'rgba(0, 0, 0, 0)', avatarBg);

  console.log('\n[3] 登录后下拉含「个人中心」「退出登录」');
  await page.click('.user-dropdown .user-btn');
  await page.waitForSelector('.user-dropdown.open .user-menu .user-menu-profile');
  const profileItem = await page.$('.user-dropdown .user-menu .user-menu-profile');
  const profileHref = profileItem ? await profileItem.getAttribute('href') : '';
  ok('下拉含个人中心链接 → profile.html', profileHref === 'profile.html', profileHref);
  ok('下拉含退出登录', await page.$('.user-dropdown .user-menu .user-menu-logout') !== null);
  // index 下拉保留字形切换区
  ok('index 下拉保留字形切换区', await page.$('.user-dropdown .user-menu #langBtnS') !== null);

  console.log('\n[4] profile.html 门禁: 未登录跳转 login');
  const guestCtx = await browser.newContext();
  const guestPage = await guestCtx.newPage();
  await guestPage.goto(`${BASE}/profile.html`);
  await guestPage.waitForTimeout(1200);
  ok('未登录访问 profile → 跳转 login.html', guestPage.url().includes('login.html'), guestPage.url());
  await guestCtx.close();

  console.log('\n[5] profile.html 已登录: 显示邮箱与昵称');
  await page.goto(`${BASE}/profile.html`);
  await page.waitForSelector('#email');
  const emailVal = await page.inputValue('#email');
  ok('个人中心显示邮箱', emailVal === 'test@example.com', emailVal);
  ok('个人中心显示头像预览', await page.$('#avatarPreview .user-avatar, #avatarPreview img, #avatarPreview') !== null);

  console.log('\n[6] 昵称编辑保存');
  await page.fill('#nickname', '逐风少年');
  await page.click('#saveBtn');
  await page.waitForTimeout(300);
  const prof = await page.evaluate(() => JSON.parse(localStorage.getItem('kanseki_profile') || '{}'));
  ok('kanseki_profile.name 已保存', prof.name === '逐风少年', JSON.stringify(prof));

  console.log('\n[7] 头像自定义: 颜色+文字');
  await page.click('#pickColorBtn');
  await page.waitForSelector('#colorPickerWrap');
  await page.click('.color-dot[data-bg="#10b981"]');
  await page.fill('#avatarCharInput', '逐');
  await page.click('#applyColorBtn');
  await page.waitForTimeout(300);
  const av1 = await page.evaluate(() => window.UserState.getAvatarData());
  ok('颜色头像已写入', av1 && av1.type === 'color' && av1.bg === '#10b981' && av1.char === '逐', JSON.stringify(av1));
  const previewBg = await page.$eval('#avatarPreview', el => el.style.background);
  ok('预览区背景已应用', previewBg.includes('rgb(16, 185, 129)') || previewBg.includes('#10b981'), previewBg);

  console.log('\n[8] 头像自定义: 恢复默认');
  await page.click('#resetAvatarBtn');
  await page.waitForTimeout(300);
  const av2 = await page.evaluate(() => window.UserState.getAvatarData());
  ok('恢复默认后 avatar 为 null', av2 === null, JSON.stringify(av2));

  console.log('\n[9] 登录后表头同步颜色头像 (index)');
  await page.goto(`${BASE}/index.html`);
  await page.evaluate(() => {
    window.UserState.setAvatarData({ type: 'color', bg: '#10b981', char: '逐', fg: '#ffffff' });
  });
  await page.reload();
  await page.waitForSelector('.user-dropdown .user-avatar');
  const headerBg = await page.$eval('.user-dropdown .user-avatar', el => getComputedStyle(el).backgroundColor);
  ok('表头头像背景同步为绿色', headerBg.includes('16, 185, 129'), headerBg);
  const headerCh = await page.textContent('.user-dropdown .user-avatar');
  ok('表头头像文字为「逐」', headerCh.trim() === '逐', headerCh);

  console.log('\n[10] 退出登录');
  await page.click('.user-dropdown .user-btn');
  await page.waitForSelector('.user-dropdown.open .user-menu .user-menu-logout');
  await page.click('.user-dropdown .user-menu-logout');
  await page.waitForTimeout(1200);
  const userAfter = await page.evaluate(() => localStorage.getItem('kanseki_user'));
  ok('退出后 kanseki_user 已清除', userAfter === null, String(userAfter));
  const stillAvatar = await page.$('.user-dropdown .user-avatar');
  ok('退出后表头恢复「登录」', stillAvatar === null);
  const loginTxt2 = (await page.textContent('.user-dropdown .user-login-link')).trim();
  ok('退出后表头显示登录链接', loginTxt2 === '登录', loginTxt2);

  console.log('\n[11] 登录页(演示模式) → 登录 → 表头头像');
  await demoPage.goto(`${BASE}/login.html`);
  await demoPage.waitForSelector('#loginForm');
  await demoPage.fill('#email', 'demo@example.com');
  await demoPage.fill('#password', 'demo12345');
  await demoPage.click('#loginBtn');
  await demoPage.waitForURL('**/index.html', { timeout: 8000 });
  await demoPage.waitForSelector('.user-dropdown .user-avatar');
  const demoName = (await demoPage.textContent('.user-dropdown .user-btn-name')).trim();
  ok('演示登录后表头显示邮箱前缀昵称', demoName === 'demo', demoName);

  console.log('\n[12] 其余四页登录态渲染');
  await demoPage.goto(`${BASE}/guide.html`);
  await demoPage.waitForSelector('.user-dropdown .user-avatar');
  await demoPage.click('.user-dropdown .user-btn');
  await demoPage.waitForSelector('.user-dropdown .user-menu .user-menu-profile');
  const gpHref = await demoPage.$eval('.user-dropdown .user-menu .user-menu-profile', el => el.getAttribute('href'));
  ok('guide 登录后下拉含个人中心', gpHref === 'profile.html', gpHref);
  const gpLogout = await demoPage.$('.user-dropdown .user-menu .user-menu-logout');
  ok('guide 登录后下拉含退出', gpLogout !== null);

  await browser.close();
  await demoCtx.close();
  console.log(`\n==== V7.0 个人中心/登录头像: ${passed} 通过, ${failed} 失败 ====`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
