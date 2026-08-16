// V6.1: 验证登录/注册页 Juvenile 连点 5 次 → admin.html 管理员入口
const { CHROME_PATH, PORT, playwrightCorePath } = require('./helpers/config');
const { chromium } = require(playwrightCorePath());

const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + '  ' + extra); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);

  console.log('\n[1] 登录页连点 5 次 → admin.html');
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.brand');
  // 快速连点 5 次 brand (dispatchEvent 确保无遮挡)
  for (let i = 0; i < 5; i++) {
    await page.locator('.brand').dispatchEvent('click');
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(600);
  const url1 = page.url();
  ok('登录页连点5次跳转 admin.html', url1.includes('admin.html'), url1);

  console.log('\n[2] 注册页连点 5 次 → admin.html');
  await page.goto(`${BASE}/signup.html`);
  await page.waitForSelector('.brand');
  for (let i = 0; i < 5; i++) {
    await page.locator('.brand').dispatchEvent('click');
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(600);
  const url2 = page.url();
  ok('注册页连点5次跳转 admin.html', url2.includes('admin.html'), url2);

  console.log('\n[3] 单击 brand → 回首页 (500ms 超时)');
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.brand');
  await page.locator('.brand').dispatchEvent('click');
  await page.waitForTimeout(800); // 等 500ms 超时触发
  const url3 = page.url();
  ok('单击 brand 回首页', url3.includes('index.html'), url3);

  console.log('\n[4] 连点 3 次不触发 (未满 5)');
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('.brand');
  for (let i = 0; i < 3; i++) {
    await page.locator('.brand').dispatchEvent('click');
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(800);
  const url4 = page.url();
  ok('连点3次回首页而非 admin', url4.includes('index.html') && !url4.includes('admin'), url4);

  console.log('\n[5] changelog 无凭据泄露');
  await page.goto(`${BASE}/changelog.html`);
  const clText = await page.textContent('.cl-entry');
  ok('changelog 不含 admin123', !clText.includes('admin123'), '');
  ok('changelog 不含 演示账号', !clText.includes('演示账号'), '');

  console.log('\n[6] admin 登录页不显示演示凭据提示');
  await page.goto(`${BASE}/admin.html`);
  const gateHint = await page.textContent('#gateHint');
  ok('gateHint 不含 admin123', !gateHint.includes('admin123'), gateHint);
  ok('gateHint 不含 admin / admin', !gateHint.includes('admin / admin'), gateHint);

  await browser.close();
  console.log(`\n==== 连点入口验证: ${passed} 通过, ${failed} 失败 ====`);
  // 使用 process.exitCode 而非 process.exit(): Windows 下 playwright 子进程
  // 句柄未释放时强制 exit 可能被 shell 误判为非零, 此处让事件循环自然结束。
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
