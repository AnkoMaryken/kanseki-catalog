// ================================================
// app/tests/browser/v91_kanseki_ai.test.cjs — V9.1 桌面版调整
// ---------------------------------------------------------------
// 验证（对 app/dist 的 dev server 8766）：
//   1. 侧栏顺序：「古籍类目查询」紧随「纪年查询」之下
//   2. 构建阶段注入的隐藏规则生效：页内「导出 CSV / 简繁 / 切换主题」在 APP 内不显示
//      （仓库根的网页版仍保留，见 tests/test_v91_ai.js 与 tests/test_v90_kanseki.js）
//   3. AI 复检入口在非 Tauri 环境（本测试用的普通浏览器）下自动隐藏
//      —— 真机 Tauri 下的可用性由 .workbuddy/verify_v90_desktop.cjs 的 CDP 探针验证
//   4. 注入标记与 0 JS 错误
// 须串行运行
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
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

  await page.goto(config.resolveAppUrl(), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);

  // ---------- 1. 侧栏顺序 ----------
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('.nav-item')].map(el => {
      const s = el.querySelector('span');
      return (s ? s.textContent : el.textContent).trim();
    })
  );
  const iQuery = labels.findIndex(t => /纪年查询|紀年查詢/.test(t));
  const iKan = labels.findIndex(t => /古籍类目查询|古籍類目查詢/.test(t));
  check('侧栏含「纪年查询」', iQuery >= 0, 'idx=' + iQuery);
  check('侧栏含「古籍类目查询」', iKan >= 0, 'idx=' + iKan);
  check('「古籍类目查询」紧接「纪年查询」之下（相邻）', iKan === iQuery + 1,
    `纪年@${iQuery} 古籍@${iKan}`);
  const iCatalog = labels.findIndex(t => /细则查阅|細則查閱/.test(t));
  check('「编目规范」组的三项仍在其后', iCatalog > iKan, `细则@${iCatalog}`);

  // ---------- 2. 注入样式隐藏三件套 ----------
  const distPage = path.resolve(__dirname, '..', '..', 'dist', 'pages', 'kanseki.html');
  check('dist/pages/kanseki.html 存在', fs.existsSync(distPage));
  const distHtml = fs.readFileSync(distPage, 'utf8');
  check('dist 版已注入 kanseki-app-embed 样式', distHtml.includes('kanseki-app-embed'));
  check('注入样式含 #ksExport 隐藏规则', /#ksExport\{display:none !important\}/.test(distHtml));
  check('注入样式含 .ks-lang 隐藏规则', /\.ks-lang\{display:none !important\}/.test(distHtml));
  check('注入样式含 #themeToggleSide 隐藏规则', /#themeToggleSide\{display:none !important\}/.test(distHtml));
  const rootHtml = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'kanseki.html'), 'utf8');
  check('仓库根网页版未被注入（三件套仍在）', !rootHtml.includes('kanseki-app-embed'));

  // 切到 kanseki 视图，实测计算样式
  await page.evaluate(() => { location.hash = '#/kanseki'; });
  await page.waitForTimeout(3000);
  const frame = page.frames().find(f => /kanseki\.html/.test(f.url()));
  check('取到 kanseki iframe', !!frame);
  if (frame) {
    await frame.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 40000 }).catch(() => { });
    await frame.waitForTimeout(600);
    const vis = await frame.evaluate(() => {
      const shown = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && el.getBoundingClientRect().width > 0;
      };
      return {
        exportBtn: shown('#ksExport'),
        langGroup: shown('.ks-lang'),
        themeBtn: shown('#themeToggleSide'),
        aiBtn: shown('#ksAiBtn'),
        aiPanel: document.getElementById('ksAiPanel') ? !document.getElementById('ksAiPanel').hidden : null,
        total: (document.getElementById('ksTotal') || {}).textContent || ''
      };
    });
    check('APP 内「导出 CSV」已隐藏', vis.exportBtn === false, String(vis.exportBtn));
    check('APP 内页内简繁切换已隐藏', vis.langGroup === false, String(vis.langGroup));
    check('APP 内页内主题按钮已隐藏', vis.themeBtn === false, String(vis.themeBtn));

    // ---------- 3. 非 Tauri 环境下 AI 入口隐藏 ----------
    check('非 Tauri 环境隐藏「AI 复检」入口', vis.aiBtn === false, String(vis.aiBtn));
    check('主功能不受影响（数据已载入）', /177,107|=177107|177107/.test(vis.total.replace(/,/g, '')),
      vis.total.trim());
  }

  // ---------- 4. 无 JS 错误 ----------
  const real = errors.filter(e => !/favicon/i.test(e));
  check('0 JS 错误', real.length === 0, real.slice(0, 3).join(' | '));

  await browser.close();
  const fails = results.filter(r => r.startsWith('FAIL'));
  results.forEach(r => console.log(r));
  console.log('\nTOTAL | ' + results.length + ' | FAIL ' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('运行失败:', e && e.stack || e); process.exit(1); });
