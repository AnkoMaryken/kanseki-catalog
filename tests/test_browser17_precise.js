// V4.2 精确查询增强专项测试
// 覆盖: 1) 临近年份「猜你会需要」 2) 日本年号闪烁 3) 相同年号高亮提醒 4) 常用年号快捷区
const { chromium } = require('playwright-core');

const CHROME = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';
const BASE = 'http://localhost:8765/index.html';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  // 切简体 (默认繁体)
  await page.click('#langBtnS');
  await page.waitForTimeout(300);

  // ========== 1. 临近年份「猜你会需要」 ==========
  // 精准查询: 道光三年 (1823, 道光元年=1821)
  await page.fill('#globalSearch', '道光三年');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  check('道光三年命中行存在', await page.locator('#tableBody tr.precise-hit-row').count() >= 1);
  const hitYear1823 = await page.locator('#tableBody tr.precise-hit-row .cell-year').first().textContent();
  check('道光三年命中1823', hitYear1823.trim() === '1823', hitYear1823);
  const nearbySep = await page.locator('#tableBody tr.nearby-sep-row').count();
  check('「猜你会需要」分隔行出现', nearbySep >= 1, 'count=' + nearbySep);
  const nearbyRows = await page.locator('#tableBody tr.nearby-row').count();
  check('临近行 4 条 (前后各2)', nearbyRows >= 4, 'count=' + nearbyRows);
  // 验证临近行年份为 1821/1822/1824/1825
  const nearbyYears = await page.locator('#tableBody tr.nearby-row .cell-year').allTextContents();
  const has1821 = nearbyYears.includes('1821'), has1822 = nearbyYears.includes('1822');
  const has1824 = nearbyYears.includes('1824'), has1825 = nearbyYears.includes('1825');
  check('临近行含1821/1822/1824/1825', has1821 && has1822 && has1824 && has1825, nearbyYears.join(','));
  // 精准行与临近行样式区分
  const preciseBg = await page.locator('#tableBody tr.precise-hit-row .cell-year').evaluate(el => getComputedStyle(el).boxShadow);
  const nearbyOpacity = await page.locator('#tableBody tr.nearby-row').first().evaluate(el => getComputedStyle(el).opacity);
  check('精准行有描边', preciseBg && preciseBg !== 'none', preciseBg);
  check('临近行弱化', parseFloat(nearbyOpacity) < 1, 'opacity=' + nearbyOpacity);
  // 统计: 精准命中 1 行 (道光三年), 不含临近行
  const totalText = await page.locator('#totalCount').textContent();
  check('统计为精准命中1行', totalText.trim() === '1', 'total=' + totalText);

  // 年号+干支: 道光丁酉 (1837)
  await page.fill('#globalSearch', '道光丁酉');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const hitYear1837 = await page.locator('#tableBody tr.precise-hit-row .cell-year').first().textContent();
  check('道光丁酉命中1837', hitYear1837.trim() === '1837', hitYear1837);
  const sep2 = await page.locator('#tableBody tr.nearby-sep-row').count();
  check('干支查询也有分隔行', sep2 >= 1, 'count=' + sep2);

  // 普通查询 (非精准) 不触发临近行
  await page.fill('#globalSearch', '贞观');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const sep3 = await page.locator('#tableBody tr.nearby-sep-row').count();
  check('普通查询无临近行', sep3 === 0, 'count=' + sep3);

  // ========== 2. 日本年号闪烁 ==========
  // 日本专属年号: 大化 (645-650)
  await page.fill('#globalSearch', '大化');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const flashCount = await page.locator('#tableBody td.jp-flash-cell').count();
  check('大化结果行日本闪烁', flashCount >= 1, 'count=' + flashCount);

  // 中日重名年号 (贞观): 不闪烁 (因为也是中国年号, 应显示重名提醒)
  await page.fill('#globalSearch', '贞观');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const flashZg = await page.locator('#tableBody td.jp-flash-cell').count();
  check('贞观不触发日本闪烁', flashZg === 0, 'count=' + flashZg);

  // ========== 3. 相同年号高亮提醒 ==========
  // 中日重名: 贞观
  await page.fill('#globalSearch', '贞观');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const alertShown = await page.locator('#eraAlert.show').count();
  check('贞观触发重名提醒框', alertShown === 1, 'count=' + alertShown);
  const alertHtml = await page.locator('#eraAlert').innerHTML();
  check('提醒框含唐与日本', alertHtml.includes('唐') && alertHtml.includes('日本') && alertHtml.includes('西夏'), 'html=' + alertHtml.slice(0, 80));
  check('提醒框含年份区间', alertHtml.includes('627') || alertHtml.includes('859') || alertHtml.includes('1101'), 'html=' + alertHtml.slice(0, 120));

  // 中国内部重名: 太和 (6处)
  await page.fill('#globalSearch', '太和');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const alertTaihe = await page.locator('#eraAlert.show').count();
  check('太和触发内部重名提醒', alertTaihe === 1, 'count=' + alertTaihe);

  // 无重名年号 (道光): 不显示提醒框
  await page.fill('#globalSearch', '道光');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const alertDg = await page.locator('#eraAlert.show').count();
  check('道光无重名不提醒', alertDg === 0, 'count=' + alertDg);

  // ========== 4. 常用年号快捷区 (贞观直选) ==========
  await page.fill('#globalSearch', '');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(600);
  const quickGroup = await page.locator('#eraQuickFilter').count();
  const quickVisible = await page.locator('#eraQuickFilter').evaluate(el => el.style.display !== 'none');
  check('常用年号快捷区可见', quickGroup === 1 && quickVisible, 'display=' + (await page.locator('#eraQuickFilter').evaluate(el => el.style.display)));
  const quickTags = await page.locator('#eraQuickTags .filter-tag').count();
  check('快捷区有标签', quickTags >= 30, 'count=' + quickTags);
  const hasZhenGuan = await page.locator('#eraQuickTags .filter-tag[data-value="贞观"]').count();
  check('快捷区含贞观', hasZhenGuan === 1, 'count=' + hasZhenGuan);
  // 点击贞观快捷标签 → 筛选出贞观各朝
  await page.locator('#eraQuickTags .filter-tag[data-value="贞观"]').click();
  await page.waitForTimeout(800);
  const totalZg = await page.locator('#totalCount').textContent();
  check('点击贞观后筛选生效', parseInt(totalZg) >= 23, 'total=' + totalZg); // 唐23年 + 西夏13年 + 日本19年
  // 快捷区在筛选后隐藏 (已选朝代/年号)
  const quickHidden = await page.locator('#eraQuickFilter').evaluate(el => el.style.display === 'none');
  check('筛选后快捷区隐藏', quickHidden);
  // 清空筛选
  await page.click('#filterClearBtn');
  await page.waitForTimeout(600);
  const quickShown2 = await page.locator('#eraQuickFilter').evaluate(el => el.style.display !== 'none');
  check('清空后快捷区恢复', quickShown2);

  // ========== JS 错误检查 ==========
  check('无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));

  await page.screenshot({ path: '.workbuddy/v42_precise.png', fullPage: false });
  await browser.close();

  console.log('\n===== V4.2 专项测试结果 =====');
  console.log('通过: ' + passed + ' / ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
