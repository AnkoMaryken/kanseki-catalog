// ============================================
// V8.9 专项测试: 一键简繁切换 (网页版侧接口 + 偏好持久化)
// --------------------------------------------
// 覆盖:
//   1. window.KansekiLang 接口导出 (供桌面版标题栏按钮调用)
//   2. 字形偏好持久化 kanseki_lang (切简体后刷新仍为简体)
//   3. 无记录时默认繁体 (回归 v1.1 起行为)
//   4. toggle 往返 / 非法值回退
//   5. onChange 订阅 (桌面外壳同步按钮文字用)
//   6. 页内下拉「简/繁」按钮仍可用且同样落盘
// 依赖 http://localhost:8765 静态服务
// ============================================
const { chromium } = require('playwright-core');

const CHROME_PATH = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const URL = 'http://localhost:8765/index.html';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  // ===== 1. 接口导出 =====
  const api = await page.evaluate(() => {
    const k = window.KansekiLang;
    return k ? {
      ready: k.ready === true,
      hasGet: typeof k.get === 'function',
      hasSet: typeof k.set === 'function',
      hasToggle: typeof k.toggle === 'function',
      hasOnChange: typeof k.onChange === 'function',
      key: k.KEY,
      cur: k.get(),
    } : null;
  });
  check('window.KansekiLang 已导出', !!api, JSON.stringify(api));
  check('接口 ready 标记为 true', !!(api && api.ready));
  check('get/set/toggle/onChange 齐备',
    !!(api && api.hasGet && api.hasSet && api.hasToggle && api.hasOnChange), JSON.stringify(api));
  check('KEY 为 kanseki_lang', !!(api && api.key === 'kanseki_lang'), api && String(api.key));

  // ===== 2. 无记录时默认繁体 (回归) =====
  await page.evaluate(() => localStorage.removeItem('kanseki_lang'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const defLang = await page.evaluate(() => window.KansekiLang.get());
  const defHead = await page.locator('#tableHead th').allTextContents().then(a => a.join('|'));
  check('无记录时默认繁体(状态)', defLang === 't', defLang);
  check('无记录时表头「中國年號」', defHead.includes('中國年號'), defHead.slice(0, 50));

  // ===== 3. set('s') 生效 + 落盘 =====
  await page.evaluate(() => window.KansekiLang.set('s'));
  await page.waitForTimeout(500);
  const afterS = await page.evaluate(() => ({
    lang: window.KansekiLang.get(),
    ls: localStorage.getItem('kanseki_lang'),
  }));
  check('set("s") 生效', afterS.lang === 's', JSON.stringify(afterS));
  check('set("s") 已写入 kanseki_lang', afterS.ls === 's', String(afterS.ls));
  const headS = await page.locator('#tableHead th').allTextContents().then(a => a.join('|'));
  check('切简体后表头「中国年号」', headS.includes('中国年号'), headS.slice(0, 50));

  // ===== 4. 刷新后保持简体 (持久化核心) =====
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const reloaded = await page.evaluate(() => window.KansekiLang.get());
  const rHead = await page.locator('#tableHead th').allTextContents().then(a => a.join('|'));
  check('刷新后仍为简体(已记住)', reloaded === 's', reloaded);
  check('刷新后表头仍为简体', rHead.includes('中国年号'), rHead.slice(0, 50));

  // ===== 5. 繁体记忆同样生效 =====
  await page.evaluate(() => window.KansekiLang.set('t'));
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const reloadedT = await page.evaluate(() => window.KansekiLang.get());
  check('切繁体后刷新仍为繁体', reloadedT === 't', reloadedT);

  // ===== 6. toggle 往返 =====
  const t1 = await page.evaluate(() => window.KansekiLang.toggle());
  await page.waitForTimeout(400);
  const t2 = await page.evaluate(() => window.KansekiLang.toggle());
  await page.waitForTimeout(400);
  check('toggle 第一次 → 简体', t1 === 's', String(t1));
  check('toggle 第二次 → 繁体', t2 === 't', String(t2));
  const lsAfterToggle = await page.evaluate(() => localStorage.getItem('kanseki_lang'));
  check('toggle 后 localStorage 同步', lsAfterToggle === 't', String(lsAfterToggle));

  // ===== 7. onChange 订阅 (含退订) =====
  const cbRes = await page.evaluate(async () => {
    const hits = [];
    const off = window.KansekiLang.onChange((l) => hits.push(l));
    window.KansekiLang.set('s');
    await new Promise(r => setTimeout(r, 250));
    window.KansekiLang.set('t');
    await new Promise(r => setTimeout(r, 250));
    off();               // 退订
    window.KansekiLang.set('s');  // 不应再被记录
    await new Promise(r => setTimeout(r, 250));
    return hits;
  });
  check('onChange 收到两次变化', JSON.stringify(cbRes) === '["s","t"]', JSON.stringify(cbRes));

  // ===== 8. 非法值回退繁体 =====
  await page.evaluate(() => window.KansekiLang.set('bogus'));
  await page.waitForTimeout(300);
  const bogus = await page.evaluate(() => window.KansekiLang.get());
  check('非法值回退为繁体', bogus === 't', bogus);

  // ===== 9. 页内下拉按钮仍可用且落盘 =====
  await page.evaluate(() => localStorage.removeItem('kanseki_lang'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.click('.user-btn svg');
  await page.waitForTimeout(250);
  await page.click('#langBtnS');
  await page.waitForTimeout(400);
  const viaBtn = await page.evaluate(() => ({
    lang: window.KansekiLang.get(),
    ls: localStorage.getItem('kanseki_lang'),
    btnSActive: document.getElementById('langBtnS').classList.contains('active'),
  }));
  check('页内「简」按钮仍可切换', viaBtn.lang === 's', JSON.stringify(viaBtn));
  check('页内切换写入 kanseki_lang', viaBtn.ls === 's', String(viaBtn.ls));
  check('页内「简」按钮高亮', viaBtn.btnSActive === true, String(viaBtn.btnSActive));

  // ===== 10. 无 JS 错误 =====
  check('0 JS 错误', errors.length === 0, errors.slice(0, 2).join(' ;; '));

  console.log('\n===== V8.9 简繁接口实测结果 =====');
  let fail = 0;
  for (const r of results) { console.log('  ' + r); if (r.startsWith('FAIL')) fail++; }
  console.log(`\n==== V8.9 简繁: ${results.length - fail} 通过, ${fail} 失败 ====`);
  await browser.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300).unref();
})();
