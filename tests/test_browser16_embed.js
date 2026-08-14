// v4.1 快速跳转页专项验证 (去侧边栏 + 等宽标签 + 自添加持久化)
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
  };

  // 0. 清理自定义标签残留
  await page.goto('http://localhost:8765/embed.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => localStorage.removeItem('quickLinksCustom'));

  // 1. 页面加载与标题
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  check('页面标题含快速跳转', (await page.title()).includes('快速跳转'), await page.title());
  check('页头 h2 快速跳转', await page.locator('.page-head h2').textContent().then(t => t.includes('快速跳转')));

  // 2. 侧边栏已移除
  check('浮动侧边栏已移除', await page.locator('.side-dock').count() === 0);

  // 3. 页头说明文字已删除
  const headHtml = await page.locator('.page-head').innerHTML();
  check('说明文字已删除', !headHtml.includes('右上角输入网址直达'), headHtml);

  // 4. 输入框 placeholder 已删除
  const ph = await page.locator('#jumpInput').getAttribute('placeholder');
  check('placeholder 已删除', ph === null, String(ph));

  // 5. 导航: 快速跳转 active
  let navLinks = await page.locator('.header-nav > a').allTextContents();
  check('导航直链 3 项', navLinks.length === 3, JSON.stringify(navLinks));
  let activeText = await page.locator('.header-nav a.active').textContent();
  check('快速跳转 active', activeText.includes('快速跳转'), activeText);

  // 6. 搜索栏右上角
  const barPos = await page.evaluate(() => {
    const r = document.getElementById('jumpBar').getBoundingClientRect();
    return { right: Math.round(innerWidth - r.right), top: Math.round(r.top) };
  });
  check('搜索栏位于右上角', barPos.right <= 40 && barPos.top >= 60 && barPos.top <= 110, JSON.stringify(barPos));

  // 7. 标签网格: 7 预置 + 1 添加按钮 = 8 卡片
  const cardCount = await page.locator('.jump-card').count();
  check('标签卡 8 张 (7 预置+添加)', cardCount === 8, 'count=' + cardCount);

  // 8. 标签长宽一致 (等宽等高)
  const dims = await page.locator('.jump-card:not(.add-card)').evaluateAll(cs => cs.map(c => {
    const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }));
  const w0 = dims[0].w, h0 = dims[0].h;
  const allEqual = dims.every(d => Math.abs(d.w - w0) <= 1 && Math.abs(d.h - h0) <= 1);
  check('标签等宽等高', allEqual && Math.abs(w0 - h0) <= 2, JSON.stringify(dims.slice(0, 3)));

  // 9. 7 个网站名称齐全
  const names = ['典津全球汉籍影像开放集成系统', '国学大全', '日本所藏中文古籍数据库', '日本国立公文书馆检索页面', '古籍觅宝', 'PaddleOCR', 'GitHub'];
  const cardTexts = await page.locator('.jump-card:not(.add-card) .jc-name').allTextContents();
  let allNames = true;
  names.forEach(n => { if (!cardTexts.some(t => t.includes(n))) allNames = false; });
  check('7 个网站名称齐全', allNames, JSON.stringify(cardTexts));

  // 10. 自定义跳转 (popup 断言)
  await page.fill('#jumpInput', 'guji99.com');
  const [popup1] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10000 }),
    page.click('#jumpGo')
  ]);
  await popup1.waitForTimeout(800);
  check('自定义跳转补 https', popup1.url() === 'https://guji99.com/', popup1.url());
  await popup1.close().catch(() => {});

  // 11. 空输入提示
  await page.fill('#jumpInput', '   ');
  await page.click('#jumpGo');
  await page.waitForTimeout(300);
  const hintShown = await page.locator('#jumpHint').evaluate(h => h.classList.contains('show'));
  check('空输入警告提示', hintShown);

  // 12. Enter 提交跳转
  await page.fill('#jumpInput', 'github.com');
  const [popup2] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10000 }),
    page.press('#jumpInput', 'Enter')
  ]);
  await popup2.waitForTimeout(800);
  check('Enter 提交跳转', popup2.url() === 'https://github.com/', popup2.url());
  await popup2.close().catch(() => {});

  // 13. 预置标签点击跳转 (popup)
  const [popup3] = await Promise.all([
    page.waitForEvent('popup', { timeout: 10000 }),
    page.click('.jump-card .jc-link[href="https://guji.cckb.cn/"]')
  ]);
  await popup3.waitForTimeout(800);
  check('预置标签点击跳转', popup3.url() === 'https://guji.cckb.cn/', popup3.url());
  await popup3.close().catch(() => {});

  // 14. 添加标签弹窗
  await page.click('.add-card');
  await page.waitForTimeout(400);
  check('添加弹窗打开', await page.locator('#addOverlay').evaluate(o => o.classList.contains('show')));
  await page.fill('#addName', '维基百科');
  await page.fill('#addUrl', 'wikipedia.org');
  await page.click('#addSave');
  await page.waitForTimeout(500);
  check('弹窗已关闭', !(await page.locator('#addOverlay').evaluate(o => o.classList.contains('show'))));
  check('新增标签卡出现', await page.locator('.jump-card .jc-name', { hasText: '维基百科' }).count() === 1);
  check('卡片数变为 9', await page.locator('.jump-card').count() === 9, 'count=' + await page.locator('.jump-card').count());
  const newHref = await page.locator('.jump-card .jc-link[href="https://wikipedia.org"]').count();
  check('新增标签 URL 正确', newHref === 1, 'href=' + newHref);

  // 15. 持久化: 刷新后自定义标签仍在
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check('刷新后自定义标签保留', await page.locator('.jump-card .jc-name', { hasText: '维基百科' }).count() === 1);

  // 16. 删除自定义标签
  const customCard = page.locator('.jump-card.custom').first();
  await customCard.hover();
  await page.waitForTimeout(300);
  await customCard.locator('.jc-del').click();
  await page.waitForTimeout(500);
  check('删除后标签消失', await page.locator('.jump-card .jc-name', { hasText: '维基百科' }).count() === 0);
  check('卡片数回到 8', await page.locator('.jump-card').count() === 8, 'count=' + await page.locator('.jump-card').count());

  // 17. 持久化: 刷新后自定义标签保持删除
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  check('刷新后删除生效', await page.locator('.jump-card .jc-name', { hasText: '维基百科' }).count() === 0);

  // 18. 主题切换
  let theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeToggle');
  let theme2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('主题切换', theme !== theme2, theme + ' -> ' + theme2);
  await page.click('#themeToggle');
  await page.screenshot({ path: '.workbuddy/v41_quickjump.png' });

  // 19. 四页导航「快速跳转」入口回归
  for (const [file, label] of [['index.html', '快速跳转'], ['catalog.html', '快速跳轉'], ['guide.html', '快速跳转'], ['changelog.html', '快速跳转']]) {
    await page.goto('http://localhost:8765/' + file, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);
    const has = await page.locator('.header-nav a[href="embed.html"]').count();
    const txt = await page.locator('.header-nav a[href="embed.html"]').textContent().catch(() => '');
    check(file + ' 导航快速跳转入口', has === 1 && txt.includes(label), 'count=' + has + ' text=' + txt);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join(';') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
