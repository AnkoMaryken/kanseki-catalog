// v3.2 网站嵌入页专项验证
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';
(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
  };

  // 1. embed 页可加载
  await page.goto('http://localhost:8765/embed.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  check('embed 页标题', (await page.title()).includes('网站嵌入'), await page.title());
  check('embed 页头部', await page.locator('.page-head h2').textContent().then(t => t.includes('网站嵌入')));

  // 2. 导航四页统一: 说明文档下拉 + 纪年查询 + 编目规范 + 嵌入(active)
  let btnText = await page.locator('.nav-dropdown-btn').textContent();
  check('embed 导航有「说明文档」', btnText.includes('说明文档'), btnText);
  let navLinks = await page.locator('.header-nav > a').allTextContents();
  check('embed 导航直链 3 项', navLinks.length === 3, JSON.stringify(navLinks));
  check('embed 导航含纪年/编目/嵌入', navLinks.some(t => t.includes('纪年查询')) && navLinks.some(t => t.includes('编目规范')) && navLinks.some(t => t.includes('嵌入')), JSON.stringify(navLinks));
  let activeText = await page.locator('.header-nav a.active').textContent();
  check('embed 页「嵌入」active', activeText.includes('嵌入'), activeText);

  // 3. 默认占位态
  check('默认占位提示', await page.locator('.embed-placeholder .ph-t').textContent().then(t => t.includes('输入网址')), await page.locator('.embed-placeholder .ph-t').textContent());
  check('iframe 初始无 src', await page.locator('#embedFrame').getAttribute('src') === null);

  // 4. 同源嵌入 (本站 guide.html 无 frame 限制)
  await page.fill('#embedInput', 'guide.html');
  await page.click('#embedGo');
  await page.waitForTimeout(1500);
  let src = await page.locator('#embedFrame').getAttribute('src');
  check('同源相对路径 src 生效', src === 'guide.html', src);
  check('iframe 已加载', await page.locator('#embedFrame').evaluate(f => f.contentDocument && f.contentDocument.body !== null));
  // iframe 高度须铺满容器 (修复 height:100% 在 flex 下失效为 150px 的问题)
  const h = await page.evaluate(() => {
    const f = document.getElementById('embedFrame');
    const s = document.querySelector('.embed-stage');
    return { fh: Math.round(f.getBoundingClientRect().height), sh: Math.round(s.getBoundingClientRect().height) };
  });
  check('iframe 高度铺满容器', h.fh > 300 && Math.abs(h.fh - h.sh) <= 2, JSON.stringify(h));
  let statusOk = await page.locator('#embedStatus').textContent();
  check('同源加载状态 ok', statusOk.includes('已加载'), statusOk);

  // 5. 快捷入口点击 (工作手册 PDF)
  await page.click('.embed-quick a[data-url="docs/manual.pdf"]');
  await page.waitForTimeout(1500);
  src = await page.locator('#embedFrame').getAttribute('src');
  check('快捷入口 PDF src', src === 'docs/manual.pdf', src);
  statusOk = await page.locator('#embedStatus').textContent();
  check('PDF 加载状态 ok', statusOk.includes('已加载'), statusOk);
  await page.screenshot({ path: '.workbuddy/v32_embed.png' });

  // 6. Enter 键提交
  await page.fill('#embedInput', 'index.html');
  await page.press('#embedInput', 'Enter');
  await page.waitForTimeout(1500);
  src = await page.locator('#embedFrame').getAttribute('src');
  check('Enter 提交生效', src === 'index.html', src);

  // 7. 空输入提示
  await page.fill('#embedInput', '   ');
  await page.click('#embedGo');
  await page.waitForTimeout(300);
  statusOk = await page.locator('#embedStatus').textContent();
  check('空输入警告', statusOk.includes('请输入有效网址'), statusOk);

  // 8. 主题切换可用 (embed 页有自己的 themeToggle)
  let theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeToggle');
  let theme2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('主题切换', theme !== theme2, theme + ' -> ' + theme2);

  // 9. 四页导航「嵌入」入口回归 (index/catalog/guide/changelog)
  for (const [file, lang] of [['index.html', '简体'], ['catalog.html', '繁体'], ['guide.html', '简体'], ['changelog.html', '简体']]) {
    await page.goto('http://localhost:8765/' + file, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);
    const has = await page.locator('.header-nav a[href="embed.html"]').count();
    check(file + ' 导航含嵌入入口(' + lang + ')', has === 1, 'count=' + has);
  }

  // 10. 从 index 点击「嵌入」跳转
  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  await page.click('.header-nav a[href="embed.html"]');
  await page.waitForTimeout(800);
  check('index 点击嵌入跳转', page.url().includes('embed.html'), page.url());

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join(';') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
