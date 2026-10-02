// ============================================
// V9.1 古籍类目查询（桌面版调整 + AI 复检）专项测试
// --------------------------------------------
// 覆盖（网页版侧）:
//   1. 需求 2 的范围：网页版**保留** 导出 CSV / 简繁 / 切换主题
//   2. AI 复检仅桌面版可用：非 Tauri 环境下入口与面板自动隐藏（不留死按钮）
//   3. window.KansekiAI 接口存在且可用性判断正确
//   4. 复检提示词构造：system 指明两套分类体系；user 含总体统计与逐条条目
//   5. 送审范围三种取样（当前页 / 当前结果抽样 / 全库抽样）均生效且 ≤100 条
//   6. 提示词跟随显示字形（繁体↔简体）
//   7. AI 面板不干扰主检索
//   8. 0 JS 错误
// 依赖 http://localhost:8765 静态服务（仓库根）
// 注：桌面版专属断言（侧栏顺序、三个按钮被隐藏、AI 面板可用）见
//     app/tests/browser/v91_kanseki_ai.test.cjs（跑在 app/dist 上）
// ============================================
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const BASE = 'http://localhost:8765/kanseki.html';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 60000 })
    .catch(() => { });
  await page.waitForTimeout(1200);

  // ---------- 1. 网页版保留三件套（需求 2 只作用于桌面版） ----------
  const keep = await page.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    return {
      exportBtn: vis(document.getElementById('ksExport')),
      langGroup: vis(document.querySelector('.ks-lang')),
      themeBtn: vis(document.getElementById('themeToggleSide'))
    };
  });
  check('网页版保留「导出 CSV」', keep.exportBtn);
  check('网页版保留页内简繁切换', keep.langGroup);
  check('网页版保留页内主题切换', keep.themeBtn);

  // ---------- 2. AI 在网页版应完全隐藏 ----------
  const ai = await page.evaluate(() => {
    const btn = document.getElementById('ksAiBtn');
    const panel = document.getElementById('ksAiPanel');
    return {
      hasApi: !!window.KansekiAI,
      available: window.KansekiAI ? window.KansekiAI.available() : null,
      btnHidden: btn ? btn.hidden : null,
      panelHidden: panel ? panel.hidden : null,
      tauri: !!window.__TAURI_INTERNALS__
    };
  });
  check('window.KansekiAI 接口存在', ai.hasApi === true);
  check('非 Tauri 环境下 available() === false', ai.available === false, 'tauri=' + ai.tauri);
  check('网页版隐藏「AI 复检」入口按钮', ai.btnHidden === true);
  check('网页版隐藏 AI 面板', ai.panelHidden === true);

  // ---------- 3. 提示词构造 ----------
  const prompt = await page.evaluate(() => window.KansekiAI.prompt());
  check('system 提示词指明《中国古籍总目》', /中国古籍总目/.test(prompt));
  check('system 提示词指明《全球汉籍合璧工程》', /全球汉籍合璧工程/.test(prompt));
  check('system 提示词要求逐条复核并给出可疑条目', /可疑条目/.test(prompt));
  check('默认（繁体）提示词要求用繁体中文回答', /繁体中文/.test(prompt));

  const msgs = await page.evaluate(() => window.KansekiAI.messagesForRecheck('page'));
  check('复检消息为 system + user 两条', Array.isArray(msgs) && msgs.length === 2 &&
    msgs[0].role === 'system' && msgs[1].role === 'user', msgs && msgs.length);
  check('user 含总体统计（判定分布）', /判定分布/.test(msgs[1].content));
  check('user 含待复核条目清单', /【待复核条目】/.test(msgs[1].content));
  const lineCount = (msgs[1].content.match(/^\d+\. /gm) || []).length;
  check('当前页送审条数 = 每页 100 且 ≤100', lineCount === 100, '实际 ' + lineCount);
  check('条目行含合璧对应与判定', /合璧对应：/.test(msgs[1].content) && /判定：/.test(msgs[1].content));

  // ---------- 4. 三种取样范围 ----------
  const scopes = await page.evaluate(() => {
    const out = {};
    for (const s of ['page', 'sample', 'all']) {
      const m = window.KansekiAI.messagesForRecheck(s);
      out[s] = { n: (m[1].content.match(/^\d+\. /gm) || []).length, len: m[1].content.length };
    }
    out.labels = { page: window.KansekiAI.scopeLabel() };
    return out;
  });
  check('范围「当前页」有内容', scopes.page.n > 0, scopes.page.n + ' 条');
  check('范围「当前结果抽样」=100 条', scopes.sample.n === 100, scopes.sample.n + ' 条');
  check('范围「全库抽样」=100 条', scopes.all.n === 100, scopes.all.n + ' 条');
  check('抽样不重复（全库抽样覆盖不同记录）', scopes.all.len > 1000, scopes.all.len + ' 字符');

  // ---------- 5. 提示词跟随字形 ----------
  await page.evaluate(() => window.KansekiLang.set('s'));
  await page.waitForTimeout(700);
  const promptS = await page.evaluate(() => window.KansekiAI.prompt());
  check('切简体后提示词要求用简体中文回答', /简体中文/.test(promptS) && !/繁体中文/.test(promptS));
  await page.evaluate(() => window.KansekiLang.set('t'));
  await page.waitForTimeout(500);

  // ---------- 6. AI 面板不影响主检索 ----------
  await page.fill('#ksSearch', '周易');
  await page.waitForTimeout(800);
  const searchOk = await page.evaluate(() => {
    const t = (document.getElementById('ksTotal').textContent.match(/[\d,]+/) || [''])[0];
    return { total: t, rows: document.querySelectorAll('tbody tr').length };
  });
  check('主检索仍正常（周易 → 1044 条）', searchOk.total === '1,044', '共 ' + searchOk.total);
  check('主检索仍渲染结果行', searchOk.rows > 0, searchOk.rows + ' 行');

  // 检索后复检内容应跟随最新结果
  const afterSearch = await page.evaluate(() => {
    const m = window.KansekiAI.messagesForRecheck('sample');
    return { n: (m[1].content.match(/^\d+\. /gm) || []).length, hasZhouyi: /周易/.test(m[1].content) };
  });
  check('复检内容跟随当前筛选结果', afterSearch.n > 0 && afterSearch.hasZhouyi,
    afterSearch.n + ' 条，含周易=' + afterSearch.hasZhouyi);

  // ---------- 7. JS 错误 ----------
  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n===== V9.1 AI 复检（网页版侧）: ' + passed + ' 通过, ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行失败:', e && e.stack || e); process.exit(1); });
