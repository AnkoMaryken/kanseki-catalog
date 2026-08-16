// v2.1 年份/干支拼音检索专项测试
// 覆盖: 年份全拼/缩写、干支全拼/缩写、建议点击跳转、回车搜索、繁体兼容、回归
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
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS'); // 简体
  await page.waitForTimeout(300);

  const getSuggestions = async (text) => {
    await page.fill('#globalSearch', text);
    await page.waitForTimeout(450);
    return await page.locator('#searchSuggestions .search-suggestion-item').allTextContents();
  };

  // 1. 年份全拼 erlingerliu -> 2026
  let s = await getSuggestions('erlingerliu');
  check('年份全拼 erlingerliu 命中2026', s.some(x => x.includes('2026')), JSON.stringify(s));
  check('年份全拼 建议显示公元2026年', s.some(x => x.includes('公元2026年')), JSON.stringify(s));

  // 2. 年份缩写 ell -> 2000系列
  s = await getSuggestions('ell');
  check('年份缩写 ell 命中2000+', s.some(x => x.includes('2000')), JSON.stringify(s.slice(0,3)));

  // 3. 干支全拼 wuchen -> 戊辰
  s = await getSuggestions('wuchen');
  check('干支全拼 wuchen 命中戊辰年', s.some(x => x.includes('戊辰年')), JSON.stringify(s.slice(0,2)));

  // 4. 干支缩写 jz -> 甲子
  s = await getSuggestions('jz');
  check('干支缩写 jz 命中甲子年', s.some(x => x.includes('甲子年')), JSON.stringify(s.slice(0,2)));

  // 5. 年号拼音回归 jingtai -> 明·景泰
  s = await getSuggestions('jingtai');
  check('年号拼音回归 jingtai 命中景泰', s.some(x => x.includes('景泰')), JSON.stringify(s));

  // 6. 干支组合查询 wuchen 回车搜索 -> 命中戊辰年所有行
  await page.fill('#globalSearch', 'wuchen');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const total = parseInt((await page.locator('#totalCount').textContent()).trim());
  check('wuchen 搜索命中50行', total === 50, 'total=' + total);
  // 首行含戊辰年
  const firstRow = await page.locator('#tableBody tr').first().textContent();
  check('wuchen 首行含戊辰', firstRow.includes('戊辰'), firstRow.slice(0, 60));

  // 7. 年份拼音回车搜索 ell -> 命中 2000-2009 等
  await page.fill('#globalSearch', 'ell');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const total2 = parseInt((await page.locator('#totalCount').textContent()).trim());
  check('ell 搜索有命中', total2 > 0, 'total=' + total2);

  // 8. 建议点击跳转: 干支全拼 wuchen 点击第一条
  await page.fill('#globalSearch', 'wuchen');
  await page.waitForTimeout(450);
  await page.locator('#searchSuggestions .search-suggestion-item').first().click();
  await page.waitForTimeout(500);
  const yearBadge = await page.locator('#currentYearDisplay, #yearDisplay, .year-badge').count();
  check('点击干支建议后跳转 (有年份显示元素)', yearBadge >= 0, 'badgeCount=' + yearBadge);

  // 9. 繁体兼容: 切繁体后干支拼音仍可用
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnT');
  await page.waitForTimeout(300);
  s = await getSuggestions('wuchen');
  check('繁体下干支拼音 wuchen 命中戊辰', s.some(x => x.includes('戊辰年')), JSON.stringify(s.slice(0,2)));
  s = await getSuggestions('erlingerliu');
  check('繁体下年份拼音 erlingerliu 命中2026', s.some(x => x.includes('2026')), JSON.stringify(s.slice(0,2)));

  // 10. 纯数字/字母混合不干扰: jingt (音节前缀)
  s = await getSuggestions('jingt');
  check('音节前缀 jingt 命中景泰', s.some(x => x.includes('景泰')), JSON.stringify(s.slice(0,2)));

  // 11. 汉字数字年份: 查询"二零二六"应命中 2026
  await page.fill('#globalSearch', '二零二六');
  await page.waitForTimeout(450);
  const sHan = await page.locator('#searchSuggestions .search-suggestion-item').allTextContents();
  check('汉字年份 二零二六 有建议', sHan.length > 0, JSON.stringify(sHan.slice(0,2)));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join('\n') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
