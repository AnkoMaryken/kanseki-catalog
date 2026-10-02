// ============================================
// V9.3 古籍类目查询 · AI 复检面板专项测试
// --------------------------------------------
// （前身为 test_v92_ai.js，因 V9.3 改了判定契约与接口名而重写）
// 覆盖:
//   1. 表头改名：「合璧中是否有相同类目」「是否一致」（表格 + CSV 导出表头）
//   2. 行选中 → 单击「AI 复检」→ 结果区在搜索栏下方；判定徽标与三态
//   3. 一致不标红；不一致 / 可能不一致一律标红（加粗 + 红色）
//   4. 警告条与「反馈错误结果」面板（复制报告、无邮箱时回落为复制）
//   5. 导出 Markdown（文件名、内容含一致性判定与网络查证说明）
//   6. 长按「AI 复检」→ 弹窗（整页复检 / 提问两页签、送审范围 3 项、无 API 输入）
//   7. 提示词：要求先输出一致性、不得默认本表正确、篇幅不限
//   8. 0 JS 错误
// 说明：不真实调用 DeepSeek —— 通过替换 window.KansekiAI.chat 注入固定回复。
// 依赖 http://localhost:8765 静态服务（仓库根）。
// ============================================
const config = require('./helpers/config.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

(async () => {
  const pw = await import(require('url').pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  const browser = await chromium.launch(config.launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8765/kanseki.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 90000 }).catch(() => { });
  await page.waitForTimeout(1000);

  // ---------- 1. 表头改名 ----------
  const heads = await page.evaluate(() => [...document.querySelectorAll('thead th')].map(x => x.textContent.trim()));
  check('表格表头含「合璧中是否有相同类目」', heads.includes('合璧中是否有相同類目'), heads.join('|'));
  check('表格表头含「是否一致」', heads.includes('是否一致'));
  check('旧表头已不存在', !heads.includes('合璧對應類目') && !heads.includes('合璧判定'));

  // ---------- 2. 接入桩 + 选中行 ----------
  await page.evaluate(() => {
    window.KansekiAI.setConfig({ key: 'sk-stub', model: 'deepseek-flash' });
    window.__CANNED = {
      ok: '【一致性】一致\n分类：經部／易類。\n依据：与《总目》易类正文之属一致。\n出处：本条目《中国古籍总目》經部／易類／正文之屬。',
      bad: '【一致性】不一致\n分类：应归子部／儒家类。\n依据：该书内容属儒家言行，非易类。\n出处：本条目《中国古籍总目》經部／易類／正文之屬。',
      maybe: '【一致性】可能不一致\n分类：或可归子部／儒家类。\n依据：证据不足，存在两可。\n出处：本条目《中国古籍总目》經部／易類。'
    };
    window.__pick = 'ok';
    window.__searchCalls = [];
    window.KansekiAI.chat = function () {
      const c = window.__CANNED[window.__pick];
      return Promise.resolve({ ok: true, content: c, model: 'stub', total_tokens: 9, via: 'fetch', finish_reason: 'stop' });
    };
    // 联网查证在网页版不可用，但仍记录调用以便断言
    const origSearch = window.KansekiAI.search;
    window.KansekiAI.search = function (q, n) {
      window.__searchCalls.push(q);
      return origSearch.call(window.KansekiAI, q, n);
    };
  });

  await page.click('#ksBody tr:nth-child(3)');
  await page.waitForTimeout(200);
  const sel = await page.evaluate(() => ({ sel: window.KansekiAIPage.selected(), cls: document.querySelectorAll('#ksBody tr.sel').length }));
  check('点击行即选中（高亮 1 行）', sel.cls === 1 && sel.sel !== null, 'sel=' + sel.sel);

  // ---------- 3. 一致：不标红 ----------
  await page.evaluate(() => { window.__pick = 'ok'; });
  await page.click('#ksAiBtn');
  await page.waitForTimeout(900);
  const keep = await page.evaluate(() => ({
    outHidden: document.getElementById('ksAiOut').hidden,
    verdict: document.getElementById('ksAiVerdict').innerText.trim(),
    body: document.getElementById('ksAiOutBody').innerText,
    warn: document.getElementById('ksAiWarn').hidden,
    red: !!document.querySelector('#ksAiOutBody .ks-overturn'),
    srcShown: !document.getElementById('ksAiSrc').hidden,
    // 用页面自带的 k2s 归一化，断言可用简体、不受界面字形影响
    srcText: window.KansekiAIPage.k2s(document.getElementById('ksAiSrc').innerText)
  }));
  check('结果区在搜索栏下方展开', keep.outHidden === false);
  check('判定徽标显示「一致」', /^一致$/.test(keep.verdict), keep.verdict);
  check('正文含分类与依据', /分类/.test(keep.body) && /依据/.test(keep.body));
  check('「一致」时不标红', keep.red === false && keep.warn === true);
  check('显示联网查证状态行（网页版明示不可用）', keep.srcShown === true, keep.srcText.slice(0, 40));
  check('联网状态说明含「未能联网查证」', /未能联网查证|网页版/.test(keep.srcText), keep.srcText.slice(0, 50));
  const searchCalls = await page.evaluate(() => window.__searchCalls.slice());
  check('复检时确实发起了检索（构造了检索词）', searchCalls.length >= 1, JSON.stringify(searchCalls));

  // ---------- 4. 不一致 / 可能不一致：标红 ----------
  for (const [pick, label] of [['bad', '不一致'], ['maybe', '可能不一致']]) {
    await page.evaluate(p => { window.__pick = p; }, pick);
    await page.click('#ksAiBtn');
    await page.waitForTimeout(900);
    const st = await page.evaluate(() => ({
      verdict: document.getElementById('ksAiVerdict').innerText.trim(),
      red: !!document.querySelector('#ksAiOutBody .ks-overturn'),
      weight: (function () { const e = document.querySelector('#ksAiOutBody .ks-overturn'); return e ? getComputedStyle(e).fontWeight : ''; })(),
      color: (function () { const e = document.querySelector('#ksAiOutBody .ks-overturn'); return e ? getComputedStyle(e).color : ''; })(),
      warn: !document.getElementById('ksAiWarn').hidden,
      warnTx: document.getElementById('ksAiWarnTx').innerText,
      badgeRed: (function () { const e = document.querySelector('#ksAiVerdict .ks-vd'); return e ? e.className : ''; })()
    }));
    check('判定徽标显示「' + label + '」', st.verdict === label, st.verdict);
    check('「' + label + '」正文标红加粗', st.red && /bold|[7-9]00/.test(st.weight) && /rgb\(19[0-9]|255,\s*138/.test(st.color),
      st.weight + ' / ' + st.color);
    check('「' + label + '」徽标为红色样式', /overturn/.test(st.badgeRed), st.badgeRed);
    check('「' + label + '」显示警告条', st.warn === true, st.warnTx.slice(0, 30));
  }

  // ---------- 5. 反馈面板 ----------
  const fbOpen = await page.evaluate(() => { document.getElementById('ksAiReportBtn').click(); return !document.getElementById('ksAiFb').hidden; });
  check('点击「反馈错误结果」展开面板', fbOpen === true);
  const fbTx = await page.evaluate(() => window.KansekiAIPage.k2s(window.KansekiAIPage.feedbackText()));
  check('报告含复检对象/书名/本表类目/一致性判定',
    /复检对象/.test(fbTx) && /书名/.test(fbTx) && /本表合璧类目/.test(fbTx) && /一致性判定/.test(fbTx), fbTx.slice(0, 80));
  check('报告含结论「可能不一致」', /可能不一致/.test(fbTx), fbTx.slice(0, 40));

  await page.evaluate(() => {
    window.__copied = '';
    navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); };
    document.getElementById('ksAiFbCopy').click();
  });
  await page.waitForTimeout(400);
  const copied = await page.evaluate(() => window.__copied || '');
  check('「复制报告」写入剪贴板', copied.length > 100, String(copied.length) + ' 字符');
  // 未填收件邮箱时，「邮件发送」应回落为复制而不是静默失败
  const mailFallback = await page.evaluate(() => {
    window.KansekiAI.setConfig({ email: '' });
    window.__copied = '';
    document.getElementById('ksAiFbMail').click();
    return new Promise(r => setTimeout(() => r({ tip: window.KansekiAIPage.k2s(document.getElementById('ksAiFbTip').textContent), copied: window.__copied.length }), 400));
  });
  check('未填收件邮箱时回落为复制报告（并保留原因说明）',
    /收件邮箱/.test(mailFallback.tip) && /复制/.test(mailFallback.tip) && mailFallback.copied > 100,
    mailFallback.tip);

  // ---------- 6. 导出 Markdown ----------
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => document.getElementById('ksAiMd').click())
  ]);
  const name = dl.suggestedFilename();
  check('导出文件名为 .md 且含「古籍类目复检」', /古籍类目复检/.test(name) && /\.md$/.test(name), name);
  const mdPath = require('path').join(require('os').tmpdir(), name);
  await dl.saveAs(mdPath);
  const mdRaw = require('fs').readFileSync(mdPath, 'utf8');
  // 报告按当前字形（默认繁体）输出，断言前统一归一到简体
  const md = await page.evaluate(s => window.KansekiAIPage.k2s(s), mdRaw);
  check('Markdown 含一致性判定字段', /一致性判定/.test(md));
  check('Markdown 含网络查证说明', /网络查证/.test(md));
  check('Markdown 含条目信息与复检意见', /复检对象/.test(md) && /复检意见/.test(md), md.slice(0, 60));
  try { require('fs').unlinkSync(mdPath); } catch (e) { }

  // ---------- 7. 长按 → 弹窗 ----------
  const modal = await page.evaluate(async () => {
    const b = document.getElementById('ksAiBtn');
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return {
      open: !document.getElementById('ksAiModal').hidden,
      tabPage: !!document.getElementById('ksAiTabPage'),
      tabAsk: !!document.getElementById('ksAiTabAsk'),
      scopeOpts: document.querySelectorAll('#ksAiScope option').length,
      noApiInput: !document.getElementById('ksAiKey') && !document.getElementById('ksAiModel'),
      cfg: document.getElementById('ksAiCfg').textContent
    };
  });
  check('长按打开弹窗', modal.open === true);
  check('弹窗含整页复检 + 提问两页签', modal.tabPage && modal.tabAsk);
  check('送审范围 3 种取值', modal.scopeOpts === 3, String(modal.scopeOpts));
  check('弹窗内无 API 输入控件', modal.noApiInput === true);
  check('弹窗底部显示当前模型', /deepseek/.test(modal.cfg), modal.cfg);
  const tabs = await page.evaluate(() => {
    document.getElementById('ksAiTabAsk').click();
    const askOn = !document.getElementById('ksAiPaneAsk').hidden && document.getElementById('ksAiPanePage').hidden;
    document.getElementById('ksAiTabPage').click();
    return { askOn, pageOn: !document.getElementById('ksAiPanePage').hidden };
  });
  check('页签可切换', tabs.askOn && tabs.pageOn);

  // ---------- 8. 提示词契约 ----------
  const msgs = await page.evaluate(() => window.KansekiAIPage.itemMessages(1, { hits: [{ title: 'T', url: 'https://e.com', snippet: 'S' }], err: '' }));
  const sys = msgs[0].content;
  check('要求第一行输出一致性', /【一致性】/.test(sys));
  check('明确不得把本表当正确', /人工整理|不要把|不要将/.test(sys));
  check('不再限制篇幅', /篇幅不限|自由作答/.test(sys));
  check('要求说明网络资料的使用', /网络资料/.test(sys));
  check('用户消息含网络查证资料与链接', /【网络查证资料】/.test(msgs[1].content) && /https:\/\/e\.com/.test(msgs[1].content));

  const parsed = await page.evaluate(() => [
    window.KansekiAIPage.parseConsistency('【一致性】一致'), 
    window.KansekiAIPage.parseConsistency('【一致性】可能不一致'),
    window.KansekiAIPage.parseConsistency('【一致性】不一致'),
    window.KansekiAIPage.parseConsistency('乱答但提到不一致'),
    window.KansekiAIPage.parseConsistency('完全无法解析')
  ]);
  check('一致性解析：三态正确', parsed[0] === '一致' && parsed[1] === '可能不一致' && parsed[2] === '不一致', parsed.join(','));
  check('无法解析时按最需提醒的一档处理', parsed[3] === '不一致' && parsed[4] === '不一致');

  // ---------- 9. 搜索框复检（未选中时）----------
  await page.evaluate(() => {
    window.KansekiAIPage.closeModal();   // 先关掉上一步长按打开的弹窗，否则会挡住点击
    window.__searchCalls = [];
    window.KansekiAIPage.selectRow(null);
    document.getElementById('ksSearch').value = '周易';
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__pick = 'ok'; });
  await page.click('#ksAiBtn');
  await page.waitForTimeout(1200);
  const qCtx = await page.evaluate(() => window.KansekiAIPage.ctx());
  check('未选中时改为复检搜索框内容', qCtx.mode === 'query' && qCtx.query === '周易', JSON.stringify(qCtx.mode + '/' + qCtx.query));
  const qs = await page.evaluate(() => window.__searchCalls.slice());
  check('按搜索框内容构造检索词', qs.some(q => q.indexOf('周易') === 0), JSON.stringify(qs));

  // ---------- 10. 清理与错误 ----------
  await page.evaluate(() => { window.KansekiAI.clearKey(); });
  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n===== V9.3 AI 复检面板：' + passed + ' 通过, ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行失败:', e && e.stack || e); process.exit(1); });
