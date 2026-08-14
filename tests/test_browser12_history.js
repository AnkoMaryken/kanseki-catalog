// v2.1 搜索历史功能调试脚本
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
  };

  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  // 切简体 (默认繁体)
  await page.click('#langBtnS');
  await page.waitForTimeout(300);
  // 清空历史
  await page.evaluate(() => localStorage.removeItem('kanseki_search_history'));

  // 1. 初始无历史: 聚焦空输入框不显示浮层
  await page.click('#globalSearch');
  await page.waitForTimeout(300);
  let active = await page.locator('#searchSuggestions.active').count();
  check('无历史时聚焦不显示浮层', active === 0, 'active=' + active);

  // 2. 搜索"万历"记录历史
  await page.fill('#globalSearch', '万历');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  let hist = await page.evaluate(() => JSON.parse(localStorage.getItem('kanseki_search_history') || '[]'));
  check('搜索后记录历史', hist.includes('万历'), JSON.stringify(hist));

  // 3. 清空输入框聚焦 -> 显示历史浮层
  await page.fill('#globalSearch', '');
  await page.click('#globalSearch');
  await page.waitForTimeout(300);
  let items = await page.locator('#searchSuggestions .search-history-item').count();
  check('聚焦空框显示历史浮层', items === 1, 'items=' + items);
  let headText = await page.locator('#searchSuggestions .search-history-head').textContent();
  check('历史浮层标题含搜索历史', headText.includes('搜索历史'), headText);

  // 4. 再搜一个"戊辰" (历史应有 2 条, 戊辰置顶)
  await page.fill('#globalSearch', '戊辰');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  hist = await page.evaluate(() => JSON.parse(localStorage.getItem('kanseki_search_history') || '[]'));
  check('第二条历史已记录', hist.length === 2 && hist[0] === '戊辰', JSON.stringify(hist));

  // 5. 点击历史条目回填并搜索
  await page.fill('#globalSearch', '');
  await page.click('#globalSearch');
  await page.waitForTimeout(300);
  await page.locator('#searchSuggestions .search-history-item').nth(1).click(); // 万历
  await page.waitForTimeout(600);
  const inputVal = await page.inputValue('#globalSearch');
  check('点击历史回填输入框', inputVal === '万历', 'val=' + inputVal);
  const total = parseInt((await page.locator('#totalCount').textContent()).trim());
  check('点击历史后执行搜索', total > 0, 'total=' + total);

  // 6. 清空历史按钮
  await page.fill('#globalSearch', '');
  await page.click('#globalSearch');
  await page.waitForTimeout(300);
  await page.click('#searchHistoryClear');
  await page.waitForTimeout(300);
  let activeCount = await page.locator('#searchSuggestions.active').count();
  hist = await page.evaluate(() => JSON.parse(localStorage.getItem('kanseki_search_history') || '[]'));
  check('清空历史后浮层消失', activeCount === 0 && hist.length === 0, 'active=' + activeCount + ' hist=' + JSON.stringify(hist));

  // 7. 繁体模式下历史标题显示繁体
  await page.click('#langBtnT');
  await page.waitForTimeout(300);
  await page.fill('#globalSearch', '明治');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await page.fill('#globalSearch', '');
  await page.click('#globalSearch');
  await page.waitForTimeout(300);
  headText = await page.locator('#searchSuggestions .search-history-head').textContent();
  check('繁体模式历史标题繁体', headText.includes('搜索歷史'), headText);
  // 清理: 移除测试历史
  await page.evaluate(() => localStorage.removeItem('kanseki_search_history'));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join('\n') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
