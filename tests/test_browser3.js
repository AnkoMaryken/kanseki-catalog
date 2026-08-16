// 本次需求浏览器端到端测试:
// 1. 标题/图标变更 2. 首页导航删除 3. 跳转年份按钮删除
// 4. 底部更新日志按钮 5. CSV 导出自定义 (选列+范围) 6. 标题条宽度
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const URL = 'http://localhost:8765/index.html';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const context = browser.contexts()[0];
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  // v1.1.1 起默认繁体: 本脚本是 v1.1 功能回归测试, 先切简体以沿用简体期望值
  // (字形切换行为由 test_browser4.js 专项覆盖, 第 6/7 节仍保留繁体跟随验证)
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(300);

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // ===== 1. 标题与图标 =====
  const title = await page.locator('.header-brand h1').textContent();
  check('标题改为"日本汉籍编目工具"', title === '日本汉籍编目工具', title);
  const icon = await page.locator('.header-brand .brand-icon').textContent();
  check('图标改为"汉"', icon === '汉', icon);

  // ===== 2. 首页导航删除 =====
  const navLinks = await page.locator('.header-nav .nav-link').allTextContents();
  check('导航无"首页"', !navLinks.some(t => t.includes('首页')), JSON.stringify(navLinks));
  check('导航含"纪年查询"和"编目规范"', navLinks.some(t => t.includes('纪年查询')) && navLinks.some(t => t.includes('编目规范')), JSON.stringify(navLinks));

  // ===== 3. 跳转年份按钮删除 =====
  const yearJumpCount = await page.locator('.year-jump, #yearJumpInput, #yearJumpBtn').count();
  check('跳转年份按钮已删除', yearJumpCount === 0, 'count=' + yearJumpCount);

  // ===== 4. 底部更新日志按钮 =====
  const clBtn = page.locator('.footer-changelog-btn');
  check('底部更新日志按钮存在', await clBtn.count() > 0);
  const clText = await clBtn.textContent();
  check('按钮文本为"更新日志"', clText.includes('更新日志'), clText.trim());
  const clHref = await clBtn.getAttribute('href');
  check('按钮指向 changelog.html', clHref === 'changelog.html', clHref);

  // 点击按钮跳转
  await clBtn.click();
  await page.waitForTimeout(800);
  check('跳转到 changelog.html', page.url().includes('changelog.html'), page.url());
  const clTitle = await page.locator('.page-head h2').textContent();
  check('更新日志页标题', clTitle.includes('更新日志'), clTitle);
  const clEntries = await page.locator('.cl-entry').count();
  check('更新日志有条目', clEntries >= 3, 'entries=' + clEntries);

  // ===== 5. CSV 导出自定义 =====
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);
  // 重新加载后恢复默认繁体, 再切回简体保持断言语义
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnS');
  await page.waitForTimeout(300);

  // 点击导出按钮 -> 对话框打开
  await page.click('#exportBtn');
  await page.waitForTimeout(400);
  check('导出对话框打开', await page.locator('#exportDialog.open').count() > 0);

  // 列勾选项数量 (10列)
  const colCount = await page.locator('#exportDialog .exp-col').count();
  check('导出列选项 10 个', colCount === 10, 'cols=' + colCount);

  // 默认全选
  const checkedAll = await page.locator('#exportDialog .exp-col input[type="checkbox"]:checked').count();
  check('默认全选 10 列', checkedAll === 10, 'checked=' + checkedAll);

  // 统计显示
  const countText = await page.locator('#exportDialog .exp-count').textContent();
  check('统计文本含"将导出"', countText.includes('将导出'), countText.trim());

  // 取消勾选若干列: 取消 干支/生肖/备注
  await page.locator('#exportDialog .exp-col input[data-col="ganzhi"]').uncheck();
  await page.locator('#exportDialog .exp-col input[data-col="zodiac"]').uncheck();
  await page.locator('#exportDialog .exp-col input[data-col="notes"]').uncheck();
  await page.waitForTimeout(200);
  const countText2 = await page.locator('#exportDialog .exp-count').textContent();
  check('取消后统计为 7 列', countText2.includes('× 7'), countText2.trim());

  // 选择"仅当前页"
  await page.locator('#exportDialog input[name="expRange"][value="page"]').check();
  await page.waitForTimeout(200);
  const countText3 = await page.locator('#exportDialog .exp-count').textContent();
  check('仅当前页统计 50 行', countText3.includes('50'), countText3.trim());

  // 点击确认导出 -> 触发下载
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    page.click('#exportDialogConfirm')
  ]);
  const dlPath = 'D:/WorkBuddy空间/2026-08-01-13-40-21/.workbuddy/download_test.csv';
  await download.saveAs(dlPath);
  check('导出文件下载', fs.existsSync(dlPath), dlPath);

  // 校验 CSV 内容: 只含 7 列 (不含干支/生肖/备注), 50 行数据
  if (fs.existsSync(dlPath)) {
    const csv = fs.readFileSync(dlPath, 'utf-8');
    const lines = csv.trim().split('\n');
    const header = lines[0];
    check('CSV 表头 7 列', header.split(',').length === 7, header);
    check('CSV 表头含公历年份', header.includes('公历年份'), header);
    check('CSV 表头不含干支', !header.includes('干支'), header);
    check('CSV 数据行 50', lines.length - 1 === 50, 'rows=' + (lines.length - 1));
    // 第一行数据检查 (无筛选时第一页从公元前841开始)
    const firstRow = lines[1];
    const firstCell = firstRow.split(',')[0].replace(/"/g, '');
    check('CSV 首行年份为"前841"', firstCell === '前841', firstCell);
  }

  // ===== 6. 繁体模式下导出对话框跟随字形 =====
  await page.click('.user-btn svg');
  await page.waitForTimeout(200);
  await page.click('#langBtnT');
  await page.waitForTimeout(400);
  await page.click('#exportBtn');
  await page.waitForTimeout(400);
  const modalTitle = await page.locator('#exportDialog .modal-head h3').textContent();
  check('繁体对话框标题"導出 CSV"', modalTitle.includes('導出'), modalTitle);
  const colLabelT = await page.locator('#exportDialog .exp-col').first().textContent();
  check('繁体列标签"公曆年份"', colLabelT.includes('公曆'), colLabelT.trim());
  const confirmT = await page.locator('#exportDialogConfirm').textContent();
  check('繁体确认按钮"確認導出"', confirmT.includes('確認導出'), confirmT.trim());

  // 关闭对话框
  await page.click('#exportDialogClose');
  await page.waitForTimeout(200);
  check('对话框可关闭', await page.locator('#exportDialog.open').count() === 0);

  // ===== 7. 繁体模式 footer 更新日志按钮 =====
  const clBtnT = await page.locator('.footer-changelog-btn').textContent();
  check('繁体底部按钮"更新日誌"', clBtnT.includes('更新日誌'), clBtnT.trim());

  // ===== 8. 标题条宽度对比 (index vs catalog) =====
  const indexHeaderW = await page.evaluate(() => {
    const el = document.querySelector('.header-inner');
    return el ? Math.round(el.getBoundingClientRect().width) : -1;
  });
  await page.goto('http://localhost:8765/catalog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);
  const catHeaderW = await page.evaluate(() => {
    const el = document.querySelector('.header-inner');
    return el ? Math.round(el.getBoundingClientRect().width) : -1;
  });
  check('标题条宽度一致', indexHeaderW === catHeaderW, `index=${indexHeaderW} catalog=${catHeaderW}`);

  // catalog 页无首页链接、标题正确 (V5.1 起界面统一简体)
  const catNav = await page.locator('.header-nav a').allTextContents();
  check('编目页导航无"首頁"', !catNav.some(t => t.includes('首頁')), JSON.stringify(catNav));
  const catBrand = await page.locator('.header-brand h1').textContent();
  check('编目页标题"日本汉籍编目工具"', catBrand.includes('日本汉籍编目工具'), catBrand);
  const catIcon = await page.locator('.header-brand .bi').textContent();
  check('编目页图标"汉"', catIcon === '汉', catIcon);

  // ===== 9. changelog 页导航 =====
  await page.goto('http://localhost:8765/changelog.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(500);
  const clNav = await page.locator('.header-nav a').allTextContents();
  check('日志页导航含更新日志', clNav.some(t => t.includes('更新日志')), JSON.stringify(clNav));

  // ===== 10. landing.html 已删除 =====
  const landingResp = await page.evaluate(async () => {
    try {
      const r = await fetch('landing.html');
      return r.status;
    } catch (e) { return -1; }
  });
  check('landing.html 已删除 (404)', landingResp === 404, 'status=' + landingResp);

  console.log('\n===== 本次需求浏览器实测结果 =====');
  results.forEach(r => console.log('  ' + r));

  await browser.close();
})();
