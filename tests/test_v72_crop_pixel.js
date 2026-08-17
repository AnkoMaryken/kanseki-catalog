// V7.2 像素级验证: 裁剪所见即所得
// 生成 400x400 四象限测试图:
//   左上红(255,0,0) 右上绿(0,255,0) 左下蓝(0,0,255) 右下黄(255,255,0)
//   中心 80x80 区域为白色(255,255,255) 特征块, 用于验证中心对齐
// 裁剪后输出头像中心像素应接近白色(中心特征), 而非红/绿/蓝/黄
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

// 在 Node 里生成测试 PNG (400x400 四象限 + 中心白块)
const W = 400, H = 400;
function makeTestPng() {
  // 用 zlib 手写最小 PNG (RGBA 无压缩)
  const zlib = require('zlib');
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (W * 4 + 1) + 1 + x * 4;
      const cx = x - W / 2, cy = y - H / 2;
      const inCenter = Math.abs(cx) <= 40 && Math.abs(cy) <= 40;
      let r, g, b;
      if (inCenter) { r = 255; g = 255; b = 255; }
      else if (x < W / 2 && y < H / 2) { r = 255; g = 0; b = 0; }
      else if (x >= W / 2 && y < H / 2) { r = 0; g = 255; b = 0; }
      else if (x < W / 2 && y >= H / 2) { r = 0; g = 0; b = 255; }
      else { r = 255; g = 255; b = 0; }
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  }
  // CRC32
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return png;
}

const TMP_IMG = path.join(__dirname, '_tmp_quad_test.png');
fs.writeFileSync(TMP_IMG, makeTestPng());

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
  page.on('pageerror', e => console.log('  [页面JS错误]', e.message));

  // 登录
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(() => {
    localStorage.setItem('kanseki_user', JSON.stringify({ email: 'quad@example.com', id: 'u9', name: '象限测试' }));
  });
  await page.goto(`${BASE}/profile.html`);
  await page.waitForSelector('#avatarPreview');

  // 上传 → 裁剪弹窗
  await page.setInputFiles('#avatarFileInput', TMP_IMG);
  await page.waitForSelector('#cropOverlay.show');
  ok('裁剪弹窗显示', true);

  // 检查裁剪圈中心像素 (应为中心白块)
  const centerPx = await page.evaluate(() => {
    const stage = document.getElementById('cropStage');
    const img = document.getElementById('cropImg');
    const rect = stage.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    // stage 中心 (屏幕坐标)
    const sx = rect.x + rect.width / 2;
    const sy = rect.y + rect.height / 2;
    // 图片内容在 stage 中心处的原始坐标
    const imgW = img.naturalWidth, imgH = img.naturalHeight;
    const relX = (sx - imgRect.x) / imgRect.width;
    const relY = (sy - imgRect.y) / imgRect.height;
    const srcX = Math.round(relX * imgW);
    const srcY = Math.round(relY * imgH);
    return { srcX, srcY, imgW, imgH, rect: { x: rect.x, y: rect.y, w: rect.width } };
  });
  ok('裁剪圈中心对应图片中心区域 (x=160~240)', centerPx.srcX > 140 && centerPx.srcX < 260 && centerPx.srcY > 140 && centerPx.srcY < 260,
    `srcX=${centerPx.srcX} srcY=${centerPx.srcY}`);

  // 确认裁剪
  await page.click('#cropConfirmBtn');
  await page.waitForTimeout(500);

  // 读取输出头像, 检查中心像素
  const avData = await page.evaluate(() => {
    const av = window.UserState.getAvatarData();
    if (!av || !av.data) return null;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const c = cv.getContext('2d');
        c.drawImage(img, 0, 0);
        const mid = Math.floor(img.naturalWidth / 2);
        const px = c.getImageData(mid, mid, 1, 1).data;
        resolve({ w: img.naturalWidth, h: img.naturalHeight, center: [px[0], px[1], px[2], px[3]] });
      };
      img.onerror = () => resolve(null);
      img.src = av.data;
    });
  });
  ok('输出头像为 256x256', avData && avData.w === 256 && avData.h === 256, avData ? `${avData.w}x${avData.h}` : 'null');
  ok('头像中心为白色(中心白块, 非四象限色)', avData && avData.center[0] > 200 && avData.center[1] > 200 && avData.center[2] > 200,
    avData ? `rgb(${avData.center[0]},${avData.center[1]},${avData.center[2]})` : 'null');
  // 头像边缘应为非白 (四象限色) — 验证圆形裁剪有效
  const edgePx = await page.evaluate(() => {
    const av = window.UserState.getAvatarData();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const c = cv.getContext('2d');
        c.drawImage(img, 0, 0);
        const px = c.getImageData(8, 8, 1, 1).data; // 左上角 (圆外, 应为透明)
        resolve([px[0], px[1], px[2], px[3]]);
      };
      img.onerror = () => resolve(null);
      img.src = av.data;
    });
  });
  ok('头像圆角外为透明(圆形裁剪生效)', edgePx && edgePx[3] === 0, edgePx ? `rgba(${edgePx.join(',')})` : 'null');

  console.log('\n[拖动后重新裁剪] 中心应跟随到新位置');
  // 再传一次图, 拖到左上 (显示红色区域), 输出中心应为红
  await page.setInputFiles('#avatarFileInput', TMP_IMG);
  await page.waitForSelector('#cropOverlay.show');
  await page.waitForTimeout(300);
  const box = await page.$eval('#cropStage', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; });
  // 从中心拖到左上角 (把白色中心块移出圆圈, 露出红色象限)
  await page.mouse.move(box.x + box.w / 2, box.y + box.w / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2 - 120, box.y + box.w / 2 - 120, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await page.click('#cropConfirmBtn');
  await page.waitForTimeout(500);
  const avData2 = await page.evaluate(() => {
    const av = window.UserState.getAvatarData();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const c = cv.getContext('2d');
        c.drawImage(img, 0, 0);
        const mid = Math.floor(img.naturalWidth / 2);
        const px = c.getImageData(mid, mid, 1, 1).data;
        resolve([px[0], px[1], px[2], px[3]]);
      };
      img.onerror = () => resolve(null);
      img.src = av.data;
    });
  });
  // 图片向左上移120px后, 圆圈中心应落在原图右下象限 (黄色 r>200,g>200,b<100)
  // (拖动方向: 图片左移 → 看到的区域是原图的右下)
  ok('拖动后中心为黄色(跟随显示)', avData2 && avData2[0] > 180 && avData2[1] > 180 && avData2[2] < 100,
    avData2 ? `rgb(${avData2.join(',')})` : 'null');

  console.log('\n[放大2倍后拖动] 中心应跟随到新位置 (缩放+拖动组合)');
  // 再传一次图: 放大 2 倍后向左上拖 → 圆圈中心看到原图右下 (黄色)
  await page.setInputFiles('#avatarFileInput', TMP_IMG);
  await page.waitForSelector('#cropOverlay.show');
  await page.waitForTimeout(400);
  await page.$eval('#cropZoom', el => { el.value = 2; el.dispatchEvent(new Event('input')); });
  await page.waitForTimeout(150);
  const box2 = await page.$eval('#cropStage', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; });
  await page.mouse.move(box2.x + box2.w / 2, box2.y + box2.w / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.w / 2 - 200, box2.y + box2.w / 2 - 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await page.click('#cropConfirmBtn');
  await page.waitForTimeout(500);
  const avData3 = await page.evaluate(() => {
    const av = window.UserState.getAvatarData();
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const c = cv.getContext('2d');
        c.drawImage(img, 0, 0);
        const mid = Math.floor(img.naturalWidth / 2);
        const px = c.getImageData(mid, mid, 1, 1).data;
        resolve([px[0], px[1], px[2], px[3]]);
      };
      img.onerror = () => resolve(null);
      img.src = av.data;
    });
  });
  // 放大2倍后向左上拖 200px: 圆圈中心仍落在原图右下象限 (黄色)
  ok('放大2倍+拖动后中心为黄色(缩放拖动跟随)', avData3 && avData3[0] > 180 && avData3[1] > 180 && avData3[2] < 100,
    avData3 ? `rgb(${avData3.join(',')})` : 'null');

  await browser.close();
  fs.unlinkSync(TMP_IMG);
  console.log(`\n==== V7.2 裁剪像素级验证: ${passed} 通过, ${failed} 失败 ====`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error('ERROR:', e.message); try { fs.unlinkSync(TMP_IMG); } catch (_) {} process.exit(1); });
