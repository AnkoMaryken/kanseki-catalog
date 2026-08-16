// v1.2 模糊搜索专项测试:
// 1. 输入"同治一" -> 建议含"同治十一年""同治二十一年""同治三十一年"
// 2. 输入"同治戊" -> 建议含"同治戊戌""同治戊寅"
// 3. 输入"明治三" -> 建议含"明治三十一年"等
// 4. 按回车搜索"同治一" -> 结果命中同治十一年/二十一年等行
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
  await page.waitForTimeout(600);
  // 切简体方便断言
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(300);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  const getSuggestions = async (text) => {
    await page.fill('#globalSearch', text);
    await page.waitForTimeout(500);
    const items = await page.locator('#searchSuggestions .search-suggestion-item').allTextContents();
    return items.map(s => s.trim());
  };

  // ===== 1. 同治一 =====
  // 注: 同治朝仅 1862-1874, 含"一"的年号只有"同治十一年"(1872); 二十一/三十一年史实不存在
  let sug = await getSuggestions('同治一');
  check('建议含"同治十一年"', sug.some(s => s.includes('同治十一年')), JSON.stringify(sug));

  // ===== 2. 同治戊 =====
  // 注: 同治朝唯一戊年 = 戊辰(1868), 戊戌/戊寅不在同治朝期内
  sug = await getSuggestions('同治戊');
  check('建议含"同治戊辰"', sug.some(s => s.includes('同治戊辰')), JSON.stringify(sug));

  // ===== 3. 明治三 (明治 1868-1912, 含多年份, 验证多候选补全) =====
  sug = await getSuggestions('明治三');
  check('建议含"明治三十一年"', sug.some(s => s.includes('明治三十一年')), JSON.stringify(sug));
  check('建议含"明治三十五年"', sug.some(s => s.includes('明治三十五年')), JSON.stringify(sug));

  // ===== 3b. 永乐一 (永乐 1403-1424, 含十一年/二十一年, 验证数字片段多候选) =====
  sug = await getSuggestions('永乐一');
  check('建议含"永乐十一年"', sug.some(s => s.includes('永乐十一年')), JSON.stringify(sug));
  check('建议含"永乐二十一年"', sug.some(s => s.includes('永乐二十一年')), JSON.stringify(sug));

  // ===== 4. 回车搜索明治三 -> 结果命中多个年份 =====
  await page.fill('#globalSearch', '明治三');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const total = await page.locator('#totalCount').textContent();
  check('搜索"明治三"命中数', parseInt(total) >= 2, 'total=' + total);
  const eraCells = await page.locator('#tableBody .cell-jp-era').allTextContents();
  const allText = eraCells.join(' ');
  check('结果含"明治三十一年"', allText.includes('明治三十一年'), allText.slice(0, 120));
  check('结果含"明治三十五年"', allText.includes('明治三十五年'), allText.slice(0, 120));

  // ===== 5. 繁体模式下模糊建议仍显示繁体 =====
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnT');
  await page.waitForTimeout(300);
  sug = await getSuggestions('同治一');
  check('繁体建议含"同治十一年"', sug.some(s => s.includes('同治十一年')), JSON.stringify(sug));

  // ===== 6. 点击建议跳转 =====
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(300);
  await page.fill('#globalSearch', '同治戊');
  await page.waitForTimeout(800);
  const sug6 = await page.locator('#searchSuggestions .search-suggestion-item').allTextContents();
  check('再次输入同治戊有建议', sug6.length > 0, JSON.stringify(sug6.map(s => s.trim())));
  const gzItem = page.locator('#searchSuggestions .search-suggestion-item', { hasText: '同治戊' }).nth(0);
  const cnt = await page.locator('#searchSuggestions .search-suggestion-item').count();
  if (cnt > 0) {
    await gzItem.first().click();
    await page.waitForTimeout(600);
    const sugPanel = await page.locator('#searchSuggestions.active').count();
    check('点击建议后面板关闭', sugPanel === 0, 'active=' + sugPanel);
  } else {
    check('点击建议跳转成功', false, '无建议可点');
  }

  console.log('\n===== 模糊搜索浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));
  console.log('\nJS错误数:', errors.length);
  errors.slice(0, 5).forEach(e => console.log('  ', e));

  await browser.close();
})();
