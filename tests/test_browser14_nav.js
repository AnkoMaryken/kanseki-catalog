// v3.0 导航下拉菜单验证
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
  };

  // index 页
  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(700);
  let links = await page.locator('.header-nav > a.nav-link').allTextContents();
  check('index 导航直链无「使用介绍」', !links.some(t => t.trim() === '使用介绍') && links.some(t => t.includes('纪年查询')), JSON.stringify(links));
  check('index 导航含「快速跳转」', links.some(t => t.trim() === '快速跳转'), JSON.stringify(links));
  let btnText = await page.locator('.header-nav .nav-dropdown-btn').textContent();
  check('index 有「说明文档」按钮', btnText.includes('说明文档'), btnText);
  // hover 展开
  await page.hover('.header-nav .nav-dropdown-btn');
  await page.waitForTimeout(400);
  let visible = await page.locator('.header-nav .nav-dropdown-menu').isVisible();
  check('hover 展开下拉菜单', visible);
  let items = await page.locator('.header-nav .nav-dropdown-menu a').allTextContents();
  check('下拉含使用介绍+更新日志', items.some(t => t.includes('使用介绍')) && items.some(t => t.includes('更新日志')), JSON.stringify(items));
  await page.screenshot({ path: '.workbuddy/v3_nav_dropdown.png' });

  // 点击跳转 guide
  await page.click('.header-nav .nav-dropdown-menu a[href="guide.html"]');
  await page.waitForTimeout(800);
  check('点击跳转 guide.html', page.url().includes('guide.html'), page.url());
  // guide 页: 说明文档 active, 菜单内使用介绍 active
  let btnCls = await page.locator('.header-nav .nav-dropdown-btn').getAttribute('class');
  check('guide 页说明文档 active', btnCls.includes('active'), btnCls);
  let menuActive = await page.locator('.nav-dropdown-menu a.active').textContent();
  check('guide 页菜单内「使用介绍」active', menuActive.includes('使用介绍'), menuActive);

  // changelog 页
  await page.goto('http://localhost:8765/changelog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  menuActive = await page.locator('.nav-dropdown-menu a.active').textContent();
  check('changelog 页菜单内「更新日志」active', menuActive.includes('更新日志'), menuActive);

  // catalog 页 (V5.1 起简体)
  await page.goto('http://localhost:8765/catalog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  btnText = await page.locator('.header-nav .nav-dropdown-btn').textContent();
  check('catalog 简体「说明文档」', btnText.includes('说明文档'), btnText);
  await page.hover('.header-nav .nav-dropdown-btn');
  await page.waitForTimeout(400);
  items = await page.locator('.header-nav .nav-dropdown-menu a').allTextContents();
  check('catalog 下拉简体项', items.some(t => t.includes('使用介绍')) && items.some(t => t.includes('更新日志')), JSON.stringify(items));
  await page.screenshot({ path: '.workbuddy/v3_nav_dropdown_catalog.png' });

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join(';') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
