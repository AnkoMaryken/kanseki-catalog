/* V9.3 冒烟：语法 + 新结构 + 一致判定 + 搜索框复检路径 */
const config = require('../tests/helpers/config.js');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('PASS ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('FAIL ' + n + '  ' + (d || '')); } };

(async () => {
  const pw = await import(require('url').pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.launch(config.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto('http://localhost:8765/kanseki.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 90000 }).catch(() => { });
  await page.waitForTimeout(1000);

  ok('页面加载无 JS 错误', errs.length === 0, errs.slice(0, 3).join(' | '));
  const st = await page.evaluate(() => ({
    version: (window.__ks || {}).version,
    hasLib: !!(window.KansekiAI && window.KansekiAI.search && window.KansekiAI.saveExport),
    hasPage: !!(window.KansekiAIPage && window.KansekiAIPage.recheck),
    defaultModel: window.KansekiAI ? window.KansekiAI.getConfig().model : '',
    hasSrc: !!document.getElementById('ksAiSrc'),
    hasWarnTx: !!document.getElementById('ksAiWarnTx'),
    maxTok: window.KansekiAI ? window.KansekiAI.getConfig().maxTokens : 0
  }));
  console.log('结构:', JSON.stringify(st));
  ok('共享模块含 search/saveExport', st.hasLib === true);
  ok('页面接口含 recheck', st.hasPage === true);
  ok('默认模型为现行 deepseek-flash', st.defaultModel === 'deepseek-flash', st.defaultModel);
  ok('结果区含联网查证状态行', st.hasSrc === true);
  ok('警告文案槽位存在', st.hasWarnTx === true);
  ok('maxTokens 默认已放大（不再 400）', st.maxTok >= 4000, String(st.maxTok));

  // 一致判定解析
  const parsed = await page.evaluate(() => [
    window.KansekiAIPage.parseConsistency('【一致性】一致\n分类：x'),
    window.KansekiAIPage.parseConsistency('【一致性】可能不一致\n理由：y'),
    window.KansekiAIPage.parseConsistency('【一致性】不一致'),
    window.KansekiAIPage.parseConsistency('没有格式行，但是不一致'),
    window.KansekiAIPage.parseConsistency('完全无法解析的输出')
  ]);
  ok('解析：一致/可能不一致/不一致', parsed[0] === '一致' && parsed[1] === '可能不一致' && parsed[2] === '不一致', parsed.slice(0, 3).join(','));
  ok('兜底：无格式行含「不一致」→ 不一致', parsed[3] === '不一致');
  ok('兜底：完全无法解析 → 按不一致（需提醒）', parsed[4] === '不一致');
  const red = await page.evaluate(() => [window.KansekiAIPage.isRed('一致'), window.KansekiAIPage.isRed('可能不一致'), window.KansekiAIPage.isRed('不一致')]);
  ok('只有「一致」不标红', red[0] === false && red[1] === true && red[2] === true, String(red));

  // 提示词不再限制篇幅、要求联网核对
  const msgs = await page.evaluate(() => window.KansekiAIPage.itemMessages(1, { hits: [{ title: 'T', url: 'https://e.com', snippet: 'S' }], err: '' }));
  const sys = msgs[0].content, usr = msgs[1].content;
  ok('系统提示要求先输出一致性', /【一致性】/.test(sys));
  ok('系统提示明确「不要把本表当作正确」', /不要(把|将).{0,6}(本表|用户提供).{0,12}当作|人工整理/.test(sys), sys.slice(0, 60));
  ok('系统提示不再限制篇幅', /篇幅不限|自由作答/.test(sys));
  ok('用户消息含网络查证资料', /【网络查证资料】/.test(usr) && /https:\/\/e\.com/.test(usr));
  ok('系统提示要求说明网络资料的使用', /网络资料/.test(sys));

  // 搜索框复检路径
  const qm = await page.evaluate(() => window.KansekiAIPage.queryMessages('不存在的书', [], { hits: [], err: '测试' }));
  ok('搜索框复检提示词含「本表未收录」处理', /未收录|未找到/.test(qm[1].content));
  ok('检索失败时提示词明示没有网络资料', /未能取得/.test(qm[1].content));

  // 检索词构造
  const qs = await page.evaluate(() => ({ row: window.KansekiAIPage.searchQueriesForRow(1), text: window.KansekiAIPage.searchQueriesForText('周易') }));
  ok('行检索词含书名', qs.row.length > 0 && /《/.test(qs.row[0]), JSON.stringify(qs.row));
  ok('文本检索词由输入构造', qs.text.length === 2 && qs.text[0].indexOf('周易') === 0, JSON.stringify(qs.text));

  // 网页版检索应被明确拒绝（无跨域）
  const webSearch = await page.evaluate(() => window.KansekiAI.search('周易').then(r => ({ ok: r.ok, err: r.error })));
  ok('网页版联网查证给出明确说明', webSearch.ok === false && /网页版/.test(webSearch.err), webSearch.err);

  // 单击复检（未配置 Key、无选中、搜索框空）→ 给提示
  await page.evaluate(() => { window.KansekiAI.clearKey(); document.getElementById('ksSearch').value = ''; window.KansekiAIPage.selectRow(null); });
  await page.waitForTimeout(200);
  await page.click('#ksAiBtn');
  await page.waitForTimeout(500);
  const hint = await page.evaluate(() => document.getElementById('ksAiOutBody').innerText);
  ok('无选中且搜索框为空时给出提示', /搜索框|选中/.test(hint), hint.slice(0, 50));

  ok('全程 0 JS 错误', errs.length === 0, errs.slice(0, 3).join(' | '));
  await browser.close();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  setTimeout(() => process.exit(fail ? 1 : 0), 200).unref();
})().catch(e => { console.error('ERR', e && e.stack || e); process.exit(1); });
