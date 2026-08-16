// 验证: 进入纪年查询页面时默认为繁体字
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
  const context = browser.contexts()[0];
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // ===== 1. 初始按钮状态: 繁体 active =====
  const btnSActive = await page.locator('#langBtnS.active').count();
  const btnTActive = await page.locator('#langBtnT.active').count();
  check('初始"繁"按钮高亮', btnTActive === 1, 'btnS_active=' + btnSActive + ' btnT_active=' + btnTActive);

  // ===== 2. 表头为繁体 =====
  const headers = await page.locator('#tableHead th').allTextContents();
  const headJoin = headers.join('|');
  check('表头"中國年號"', headJoin.includes('中國年號'), headJoin.substring(0, 80));
  check('表头"公曆年份"', headJoin.includes('公曆年份'), headJoin.substring(0, 80));
  check('表头"日本時代"', headJoin.includes('日本時代'), headJoin.substring(0, 80));
  check('表头"在位天皇"', headJoin.includes('在位天皇'), headJoin.substring(0, 80));
  check('表头无简体"中国年号"', !headJoin.includes('中国年号'), headJoin.substring(0, 80));

  // ===== 3. 表格数据为繁体 (年号单元格) =====
  const firstEraCell = await page.locator('#tableBody tr:first-child .era-text').first().textContent();
  check('首行年号繁体', /[\u4e00-\u9fff]/.test(firstEraCell), firstEraCell);

  // 搜索贞观验证单元格繁体
  await page.fill('#globalSearch', '贞观');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  const eraCellT = await page.locator('#tableBody tr:first-child .era-text').first().textContent();
  check('搜索结果年号繁体"貞觀"', eraCellT.includes('貞觀'), eraCellT);

  // ===== 4. 快捷筛选 chips 繁体 =====
  // v5.1 起筛选改为浮窗: 打开快捷筛选浮窗选中"西周"朝代, 验证 chip 显示繁体"西週"
  await page.evaluate(() => {
    const w = document.getElementById('qfWrap');
    if (!w.classList.contains('open')) document.getElementById('qfBtn').click();
  });
  await page.waitForTimeout(400); // 等浮窗动画完成
  await page.locator('.qf-dyn-item[data-label="西周"]').dispatchEvent('click');
  await page.waitForTimeout(400);
  const tagT = await page.locator('.qf-chip-dyn').first().textContent();
  check('筛选 chip 繁体"西週"', tagT.includes('西週'), tagT);
  // 清除筛选, 恢复初始状态
  await page.click('#qfClear');
  await page.waitForTimeout(300);

  // ===== 5. placeholder 繁体 =====
  const ph = await page.locator('#globalSearch').getAttribute('placeholder');
  check('搜索框 placeholder 繁体', ph.includes('公曆年份') && ph.includes('年號'), ph);

  // ===== 6. 复制输出繁体 =====
  // 先关闭快捷筛选浮窗, 避免遮挡表格复制按钮
  await page.evaluate(() => {
    const w = document.getElementById('qfWrap');
    if (w.classList.contains('open')) document.getElementById('qfBtn').click();
  });
  await page.waitForTimeout(400);
  const copyBtn = page.locator('#tableBody tr:first-child .era-copy-btn').first();
  await copyBtn.click();
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('默认复制输出繁体', /[\u3400-\u9fff]/.test(clip) && clip.includes('貞觀'), clip);

  // ===== 7. 切简体后恢复 =====
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(400);
  const headS = await page.locator('#tableHead th').allTextContents().then(a => a.join('|'));
  check('切简体后表头"中国年号"', headS.includes('中国年号'), headS.substring(0, 60));
  await page.evaluate(() => {
    const w = document.getElementById('qfWrap');
    if (!w.classList.contains('open')) document.getElementById('qfBtn').click();
  });
  await page.waitForTimeout(400);
  await page.locator('.qf-dyn-item[data-label="西周"]').dispatchEvent('click');
  await page.waitForTimeout(400);
  const tagS = await page.locator('.qf-chip-dyn').first().textContent();
  check('切简体后 chip"西周"', tagS.includes('西周'), tagS);
  await page.click('#qfClear');
  await page.waitForTimeout(300);

  // ===== 8. 再切回繁体 =====
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnT');
  await page.waitForTimeout(400);
  const headT2 = await page.locator('#tableHead th').allTextContents().then(a => a.join('|'));
  check('切回繁体表头"中國年號"', headT2.includes('中國年號'), headT2.substring(0, 60));

  console.log('\n===== 默认繁体浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));

  await browser.close();
})();
