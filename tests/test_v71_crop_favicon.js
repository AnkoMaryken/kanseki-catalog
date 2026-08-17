// V7.1: 头像裁剪 + 全站 favicon 统一为 J
const { CHROME_PATH, PORT, playwrightCorePath } = require('./helpers/config');
const { chromium } = require(playwrightCorePath());
const fs = require('fs');
const path = require('path');

const BASE = `http://localhost:${PORT}`;
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + '  ' + extra); }
}

// 生成一张 2x2 红色测试 PNG (base64)
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4GBgYGJAQAFOwIBVtH1XQAAAABJRU5ErkJggg==',
  'base64'
);
const TMP_IMG = path.join(__dirname, '_tmp_crop_test.png');
fs.writeFileSync(TMP_IMG, TEST_PNG);

const PAGES = ['index.html', 'guide.html', 'catalog.html', 'changelog.html', 'embed.html'];

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { window.SUPABASE_DEMO = true; });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);

  console.log('\n[1] 五页 favicon 统一为「J」');
  for (const p of PAGES) {
    await page.goto(`${BASE}/${p}`);
    const href = await page.$eval('link[rel="icon"]', el => el.href);
    ok(`${p} favicon 为 J`, href.includes("'>J</text></svg>") || href.includes('%3EJ%3C') || href.includes("serif'>J<"), href.slice(0, 60));
  }

  console.log('\n[2] profile 已登录: 上传图片 → 裁剪弹窗出现');
  // 先设登录态 (profile 门禁会重定向, 须先登录再访问)
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(() => {
    localStorage.setItem('kanseki_user', JSON.stringify({ email: 'crop@example.com', id: 'u2', name: '裁剪测试' }));
  });
  await page.goto(`${BASE}/profile.html`);
  await page.waitForSelector('#avatarPreview');
  await page.setInputFiles('#avatarFileInput', TMP_IMG);
  await page.waitForSelector('#cropOverlay.show');
  ok('裁剪弹窗已显示', await page.$('#cropOverlay.show') !== null);

  console.log('\n[3] 裁剪弹窗元素与交互');
  ok('图片已加载', await page.$('#cropImg[src^="data:image"]') !== null);
  ok('缩放滑块存在', await page.$('#cropZoom') !== null);
  // 放大按钮
  await page.click('#cropZoomInBtn');
  const zoomVal1 = await page.inputValue('#cropZoom');
  ok('放大后 zoom > 1', parseFloat(zoomVal1) > 1, zoomVal1);
  // 缩小按钮
  await page.click('#cropZoomOutBtn');
  const zoomVal2 = await page.inputValue('#cropZoom');
  ok('缩小后 zoom 回落', parseFloat(zoomVal2) < parseFloat(zoomVal1), zoomVal2);

  console.log('\n[4] 拖拽移动 (模拟)');
  const stageBox = await page.$eval('#cropStage', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; });
  const before = await page.$eval('#cropImg', el => el.style.transform);
  await page.mouse.move(stageBox.x + stageBox.w / 2, stageBox.y + stageBox.w / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + stageBox.w / 2 + 20, stageBox.y + stageBox.w / 2 + 15, { steps: 3 });
  await page.mouse.up();
  const after = await page.$eval('#cropImg', el => el.style.transform);
  ok('拖拽改变图片位置', before !== after, before + ' → ' + after);

  console.log('\n[5] 确定 → 头像保存为裁剪图');
  await page.click('#cropConfirmBtn');
  await page.waitForTimeout(400);
  const av = await page.evaluate(() => window.UserState.getAvatarData());
  ok('头像为 img 类型', av && av.type === 'img' && av.data.startsWith('data:image/png'), av ? av.data.slice(0, 30) : 'null');
  ok('裁剪弹窗已关闭', await page.$('#cropOverlay.show') === null);
  const previewImg = await page.$('#avatarPreview img');
  ok('预览区显示裁剪图', previewImg !== null);

  console.log('\n[6] 恢复默认仍正常');
  await page.click('#resetAvatarBtn');
  await page.waitForTimeout(300);
  const av2 = await page.evaluate(() => window.UserState.getAvatarData());
  ok('恢复默认 avatar 为 null', av2 === null, JSON.stringify(av2));

  await browser.close();
  fs.unlinkSync(TMP_IMG);
  console.log(`\n==== V7.1 头像裁剪/favicon: ${passed} 通过, ${failed} 失败 ====`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('ERROR:', e.message); try { fs.unlinkSync(TMP_IMG); } catch (_) {} process.exit(1); });
