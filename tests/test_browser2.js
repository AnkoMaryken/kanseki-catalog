// 补充浏览器测试: 搜索建议下拉 + 复制按钮 + 繁体复制验证
const { chromium } = require('playwright-core');

const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const URL = 'http://localhost:8765/index.html';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 授予剪贴板权限
  const context = browser.contexts()[0];
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // 1. 简体搜索建议: 先切到简体, 输入"万"看建议
  await page.click('#langBtnS');
  await page.waitForTimeout(400);
  await page.fill('#globalSearch', '万');
  await page.waitForTimeout(400);
  const suggCount = await page.locator('.search-suggestion-item').count();
  check('搜索建议出现', suggCount > 0, suggCount + ' 条建议');
  const firstSugg = await page.locator('.search-suggestion-item').first().textContent();
  check('建议内容含"万历"', firstSugg.includes('万历'), firstSugg.trim());

  // 2. 繁体输入建议: 输入"萬"看建议
  await page.fill('#globalSearch', '萬');
  await page.waitForTimeout(400);
  const suggT = await page.locator('.search-suggestion-item').first().textContent();
  check('繁体建议出现', suggT.includes('万历') || suggT.includes('萬曆'), suggT.trim());

  // 3. 干支建议: 输入"癸未"
  await page.fill('#globalSearch', '癸未');
  await page.waitForTimeout(400);
  const suggGz = await page.locator('.search-suggestion-item').first().textContent();
  check('干支建议"癸未年"', suggGz.includes('癸未年'), suggGz.trim());

  // 4. 简体复制按钮: 复制贞观元年
  await page.fill('#globalSearch', '贞观');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  const copyBtnS = page.locator('#tableBody tr:first-child .era-copy-btn').first();
  await copyBtnS.click();
  await page.waitForTimeout(300);
  const clipS = await page.evaluate(() => navigator.clipboard.readText());
  check('简体复制文本', clipS === '贞观元年（627）', clipS);

  // 5. 切繁体后复制
  await page.click('#langBtnT');
  await page.waitForTimeout(400);
  const copyBtnT = page.locator('#tableBody tr:first-child .era-copy-btn').first();
  await copyBtnT.click();
  await page.waitForTimeout(300);
  const clipT = await page.evaluate(() => navigator.clipboard.readText());
  check('繁体复制文本', clipT === '貞觀元年（627）', clipT);

  // 6. 繁体模式下复制"高后"(应保持"后")
  await page.fill('#globalSearch', '高后');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  const copyBtnG = page.locator('#tableBody tr:first-child .era-copy-btn').first();
  await copyBtnG.click();
  await page.waitForTimeout(300);
  const clipG = await page.evaluate(() => navigator.clipboard.readText());
  check('繁体复制"高后"(保持后)', clipG === '高后元年（前187）', clipG);

  // 7. 繁体模式复制"后元" (应转"後") — 定位含"後元"的行 (跳过"高后元年")
  await page.fill('#globalSearch', '后元');
  await page.click('#searchBtn');
  await page.waitForTimeout(800);
  const hyRow = page.locator('#tableBody tr', { hasText: '後元' }).first();
  const hyBtn = hyRow.locator('.era-copy-btn').first();
  await hyBtn.click();
  await page.waitForTimeout(300);
  const clipHY = await page.evaluate(() => navigator.clipboard.readText());
  check('繁体复制"后元"(转後)', clipHY === '後元元年（前163）', clipHY);

  // 8. 繁体模式下筛选标签显示
  const tagChina = await page.locator('.filter-tag.china').first().textContent();
  check('繁体筛选标签', tagChina.includes('西'), tagChina);

  // 9. 简体切回后筛选标签恢复
  await page.click('#langBtnS');
  await page.waitForTimeout(400);
  const tagChinaS = await page.locator('.filter-tag.china').first().textContent();
  check('简体筛选标签恢复', tagChinaS === '西周', tagChinaS);

  // 10. 繁体模式下搜索"萬曆"建议与跳转
  await page.click('#langBtnT');
  await page.waitForTimeout(300);
  await page.fill('#globalSearch', '萬曆');
  await page.waitForTimeout(400);
  const suggW = await page.locator('.search-suggestion-item').first().textContent();
  check('繁体建议含"萬曆"', suggW.includes('萬曆'), suggW.trim());

  await page.screenshot({ path: 'D:/WorkBuddy空间/2026-08-01-13-40-21/.workbuddy/browser_test_final.png', fullPage: false });

  console.log('\n===== 补充浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));

  await browser.close();
})();
