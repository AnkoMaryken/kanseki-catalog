// 浏览器实测: 繁简切换 + 干支/繁简搜索
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
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // 1. 页面初始状态
  const rowCount = await page.locator('#tableBody tr').count();
  check('表格初始渲染 (50行)', rowCount === 50, '实际 ' + rowCount);

  // 2. 简体搜索: 万历
  await page.fill('#globalSearch', '万历');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  let total = await page.locator('#totalCount').textContent();
  check('搜索"万历"命中数', parseInt(total) === 48, total);

  // 3. 繁体搜索: 萬曆
  await page.fill('#globalSearch', '萬曆');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  total = await page.locator('#totalCount').textContent();
  check('搜索"萬曆"命中数(繁简等价)', parseInt(total) === 48, total);

  // 4. 干支组合: 万历癸未 -> 1583
  await page.fill('#globalSearch', '万历癸未');
  await page.click('#searchBtn');
  await page.waitForTimeout(800);
  total = await page.locator('#totalCount').textContent();
  const firstYear = await page.locator('#tableBody tr:first-child .cell-year').textContent();
  check('搜索"万历癸未"精确命中1583', parseInt(total) === 1 && firstYear.trim() === '1583', `总数=${total}, 首行年份=${firstYear.trim()}`);
  // 行内应显示万历十一年 (页面默认繁体, 显示萬曆十一年)
  const cnEra = await page.locator('#tableBody tr:first-child .cell-cn-era').textContent();
  check('1583行显示"萬曆十一年"(默认繁体)', cnEra.includes('萬曆十一年'), cnEra);

  // 5. 繁体组合: 萬曆癸未
  await page.fill('#globalSearch', '萬曆癸未');
  await page.click('#searchBtn');
  await page.waitForTimeout(800);
  total = await page.locator('#totalCount').textContent();
  check('搜索"萬曆癸未"精确命中1583', parseInt(total) === 1, total);

  // 6. 纯干支: 癸未
  await page.fill('#globalSearch', '癸未');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  total = await page.locator('#totalCount').textContent();
  check('搜索"癸未"命中所有癸未年', parseInt(total) === 48, total);

  // 7. "万历十一年" 直接搜索
  await page.fill('#globalSearch', '万历十一年');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  total = await page.locator('#totalCount').textContent();
  check('搜索"万历十一年"命中1583', parseInt(total) === 1, total);

  // 8. 繁体"貞觀"
  await page.fill('#globalSearch', '貞觀');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  total = await page.locator('#totalCount').textContent();
  check('搜索"貞觀"命中55条', parseInt(total) === 55, total);

  // 9. 繁简切换: 点"繁"
  await page.click('#langBtnT');
  await page.waitForTimeout(600);
  const headerTh = await page.locator('#tableHead th.col-cn-era').textContent();
  check('繁体表头"中國年號"', headerTh.includes('中國年號'), headerTh.trim());
  const tRow = await page.locator('#tableBody tr:first-child .cell-cn-era').textContent();
  check('繁体年号单元格', tRow.includes('貞觀'), tRow);

  // 10. 繁体模式下复制按钮的 data-copy
  const copyVal = await page.locator('#tableBody tr:first-child .era-copy-btn').first().getAttribute('data-copy');
  check('繁体模式复制文本', copyVal && copyVal.includes('貞觀'), copyVal);

  // 11. 切回简体
  await page.click('#langBtnS');
  await page.waitForTimeout(600);
  const headerThS = await page.locator('#tableHead th.col-cn-era').textContent();
  check('简体表头"中国年号"', headerThS.includes('中国年号'), headerThS.trim());

  // 12. 繁体模式搜索"萬曆癸未"
  await page.click('#langBtnT');
  await page.waitForTimeout(300);
  await page.fill('#globalSearch', '萬曆癸未');
  await page.click('#searchBtn');
  await page.waitForTimeout(800);
  total = await page.locator('#totalCount').textContent();
  const rowYear = await page.locator('#tableBody tr:first-child .cell-year').textContent();
  const rowEra = await page.locator('#tableBody tr:first-child .cell-cn-era').textContent();
  check('繁体模式搜索"萬曆癸未"', parseInt(total) === 1 && rowYear.trim() === '1583', `总=${total}, 年=${rowYear.trim()}, 年号=${rowEra}`);
  check('繁体模式显示"萬曆十一年"', rowEra.includes('萬曆十一年'), rowEra);

  // 截图 (繁体模式)
  await page.screenshot({ path: 'D:/WorkBuddy空间/2026-08-01-13-40-21/.workbuddy/browser_test_traditional.png', fullPage: false });

  console.log('\n===== 浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));
  console.log('\nJS错误数:', errors.length);
  errors.slice(0, 5).forEach(e => console.log('  ', e));

  await browser.close();
})();
