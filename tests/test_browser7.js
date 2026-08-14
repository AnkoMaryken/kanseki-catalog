// v1.4 编目细则重建专项验证：两版标题居中、引号转换、Markdown 结构渲染、全文检索回归
const { chromium } = require('playwright-core');
const path = require('path');

const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const URL = 'http://localhost:8765/catalog.html';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);

  const results = [];
  const check = (name, cond, extra = '') => results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));

  // ===== 1. 2023 版默认：大标题/次标题居中 =====
  const titles2023 = await page.locator('#db .stitle').allTextContents();
  check('2023 首标题为细则全名', titles2023[0] === '全球汉籍合璧工程编目工作细则', titles2023[0]);
  check('2023 次标题为修订稿', titles2023[1] === '（2023.09修订稿）', titles2023[1]);
  const centers = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#db .stitle')];
    return els.slice(0, 3).map(e => {
      const st = getComputedStyle(e);
      return { cls: e.className, align: st.textAlign, border: st.borderBottomWidth, fs: st.fontSize };
    });
  });
  check('2023 大标题 .center', centers[0].cls.includes('center'), JSON.stringify(centers[0]));
  check('2023 大标题居中', centers[0].align === 'center', centers[0].align);
  check('2023 次标题居中', centers[1].align === 'center', centers[1].align);
  check('2023 章节标题左对齐', centers[2].align !== 'center', centers[2].align);

  // ===== 2. 章节结构 =====
  check('2023 含十、著录实例', titles2023.includes('十、著录实例'), 'count=' + titles2023.length);
  check('2023 章节数>=19', titles2023.length >= 19, 'count=' + titles2023.length);

  // ===== 3. 引号检查：正文应含“”而非「」 =====
  const bodyText23 = await page.evaluate(() => document.getElementById('db').innerText);
  check('2023 正文含全角双引号“”', bodyText23.includes('“') && bodyText23.includes('”'));
  check('2023 正文无「', !bodyText23.includes('「'), bodyText23.includes('「') ? 'LEAK' : 'ok');
  check('2023 正文无」', !bodyText23.includes('」'));

  // ===== 4. 代码块/引用块渲染 =====
  check('2023 参考格式代码块渲染', await page.locator('#db .doc-code').count() >= 1);
  check('2023 引用块渲染', await page.locator('#db .doc-ex').count() >= 1);

  // ===== 5. 著录实例 =====
  check('2023 例一含後漢書', bodyText23.includes('後漢書九十卷志三十卷'));
  check('2023 丛例子目列表', bodyText23.includes('爾雅注疏十一卷'));

  // ===== 6. 切换到 2025 版 =====
  await page.click('.ver-btn[data-d="2025"]');
  await page.waitForTimeout(400);
  const titles2025 = await page.locator('#db .stitle').allTextContents();
  check('2025 首标题简体细则全名', titles2025[0] === '全球汉籍合璧工程境外汉籍编目工作细则', titles2025[0]);
  check('2025 次标题征求意见稿', titles2025[1] === '（2025.10修订，征求意见稿）', titles2025[1]);
  const centers2025 = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#db .stitle')];
    return els.slice(0, 2).map(e => getComputedStyle(e).textAlign);
  });
  check('2025 大标题居中', centers2025[0] === 'center', centers2025[0]);
  check('2025 次标题居中', centers2025[1] === 'center', centers2025[1]);
  const bodyText25 = await page.evaluate(() => document.getElementById('db').innerText);
  check('2025 正文含“”', bodyText25.includes('“') && bodyText25.includes('”'));
  check('2025 正文无「', !bodyText25.includes('「'));
  check('2025 正文无」', !bodyText25.includes('」'));
  check('2025 卷数子目示例', bodyText25.includes('存五卷：一至五'));
  check('2025 版本示例', bodyText25.includes('清道光七年（1827）京师西江米巷寿藤书屋刻本'));
  check('2025 附注项', bodyText25.includes('内封A面：练江汪文伯集'));
  check('2025 编目实例十三经', bodyText25.includes('十三经注疏十三种三百三十三卷'));
  check('2025 孟子注疏', bodyText25.includes('孟子注疏解经十四卷'));

  // ===== 7. 全文检索回归 (V3.1 起 2025 版为简体文档, 用简体词检索) =====
  await page.fill('#dsi', '附注项');
  await page.click('#dsb');
  await page.waitForTimeout(300);
  const hlCount = await page.locator('#db mark.doc-hl').count();
  check('检索"附注项"有高亮', hlCount >= 1, 'hl=' + hlCount);
  const navText = await page.locator('#dsc').textContent();
  check('检索计数显示', /\/\d+/.test(navText), navText);

  // 清除检索
  await page.fill('#dsi', '');
  await page.click('#dsb');
  await page.waitForTimeout(200);

  // ===== 8. 回到 2023 检索 =====
  await page.click('.ver-btn[data-d="2023"]');
  await page.waitForTimeout(300);
  await page.fill('#dsi', '翻刻');
  await page.click('#dsb');
  await page.waitForTimeout(300);
  const hl23 = await page.locator('#db mark.doc-hl').count();
  check('2023 检索"翻刻"有高亮', hl23 >= 1, 'hl=' + hl23);

  // ===== 9. 分类表 tab 回归 =====
  await page.click('.tab-btn[data-tab="1"]');
  await page.waitForTimeout(400);
  const tree = await page.locator('.ctbl').count();
  check('分类表渲染', tree >= 1);

  // ===== 10. JS 错误检查 =====
  check('无 JS 错误', errs.length === 0, errs.join(' ; '));

  console.log('\n===== v1.4 编目细则重建浏览器实测 =====');
  results.forEach(r => console.log('  ' + r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\nTOTAL:', results.length, ' PASS:', results.length - fails.length, ' FAIL:', fails.length);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
