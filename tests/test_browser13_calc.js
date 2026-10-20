// v1.4：卷数计算器已按需求移除，本测试改为断言「不再存在」。
const path = require('path');
const config = require(path.resolve(__dirname, 'helpers', 'config.js'));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + ' ' + (d || '')); } };
(async () => {
  const pw = await import(require('url').pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const b = await chromium.launch(config.launchOptions);
  const p = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e && e.message || e).slice(0, 120)));
  await p.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'load' });
  await p.waitForTimeout(1500);
  const st = await p.evaluate(() => ({
    btn: document.querySelectorAll('#calcBtn').length,
    overlay: document.querySelectorAll('#calcOverlay').length,
    script: [...document.querySelectorAll('script[src]')].some((s) => /calc\.js/.test(s.src)),
    text: /卷数计算|丛书卷数/.test(document.body.innerText),
  }));
  ok('卷数计算器按钮已移除', st.btn === 0, 'count=' + st.btn);
  ok('卷数计算弹窗已移除', st.overlay === 0, 'count=' + st.overlay);
  ok('不再加载 calc.js', st.script === false);
  ok('页面无卷数计算文案', st.text === false);
  ok('无 JS 错误', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log('\n==== 卷数计算器移除检查: ' + (fail ? '失败 ' + fail : '通过 ' + pass) + ' ====');
  process.exit(fail ? 1 : 0);
})();
