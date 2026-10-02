// ============================================
// V9.3.1 专项测试
// --------------------------------------------
// A. 设置页：已移除「个人中心」，只保留 同步设置 / API 管理
// B. API 管理：Token 用量可视化（累计/输入/输出/思维链/按模型/最近调用/清零）
//    —— 通过替换 window.fetch 返回假响应，走**真实 chat() 代码路径**产生用量记录
// C. 古籍类目查询：检索历史（记录、去重置顶、回填重查、单条删除、清空、持久化）
// 依赖 http://localhost:8765 静态服务（仓库根）
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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });

  // ================= A. 设置页分区 =================
  console.log('--- A. 设置页分区 ---');
  const sp = await ctx.newPage();
  const spErrs = [];
  sp.on('pageerror', e => spErrs.push('pageerror: ' + e.message));
  sp.on('console', m => { if (m.type() === 'error') spErrs.push('console: ' + m.text()); });
  await sp.goto('http://localhost:8765/settings.html', { waitUntil: 'load', timeout: 60000 });
  await sp.waitForTimeout(1200);
  const panes = await sp.evaluate(() => ({
    tabs: [...document.querySelectorAll('.set-tab')].map(b => b.textContent.trim()),
    hasProfileTab: !!document.getElementById('tab-profile'),
    hasProfilePane: !!document.getElementById('pane-profile'),
    hasProfileFrame: !!document.getElementById('profileFrame'),
    active: (document.querySelector('.set-pane.active') || {}).id || '',
    paneIds: [...document.querySelectorAll('.set-pane')].map(s => s.id)
  }));
  check('设置页只剩两个页签', panes.tabs.length === 2, panes.tabs.join('/'));
  check('页签为「同步设置 / API 管理」',
    panes.tabs.join('|') === '同步设置|API 管理', panes.tabs.join('|'));
  check('已无「个人中心」页签', panes.hasProfileTab === false);
  check('已无「个人中心」面板与内嵌页', panes.hasProfilePane === false && panes.hasProfileFrame === false);
  check('面板只剩 sync / api', panes.paneIds.join('|') === 'pane-sync|pane-api', panes.paneIds.join('|'));
  check('网页版默认进 API 管理（无同步能力）', panes.active === 'pane-api', panes.active);
  await sp.goto('http://localhost:8765/settings.html#profile', { waitUntil: 'load', timeout: 60000 });
  await sp.waitForTimeout(900);
  check('旧的 #profile 链接不再落到空面板',
    await sp.evaluate(() => (document.querySelector('.set-pane.active') || {}).id === 'pane-api'));

  // ================= B. Token 用量 =================
  console.log('--- B. Token 用量可视化 ---');
  const kp = await ctx.newPage();
  const kpErrs = [];
  kp.on('pageerror', e => kpErrs.push('pageerror: ' + e.message));
  kp.on('console', m => { if (m.type() === 'error') kpErrs.push('console: ' + m.text()); });
  await kp.goto('http://localhost:8765/kanseki.html', { waitUntil: 'load', timeout: 90000 });
  await kp.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 90000 }).catch(() => { });
  await kp.waitForTimeout(800);

  // 用假响应驱动真实 chat() 路径，产生可预期的用量
  await kp.evaluate(async () => {
    window.KansekiAI.setConfig({ key: 'sk-usage-test', model: 'deepseek-flash', maxTokens: 8000 });
    window.KansekiAI.resetUsage();
    const orig = window.fetch;
    window.fetch = function (url) {
      if (String(url).indexOf('deepseek.com') >= 0) {
        const body = JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: { content: '用量测试回复' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 120, completion_tokens: 80, total_tokens: 200,
            completion_tokens_details: { reasoning_tokens: 30 }
          }
        });
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return orig.apply(this, arguments);
    };
    window.__origFetch = orig;
    await window.KansekiAI.chat([{ role: 'user', content: 'hi' }], { maxTokens: 100 });
    await window.KansekiAI.chat([{ role: 'user', content: 'hi again' }], { maxTokens: 100 });
  });
  const u = await kp.evaluate(() => window.KansekiAI.getUsage());
  check('记录调用次数', u.calls === 2, String(u.calls));
  check('累计输入 tokens = 240', u.prompt === 240, String(u.prompt));
  check('累计输出 tokens = 160', u.completion === 160, String(u.completion));
  check('累计思维链 tokens = 60', u.reasoning === 60, String(u.reasoning));
  check('累计总量 = 400', u.total === 400, String(u.total));
  check('按模型分组统计', !!u.byModel['deepseek-flash'] && u.byModel['deepseek-flash'].calls === 2,
    JSON.stringify(u.byModel));
  check('最近调用留痕（含时间与模型）', u.recent.length === 2 && !!u.recent[0].at && u.recent[0].model === 'deepseek-flash',
    JSON.stringify(u.recent[0] || {}));

  // 设置页读取同一份数据并渲染
  await sp.goto('http://localhost:8765/settings.html#api', { waitUntil: 'load', timeout: 60000 });
  await sp.waitForTimeout(1200);
  const view = await sp.evaluate(() => ({
    total: document.getElementById('tkTotal').textContent.trim(),
    calls: document.getElementById('tkCalls').textContent.trim(),
    inTok: document.getElementById('tkIn').textContent.trim(),
    outTok: document.getElementById('tkOut').textContent.trim(),
    reason: document.getElementById('tkReason').textContent.trim(),
    segIn: document.getElementById('tkSegIn').style.width,
    segOut: document.getElementById('tkSegOut').style.width,
    models: document.getElementById('tkModels').innerText,
    recent: document.getElementById('tkRecent').innerText,
    span: document.getElementById('tkSpan').textContent.trim(),
    barVisible: (function () { const b = document.getElementById('tkBar'); return b && b.getBoundingClientRect().width > 0; })()
  }));
  check('页面显示累计 tokens = 400', view.total === '400', view.total);
  check('页面显示调用次数 = 2', view.calls === '2', view.calls);
  check('页面显示输入/输出/思维链', view.inTok === '240' && view.outTok === '160' && view.reason === '60',
    view.inTok + '/' + view.outTok + '/' + view.reason);
  // 浏览器会把 60.0% 规范化为 60%，故用数值比较
  const pIn = parseFloat(view.segIn), pOut = parseFloat(view.segOut);
  check('堆叠条按输入占比渲染（240/400 = 60%）',
    Math.abs(pIn - 60) < 0.2 && Math.abs(pOut - 40) < 0.2,
    view.segIn + ' / ' + view.segOut);
  check('堆叠条实际可见（有宽度）', view.barVisible === true);
  check('按模型分布有内容', /deepseek-flash/.test(view.models) && /400/.test(view.models), view.models.slice(0, 60));
  check('最近调用列出记录', /deepseek-flash/.test(view.recent) && /200/.test(view.recent), view.recent.slice(0, 60));
  check('显示统计起始时间', /\d{4}-\d{2}-\d{2}/.test(view.span), view.span);

  // 清零
  const cleared = await sp.evaluate(() => {
    window.confirm = () => true;
    document.getElementById('tkReset').click();
    return {
      usage: window.KansekiAI.getUsage(),
      total: document.getElementById('tkTotal').textContent.trim(),
      models: document.getElementById('tkModels').innerText
    };
  });
  check('「清零统计」把用量归零', cleared.usage.calls === 0 && cleared.usage.total === 0, JSON.stringify(cleared.usage));
  check('清零后界面同步更新', cleared.total === '0' && /还没有调用记录/.test(cleared.models), cleared.total);

  // ================= C. 检索历史 =================
  console.log('--- C. 检索历史 ---');
  await kp.evaluate(() => { window.KansekiAIPage.hist.clear(); });
  // 1) 按 Enter 记录
  await kp.fill('#ksSearch', '周易');
  await kp.press('#ksSearch', 'Enter');
  await kp.waitForTimeout(1200);
  let h = await kp.evaluate(() => window.KansekiAIPage.hist.load());
  check('按 Enter 记为一条历史', h.length === 1 && h[0] === '周易', JSON.stringify(h));
  // 2) 点「检索」记录
  await kp.fill('#ksSearch', '尚書');
  await kp.click('#ksGo');
  await kp.waitForTimeout(1200);
  h = await kp.evaluate(() => window.KansekiAIPage.hist.load());
  check('点「检索」记为历史且最新在前', h.length === 2 && h[0] === '尚書' && h[1] === '周易', JSON.stringify(h));
  // 3) 重复词去重置顶
  await kp.fill('#ksSearch', '周易');
  await kp.press('#ksSearch', 'Enter');
  await kp.waitForTimeout(1200);
  h = await kp.evaluate(() => window.KansekiAIPage.hist.load());
  check('重复检索去重并置顶', h.length === 2 && h[0] === '周易', JSON.stringify(h));
  // 4) 纯打字停顿也会记录（不按 Enter）
  await kp.fill('#ksSearch', '漢書');
  await kp.waitForTimeout(2000);
  h = await kp.evaluate(() => window.KansekiAIPage.hist.load());
  check('输入停顿后自动记录', h[0] === '漢書' && h.length === 3, JSON.stringify(h));

  // 5) 徽标与面板
  const panel = await kp.evaluate(() => {
    const n = document.getElementById('ksHistN');
    document.getElementById('ksHistBtn').click();
    return {
      badgeHidden: n.hidden, badge: n.textContent,
      open: !document.getElementById('ksHistPanel').hidden,
      items: [...document.querySelectorAll('#ksHistList .ks-hist-item')].map(b => b.textContent.trim())
    };
  });
  check('历史按钮显示条数徽标', panel.badgeHidden === false && panel.badge === '3', panel.badge);
  check('点击打开历史面板', panel.open === true);
  check('面板按最新在前列出', panel.items.join('|') === '漢書|周易|尚書', panel.items.join('|'));

  // 6) 点历史项回填并重查
  const recall = await kp.evaluate(async () => {
    const btns = [...document.querySelectorAll('#ksHistList .ks-hist-item')];
    btns[1].click();                       // 选「周易」
    await new Promise(r => setTimeout(r, 900));
    return {
      input: document.getElementById('ksSearch').value,
      total: document.getElementById('ksTotal').textContent.trim(),
      first: window.KansekiAIPage.hist.load()[0],
      panelClosed: document.getElementById('ksHistPanel').hidden
    };
  });
  check('点历史项回填搜索框', recall.input === '周易', recall.input);
  check('点历史项会重新检索', /共/.test(recall.total), recall.total);
  check('点历史项后该项置顶', recall.first === '周易', recall.first);
  check('选完后自动收起面板', recall.panelClosed === true);

  // 7) 单条删除
  const delOne = await kp.evaluate(async () => {
    document.getElementById('ksHistBtn').click();
    await new Promise(r => setTimeout(r, 200));
    const dels = [...document.querySelectorAll('#ksHistList .ks-hist-del')];
    dels[0].click();
    await new Promise(r => setTimeout(r, 300));
    return { list: window.KansekiAIPage.hist.load(), open: !document.getElementById('ksHistPanel').hidden };
  });
  check('可删除单条历史', delOne.list.length === 2 && delOne.list.indexOf('周易') === -1, JSON.stringify(delOne.list));
  check('删除后面板保持打开', delOne.open === true);

  // 8) 持久化：刷新后仍在
  await kp.evaluate(() => document.getElementById('ksHistPanel').hidden = true);
  await kp.reload({ waitUntil: 'load', timeout: 90000 });
  await kp.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 90000 }).catch(() => { });
  await kp.waitForTimeout(800);
  const persisted = await kp.evaluate(() => window.KansekiAIPage.hist.load());
  check('历史在刷新后仍保留', persisted.length === 2 && persisted.indexOf('周易') === -1, JSON.stringify(persisted));

  // 9) 清空
  const clearedH = await kp.evaluate(() => {
    window.KansekiAIPage.hist.clear();
    return { list: window.KansekiAIPage.hist.load(), badgeHidden: document.getElementById('ksHistN').hidden };
  });
  check('可一键清空历史', clearedH.list.length === 0);
  check('清空后徽标隐藏', clearedH.badgeHidden === true);

  // 10) 历史上限
  const cap = await kp.evaluate(() => {
    for (let i = 0; i < 26; i++) window.KansekiAIPage.hist.push('词' + i);
    return window.KansekiAIPage.hist.load();
  });
  check('历史上限 20 条（超出丢最旧）', cap.length === 20 && cap[0] === '词25' && cap[19] === '词6',
    cap.length + ' 首=' + cap[0] + ' 末=' + cap[19]);

  // 清理测试数据
  await kp.evaluate(() => { window.KansekiAIPage.hist.clear(); window.KansekiAI.clearKey(); window.KansekiAI.resetUsage(); });

  check('设置页 0 JS 错误', spErrs.filter(e => !/favicon|Failed to load resource/i.test(e)).length === 0,
    spErrs.slice(0, 2).join(' | '));
  check('查询页 0 JS 错误', kpErrs.filter(e => !/favicon|Failed to load resource/i.test(e)).length === 0,
    kpErrs.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n===== V9.3.1（设置分区 / Token 用量 / 检索历史）：' + passed + ' 通过, ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行失败:', e && e.stack || e); process.exit(1); });
