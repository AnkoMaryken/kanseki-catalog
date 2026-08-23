// V8.3 功能专项测试
// 覆盖: ① 卡片横向网格 4/6 列切换+持久化 ② 卡片内年号独立复制按钮
//       ③ 混合查询(汉字+拼音/数字) ④ 干支错写提醒+弱高亮 ⑤ 快捷筛选整朝选择 ⑥ 移动端单列
// 注: Windows headless Chrome 偶发「断言全绿但进程不退出」, 末尾加强制退出守卫 (90s) 兜底
const { CHROME_PATH, PORT, playwrightCorePath } = require('D:/WorkBuddy空间/2026-08-01-13-40-21/tests/helpers/config');
const { chromium } = require(playwrightCorePath());
const BASE = 'http://localhost:' + PORT;
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + '  ' + (extra || '')); }
}
// 强制退出守卫: 断言结果已打印, 若 playwright 偶发不退出则 90s 后兜底退出
const GUARD_MS = 90000;
setTimeout(() => { console.log('[guard] 超时强制退出 (断言结果以上方为准)'); process.exit(failed ? 1 : 0); }, GUARD_MS).unref();

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  // 清态: 表格视图 + 默认列数
  await page.evaluate(() => {
    localStorage.removeItem('kanseki_view_mode');
    localStorage.removeItem('kanseki_card_columns');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // ===== 1. 卡片横向排布 + 4/6 列 =====
  console.log('\n[1] 卡片视图列数');
  await page.click('#viewModeCard');
  await page.waitForTimeout(400);
  const gridCols = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('cardView'));
    return { display: cs.display, cols: cs.gridTemplateColumns.split(' ').length };
  });
  ok('卡片视图 display=grid', gridCols.display === 'grid', JSON.stringify(gridCols));
  ok('卡片默认 4 列', gridCols.cols === 4, 'cols=' + gridCols.cols);

  await page.click('.card-cols-btn[data-cols="6"]');
  await page.waitForTimeout(300);
  const cols6 = await page.evaluate(() => getComputedStyle(document.getElementById('cardView')).gridTemplateColumns.split(' ').length);
  ok('切换到 6 列', cols6 === 6, 'cols=' + cols6);
  const stored = await page.evaluate(() => localStorage.getItem('kanseki_card_columns'));
  ok('列数持久化 localStorage', stored === '6', 'stored=' + stored);
  await page.click('.card-cols-btn[data-cols="4"]');
  await page.waitForTimeout(300);

  // ===== 2. 卡片内年号独立复制按钮 =====
  console.log('\n[2] 卡片内独立复制');
  await page.fill('#globalSearch', '1583');
  await page.waitForTimeout(600);
  const copyInfo = await page.evaluate(() => {
    const card = document.querySelector('#cardView .year-card');
    if (!card) return { ok: false };
    const jpBtns = card.querySelectorAll('.yc-block.jp .era-copy-btn');
    const cnBtns = card.querySelectorAll('.yc-block:not(.jp) .era-copy-btn');
    return {
      ok: true,
      jp: Array.from(jpBtns).map(b => b.getAttribute('data-copy')),
      cn: Array.from(cnBtns).map(b => b.getAttribute('data-copy'))
    };
  });
  ok('卡片内存在复制按钮', copyInfo.ok && (copyInfo.jp.length + copyInfo.cn.length) >= 2, JSON.stringify(copyInfo));
  ok('其他朝代独立复制(非一长串)', copyInfo.ok && copyInfo.jp.length >= 1 &&
    copyInfo.jp.every(t => t && !t.includes('；') && !t.includes(';') && t.length < 40), JSON.stringify(copyInfo.jp));
  ok('1583 年日本三朝独立按钮', copyInfo.ok &&
    copyInfo.jp.some(t => t.includes('天正十一年')) &&
    copyInfo.jp.some(t => t.includes('光興六年')) &&
    copyInfo.jp.some(t => t.includes('延成六年')), JSON.stringify(copyInfo.jp));

  await page.click('#cardView .yc-block.jp .era-copy-btn');
  await page.waitForTimeout(300);
  const copied = await page.evaluate(() => {
    const btn = document.querySelector('#cardView .yc-block.jp .era-copy-btn');
    return btn ? btn.classList.contains('copied') : false;
  });
  ok('复制按钮点击反馈(copied)', copied);

  // ===== 3. 混合查询 =====
  console.log('\n[3] 混合查询');
  await page.click('#viewModeTable');
  await page.waitForTimeout(300);
  async function searchRows(q, waitMs) {
    await page.fill('#globalSearch', q);
    await page.waitForTimeout(waitMs || 700);
    return page.evaluate(() => {
      const rows = document.querySelectorAll('#tableBody tr:not(.nearby-row):not(.nearby-sep-row)');
      return { count: rows.length, txt: rows[0] ? rows[0].textContent.replace(/\s+/g, ' ').trim() : '' };
    });
  }
  const m1 = await searchRows('光绪wushen');
  ok('光绪wushen → 1 条', m1.count === 1, 'count=' + m1.count);
  ok('光绪wushen → 命中 1908 戊申', m1.txt.includes('1908') && m1.txt.includes('戊申') && m1.txt.includes('光緒'), m1.txt.slice(0, 60));

  const m2 = await searchRows('光绪3');
  ok('光绪3 → 1 条', m2.count === 1, 'count=' + m2.count);
  ok('光绪3 → 命中 1877 三年', m2.txt.includes('1877') && m2.txt.includes('光緒三年'), m2.txt.slice(0, 60));

  const m3 = await searchRows('承和2');
  ok('承和2 → 1 条', m3.count === 1, 'count=' + m3.count);
  ok('承和2 → 命中 835 二年', m3.txt.includes('835') && m3.txt.includes('承和'), m3.txt.slice(0, 60));

  // ===== 4. 干支错写 =====
  console.log('\n[4] 干支错写提醒');
  await page.fill('#globalSearch', '巳巳');
  await page.waitForTimeout(700);
  const t1 = await page.evaluate(() => {
    const alert = document.getElementById('eraAlert');
    const rows = document.querySelectorAll('#tableBody tr:not(.nearby-row):not(.nearby-sep-row)');
    return {
      alertShown: alert.classList.contains('show'),
      alertText: alert.textContent,
      count: rows.length,
      typoHits: document.querySelectorAll('tr.typo-hit-row').length,
      firstGz: rows[0] ? rows[0].querySelector('.cell-ganzhi').textContent : ''
    };
  });
  ok('巳巳 → 提醒框弹出', t1.alertShown && t1.alertText.includes('己巳'), t1.alertText.slice(0, 60));
  ok('巳巳 → 列出己巳年份', t1.count > 0, 'count=' + t1.count);
  ok('巳巳 → 行弱高亮', t1.typoHits > 0, 'hits=' + t1.typoHits);
  ok('巳巳 → 行干支为 己巳', t1.firstGz === '己巳', 'gz=' + t1.firstGz);

  // 错写 + 年号前缀: 无该朝己巳时应 0 结果 + 提醒
  await page.fill('#globalSearch', '光绪巳巳');
  await page.waitForTimeout(700);
  const t2 = await page.evaluate(() => {
    const alert = document.getElementById('eraAlert');
    const rows = document.querySelectorAll('#tableBody tr:not(.nearby-row):not(.nearby-sep-row)');
    return { alertShown: alert.classList.contains('show'), count: rows.length };
  });
  ok('光绪巳巳 → 有提醒', t2.alertShown);
  ok('光绪巳巳 → 0 结果(光绪朝无己巳)', t2.count === 0, 'count=' + t2.count);

  // ===== 5. 快捷筛选整朝 =====
  console.log('\n[5] 快捷筛选整朝');
  await page.fill('#globalSearch', '');
  await page.waitForTimeout(400);
  await page.click('#qfBtn');
  await page.waitForTimeout(400);
  const qf1 = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#qfDynCol .qf-dyn-item'));
    return items.some(i => i.dataset.label === '清');
  });
  ok('快捷筛选左列含「清」', qf1);
  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('#qfDynCol .qf-dyn-item')).find(i => i.dataset.label === '清');
    item.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const actBtn = await page.evaluate(() => {
    const b = document.getElementById('qfActDyn');
    return b ? b.textContent.trim() : null;
  });
  ok('整朝按钮存在', !!actBtn && actBtn.includes('朝代'), actBtn || '');
  await page.evaluate(() => { const b = document.getElementById('qfActDyn'); if (b) b.click(); });
  await page.waitForTimeout(600);
  const qf2 = await page.evaluate(() => {
    const rows = document.querySelectorAll('#tableBody tr:not(.nearby-row):not(.nearby-sep-row)');
    const chips = Array.from(document.querySelectorAll('#qfChips .qf-chip')).map(c => c.textContent);
    return { count: rows.length, chips };
  });
  ok('整朝筛选生效(清)', qf2.count > 0, 'count=' + qf2.count);
  ok('整朝筛选 chip 含清', qf2.chips.some(c => c.includes('清')), JSON.stringify(qf2.chips));
  const allBtn = await page.evaluate(() => {
    const b = document.getElementById('qfActAllEras');
    return b ? b.textContent.trim() : null;
  });
  ok('全选本朝年号按钮存在', !!allBtn, allBtn || '');

  // ===== 6. 移动端单列 =====
  console.log('\n[6] 移动端');
  const p2 = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await p2.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await p2.waitForTimeout(500);
  const mob = await p2.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('cardView'));
    return { cols: cs.gridTemplateColumns.split(' ').length };
  });
  ok('移动端卡片单列', mob.cols === 1, 'cols=' + mob.cols);

  // ===== 7. changelog =====
  console.log('\n[7] changelog');
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await p3.goto(BASE + '/changelog.html', { waitUntil: 'networkidle' });
  const cl = await p3.evaluate(() => document.querySelector('.cl-entry .cl-ver').textContent);
  ok('changelog 最新 v8.3', cl === 'v8.3', 'ver=' + cl);

  // 注: Windows 上逐个 page.close() 可能挂起, 直接 browser.close() 统一回收
  await browser.close();
  ok('全程无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  console.log(`\n==== V8.3 功能测试: ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
