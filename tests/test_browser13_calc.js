// v2.1/v3.1 卷数计算器专项测试 (V3.1: 居中弹窗 + 计算过程预览)
const { chromium } = require('playwright-core');
const CHROME_PATH = 'C://Users//华为//.agent-browser//browsers//chrome-151.0.7922.76//chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  let pass = 0, fail = 0;
  const check = (name, cond, extra) => {
    if (cond) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra ? ' | ' + extra : '')); }
  };

  await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);

  // 1. 计算器按钮存在
  const btnCount = await page.locator('#calcBtn').count();
  check('卷数计算器按钮存在', btnCount === 1, 'count=' + btnCount);

  // 2. 点击按钮打开弹窗 (V3.1 弹窗模式)
  await page.click('#calcBtn');
  await page.waitForTimeout(400);
  let show = await page.locator('#calcOverlay.show').count();
  check('点击按钮打开弹窗', show === 1, 'show=' + show);
  // 弹窗遮罩存在
  check('弹窗遮罩存在', await page.locator('#calcOverlay').count() === 1);

  // 3. 点击数字 3 + 5 -> 8
  const press = async (keys) => {
    for (const k of keys) {
      await page.click(`#calcOverlay button[data-key="${k}"]`);
    }
    return await page.locator('#calcDisplay').textContent();
  };
  let disp = await press(['3', '+', '5', '=']);
  check('3+5=8', disp === '8', 'disp=' + disp);
  // 过程预览
  let steps = await page.locator('#calcSteps').textContent();
  check('过程预览 3＋5=8', steps.includes('3') && steps.includes('8'), steps);

  // 4. 连加 12 + 7 + 1
  await press(['C']);
  disp = await press(['1', '2', '+', '7', '+', '1', '=']);
  check('12+7+1=20', disp === '20', 'disp=' + disp);
  steps = await page.locator('#calcSteps').textContent();
  check('过程预览含最终 20', steps.includes('20'), steps);

  // 5. 减法 100 - 34 - 6
  await press(['C']);
  disp = await press(['1', '0', '0', '-', '3', '4', '-', '6', '=']);
  check('100-34-6=60', disp === '60', 'disp=' + disp);

  // 6. 退格
  await press(['C']);
  await press(['1', '2', '3']);
  disp = await page.locator('#calcDisplay').textContent();
  check('输入123显示123', disp === '123', 'disp=' + disp);
  await press(['←']);
  disp = await page.locator('#calcDisplay').textContent();
  check('退格后显示12', disp === '12', 'disp=' + disp);

  // 7. 清空
  await press(['C']);
  disp = await page.locator('#calcDisplay').textContent();
  check('清空后显示0', disp === '0', 'disp=' + disp);
  steps = await page.locator('#calcSteps').textContent();
  check('清空后过程预览为空', steps.trim() === '', steps);

  // 8. 键盘输入支持 (弹窗显示时)
  await page.keyboard.press('6');
  await page.keyboard.press('+');
  await page.keyboard.press('4');
  await page.keyboard.press('Enter');
  disp = await page.locator('#calcDisplay').textContent();
  check('键盘 6+4=10', disp === '10', 'disp=' + disp);

  // 9. 关闭按钮关闭弹窗
  await page.click('#calcClose');
  await page.waitForTimeout(300);
  show = await page.locator('#calcOverlay.show').count();
  check('关闭按钮关闭弹窗', show === 0, 'show=' + show);

  // 10. 再次打开 + Escape 关闭
  await page.click('#calcBtn');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  show = await page.locator('#calcOverlay.show').count();
  check('Escape 关闭弹窗', show === 0, 'show=' + show);

  // 11. 点击遮罩关闭
  await page.click('#calcBtn');
  await page.waitForTimeout(300);
  await page.mouse.click(20, 20);
  await page.waitForTimeout(300);
  show = await page.locator('#calcOverlay.show').count();
  check('点击遮罩关闭弹窗', show === 0, 'show=' + show);

  // 12. 与知识按钮互不干扰 (知识按钮仍可打开)
  await page.hover('#knowledgeBtn');
  await page.waitForTimeout(500);
  show = await page.locator('#knowledgePanel.show').count();
  check('知识按钮仍正常', show === 1, 'show=' + show);

  // 13. 计算器按钮不遮挡回到顶部按钮 (V3.1)
  const btnBox = await page.locator('#calcBtn').boundingBox();
  const topBtn = await page.locator('#scrollTopBtn').boundingBox();
  check('calc-btn 与 scrollTopBtn 均存在', !!btnBox && !!topBtn);
  if (btnBox && topBtn) {
    // calc-btn 在 scrollTopBtn 上方 (bottom 更小即 y 更小), 且不重叠
    const overlap = !(btnBox.y + btnBox.height <= topBtn.y || topBtn.y + topBtn.height <= btnBox.y);
    check('calc-btn 不与回顶按钮重叠', !overlap,
      `calc[y=${Math.round(btnBox.y)},h=${Math.round(btnBox.height)}] top[y=${Math.round(topBtn.y)},h=${Math.round(topBtn.height)}]`);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  console.log('JS错误:', errors.length ? errors.join('\n') : '无');
  await browser.close().catch(() => {});
  process.exit(fail > 0 ? 1 : 0);
})();
