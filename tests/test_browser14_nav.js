// V1.1 站点导航验证：六页统一「站点导航条」，不再有顶部下拉菜单
// 桌面版里这条导航由 app/scripts/build.mjs 注入的 CSS 隐藏（侧栏已有同名入口）。
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';
const BASE = 'http://localhost:8765';
const PAGES = ['index.html', 'catalog.html?tab=0', 'kanseki.html', 'guide.html', 'changelog.html', 'embed.html'];
const EXPECT = 8;

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
  };

  // 1) 六页都有导航条，且入口数为 8
  for (const p of PAGES) {
    await page.goto(`${BASE}/${p}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(500);
    const strip = await page.locator('.web-nav-strip a').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent.trim() })));
    check(`${p} 有站点导航条（${EXPECT} 项）`, strip.length === EXPECT, strip.length + '');
    const hrefs = strip.map((x) => x.href || '');
    check(`${p} 导航含纪年/类目/更新日志`,
      hrefs.includes('index.html') && hrefs.includes('kanseki.html') && hrefs.includes('changelog.html'),
      hrefs.join(','));
  }

  // 2) 旧的顶部下拉菜单已移除
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  check('index 已无下拉菜单', (await page.locator('.nav-dropdown, .header-nav .nav-dropdown-btn').count()) === 0);
  await page.goto(`${BASE}/kanseki.html`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  check('kanseki 已无下拉菜单', (await page.locator('.nav-dropdown, .header-nav .nav-dropdown-btn').count()) === 0);

  // 3) 点导航可跨页跳转
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.click('.web-nav-strip a[href="kanseki.html"]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(600);
  check('点「古籍类目」跳到 kanseki.html', page.url().includes('kanseki.html'), page.url());
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.click('.web-nav-strip a[href="changelog.html"]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(500);
  check('点「更新日志」跳到 changelog.html', page.url().includes('changelog.html'), page.url());

  // 4) 桌面内嵌模拟：html.is-embed 时导航条隐藏（index/kanseki 用该标记）
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => {
    document.documentElement.classList.add('is-embed');
    const el = document.querySelector('.web-nav-strip');
    return el ? getComputedStyle(el).display === 'none' : false;
  });
  check('内嵌标记下导航条隐藏', hidden === true);

  await page.screenshot({ path: '.workbuddy/v11_site_nav.png' });
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join(';') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
