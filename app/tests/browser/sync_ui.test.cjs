// ================================================
// app/tests/browser/sync_ui.test.cjs — 同步设置 UI
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

  await page.goto(config.resolveAppUrl('#/sync'), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);

  // Mock WebDAV 网络层：浏览器调试模式无 Rust 桥，真实请求会被坚果云 CORS 拦截
  // （这是预期行为，非应用缺陷）。mock 后「0 JS 错误」断言只反映应用代码本身。
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      if (String(url).includes('dav.jianguoyun.com')) {
        window.__mockedWebdav = (window.__mockedWebdav || 0) + 1;
        return Promise.resolve(new Response('', { status: 404, statusText: 'mocked' }));
      }
      return realFetch(url, opts);
    };
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 1. 视图结构
  check('sync 视图激活', await page.locator('#view-sync.active').count() === 1);
  check('邮箱输入框', await page.locator('#syncUser').count() === 1);
  check('密码输入框掩码', await page.locator('#syncPass').getAttribute('type') === 'password');
  check('三个按钮', await page.locator('#view-sync .av-actions .av-btn').count() === 3,
    '实际 ' + await page.locator('#view-sync .av-actions .av-btn').count());

  // 2. 空凭据拦截
  await page.click('#syncTestBtn');
  await page.waitForTimeout(300);
  check('空凭据测试拦截', (await page.locator('#toast').textContent()).includes('先填写'));
  check('toast 错误类型', (await page.locator('#toast').getAttribute('class')).includes('err'));

  // 3. 保存凭据到 IndexedDB
  await page.fill('#syncUser', 'test@example.com');
  await page.fill('#syncPass', 'app-password-123');
  await page.click('#syncSaveBtn');
  await page.waitForTimeout(400);
  const meta = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('kanseki-app');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('sync_meta', 'readonly');
        const os = tx.objectStore('sync_meta');
        const u = os.get('webdav_username');
        u.onsuccess = () => {
          const p = os.get('webdav_password');
          p.onsuccess = () => resolve({
            user: u.result ? u.result.value : null,
            pass: p.result ? p.result.value : null
          });
        };
      };
      req.onerror = () => resolve({ user: null, pass: null });
    });
  });
  check('IDB 保存用户', meta.user === 'test@example.com', JSON.stringify(meta));
  check('IDB 保存密码', meta.pass === 'app-password-123');
  check('保存 toast', (await page.locator('#toast').textContent()).includes('已保存'));

  // 4. 刷新后凭据回填
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check('刷新后用户回填', (await page.locator('#syncUser').inputValue()) === 'test@example.com');
  check('刷新后密码回填', (await page.locator('#syncPass').inputValue()) === 'app-password-123');

  // 5. 状态区
  check('待同步数显示', await page.locator('#syncPending').count() === 1);
  check('状态文字存在', await page.locator('#syncState').count() === 1);
  check('WebDAV 请求已 mock', await page.evaluate(() => (window.__mockedWebdav || 0) > 0));

  check('0 JS 错误', errors.length === 0, errors.join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
