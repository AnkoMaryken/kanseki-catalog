// ============================================
// V9.0 古籍类目查询 专项测试
// --------------------------------------------
// 覆盖:
//   1. 数据载入与加载态 (9.6MB, 177,107 条)
//   2. UI 一致性 (header / 导航 / 抽屉 / 主题)
//   3. 繁简显示 (默认繁体 / KansekiLang 接口 / 持久化 / 记录字段转换)
//   4. 检索四级: L1 精确子串 / L2 子序列 / L3 错字容错 / L4 单字降级
//   5. 多样查询: 空格分词 AND / 字段限定 书: 著: 类: 合: 判:
//   6. 判定三态色标 (完全相同=绿 / 可对应=黄 / 无对应=橙)
//   7. 筛选器 (部/类联动、判定、每页、分页、清空全部)
//   8. CSV 导出 (BOM + CRLF + 当前筛选全部结果 + 当前字形)
//   9. 1280×800 布局不溢出 + 暗色主题
//  10. 0 JS 错误
// 依赖 http://localhost:8765 静态服务 (仓库根)
// ============================================
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = 'C:\\Users\\华为\\.agent-browser\\browsers\\chrome-151.0.7922.76\\chrome.exe';
const BASE = 'http://localhost:8765/kanseki.html';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // 记录首屏「加载态」是否真实可见过 (逐帧观察, 直到数据就绪)
  await page.addInitScript(() => {
    window.__loaderSeenVisible = false;
    window.__loaderText = '';
    (function loop() {
      var el = document.getElementById('ksLoading');
      if (el) {
        if (!window.__loaderText) window.__loaderText = el.textContent.trim();
        if (!el.hidden && getComputedStyle(el).display !== 'none') window.__loaderSeenVisible = true;
      }
      if (!(window.__ks && window.__ks.ready)) requestAnimationFrame(loop);
    })();
  });

  const boot = () => page.waitForFunction(() => window.KANSEKI_QUERY_READY === true, null, { timeout: 120000 });
  const search = async (q) => {
    const s = await page.evaluate(() => window.__ks.seq);
    await page.fill('#ksSearch', q);
    await page.press('#ksSearch', 'Enter');
    await page.waitForFunction(s => window.__ks.seq > s, s, { timeout: 60000 });
  };
  const count = async () => {
    const t = await page.locator('#ksTotal').textContent();
    const m = t.match(/共\s*([\d,]+)\s*[条條]/);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : -1;
  };
  const cell = async (rowIdx, colIdx) =>
    (await page.locator('#ksBody tr').nth(rowIdx).locator('td').nth(colIdx).textContent()).trim();
  const colTexts = async (colIdx) =>
    page.locator('#ksBody tr').evaluateAll((trs, i) => trs.map(tr => tr.children[i].textContent.trim()), colIdx);
  const setLang = async (l) => {
    await page.evaluate(l => window.KansekiLang.set(l), l);
    await page.waitForTimeout(120);
  };
  // 取「判定」下拉中归一后等于 simplify 的选项值（数据字形容忍：无对应 / 無對應）
  const vdOptionValue = async (simp) => page.evaluate((simp) => {
    const t2s = window.KANSEKI_T2S, ph = window.KANSEKI_T2S_PHRASE;
    const ks = Object.keys(ph).sort((a, b) => b.length - a.length);
    const k2s = s => { let out = '', i = 0; while (i < s.length) { let hit = null; for (const k of ks) { if (s.startsWith(k, i)) { hit = k; break; } } if (hit) { out += ph[hit]; i += hit.length; } else { out += (t2s[s[i]] || s[i]); i++; } } return out; };
    const vals = [...document.querySelectorAll('#ksVerdict option')].map(o => o.value).filter(Boolean);
    return vals.find(v => k2s(v) === simp) || '';
  }, simp);

  await page.goto(BASE, { waitUntil: 'load', timeout: 120000 });
  await boot();

  // ================= 1. 加载与数据 =================
  const loaderText = await page.evaluate(() => window.__loaderText || '');
  check('首屏加载态文案「正在载入古籍类目数据…」', loaderText.indexOf('正在载入古籍类目数据') >= 0, loaderText.slice(0, 40));
  check('首屏加载态真实可见(逐帧观察)', await page.evaluate(() => window.__loaderSeenVisible === true));
  check('数据就绪后隐藏加载态', await page.evaluate(() => { const el = document.getElementById('ksLoading'); return el.hidden === true || getComputedStyle(el).display === 'none'; }));
  check('数据就绪后显示主界面', await page.evaluate(() => { const el = document.getElementById('ksApp'); return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0; }));
  check('KANSEKI_META.total = 177,107', (await page.evaluate(() => window.KANSEKI_META.total)) === 177107);
  check('KANSEKI_CATS = 349 条分类组合', (await page.evaluate(() => window.KANSEKI_CATS.length)) === 349);
  check('首屏统计「共 177,107 条」', (await page.locator('#ksTotal').textContent()).indexOf('177,107') >= 0, await page.locator('#ksTotal').textContent());
  check('默认每页 100 行', (await page.locator('#ksBody tr').count()) === 100);
  check('首行序号为 1', (await cell(0, 0)) === '1');
  const bootMs = await page.evaluate(() => window.__ks.bootMs);
  check('数据构建耗时 < 8000ms', bootMs < 8000, Math.round(bootMs) + 'ms');

  // ================= 2. UI 一致性 =================
  const navHrefs = await page.locator('.header-nav a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  check('顶部导航含 kanseki.html', navHrefs.indexOf('kanseki.html') >= 0, navHrefs.join(','));
  check('导航顺序符合规格 §4.2',
    JSON.stringify(navHrefs) === JSON.stringify(['guide.html', 'changelog.html', 'index.html', 'catalog.html', 'kanseki.html', 'embed.html']),
    navHrefs.join(','));
  check('本页导航项带 class="active"',
    (await page.locator('.header-nav a[href="kanseki.html"].active').count()) === 1);
  check('「编目规范」不再 active',
    (await page.locator('.header-nav a[href="catalog.html"].active').count()) === 0);
  const drawerHrefs = await page.locator('.drawer-nav a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  check('移动端抽屉含 kanseki.html 且位置在编目规范之后',
    drawerHrefs.indexOf('kanseki.html') === drawerHrefs.indexOf('catalog.html') + 1, drawerHrefs.join(','));
  check('header 结构复用 catalog.html（.app-header/.header-inner/.header-brand/.header-actions/.btn-icon）',
    (await page.locator('.app-header .header-inner .header-brand h1').count()) === 1 &&
    (await page.locator('.app-header .header-actions .btn-icon').count()) >= 1);
  check('主题脚本可用（localStorage["theme"]）',
    (await page.evaluate(() => { try { return typeof localStorage.getItem('theme') !== 'undefined'; } catch (e) { return false; } })) === true);
  await page.click('#themeToggle');
  await page.waitForTimeout(150);
  check('主题切到暗色', (await page.getAttribute('html', 'data-theme')) === 'dark');
  const badgeBgDark = await page.locator('#ksBody tr .vd').first().evaluate(el => getComputedStyle(el).backgroundColor);
  check('暗色下判定色标为低饱和近似色',
    badgeBgDark !== 'rgb(226, 239, 218)' && badgeBgDark !== 'rgb(255, 242, 204)' && badgeBgDark !== 'rgb(252, 228, 214)',
    badgeBgDark);
  await page.click('#themeToggle');
  await page.waitForTimeout(150);
  check('主题切回亮色', (await page.getAttribute('html', 'data-theme')) === 'light');

  // ================= 3. 繁简 =================
  await page.evaluate(() => localStorage.removeItem('kanseki_lang'));
  await page.reload({ waitUntil: 'load' });
  await boot();
  check('无记录时默认繁体', (await page.evaluate(() => window.KansekiLang.get())) === 't');
  const api = await page.evaluate(() => ({
    ready: window.KansekiLang.ready === true,
    get: typeof window.KansekiLang.get === 'function',
    set: typeof window.KansekiLang.set === 'function',
    toggle: typeof window.KansekiLang.toggle === 'function',
    onChange: typeof window.KansekiLang.onChange === 'function',
    key: window.KansekiLang.KEY,
  }));
  check('window.KansekiLang 接口齐备(get/set/toggle/onChange/KEY/ready)',
    api.ready && api.get && api.set && api.toggle && api.onChange && api.key === 'kanseki_lang', JSON.stringify(api));
  check('默认繁体下表头为「序號/書名」',
    (await page.locator('.ks-tbl thead').textContent()).indexOf('書名') >= 0);

  await search('唐開成');
  check('繁体查询「唐開成」= 2 条', (await count()) === 2, String(await count()));
  check('繁体显示书名含「開成石壁」', (await cell(0, 4)).indexOf('開成石壁') >= 0, await cell(0, 4));
  const seqsT = await page.locator('#ksBody tr .ks-seq').allTextContents();

  await page.click('#langBtnS');
  await page.waitForTimeout(150);
  const bookS = await cell(0, 4);
  check('切简体后书名转简体且无繁体残留', bookS.indexOf('开成石壁') >= 0 && bookS.indexOf('開') < 0, bookS);
  check('切简体写入 localStorage["kanseki_lang"]', (await page.evaluate(() => localStorage.getItem('kanseki_lang'))) === 's');
  check('切简体后「简」按钮高亮', (await page.locator('#langBtnS.active').count()) === 1);
  check('切简体后 UI 文案为简体(导出 CSV)', (await page.locator('#ksExport').textContent()).indexOf('导出') >= 0);
  check('切简体后表头为「序号/书名」',
    (await page.locator('.ks-tbl thead').textContent()).indexOf('书名') >= 0 &&
    (await page.locator('.ks-tbl thead').textContent()).indexOf('書名') < 0);

  await search('唐开成');
  check('简体查询「唐开成」= 2 条', (await count()) === 2, String(await count()));
  const seqsS = await page.locator('#ksBody tr .ks-seq').allTextContents();
  check('简体查询与繁体查询结果一致(序号集合相同)', JSON.stringify(seqsT) === JSON.stringify(seqsS), seqsT.join(',') + ' vs ' + seqsS.join(','));

  await page.reload({ waitUntil: 'load' });
  await boot();
  check('刷新后仍为简体(记住选择)', (await page.evaluate(() => window.KansekiLang.get())) === 's');
  await search('唐开成');
  check('刷新后结果字形仍为简体', (await cell(0, 4)).indexOf('开成石壁') >= 0, await cell(0, 4));

  const toggled = await page.evaluate(() => window.KansekiLang.toggle());
  await page.waitForTimeout(150);
  check('toggle() → 繁体', toggled === 't', String(toggled));
  check('切繁体后 UI 文案为繁体(導出)', (await page.locator('#ksExport').textContent()).indexOf('導出') >= 0, await page.locator('#ksExport').textContent());

  // 契约：整条记录字形统一为繁体（含合璧侧）→ 繁模式原样输出、简模式整条 k2s
  await setLang('t');
  await search('类:易類');
  const heT = await cell(0, 7);
  check('繁模式整条记录繁体(合璧类目為 經部/易類)', heT.indexOf('經部/') === 0 && heT.indexOf('易類') > 0, heT);
  await setLang('s');
  const heS = await cell(0, 7);
  check('简模式整条记录转简体(合璧类目為 经部/易类)', heS.indexOf('经部/') === 0 && heS.indexOf('易类') > 0, heS);
  await setLang('t');
  await search('判:無對應');
  const vdT = await cell(0, 8);
  check('繁模式判定列为繁体「無對應」', vdT === '無對應', vdT);
  await setLang('s');
  check('简模式判定列转简体「无对应」', (await cell(0, 8)) === '无对应', await cell(0, 8));
  await setLang('t');

  // ================= 4. 检索四级 =================
  await search('唐開成');
  check('L1 精确子串查询有结果', (await count()) === 2, String(await count()));
  check('L1 级别徽标为「精确匹配」', /精[确確]匹配/.test(await page.locator('#ksLevel').textContent()), await page.locator('#ksLevel').textContent());

  await search('周易');
  const cZhouyi = await count();
  check('「周易」命中多条', cZhouyi > 100, String(cZhouyi));

  await search('周易 正義');
  const cAnd = await count();
  check('空格分词 AND 生效(结果不多于单词查询)', cAnd > 0 && cAnd <= cZhouyi, cAnd + ' <= ' + cZhouyi);
  check('AND 首行同时含「周易」「正義」',
    (await cell(0, 4)).indexOf('周易') >= 0 && (await cell(0, 4)).indexOf('正義') >= 0, await cell(0, 4));

  await search('周易义');
  const cL2 = await count();
  check('L2 子序列(漏字「周易义」→「周易正義」)命中 ≥280', cL2 >= 280, String(cL2));
  check('L2 级别徽标为「模糊匹配」', (await page.locator('#ksLevel').textContent()).indexOf('模糊') >= 0, await page.locator('#ksLevel').textContent());

  await search('唐開成石璧');
  const cL3 = await count();
  check('L3 错字容错(璧/壁)命中 「唐開成石壁」', cL3 >= 1, String(cL3));
  check('L3 结果确为「唐開成石壁」', (await cell(0, 4)).indexOf('開成石壁') >= 0, await cell(0, 4));
  check('L3 级别徽标含「容错」', /容[错錯]/.test(await page.locator('#ksLevel').textContent()), await page.locator('#ksLevel').textContent());

  await search('石龘');
  const cL4 = await count();
  const hintText = await page.locator('#ksHint').textContent();
  check('L4 单字降级仍给出结果', cL4 > 0, String(cL4));
  check('L4 降级提示「未找到…包含其中 N 个字」',
    hintText.indexOf('未找到') >= 0 && hintText.indexOf('包含其中') >= 0, hintText);
  check('L4 提示条按铁律 6 判可见',
    await page.locator('#ksHint').evaluate(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0));
  check('L4 级别徽标含「单字/單字」', /[单單]字/.test(await page.locator('#ksLevel').textContent()), await page.locator('#ksLevel').textContent());

  // ---------- 字段限定 ----------
  await setLang('t');
  await search('书:周易');
  const cBook = await count();
  check('字段限定 书:周易 生效(≥999)', cBook >= 999, String(cBook));
  const bookCol = await colTexts(4);
  check('书: 结果书名均含「周易」', bookCol.length > 0 && bookCol.every(t => t.indexOf('周易') >= 0), bookCol[0]);
  await search('書:周易');
  check('繁体前缀 書: 与 书: 等价', (await count()) === cBook, String(await count()));

  await search('著:朱熹');
  const cAuthor = await count();
  check('字段限定 著:朱熹 生效(≥418)', cAuthor >= 418, String(cAuthor));
  const authorCol = await colTexts(5);
  check('著: 结果著者均含「朱熹」', authorCol.length > 0 && authorCol.every(t => t.indexOf('朱熹') >= 0), authorCol[0]);

  await search('类:易類');
  const cCat = await count();
  check('字段限定 类:易類 生效(≥2330)', cCat >= 2330, String(cCat));
  const leiCol = await colTexts(2);
  check('类: 结果類列均含「易類」', leiCol.length > 0 && leiCol.every(t => t.indexOf('易類') >= 0), leiCol[0]);

  await search('合:宗教');
  const cHe = await count();
  check('字段限定 合:宗教 生效(≥6651)', cHe >= 6651, String(cHe));
  const heCol = await colTexts(7);
  check('合: 结果合璧列均含「宗教」', heCol.length > 0 && heCol.every(t => t.indexOf('宗教') >= 0), heCol[0]);

  await search('判:无对应');
  const cVd = await count();
  check('字段限定 判:无对应(简体输入) = 18404', cVd === 18404, String(cVd));
  const vdCol = await page.locator('#ksBody tr .vd').allTextContents();
  check('判: 结果判定归一后均为「无对应」',
    vdCol.length > 0 && vdCol.every(t => /^[无無][对對][应應]$/.test(t.trim())), vdCol[0]);
  await search('判:無對應');
  check('字段限定 判:無對應(繁体输入) 与简体输入等价', (await count()) === 18404, String(await count()));
  check('判定色标为橙(无对应)',
    (await page.locator('#ksBody tr .vd').first().evaluate(el => getComputedStyle(el).backgroundColor)) === 'rgb(252, 228, 214)');

  // ================= 5. 判定三态色标 =================
  await search('判:完全相同');
  const bgSame = await page.locator('#ksBody tr .vd').first().evaluate(el => getComputedStyle(el).backgroundColor);
  check('完全相同 = 绿 #E2EFDA 系', bgSame === 'rgb(226, 239, 218)', bgSame);
  await search('判:可对应');
  const bgOk = await page.locator('#ksBody tr .vd').first().evaluate(el => getComputedStyle(el).backgroundColor);
  check('可对应 = 黄 #FFF2CC 系', bgOk === 'rgb(255, 242, 204)', bgOk);

  // ================= 6. 筛选器与分页 =================
  await page.click('#ksClear');
  await page.waitForFunction(() => document.getElementById('ksSearch').value === '');
  await page.waitForTimeout(200);
  check('「清空全部」恢复全库 177,107 条', (await count()) === 177107, String(await count()));
  check('「清空全部」清空输入框', (await page.inputValue('#ksSearch')) === '');

  await page.selectOption('#ksBu', '經部');
  await page.waitForTimeout(400);
  check('部筛选 經部 = 15144', (await count()) === 15144, String(await count()));
  const buCol = await colTexts(1);
  check('部筛选结果部列均为「經部」', buCol.length > 0 && buCol.every(t => t === '經部'), buCol[0]);

  const leiOpts = await page.locator('#ksLei option').evaluateAll(os => os.map(o => o.getAttribute('value')));
  check('類下拉随部联动(含易類)', leiOpts.indexOf('易類') >= 0, leiOpts.slice(0, 6).join(','));
  check('類下拉不含他部类别(无獨撰類)', leiOpts.indexOf('獨撰類') < 0);
  await page.selectOption('#ksLei', '易類');
  await page.waitForTimeout(400);
  const cCombo = await count();
  check('部+類 组合筛选有结果且被收窄', cCombo > 0 && cCombo < 15144, String(cCombo));
  const comboCells = await page.locator('#ksBody tr').evaluateAll(trs => trs.map(tr => tr.children[1].textContent.trim() + '|' + tr.children[2].textContent.trim()));
  check('组合筛选行均为 經部|易類', comboCells.length > 0 && comboCells.every(v => v === '經部|易類'), comboCells[0]);

  await page.click('#ksClear');
  await page.waitForTimeout(200);
  check('「清空全部」重置部/类/判定三个下拉',
    (await page.inputValue('#ksBu')) === '' && (await page.inputValue('#ksLei')) === '' && (await page.inputValue('#ksVerdict')) === '',
    [await page.inputValue('#ksBu'), await page.inputValue('#ksLei'), await page.inputValue('#ksVerdict')].join(','));
  check('「清空全部」在组合筛选后仍恢复全库', (await count()) === 177107, String(await count()));
  const vdNone = await vdOptionValue('无对应');
  check('判定下拉选项取自数据(存在「无对应/無對應」项)', vdNone !== '', vdNone);
  const vdAll = await page.locator('#ksVerdict option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
  check('判定下拉为三态', vdAll.length === 3, vdAll.join(','));
  await page.selectOption('#ksVerdict', vdNone);
  await page.waitForTimeout(500);
  check('判定筛选「无对应」= 18404', (await count()) === 18404, String(await count()));

  await page.selectOption('#ksVerdict', '');
  await page.waitForTimeout(400);
  await page.selectOption('#ksPerPage', '50');
  await page.waitForTimeout(200);
  check('每页 50 → 渲染 50 行', (await page.locator('#ksBody tr').count()) === 50);
  await page.selectOption('#ksPerPage', '200');
  await page.waitForTimeout(200);
  check('每页 200 → 渲染 200 行', (await page.locator('#ksBody tr').count()) === 200);
  check('只渲染当前页(全库 177,107 条, DOM 仅 200 行)', (await count()) === 177107 && (await page.locator('#ksBody tr').count()) === 200);

  check('第 1 页「上一页」禁用', await page.locator('#ksPrev').isDisabled());
  const seqBefore = await cell(0, 0);
  await page.click('#ksNext');
  await page.waitForTimeout(150);
  const seqAfter = await cell(0, 0);
  check('下一页后首行序号前移', parseInt(seqAfter, 10) > parseInt(seqBefore, 10), seqBefore + ' -> ' + seqAfter);
  await page.click('#ksPrev');
  await page.waitForTimeout(150);
  check('上一页后首行序号复位', (await cell(0, 0)) === seqBefore, seqBefore);

  // ================= 7. CSV 导出 =================
  await search('著:朱熹');
  const nExport = await count();
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#ksExport')]);
  const fn1 = dl1.suggestedFilename();
  check('CSV 文件名 = 古籍类目查询_YYYYMMDD_HHmm.csv', /^古籍类目查询_\d{8}_\d{4}\.csv$/.test(fn1), fn1);
  const raw1 = fs.readFileSync(await dl1.path());
  check('CSV 带 UTF-8 BOM', raw1[0] === 0xEF && raw1[1] === 0xBB && raw1[2] === 0xBF, raw1.slice(0, 3).toString('hex'));
  const txt1 = raw1.toString('utf8').replace(/^\uFEFF/, '');
  check('CSV 使用 CRLF 换行', txt1.indexOf('\r\n') >= 0);
  const lines1 = txt1.split('\r\n').filter(l => l.length > 0);
  check('CSV 行数 = 当前筛选总数 + 表头', lines1.length === nExport + 1, lines1.length + ' vs ' + (nExport + 1));
  const heads1 = lines1[0].split('","').map(s => s.replace(/^"|"$/g, ''));
  check('CSV 表头 10 列且为 序號…合璧備註',
    heads1.length === 10 && heads1[0] === '序號' && heads1[5] === '著者' && heads1[9] === '合璧備註', JSON.stringify(heads1));
  const cells1 = lines1[1].split('","').map(s => s.replace(/^"|"$/g, ''));
  check('CSV 数据行 10 列且与表格一致(著者含朱熹)',
    cells1.length === 10 && cells1[5].indexOf('朱熹') >= 0, JSON.stringify(cells1).slice(0, 120));
  check('CSV 導出全部筛选结果(非仅本页)', lines1.length - 1 === nExport && nExport > 200, (lines1.length - 1) + ' 行');

  await page.click('#langBtnS');
  await page.waitForTimeout(200);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#ksExport')]);
  const txt2 = fs.readFileSync(await dl2.path(), 'utf8').replace(/^\uFEFF/, '');
  const heads2 = txt2.split('\r\n')[0];
  check('简体导出表头转简体(序号/书名/分类路径)',
    heads2.indexOf('序号') >= 0 && heads2.indexOf('书名') >= 0 && heads2.indexOf('分类路径') >= 0, heads2);
  const cells2 = txt2.split('\r\n')[1].split('","').map(s => s.replace(/^"|"$/g, ''));
  check('简体导出行数与繁体导出一致', txt2.split('\r\n').filter(l => l.length > 0).length === nExport + 1);
  check('简体导出部列转简体(经部)', cells2[1] === '经部', cells2[1]);
  await setLang('t');

  // ================= 8. 空态 (L4 也无命中) =================
  await search('龘');
  check('完全无命中时结果为 0', (await count()) === 0, String(await count()));
  check('完全无命中时显示空态「未找到匹配的记录」',
    /未找到匹配的[记記][录錄]/.test(await page.locator('#ksEmpty').textContent()),
    await page.locator('#ksEmpty').textContent());
  check('完全无命中时空态可见(铁律 6)',
    await page.locator('#ksEmpty').evaluate(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0));
  check('完全无命中时降级提示条隐藏',
    await page.locator('#ksHint').evaluate(el => getComputedStyle(el).display === 'none'));
  await page.click('#ksClear');
  await page.waitForTimeout(300);

  // ================= 9. 1280×800 布局 + 暗色 =================
  await search('周易');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);
  const ovf = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    win: window.innerWidth,
  }));
  check('1280×800 无横向溢出', ovf.doc <= ovf.win + 1 && ovf.body <= ovf.win + 1, JSON.stringify(ovf));
  await page.click('#themeToggle');
  await page.waitForTimeout(200);
  const darkOk = await page.evaluate(() => {
    const el = document.querySelector('#ksBody tr .vd');
    const cs = el ? getComputedStyle(el) : null;
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      bg: cs ? cs.backgroundColor : '',
      w: document.documentElement.scrollWidth,
      win: window.innerWidth,
    };
  });
  check('暗色主题下页面正常且无溢出',
    darkOk.theme === 'dark' && darkOk.w <= darkOk.win + 1 && darkOk.bg !== 'rgb(255, 255, 255)',
    JSON.stringify(darkOk));
  await page.click('#themeToggle');
  await page.waitForTimeout(150);

  // ================= 10. JS 错误 =================
  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join(' ;; ').slice(0, 300));

  await browser.close();

  console.log('\n===== V9.0 古籍类目查询测试结果 =====');
  console.log('通过: ' + passed + ' / ' + (passed + failed));
  console.log('通过 ' + passed + ', 失败 ' + failed);
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 200).unref();
})().catch(e => {
  console.error('测试异常:', e && e.stack ? e.stack : e);
  process.exit(1);
});
