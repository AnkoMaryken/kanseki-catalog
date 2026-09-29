// ================================================
// app/tests/browser/records_form.test.cjs — 编目占位表单
// ================================================
const { pathToFileURL } = require('url');
const config = require('../../../tests/helpers/config.js');

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.launch(config.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  await page.goto(config.resolveAppUrl('#/records'), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  // 1. 空状态
  check('空状态标题', (await page.locator('.av-empty h3').textContent()) === '編目功能開發中，敬請期待');
  check('新增按钮禁用', await page.locator('#addRecordBtn').isDisabled());

  // 2. 打开表单
  await page.click('#previewFormBtn');
  await page.waitForTimeout(300);
  check('表单弹层可见', await page.locator('#recordFormOverlay').isVisible());
  check('必填 8 字段', await page.locator('#requiredFields .av-field').count() === 8);
  check('选填 5 字段', await page.locator('#optionalFields .av-field').count() === 5);
  check('提交按钮禁用', await page.locator('#recordFormSubmit').isDisabled());

  // 3. 必填字段与模板表头对应
  const reqLabels = await page.locator('#requiredFields label').allTextContents();
  check('必填含書名', reqLabels.some(l => l.includes('書名')));
  check('必填含索書號', reqLabels.some(l => l.includes('索書號')));
  check('必填含卷數', reqLabels.some(l => l.includes('卷數')));

  // 4. 实时校验：必填字段输入后错误消失
  const titleErr = page.locator('.av-field[data-field="title"] .field-error');
  await page.fill('#rec-title', '日本国志');
  await page.waitForTimeout(200);
  check('title 错误隐藏', await titleErr.isHidden());

  // 5. 提交按钮仍禁用（占位）
  check('提交仍禁用', await page.locator('#recordFormSubmit').isDisabled());

  // 6. 关闭
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc 关闭', await page.locator('#recordFormOverlay').isHidden());

  // 7. 字段数 = 13（+seq 自动编号 = 模板 14 列）
  check('字段总数 13', await page.locator('#recordFormOverlay .av-field').count() === 13);

  check('0 JS 错误', errors.length === 0, errors.join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
