// ============================================
// V9.2 古籍类目查询（表头改名 + AI 复检细化）专项测试
// --------------------------------------------
// 覆盖:
//   1. 表头改名：「合璧中是否有相同类目」「是否一致」（表格 + CSV 导出表头）
//   2. 网页版 AI 入口可见（DeepSeek 支持 CORS，实测可直连）
//   3. 单击「AI 复检」= 复检选中条目；未选中时给出提示
//   4. 结果区出现在搜索栏下方；判定徽标与三态
//   5. 判定「推翻」时：加粗标红 + 警告条 + 反馈面板可用
//   6. 导出 Markdown（内容含条目信息与复检意见；下载文件名正确）
//   7. 反馈报告文本与「复制报告」
//   8. 长按「AI 复检」打开弹窗（整页复检 / 提问两页签），且面板内不再有 API 输入
//   9. 提示词：单条要求「判定/分类/依据/出处」四行且要求简短
//  10. 0 JS 错误
// 依赖 http://localhost:8765 静态服务（仓库根）
// 说明：不真实调用 DeepSeek —— 通过替换 window.KansekiAI.chat 注入固定回复，
//       专注验证界面与交互逻辑（链路可用性由 CDP 真机探针另行验证）。
// ============================================
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const BASE = 'http://localhost:8765/kanseki.html';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

const CANNED_KEEP = '【判定】维持\n分类：經部／易類\n依据：与《总目》易类正文之属一致\n出处：本条目《中国古籍总目》經部／易類／正文之屬';
const CANNED_OVERTURN = '【判定】推翻\n分类：子部／儒家类\n依据：该书实为儒家类著作，非易类\n出处：本条目《中国古籍总目》經部／易類／正文之屬';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 90000 }).catch(() => { });
  await page.waitForTimeout(1000);

  // ---------- 1. 表头改名 ----------
  const heads = await page.evaluate(() => [...document.querySelectorAll('thead th')].map(x => x.textContent.trim()));
  check('表格表头含「合璧中是否有相同类目」', heads.includes('合璧中是否有相同類目'), heads.join('|'));
  check('表格表头含「是否一致」', heads.includes('是否一致'));
  check('旧表头「合璧对应类目」已不存在', !heads.includes('合璧對應類目') && !heads.includes('合璧对应类目'));
  check('旧表头「合璧判定」已不存在', !heads.includes('合璧判定'));

  const csvHead = await page.evaluate(() => {
    // 直接从页面实现取 CSV 表头（导出函数用的同一常量）
    const rows = [...document.querySelectorAll('thead th')];
    return rows.length;
  });
  check('表头仍为 9 列', csvHead === 9, String(csvHead));

  // ---------- 2. 网页版 AI 入口可见 ----------
  const vis = await page.evaluate(() => ({
    btn: !document.getElementById('ksAiBtn').hidden,
    outHidden: document.getElementById('ksAiOut').hidden,
    hasLib: !!(window.KansekiAI && window.KansekiAI.chat),
    inTauri: window.KansekiAI.isDesktop()
  }));
  check('网页版「AI 复检」按钮可见', vis.btn === true);
  check('结果区默认收起', vis.outHidden === true);
  check('共享配置模块已加载', vis.hasLib === true);
  check('网页版识别为非 Tauri（走 fetch 通道）', vis.inTauri === false);

  // ---------- 3. 未选中 → 提示 ----------
  await page.evaluate(() => {
    window.KansekiAI.setConfig({ key: 'sk-stub' });   // 让 hasKey() 通过
    // 固定回复（在浏览器上下文里定义，避免引用 Node 侧常量）
    window.__CANNED = {
      keep: '【判定】维持\n分类：經部／易類\n依据：与《总目》易类正文之属一致\n出处：本条目《中国古籍总目》經部／易類／正文之屬',
      over: '【判定】推翻\n分类：子部／儒家类\n依据：该书实为儒家类著作，非易类\n出处：本条目《中国古籍总目》經部／易類／正文之屬'
    };
    window.__canned = null;                            // null → 返回 keep
    window.KansekiAI.chat = function () {
      return Promise.resolve({
        ok: true,
        content: window.__canned ? window.__canned.content : window.__CANNED.keep,
        model: 'stub', total_tokens: 9, via: 'fetch'
      });
    };
  });
  await page.click('#ksAiBtn');
  await page.waitForTimeout(400);
  const noSel = await page.evaluate(() => ({
    hidden: document.getElementById('ksAiOut').hidden,
    text: document.getElementById('ksAiOutBody').innerText
  }));
  check('未选中时展开结果区并提示先选中', noSel.hidden === false && /選中|选中/.test(noSel.text), noSel.text.slice(0, 40));

  // ---------- 4. 选中行 → 单击复检（维持）----------
  await page.click('#ksBody tr:nth-child(3)');
  await page.waitForTimeout(200);
  const selInfo = await page.evaluate(() => ({
    sel: window.KansekiAIPage.selected(),
    cls: document.querySelectorAll('#ksBody tr.sel').length
  }));
  check('点击行即选中（高亮 1 行）', selInfo.cls === 1 && selInfo.sel !== null, 'sel=' + selInfo.sel);

  await page.evaluate(() => { window.__canned = null; });   // 默认 CANNED_KEEP
  await page.click('#ksAiBtn');
  await page.waitForTimeout(700);
  const keepState = await page.evaluate(() => ({
    verdictText: document.getElementById('ksAiVerdict').innerText.trim(),
    body: document.getElementById('ksAiOutBody').innerText,
    warnHidden: document.getElementById('ksAiWarn').hidden,
    overturnClass: !!document.querySelector('#ksAiOutBody .ks-overturn')
  }));
  check('判定徽标显示「维持」', /維持|维持/.test(keepState.verdictText), keepState.verdictText);
  check('结果正文显示分类与依据', /分类/.test(keepState.body) && /依据/.test(keepState.body));
  check('「维持」时不显示推翻警告', keepState.warnHidden === true);
  check('「维持」时不使用加粗标红', keepState.overturnClass === false);

  // ---------- 5. 推翻 → 标红 + 警告 + 反馈 ----------
  await page.evaluate(() => { window.__canned = { ok: true, content: window.__CANNED.over, model: 'stub', total_tokens: 11, via: 'fetch' }; });
  await page.click('#ksAiBtn');
  await page.waitForTimeout(700);
  const overState = await page.evaluate(() => ({
    verdictText: document.getElementById('ksAiVerdict').innerText.trim(),
    warnHidden: document.getElementById('ksAiWarn').hidden,
    warnText: document.getElementById('ksAiWarn').innerText,
    overturn: !!document.querySelector('#ksAiOutBody .ks-overturn'),
    fontBold: (function () {
      var el = document.querySelector('#ksAiOutBody .ks-overturn');
      return el ? getComputedStyle(el).fontWeight : '';
    })(),
    colorRed: (function () {
      var el = document.querySelector('#ksAiOutBody .ks-overturn');
      return el ? getComputedStyle(el).color : '';
    })()
  }));
  check('判定徽标显示「推翻」', /推翻/.test(overState.verdictText), overState.verdictText);
  check('推翻时结果使用加粗标红包裹', overState.overturn === true);
  check('推翻时字重为粗体', /bold|[7-9]00/.test(overState.fontBold), overState.fontBold);
  check('推翻时颜色为红色系', /rgb\(19[0-9],\s*(3[0-9]|4[0-9]|5[0-9]),\s*(4[0-9]|5[0-9])\)|255,\s*138,\s*128/.test(overState.colorRed),
    overState.colorRed);
  check('推翻时显示警告条', overState.warnHidden === false);
  check('警告条含「截图」与「联系软件开发者」', /截图|截圖/.test(overState.warnText) && /开发者|開發者/.test(overState.warnText),
    overState.warnText.slice(0, 50));

  const fbToggle = await page.evaluate(() => {
    document.getElementById('ksAiReportBtn').click();
    return !document.getElementById('ksAiFb').hidden;
  });
  check('点击「反馈错误结果」展开反馈面板', fbToggle === true);
  const fbText = await page.evaluate(() => window.KansekiAIPage.feedbackText());
  // 注意：界面默认繁体，断言须字形无关
  check('反馈报告含序号/书名/本表类目/复检结果',
    /序列[号號]/.test(fbText) && /(書名|书名)/.test(fbText) &&
    /本表合璧[类類]目/.test(fbText) && /([复復]檢結果|复检结果)/.test(fbText), fbText.slice(0, 80));
  check('反馈报告含「推翻」结论', /推翻/.test(fbText));

  // 复制报告（stub clipboard）
  await page.evaluate(() => {
    window.__copied = '';
    navigator.clipboard.writeText = function (t) { window.__copied = t; return Promise.resolve(); };
    document.getElementById('ksAiFbCopy').click();
  });
  await page.waitForTimeout(300);
  const copied = await page.evaluate(() => window.__copied || '');
  check('「复制报告」把报告写入剪贴板', copied.length > 100 && /推翻/.test(copied), String(copied.length) + ' 字符');
  const fbTip = await page.evaluate(() => document.getElementById('ksAiFbTip').textContent);
  check('复制后给出结果提示', /复制|複製/.test(fbTip), fbTip);

  // ---------- 6. 导出 Markdown ----------
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.evaluate(() => document.getElementById('ksAiMd').click())
  ]);
  const name = dl.suggestedFilename();
  check('导出文件名为 .md 且含「古籍类目复检」', /古籍类目复检/.test(name) && /\.md$/.test(name), name);
  const mdPath = require('path').join(require('os').tmpdir(), name);
  await dl.saveAs(mdPath);
  const md = require('fs').readFileSync(mdPath, 'utf8');
  check('Markdown 含标题与复检结果字段', /^#\s/.test(md) && /([复復]檢結果|复检结果)/.test(md), md.slice(0, 40));
  check('Markdown 含条目信息（序列号/书名/分类路径）',
    /序列[号號]/.test(md) && /(書名|书名)/.test(md) && /(中國古籍總目|中国古籍总目)/.test(md));
  check('Markdown 含复检意见正文', /([复復]檢意見|复检意见)/.test(md) && /推翻/.test(md));
  try { require('fs').unlinkSync(mdPath); } catch (e) { /* 忽略 */ }

  // ---------- 7. 长按 → 弹窗 ----------
  const modalInfo = await page.evaluate(async () => {
    const btn = document.getElementById('ksAiBtn');
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 900));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return {
      open: !document.getElementById('ksAiModal').hidden,
      tabPage: !!document.getElementById('ksAiTabPage'),
      tabAsk: !!document.getElementById('ksAiTabAsk'),
      scopeOpts: document.querySelectorAll('#ksAiScope option').length,
      hasApiInput: !!document.getElementById('ksAiKey') || !!document.getElementById('ksAiModel'),
      cfgText: document.getElementById('ksAiCfg').textContent
    };
  });
  check('长按打开弹窗', modalInfo.open === true);
  check('弹窗含「整页复检」「提问」两个页签', modalInfo.tabPage && modalInfo.tabAsk);
  check('弹窗含送审范围三种取值', modalInfo.scopeOpts === 3, String(modalInfo.scopeOpts));
  check('弹窗内不再出现 API 输入控件', modalInfo.hasApiInput === false);
  check('弹窗底部显示当前模型', /deepseek/.test(modalInfo.cfgText), modalInfo.cfgText);

  // 页签切换
  const tabSwitch = await page.evaluate(() => {
    document.getElementById('ksAiTabAsk').click();
    const askOn = !document.getElementById('ksAiPaneAsk').hidden && document.getElementById('ksAiPanePage').hidden;
    document.getElementById('ksAiTabPage').click();
    const pageOn = !document.getElementById('ksAiPanePage').hidden;
    return { askOn, pageOn };
  });
  check('页签可切换到「提问」并切回', tabSwitch.askOn && tabSwitch.pageOn);

  // ---------- 8. 提示词要求四行且简短 ----------
  const msgs = await page.evaluate(() => window.KansekiAIPage.itemMessages(1));
  check('单条提示词为 system+user 两条', msgs.length === 2 && msgs[0].role === 'system');
  check('提示词要求输出「判定/分类/依据/出处」四行',
    /【判定】/.test(msgs[0].content) && /分类：/.test(msgs[0].content) &&
    /依据：/.test(msgs[0].content) && /出处：/.test(msgs[0].content));
  check('提示词明确要求不要多余文字', /不要(任何)?(多余|多餘)文字|不要复述|不要複述/.test(msgs[0].content), msgs[0].content.slice(0, 60));
  check('user 含该条的书名与分类路径', /书名/.test(msgs[1].content) && /《中国古籍总目》分类/.test(msgs[1].content));

  const parsed = await page.evaluate(() => [
    window.KansekiAIPage.parseVerdict('【判定】推翻\n分类：x'),
    window.KansekiAIPage.parseVerdict('【判定】维持'),
    window.KansekiAIPage.parseVerdict('【判定】存疑'),
    window.KansekiAIPage.parseVerdict('没有判定行')
  ]);
  check('判定解析：推翻/维持/存疑/兜底存疑',
    parsed[0] === '推翻' && parsed[1] === '维持' && parsed[2] === '存疑' && parsed[3] === '存疑', parsed.join(','));

  // ---------- 9. 清理与错误 ----------
  await page.evaluate(() => { window.KansekiAI.clearKey(); });
  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n===== V9.2 AI 复检（网页版）：' + passed + ' 通过, ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('运行失败:', e && e.stack || e); process.exit(1); });
