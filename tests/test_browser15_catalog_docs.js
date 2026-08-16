// V3.0 catalog.html 文档站三栏布局专项测试
// 验证：深色侧栏 / 右侧「在本页」目录 / 章节锚点 / scroll-spy / 旧功能回归
const { chromium } = require('playwright-core');
const CHROME = 'C:/Users/华为/.agent-browser/browsers/chrome-151.0.7922.76/chrome.exe';
const BASE = 'http://localhost:8765/catalog.html';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
  };

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);

  // ===== 1. 三栏布局 =====
  check('深色侧栏存在', await page.locator('.docs-sidebar').count() === 1);
  const sbBg = await page.evaluate(() => getComputedStyle(document.querySelector('.docs-sidebar')).backgroundColor);
  check('侧栏为深色背景', sbBg === 'rgb(16, 16, 18)', sbBg);
  check('侧栏含三项 tab', await page.locator('.docs-sidebar .tab-btn').count() === 3);
  check('右侧目录列存在', await page.locator('.docs-toc').count() === 1);
  check('细则 tab 保持三栏(非 wide)', await page.evaluate(() => {
    const l = document.querySelector('.docs-layout');
    return !l.classList.contains('wide');
  }));
  const tocTitle = await page.locator('.toc-title').textContent();
  check('右侧目录标题「在本页」', tocTitle.includes('在本页'), tocTitle);

  // ===== 2. 章节锚点 =====
  const anchors = await page.locator('.anchor-item').count();
  check('侧栏章节锚点数量 > 10', anchors > 10, 'n=' + anchors);
  const tocItems = await page.locator('.toc-item').count();
  check('右侧目录条目与侧栏一致', tocItems === anchors, 'toc=' + tocItems + ' anchor=' + anchors);
  // 2023 细则标题
  const titles2023 = await page.locator('#db .stitle').allTextContents();
  check('2023 细则大标题存在', titles2023[0].includes('全球汉籍合璧工程编目工作细则'), titles2023[0]);
  check('2023 细则含「十、著录实例」', titles2023.some(t => t.includes('十、著录实例')));

  // ===== 3. 锚点点击滚动 =====
  await page.evaluate(() => {
    const db = document.getElementById('db');
    db.scrollTop = 0;
  });
  await page.click('.anchor-item[data-sid="s15"]');
  await page.waitForTimeout(1400);
  const scrolled = await page.evaluate(() => {
    const db = document.getElementById('db');
    const el = document.getElementById('sec-s15');
    return el ? Math.round(el.getBoundingClientRect().top - db.getBoundingClientRect().top) : -999;
  });
  check('锚点 s15 点击后滚动定位', scrolled > -5 && scrolled < 90, 'offset=' + scrolled);

  // ===== 4. 2025 版切换 =====
  await page.click('.ver-btn[data-d="2025"]');
  await page.waitForTimeout(400);
  const titles2025 = await page.locator('#db .stitle').allTextContents();
  check('2025 细则标题存在(简体)', titles2025[0].includes('全球汉籍合璧工程境外汉籍编目工作细则'), titles2025[0]);
  check('2025 锚点已更新', await page.locator('.anchor-item').count() > 10);
  const tocT2025 = await page.locator('.toc-item').first().textContent();
  check('2025 右侧目录首项为一、编目范围', tocT2025.includes('一、编目范围'), tocT2025);

  // ===== 5. 全文检索回归 (2025 已转简体) =====
  await page.fill('#dsi', '附注项');
  await page.click('#dsb');
  await page.waitForTimeout(300);
  const dsc = await page.locator('#dsc').textContent();
  check('2025 全文检索「附注项」有命中', dsc !== '0/0', dsc);
  check('检索高亮 mark 存在', await page.locator('#db mark.doc-hl').count() > 0);
  await page.click('.ver-btn[data-d="2023"]');
  await page.waitForTimeout(300);
  await page.fill('#dsi', '翻刻');
  await page.click('#dsb');
  await page.waitForTimeout(300);
  const dsc2 = await page.locator('#dsc').textContent();
  check('2023 检索「翻刻」有命中', dsc2 !== '0/0', dsc2);

  // ===== 6. 分类表 tab =====
  await page.click('.tab-btn[data-tab="1"]');
  await page.waitForTimeout(400);
  check('分类表渲染', await page.locator('.ctbl').count() === 1);
  check('分类表行数 > 10', await page.locator('.ctbl tbody tr').count() > 10);
  check('侧栏切换为分类导航', await page.locator('.cfb-side').count() >= 7);
  check('右侧目录已隐藏', await page.evaluate(() => {
    const t = document.getElementById('tocCol');
    return t.classList.contains('hide');
  }));
  // V3.1: 无「在本页」时布局扩展为两列
  check('分类表 tab 布局扩展 wide', await page.evaluate(() => {
    const l = document.querySelector('.docs-layout');
    return l.classList.contains('wide') && getComputedStyle(l).gridTemplateColumns.split(' ').length === 2;
  }));
  const catMain = await page.evaluate(() => {
    const m = document.querySelector('.docs-main');
    return m ? Math.round(m.getBoundingClientRect().width) : -1;
  });
  check('分类表内容区更宽 (>900)', catMain > 900, 'w=' + catMain);
  // 分类筛选 (V5.1 起简体)
  await page.click('.cfb-side[data-f="经部"]');
  await page.waitForTimeout(300);
  const l1rows = await page.locator('.ctbl .r-l1').allTextContents();
  check('经部筛选生效', l1rows.length === 1 && l1rows[0].includes('经部'), JSON.stringify(l1rows));

  // ===== 7. PDF tab =====
  await page.click('.tab-btn[data-tab="2"]');
  await page.waitForTimeout(500);
  check('PDF tab 布局扩展 wide', await page.evaluate(() => {
    const l = document.querySelector('.docs-layout');
    return l.classList.contains('wide');
  }));
  const pdfMain = await page.evaluate(() => {
    const m = document.querySelector('.docs-main');
    return m ? Math.round(m.getBoundingClientRect().width) : -1;
  });
  check('PDF 内容区更宽 (>900)', pdfMain > 900, 'w=' + pdfMain);
  // V3.1: 工作手册题头已删副标题
  const pdfSub = await page.locator('.pdf-sub').count();
  check('工作手册副标题已删除', pdfSub === 0, 'count=' + pdfSub);
  check('iframe 存在', await page.locator('.pdf-frame').count() === 1);
  const src = await page.locator('.pdf-frame').getAttribute('src');
  check('iframe src 正确', src === 'docs/manual.pdf', src);
  check('新窗口链接存在', await page.locator('.pdf-open[href="docs/manual.pdf"]').count() > 0);
  const box = await page.locator('.pdf-frame').boundingBox();
  check('iframe 有实际高度', box && box.height > 400, box ? 'h=' + Math.round(box.height) : 'null');
  check('PDF 请求 200 + 魔数', await page.evaluate(async () => {
    const r = await fetch('docs/manual.pdf');
    if (!r.ok) return false;
    const b = await r.arrayBuffer();
    const head = new Uint8Array(b.slice(0, 5));
    return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2D;
  }));
  check('侧栏显示手册信息卡', await page.locator('.side-card .cr').count() >= 3);
  check('侧栏「切換主題」按钮存在', await page.locator('.side-footer .sb-ghost').count() === 1);

  // ===== 8. 主题切换 =====
  await page.click('#themeToggleSide');
  await page.waitForTimeout(200);
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('侧栏主题按钮可切暗色', theme === 'dark', theme);
  await page.click('#themeToggleSide');
  await page.waitForTimeout(200);

  // ===== 9. 返回导航 =====
  check('侧栏「返回紀年查詢」链接', await page.locator('.side-btn.sb-primary[href="index.html"]').count() === 1);
  check('header 导航含「说明文档」下拉', await page.locator('.header-nav .nav-dropdown-btn').count() === 1 && await page.locator('.user-dropdown').count() === 1);

  // ===== 10. JS 错误 =====
  check('无 JS 错误', errs.length === 0, errs.join(' | '));

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
