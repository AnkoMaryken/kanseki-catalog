// v2.0 大更新专项测试:
// 1. 拼音检索: 输入"jingtai" -> 建议含"明·景泰"; 回车搜索 -> 命中景泰年间
// 2. 首字母缩写: 输入"wanli"/"wl" -> 建议含"明·万历"
// 3. 单字候选按年号顺序: 输入"景" -> 候选为"周·景王"/"汉·景帝"/"三国·景初"...(按历史顺序)
// 4. 候选带朝代前缀: 输入"万历" -> 建议含"明·万历"
// 5. 繁体模式下拼音仍可用
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

  // ===== 1. 拼音全拼: jingtai -> 明·景泰 =====
  let sug = await getSuggestions('jingtai');
  check('拼音"jingtai"建议含"明·景泰"', sug.some(s => s.includes('明·景泰')), JSON.stringify(sug));

  // ===== 2. 首字母缩写: wl -> 明·万历 =====
  sug = await getSuggestions('wl');
  check('缩写"wl"建议含"明·万历"', sug.some(s => s.includes('明·万历')), JSON.stringify(sug));

  // ===== 3. 单字候选按历史顺序: 景 =====
  sug = await getSuggestions('景');
  check('单字"景"有候选', sug.length > 0, JSON.stringify(sug));
  // 景王(-544 春秋) 应排在 汉景帝(-156 西汉) 之前, 景初(237 三国) 之前
  const idxJingWang = sug.findIndex(s => s.includes('景王'));
  const idxHanJingDi = sug.findIndex(s => s.includes('汉·景帝') || s.includes('景帝'));
  const idxJingChu = sug.findIndex(s => s.includes('景初'));
  check('景王排在景帝前', idxJingWang >= 0 && idxHanJingDi >= 0 && idxJingWang < idxHanJingDi,
    '景王@' + idxJingWang + ' 景帝@' + idxHanJingDi);
  check('景帝排在景初前', idxHanJingDi >= 0 && idxJingChu >= 0 && idxHanJingDi < idxJingChu,
    '景帝@' + idxHanJingDi + ' 景初@' + idxJingChu);

  // ===== 4. 双字候选带朝代前缀: 万历 =====
  sug = await getSuggestions('万历');
  check('"万历"建议含"明·万历"', sug.some(s => s.includes('明·万历')), JSON.stringify(sug));

  // ===== 4b. 日本年号带时代前缀: 明治 =====
  sug = await getSuggestions('明治');
  check('"明治"建议含"近现代·明治"或"明治"', sug.some(s => s.includes('明治')), JSON.stringify(sug));

  // ===== 5. 回车搜索拼音 -> 结果命中 =====
  await page.fill('#globalSearch', 'jingtai');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const total = await page.locator('#totalCount').textContent();
  check('拼音搜索"jingtai"命中数>0', parseInt(total) > 0, 'total=' + total);

  // ===== 6. 拼音前缀输入过程即时提示: jt -> 含景泰 =====
  sug = await getSuggestions('jt');
  check('输入"jt"即时提示含"景泰"', sug.some(s => s.includes('景泰')), JSON.stringify(sug));

  // ===== 7. 繁体模式下拼音建议 =====
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnT');
  await page.waitForTimeout(300);
  sug = await getSuggestions('jingtai');
  check('繁体模式拼音"jingtai"建议含"明·景泰"', sug.some(s => s.includes('景泰')), JSON.stringify(sug));
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(300);

  // ===== 8. 点击建议跳转 =====
  await page.fill('#globalSearch', 'jingtai');
  await page.waitForTimeout(800);
  const jtItem = page.locator('#searchSuggestions .search-suggestion-item', { hasText: '景泰' }).nth(0);
  const cnt = await page.locator('#searchSuggestions .search-suggestion-item').count();
  if (cnt > 0) {
    await jtItem.first().click();
    await page.waitForTimeout(600);
    const sugPanel = await page.locator('#searchSuggestions.active').count();
    check('点击拼音建议后面板关闭', sugPanel === 0, 'active=' + sugPanel);
  } else {
    check('点击拼音建议跳转成功', false, '无建议可点');
  }

  console.log('\n===== v2.0 拼音检索/候选排序/朝代前缀 浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));
  console.log('\nJS错误数:', errors.length);
  errors.slice(0, 5).forEach(e => console.log('  ', e));

  await browser.close();
})();
