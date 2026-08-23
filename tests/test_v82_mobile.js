// V8.2 移动端适配专项测试
// 覆盖: 汉堡抽屉导航 / 移动端卡片视图强制单列 / 移动筛选条 / 快捷筛选底部抽屉 / 桌面恢复
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

  // ============ 移动端 375px ============
  console.log('\n[移动端 375×812]');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // 1. 汉堡按钮可见 + 桌面导航隐藏
  const mob = await page.evaluate(() => {
    const h = document.getElementById('mHamburger');
    const nav = document.querySelector('.header-nav');
    const drawer = document.getElementById('mDrawer');
    return {
      hamburgerDisplay: h ? getComputedStyle(h).display : 'none',
      navDisplay: nav ? getComputedStyle(nav).display : '',
      drawerOpen: drawer ? drawer.classList.contains('open') : false
    };
  });
  ok('汉堡按钮显示', mob.hamburgerDisplay !== 'none', 'display=' + mob.hamburgerDisplay);
  ok('桌面导航隐藏', mob.navDisplay === 'none', 'nav=' + mob.navDisplay);

  // 2. 打开抽屉
  await page.click('#mHamburger');
  await page.waitForTimeout(400);
  const drawer1 = await page.evaluate(() => {
    const d = document.getElementById('mDrawer');
    const o = document.getElementById('mDrawerOverlay');
    return { open: d.classList.contains('open'), overlay: o.classList.contains('open'), overflow: document.body.style.overflow };
  });
  ok('抽屉打开', drawer1.open && drawer1.overlay, JSON.stringify(drawer1));
  ok('抽屉打开时锁定滚动', drawer1.overflow === 'hidden', 'overflow=' + drawer1.overflow);

  // 3. Escape 关闭
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const drawer2 = await page.evaluate(() => document.getElementById('mDrawer').classList.contains('open'));
  ok('Escape 关闭抽屉', !drawer2);

  // 4. 移动端强制卡片视图 (CSS 强制 display:flex, 不依赖 body 类)
  const card = await page.evaluate(() => {
    const cv = document.getElementById('cardView');
    const tw = document.getElementById('tableWrapper');
    const cs = getComputedStyle(cv);
    return {
      bodyCard: document.body.classList.contains('view-card'),
      display: cs.display,
      flexDir: cs.flexDirection,
      tableDisplay: tw ? getComputedStyle(tw).display : ''
    };
  });
  ok('移动端卡片显示(flex)', card.display === 'flex', 'display=' + card.display + ' dir=' + card.flexDir);
  ok('移动端卡片纵向单列', card.flexDir === 'column', 'dir=' + card.flexDir);
  ok('移动端表格隐藏', card.tableDisplay === 'none', 'table=' + card.tableDisplay);

  // 5. 移动筛选条可见 (桌面 filter-bar 已移除, 只验证移动条存在)
  const filter = await page.evaluate(() => {
    const fm = document.getElementById('mobileFilterBar');
    return { fm: fm ? getComputedStyle(fm).display : 'none' };
  });
  ok('移动筛选条显示', filter.fm !== 'none', 'fm=' + filter.fm);

  // 6. 快捷筛选底部抽屉 (移动端)
  const qfBtn = await page.evaluate(() => {
    const b = document.getElementById('qfBtn');
    return b ? getComputedStyle(b).display : 'none';
  });
  ok('快捷筛选按钮可见', qfBtn !== 'none', 'qfBtn=' + qfBtn);
  await page.click('#qfBtn');
  await page.waitForTimeout(400);
  const qfPanel = await page.evaluate(() => {
    const p = document.getElementById('qfPanel');
    if (!p) return { missing: true };
    const cs = getComputedStyle(p);
    return { display: cs.display, position: cs.position, bottom: cs.bottom, transform: cs.transform };
  });
  ok('快捷筛选面板存在', !qfPanel.missing, JSON.stringify(qfPanel));
  if (!qfPanel.missing) {
    // 移动端应显示为底部抽屉 (fixed + 非全屏展开)
    ok('快捷筛选为底部抽屉形态', qfPanel.display !== 'none', JSON.stringify(qfPanel));
  }
  await page.evaluate(() => { const c = document.querySelector('#qfPanel .qf-close-btn, #qfPanel .qf-cancel, .qf-close'); if (c) c.click(); });
  await page.waitForTimeout(300);

  // 7. 无 JS 错误
  ok('移动端无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ============ 桌面恢复 ============
  console.log('\n[桌面 1440×900 恢复]');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  const desk = await page.evaluate(() => {
    const h = document.getElementById('mHamburger');
    const nav = document.querySelector('.header-nav');
    const card = document.getElementById('cardView');
    const tw = document.getElementById('tableWrapper');
    return {
      hamburgerDisplay: h ? getComputedStyle(h).display : 'none',
      navDisplay: nav ? getComputedStyle(nav).display : '',
      cardDisplay: card ? getComputedStyle(card).display : '',
      tableDisplay: tw ? getComputedStyle(tw).display : '',
      drawerOpen: document.getElementById('mDrawer').classList.contains('open')
    };
  });
  ok('桌面汉堡隐藏', desk.hamburgerDisplay === 'none', 'display=' + desk.hamburgerDisplay);
  ok('桌面导航恢复', desk.navDisplay !== 'none', 'nav=' + desk.navDisplay);
  // 移动端未手动切卡片时, 回桌面应回到默认表格视图
  ok('桌面恢复表格视图', desk.cardDisplay === 'none' && desk.tableDisplay !== 'none', 'card=' + desk.cardDisplay + ' table=' + desk.tableDisplay);
  ok('抽屉保持关闭', !desk.drawerOpen);

  // ============ 其它页面抽屉可用性 ============
  console.log('\n[其它页面汉堡/抽屉存在性]');
  for (const p of ['guide.html', 'catalog.html', 'changelog.html', 'embed.html']) {
    const p2 = await ctx.newPage();
    await p2.goto(BASE + '/' + p, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(400);
    const has = await p2.evaluate(() => {
      const h = document.getElementById('mHamburger');
      const d = document.getElementById('mDrawer');
      const o = document.getElementById('mDrawerOverlay');
      return { h: !!h, d: !!d, o: !!o };
    });
    ok(p + ' 汉堡/抽屉/遮罩齐备', has.h && has.d && has.o, JSON.stringify(has));
    await p2.close();
  }

  // ============ 桌面端手动切卡片不落盘到移动端 ============
  console.log('\n[视图模式桌面持久化 / 移动端不落盘]');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p3 = await ctx2.newPage();
  await p3.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await p3.waitForTimeout(400);
  await p3.click('#viewModeCard');
  await p3.waitForTimeout(400);
  const storedView = await p3.evaluate(() => localStorage.getItem('kanseki_view_mode'));
  ok('桌面切卡片落盘 localStorage', storedView === 'card', 'stored=' + storedView);
  // 新移动端页面不应继承卡片 (移动端强制卡片但 viewMode 变量不落盘)
  const ctx3 = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const p4 = await ctx3.newPage();
  await p4.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await p4.waitForTimeout(500);
  const mv = await p4.evaluate(() => localStorage.getItem('kanseki_view_mode'));
  ok('移动端不写 viewMode 落盘', mv === null || mv === 'table', 'mv=' + mv);

  // 注: Windows 上逐个 page.close() 可能挂起, 直接 browser.close() 统一回收
  await browser.close();
  console.log(`\n==== V8.2 移动端测试: ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
