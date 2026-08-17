// V8.0 专项测试: 其他朝代 (日本+周边政权) 展示 / 君主悬停 / 一键复制 / 快捷筛选朝代 / 品牌名
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

  // 切简体便于断言
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(400);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // ===== 1. 表头 =====
  const headers = await page.locator('#tableHead th').allTextContents().then(a => a.join('|'));
  check('表头含"其他朝代"', headers.includes('其他朝代'), headers.substring(0, 80));
  check('表头含"年号"且不含"日本年号"', headers.includes('年号') && !headers.includes('日本年号'), headers.substring(0, 80));
  check('表头含"在位君主"', headers.includes('在位君主'), headers.substring(0, 80));

  // ===== 2. 品牌名 =====
  const brand = await page.locator('.header-brand h1').textContent();
  check('品牌名"古代史及汉籍研究工具"', brand === '古代史及汉籍研究工具', brand);
  const docTitle = await page.title();
  check('页面 title 含新品牌', docTitle.includes('古代史及汉籍研究工具'), docTitle);

  // ===== 3. 周边政权数据展示 =====
  // 搜索"天授" (中国武周 690 + 高丽 918): 首行是中国天授(690), 918 行含高丽天授
  await page.fill('#globalSearch', '天授');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const allEraTexts = await page.locator('#tableBody tr .cell-jp-era').allTextContents();
  const hitGoryeo = allEraTexts.some(t => t.includes('高丽') && t.includes('天授'));
  check('结果中含"高丽·天授"', hitGoryeo, allEraTexts.slice(0, 3).join('|'));
  const allPeriodTexts = await page.locator('#tableBody tr .cell-jp-period').allTextContents();
  check('其他朝代列含"高丽"徽标', allPeriodTexts.some(t => t.includes('高丽')), allPeriodTexts.slice(0, 3).join('|'));

  // 搜索"嘉隆" (阮朝年号 1802-1820, 首行即阮朝)
  await page.fill('#globalSearch', '嘉隆');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const baoDa = await page.locator('#tableBody tr:first-child .cell-jp-era').textContent();
  check('阮朝·嘉隆显示', baoDa.includes('阮朝') && baoDa.includes('嘉隆'), (baoDa || '').slice(0, 60));

  // ===== 4. 在位君主悬停 =====
  // 嘉隆年间 1802: 阮朝君主 世祖(阮福映)
  const rulerCell = page.locator('#tableBody tr:first-child .cell-jp-ruler .ruler-hover').first();
  check('君主悬停元素存在', await rulerCell.count() > 0, 'count=' + await rulerCell.count());
  if (await rulerCell.count() > 0) {
    // 默认只显示省略文本 (mask)
    const maskText = await rulerCell.locator('.ruler-mask').first().textContent();
    check('悬停默认显示省略名', maskText.length > 0, maskText);
    // hover 后显示完整名
    await rulerCell.first().hover();
    await page.waitForTimeout(300);
    const nameText = await rulerCell.locator('.ruler-name').first().textContent();
    check('hover 显示完整君主名', nameText.length > 0 && (nameText.includes('阮福映') || nameText.includes('世祖')), nameText);
  }

  // ===== 5. 一键复制 (周边政权年号) =====
  // 定位"其他朝代"列中含"嘉隆"的复制按钮 (排序: 日本享和在前, 阮朝嘉隆在后)
  const copyBtns = page.locator('#tableBody tr:first-child .cell-jp-era .era-copy-btn');
  const nBtns = await copyBtns.count();
  let clip = '';
  for (let i = 0; i < nBtns; i++) {
    const title = await copyBtns.nth(i).getAttribute('title');
    if (title && title.includes('嘉隆')) {
      await copyBtns.nth(i).click();
      await page.waitForTimeout(300);
      clip = await page.evaluate(() => navigator.clipboard.readText());
      break;
    }
  }
  check('复制周边年号文本', clip.includes('嘉隆') && clip.includes('1802'), clip || '(未找到嘉隆按钮)');

  // ===== 6. 快捷筛选: 单独筛朝代 =====
  // 先清空搜索词, 避免与筛选交集为空
  await page.evaluate(() => {
    const input = document.getElementById('globalSearch');
    if (input) { input.value = ''; }
    // 模拟搜索框输入事件以重置搜索状态
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  // 打开快捷筛选, 点击"高丽"朝代 (不选年号)
  await page.evaluate(() => {
    const w = document.getElementById('qfWrap');
    if (!w.classList.contains('open')) document.getElementById('qfBtn').click();
  });
  await page.waitForTimeout(400);
  const goryeoItem = page.locator('.qf-dyn-item[data-label="高丽"]');
  check('快捷筛选中含"高丽"', await goryeoItem.count() > 0);
  await goryeoItem.dispatchEvent('click');
  await page.waitForTimeout(600);
  const chipGoryeo = await page.locator('.qf-chip-dyn').allTextContents();
  check('选中"高丽"朝代 chip', chipGoryeo.some(t => t.includes('高丽')), JSON.stringify(chipGoryeo));
  const stats = await page.locator('#totalCount').textContent();
  const rowCount = parseInt(stats.replace(/,/g, ''));
  check('筛选后行数>0且<40 (高丽年号共32年)', rowCount > 0 && rowCount <= 40, 'rows=' + rowCount);
  // 结果行应全部含高丽
  const firstPeriods = await page.locator('#tableBody tr .cell-jp-period').allTextContents();
  check('结果行均含高丽', firstPeriods.every(t => t.includes('高丽')), firstPeriods.slice(0, 3).join('|'));
  // 清除
  await page.click('#qfClear');
  await page.waitForTimeout(400);

  // ===== 7. 快捷筛选: 日本时代仍可筛 =====
  await page.evaluate(() => {
    const w = document.getElementById('qfWrap');
    if (!w.classList.contains('open')) document.getElementById('qfBtn').click();
  });
  await page.waitForTimeout(400);
  const jpHeian = page.locator('.qf-dyn-item[data-label="平安"]');
  check('快捷筛选中含"平安"时代', await jpHeian.count() > 0);
  await jpHeian.dispatchEvent('click');
  await page.waitForTimeout(600);
  const chipHeian = await page.locator('.qf-chip-dyn').allTextContents();
  check('选中"平安"时代 chip', chipHeian.some(t => t.includes('平安')), JSON.stringify(chipHeian));
  await page.click('#qfClear');
  await page.waitForTimeout(400);
  // 关闭浮窗
  await page.evaluate(() => {
    const w = document.getElementById('qfWrap');
    if (w.classList.contains('open')) document.getElementById('qfBtn').click();
  });
  await page.waitForTimeout(300);

  // ===== 8. 重名提醒文案更新 =====
  await page.fill('#globalSearch', '贞观');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const alertHtml = await page.locator('#eraAlert').innerHTML();
  check('重名提醒含"其他朝代"', alertHtml.includes('其他朝代'), alertHtml.slice(0, 80));

  console.log('\n===== V8.0 其他朝代/品牌名/筛选 浏览器实测 =====');
  results.forEach(r => console.log('  ' + r));

  await browser.close();
})();
