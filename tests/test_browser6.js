// v1.3 使用介绍页专项测试:
// 1. guide.html 可访问且标题正确
// 2. 导航含"使用介绍"且在"纪年查询"左侧
// 3. 内容覆盖三大部分: 纪年查询/编目细则/其他说明
// 4. 三页导航均含"使用介绍"链接
const { chromium } = require('playwright-core');

const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const BASE = 'http://localhost:8765';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // ===== 1. guide.html 可访问 =====
  await page.goto(BASE + '/guide.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);
  check('guide.html 标题', (await page.title()).includes('使用介绍'), await page.title());
  const h2 = await page.locator('.page-head h2').textContent();
  check('页面主标题"使用介绍"', h2.includes('使用介绍'), h2);

  // ===== 2. 导航: 使用介绍在纪年查询左侧 =====
  const navLinks = await page.locator('.header-nav a').allTextContents();
  const navIdx = navLinks.map(t => t.trim());
  const gIdx = navIdx.indexOf('使用介绍');
  const cIdx = navIdx.indexOf('纪年查询');
  check('导航含"使用介绍"', gIdx >= 0, JSON.stringify(navIdx));
  check('使用介绍在纪年查询左侧', gIdx >= 0 && cIdx >= 0 && gIdx < cIdx, `使用介绍=${gIdx} 纪年查询=${cIdx}`);
  check('使用介绍链接指向 guide.html', await page.locator('.header-nav a').nth(gIdx).getAttribute('href') === 'guide.html');

  // ===== 3. 内容三大部分 =====
  const sections = await page.locator('.g-section .g-title').allTextContents();
  check('章节含"纪年查询"', sections.some(s => s.includes('纪年查询')), JSON.stringify(sections));
  check('章节含"编目细则"', sections.some(s => s.includes('编目细则')), JSON.stringify(sections));
  check('章节含"其他说明"', sections.some(s => s.includes('其他说明')), JSON.stringify(sections));
  const body = await page.locator('body').innerText();
  check('正文含"模糊补全"', body.includes('模糊补全'));
  check('正文含"岁时落款"', body.includes('岁时落款'));
  check('正文含"四部分类表"', body.includes('四部分类表'));
  check('正文含"更新日志"', body.includes('更新日志'));
  check('正文含"2023 版"与"2025 版"', body.includes('2023 版') && body.includes('2025 版'));

  // ===== 4. 其他页导航均含使用介绍 =====
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(400);
  const idxNav = (await page.locator('.header-nav a').allTextContents()).map(t => t.trim());
  check('index 导航含"使用介绍"', idxNav.includes('使用介绍'), JSON.stringify(idxNav));
  const idxG = idxNav.indexOf('使用介绍'), idxC = idxNav.indexOf('纪年查询');
  check('index 中使用介绍在纪年查询左侧', idxG >= 0 && idxC >= 0 && idxG < idxC, JSON.stringify(idxNav));

  await page.goto(BASE + '/catalog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(400);
  const catNav = (await page.locator('.header-nav a').allTextContents()).map(t => t.trim());
  check('catalog 导航含"使用介绍"', catNav.includes('使用介绍'), JSON.stringify(catNav));

  await page.goto(BASE + '/changelog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(400);
  const clNav = (await page.locator('.header-nav a').allTextContents()).map(t => t.trim());
  check('changelog 导航含"使用介绍"', clNav.includes('使用介绍'), JSON.stringify(clNav));

  // ===== 5. 从 index 点击使用介绍跳转 (V3: 位于说明文档下拉菜单内) =====
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(400);
  await page.hover('.header-nav .nav-dropdown');
  await page.waitForTimeout(300);
  await page.click('.nav-dropdown-menu a[href="guide.html"]');
  await page.waitForTimeout(800);
  check('点击使用介绍跳转到 guide.html', page.url().includes('guide.html'), page.url());

  console.log('\n===== 使用介绍页浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));
  console.log('\nJS错误数:', errors.length);
  errors.slice(0, 5).forEach(e => console.log('  ', e));

  await browser.close();
})();
