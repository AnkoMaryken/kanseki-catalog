// V4.3 精确查询整改专项测试
// 覆盖: 1) 无常用年号快捷区 2) 精准行浅描边(非黑胶囊) 3) 分隔行居中横线+整个年号年份
//       4) 回车跳转定位 (年号第一年) 5) 崇祯归属修正 6) 日本闪烁 7) 重名提醒
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

  // ========== 1. 无「常用年号」快捷区 (V4.3 已删除) ==========
  const quickGroup = await page.locator('#eraQuickFilter').count();
  const quickMobile = await page.locator('#eraQuickFilterMobile').count();
  check('桌面快捷区已删除', quickGroup === 0, 'count=' + quickGroup);
  check('移动快捷区已删除', quickMobile === 0, 'count=' + quickMobile);
  // 无 ERA_QUICK_LIST 相关 JS
  const hasQuickJs = await page.evaluate(() => typeof window.ERA_QUICK_LIST !== 'undefined');
  check('ERA_QUICK_LIST 已移除', !hasQuickJs);

  // ========== 2. 精准行浅描边 (道光三年 → 1823, 非黑胶囊) ==========
  await page.fill('#globalSearch', '道光三年');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  check('道光三年命中行存在', await page.locator('#tableBody tr.precise-hit-row').count() >= 1);
  const hitYear1823 = await page.locator('#tableBody tr.precise-hit-row .cell-year').first().textContent();
  check('道光三年命中1823', hitYear1823.trim() === '1823', hitYear1823);
  // 样式: 正常行底色 (非深黑 #101012) + inset 浅描边
  const preciseBg = await page.locator('#tableBody tr.precise-hit-row .cell-year').evaluate(el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, shadow: cs.boxShadow };
  });
  const bgNormal = preciseBg.bg !== 'rgb(16, 16, 18)' && !preciseBg.bg.includes('16, 16, 18');
  check('精准行背景正常(非深黑#101012)', bgNormal, 'bg=' + preciseBg.bg);
  check('精准行浅描边(inset)', preciseBg.shadow.includes('inset'), 'shadow=' + preciseBg.shadow);

  // ========== 3. 分隔行 = 居中横线, 其下为整个年号全部年份 (道光 1821-1850) ==========
  const nearbySep = await page.locator('#tableBody tr.nearby-sep-row').count();
  check('分隔行出现', nearbySep >= 1, 'count=' + nearbySep);
  // 横线: 无文字标签, block 显示 + 上边框线
  const sepStyle = await page.locator('#tableBody tr.nearby-sep-row .nearby-sep').first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { text: el.textContent.trim(), display: cs.display, bt: cs.borderTopWidth, ml: cs.marginLeft, mr: cs.marginRight };
  });
  check('横线无文字标签', sepStyle.text === '', 'text=' + sepStyle.text);
  check('横线为块级元素', sepStyle.display === 'block', 'display=' + sepStyle.display);
  check('横线有上边框线', parseFloat(sepStyle.bt) > 0, 'borderTop=' + sepStyle.bt);
  check('横线水平居中(auto margin)', sepStyle.ml === sepStyle.mr, 'ml=' + sepStyle.ml + ' mr=' + sepStyle.mr);
  const nearbyRows = await page.locator('#tableBody tr.nearby-row').count();
  // 道光 1821-1850 共 30 年, 命中 1823 → 其余 29 行
  check('临近行为整个年号其余年份(29)', nearbyRows === 29, 'count=' + nearbyRows);
  const nearbyYears = await page.locator('#tableBody tr.nearby-row .cell-year').allTextContents().then(a => a.map(s => s.trim()));
  check('临近行含道光元年1821', nearbyYears.includes('1821'), nearbyYears.slice(0,5).join(','));
  check('临近行含道光末年1850', nearbyYears.includes('1850'));
  check('临近行不含命中行1823', !nearbyYears.includes('1823'));
  // 统计: 精准命中 1 行 (不含临近行)
  const totalText = await page.locator('#totalCount').textContent();
  check('统计为精准命中1行', totalText.trim() === '1', 'total=' + totalText);

  // ========== 4. 回车跳转定位 ==========
  // 4a. 纯年号「道光」→ 跳转道光元年 1821
  await page.fill('#globalSearch', '道光');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  // 检查当前页第一行是否为 1821
  const firstYear = await page.locator('#tableBody tr .cell-year').first().textContent();
  check('道光回车跳转第一年1821', firstYear.trim() === '1821', 'first=' + firstYear);
  // 4b. 精准「道光三年」→ 跳转 1823
  await page.fill('#globalSearch', '道光三年');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const firstYear2 = await page.locator('#tableBody tr .cell-year').first().textContent();
  check('道光三年回车跳转1823', firstYear2.trim() === '1823', 'first=' + firstYear2);

  // 年号+干支: 道光丁酉 (1837)
  await page.fill('#globalSearch', '道光丁酉');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const hitYear1837 = await page.locator('#tableBody tr.precise-hit-row .cell-year').first().textContent();
  check('道光丁酉命中1837', hitYear1837.trim() === '1837', hitYear1837);
  const sep2 = await page.locator('#tableBody tr.nearby-sep-row').count();
  check('干支查询也有分隔行', sep2 >= 1, 'count=' + sep2);

  // 普通查询 (纯年号, 非精准) 不触发临近行
  await page.fill('#globalSearch', '贞观');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const sep3 = await page.locator('#tableBody tr.nearby-sep-row').count();
  check('普通查询无临近行', sep3 === 0, 'count=' + sep3);

  // ========== 5. 日本年号闪烁 ==========
  await page.fill('#globalSearch', '大化');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const flashCount = await page.locator('#tableBody td.jp-flash-cell').count();
  check('大化结果行日本闪烁', flashCount >= 1, 'count=' + flashCount);

  // 中日重名年号 (贞观): 不闪烁 (也是中国年号, 应显示重名提醒)
  await page.fill('#globalSearch', '贞观');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const flashZg = await page.locator('#tableBody td.jp-flash-cell').count();
  check('贞观不触发日本闪烁', flashZg === 0, 'count=' + flashZg);

  // ========== 6. 重名提醒 ==========
  // 中日重名: 贞观
  const alertShown = await page.locator('#eraAlert.show').count();
  check('贞观触发重名提醒框', alertShown === 1, 'count=' + alertShown);
  const alertHtml = await page.locator('#eraAlert').innerHTML();
  check('提醒框含唐/日本/西夏', alertHtml.includes('唐') && alertHtml.includes('日本') && alertHtml.includes('西夏'), 'html=' + alertHtml.slice(0, 80));

  // 中国内部重名: 太和
  await page.fill('#globalSearch', '太和');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const alertTaihe = await page.locator('#eraAlert.show').count();
  check('太和触发内部重名提醒', alertTaihe === 1, 'count=' + alertTaihe);

  // 崇祯: 只属明 (V4.3 修复: 不再归给清 1644-1644)
  await page.fill('#globalSearch', '崇祯');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  // 崇祯只属明 → 无重名 → 不显示提醒框
  const alertCz = await page.locator('#eraAlert.show').count();
  check('崇祯仅明一朝无重名提醒', alertCz === 0, 'count=' + alertCz);
  // 崇祯结果 17 行 (1628-1644), 第一行 1628
  const czFirst = await page.locator('#tableBody tr .cell-year').first().textContent();
  check('崇祯结果首行1628', czFirst.trim() === '1628', 'first=' + czFirst);
  const czTotal = await page.locator('#totalCount').textContent();
  check('崇祯共17年', czTotal.trim() === '17', 'total=' + czTotal);

  // 无重名年号 (道光): 不显示提醒框
  await page.fill('#globalSearch', '道光');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(800);
  const alertDg = await page.locator('#eraAlert.show').count();
  check('道光无重名不提醒', alertDg === 0, 'count=' + alertDg);

  // ========== 7. 年号子筛选完整性 ==========
  // 清空搜索词, 关闭建议浮层
  await page.fill('#globalSearch', '');
  await page.press('#globalSearch', 'Enter');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  // 选择「唐」后, 年号子筛选应含「贞观」
  await page.click('#chinaFilterTags .filter-tag[data-value="唐"]');
  await page.waitForTimeout(800);
  const hasZhenGuan = await page.locator('#chinaEraTags .filter-tag[data-value="贞观"]').count();
  check('唐年号子筛选含贞观', hasZhenGuan === 1, 'count=' + hasZhenGuan);
  // 清空筛选
  await page.click('#filterClearBtn');
  await page.waitForTimeout(600);

  // ========== JS 错误检查 ==========
  check('无 JS 错误', errors.length === 0, errors.join(' | ').slice(0, 300));

  await page.screenshot({ path: '.workbuddy/v43_precise.png', fullPage: false });
  await browser.close();

  console.log('\n===== V4.3 专项测试结果 =====');
  console.log('通过: ' + passed + ' / ' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
