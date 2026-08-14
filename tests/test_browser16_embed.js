// v4.0 快速跳转页专项验证
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

  // 1. 页面加载与标题
  await page.goto('http://localhost:8765/embed.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(700);
  check('页面标题含快速跳转', (await page.title()).includes('快速跳转'), await page.title());
  check('页头 h2 快速跳转', await page.locator('.page-head h2').textContent().then(t => t.includes('快速跳转')));

  // 2. 导航: 4 直链 + 快速跳转 active
  let navLinks = await page.locator('.header-nav > a').allTextContents();
  check('导航直链 3 项', navLinks.length === 3, JSON.stringify(navLinks));
  check('导航含快速跳转', navLinks.some(t => t.includes('快速跳转')), JSON.stringify(navLinks));
  let activeText = await page.locator('.header-nav a.active').textContent();
  check('快速跳转 active', activeText.includes('快速跳转'), activeText);

  // 3. 右上角搜索栏 (ButtonGroup)
  check('搜索栏存在', await page.locator('#jumpInput').count() === 1 && await page.locator('#jumpGo').count() === 1);
  const barPos = await page.evaluate(() => {
    const r = document.getElementById('jumpBar').getBoundingClientRect();
    return { right: Math.round(innerWidth - r.right), top: Math.round(r.top) };
  });
  check('搜索栏位于右上角', barPos.right <= 40 && barPos.top >= 60 && barPos.top <= 110, JSON.stringify(barPos));

  // 4. 左侧浮动侧边栏 7 个预置快捷网站
  const dockPos = await page.evaluate(() => {
    const r = document.getElementById('sideDock').getBoundingClientRect();
    return { left: Math.round(r.left), w: Math.round(r.width), cy: Math.round(r.top + r.height / 2) };
  });
  check('侧边栏位于左侧浮动', dockPos.left <= 40 && Math.abs(dockPos.cy - 450) < 200, JSON.stringify(dockPos));
  const items = await page.locator('.dock-item').allTextContents();
  check('侧边栏 7 个快捷项', items.length === 7, 'count=' + items.length);
  const names = ['典津全球汉籍影像开放集成系统', '国学大全', '日本所藏中文古籍数据库', '日本国立公文书馆检索页面', '古籍觅宝', 'PaddleOCR', 'GitHub'];
  let allNames = true;
  names.forEach(n => { if (!items.some(t => t.includes(n))) allNames = false; });
  check('7 个网站名称齐全', allNames, JSON.stringify(items));

  // 5. 快捷项 URL 正确
  const hrefs = await page.locator('.dock-item').evaluateAll(as => as.map(a => a.href));
  const expectUrls = ['https://guji.cckb.cn/', 'https://www.gxdq.com/', 'https://www.kanji.zinbun.kyoto-u.ac.jp/kanseki?detail=', 'https://www.digital.archives.go.jp/', 'https://guji99.com/', 'https://aistudio.baidu.com/paddleocr', 'https://github.com/'];
  check('快捷项 URL 正确', JSON.stringify(hrefs) === JSON.stringify(expectUrls), JSON.stringify(hrefs));

  // 6. 主体卡片网格 7 张
  const cards = await page.locator('.jump-card').count();
  check('卡片网格 7 张', cards === 7, 'count=' + cards);

  // 7. 自定义跳转: 无协议域名自动补 https (popup 断言)
  await page.fill('#jumpInput', 'guji99.com');
  const [popup1] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    page.click('#jumpGo')
  ]);
  await popup1.waitForTimeout(800);
  check('自定义跳转补 https 并开新标签', popup1.url() === 'https://guji99.com/', popup1.url());
  await popup1.close().catch(() => {});

  // 8. Enter 键提交
  await page.fill('#jumpInput', 'github.com');
  const [popup2] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    page.press('#jumpInput', 'Enter')
  ]);
  await popup2.waitForTimeout(800);
  check('Enter 提交跳转', popup2.url() === 'https://github.com/', popup2.url());
  await popup2.close().catch(() => {});

  // 9. 空输入提示
  await page.fill('#jumpInput', '   ');
  await page.click('#jumpGo');
  await page.waitForTimeout(300);
  const hint = await page.locator('#jumpHint').textContent();
  const hintShown = await page.locator('#jumpHint').evaluate(h => h.classList.contains('show'));
  check('空输入警告提示', hintShown && hint.includes('请输入有效网址'), hint + ' shown=' + hintShown);

  // 10. 快捷项点击跳转 (新标签)
  const [popup3] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    page.click('.dock-item[href="https://guji.cckb.cn/"]')
  ]);
  await popup3.waitForTimeout(800);
  check('快捷项点击跳转', popup3.url() === 'https://guji.cckb.cn/', popup3.url());
  await popup3.close().catch(() => {});

  // 11. 卡片点击跳转
  const [popup4] = await Promise.all([
    page.waitForEvent('popup', { timeout: 5000 }),
    page.click('.jump-card[href="https://www.gxdq.com/"]')
  ]);
  await popup4.waitForTimeout(800);
  check('卡片点击跳转', popup4.url() === 'https://www.gxdq.com/', popup4.url());
  await popup4.close().catch(() => {});

  // 12. 侧边栏收缩/展开
  const wBefore = await page.locator('#sideDock').evaluate(d => d.getBoundingClientRect().width);
  await page.click('#dockToggle');
  await page.waitForTimeout(500);
  const wAfter = await page.locator('#sideDock').evaluate(d => d.getBoundingClientRect().width);
  check('侧边栏收缩变窄', wBefore > 200 && wAfter < 80, wBefore + ' -> ' + wAfter);
  check('收缩态 shared-border 按钮组', await page.locator('#sideDock').evaluate(d => d.classList.contains('collapsed')));
  const collapsedItemBorder = await page.locator('.dock-item').first().evaluate(a => getComputedStyle(a).borderTopWidth);
  check('收缩态有边框 (ButtonGroup 样式)', collapsedItemBorder !== '0px', collapsedItemBorder);
  // 收缩态名称隐藏
  const nameVisible = await page.locator('.dock-item .di-text').first().isVisible();
  check('收缩态隐藏名称', !nameVisible);
  await page.screenshot({ path: '.workbuddy/v40_dock_collapsed.png' });
  // 再点展开
  await page.click('#dockToggle');
  await page.waitForTimeout(500);
  const wBack = await page.locator('#sideDock').evaluate(d => d.getBoundingClientRect().width);
  check('侧边栏再展开', wBack > 200, 'w=' + wBack);
  check('展开态显示名称', await page.locator('.dock-item .di-text').first().isVisible());

  // 13. 收缩状态持久化 (localStorage)
  await page.click('#dockToggle');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const persisted = await page.locator('#sideDock').evaluate(d => d.classList.contains('collapsed'));
  check('收缩状态持久化', persisted);
  await page.click('#dockToggle');
  await page.waitForTimeout(400);

  // 14. 主题切换
  let theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeToggle');
  let theme2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('主题切换', theme !== theme2, theme + ' -> ' + theme2);
  await page.click('#themeToggle');
  await page.screenshot({ path: '.workbuddy/v40_quickjump.png' });

  // 15. 四页导航「快速跳转」入口回归
  for (const [file, label] of [['index.html', '快速跳转'], ['catalog.html', '快速跳轉'], ['guide.html', '快速跳转'], ['changelog.html', '快速跳转']]) {
    await page.goto('http://localhost:8765/' + file, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);
    const has = await page.locator('.header-nav a[href="embed.html"]').count();
    const txt = await page.locator('.header-nav a[href="embed.html"]').textContent().catch(() => '');
    check(file + ' 导航快速跳转入口', has === 1 && txt.includes(label), 'count=' + has + ' text=' + txt);
  }

  // 16. 从 index 点击「快速跳转」跳转
  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  await page.click('.header-nav a[href="embed.html"]');
  await page.waitForTimeout(800);
  check('index 点击快速跳转跳转', page.url().includes('embed.html'), page.url());

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join(';') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
