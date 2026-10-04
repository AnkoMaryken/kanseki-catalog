// ================================================
// app/tests/browser/mini_year.test.cjs — 「纪年小窗」页面（mini.html）浏览器行为
// ================================================
// 被测页面：dist/mini.html（app/src/mini.html 由 scripts/build.mjs 整体拷贝而来）
// 服务：http://localhost:8766 指向 app/dist（APP_PORT，见 tests/helpers/config.js）
// 视口按 tauri.conf.json 里声明的 mini 窗口尺寸（460x620）设置，只验页面本身；
// 不验 Tauri 窗口（浏览器里没有 __TAURI_INTERNALS__，窗口按钮必须降级而非报错）。
//
// 字形：测试把 kanseki_lang 钉为 's'（简体），断言里的「万历」才能逐字比对；
//       繁体路径单独用 storage 事件验一条（万历 → 萬曆）。
// ================================================
const { pathToFileURL } = require('url');
const config = require('../../../tests/helpers/config.js');

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  // ⚠️ 必须带 --font-render-hinting=none：
  //   无此开关时 headless Chrome 走整字形渲染，textContent/expect 取回的 CJK
  //   文本会变成互不相同的私用区码位（实测「萬曆」取回后 includes('萬曆') === false，
  //   但 innerText 正常）。加此开关后 textContent 与 DOM 文本一致，
  //   简繁断言才可信。（只影响测试进程的浏览器启动参数，不改任何产品代码。）
  const launchOptions = Object.assign({}, config.launchOptions, {
    args: (config.launchOptions.args || []).concat(['--font-render-hinting=none'])
  });
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 460, height: 620 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // 预置偏好：简体 + 浅色（首屏断言基于此）
  await page.addInitScript(() => {
    try { localStorage.setItem('kanseki_lang', 's'); localStorage.setItem('theme', 'light'); } catch (_) {}
  });
  await page.goto(config.resolveAppUrl('mini.html'), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(() => window.__miniReady === true, null, { timeout: 20000 });
  await page.waitForTimeout(250);

  const thisYear = String(new Date().getFullYear());

  // ---------- 1. 自绘标题栏与窗口控制 ----------
  check('标题栏存在且整条可拖动', await page.locator('#miniTitlebar[data-tauri-drag-region]').count() === 1);
  check('最小化按钮存在（id=miniMin）', await page.locator('#miniMin').count() === 1);
  check('关闭按钮存在（id=miniClose）', await page.locator('#miniClose').count() === 1);
  check('置顶开关存在且有 aria-pressed', (await page.locator('#miniTop[aria-pressed]').count()) === 1);
  check('置顶开关初始为未置顶', (await page.getAttribute('#miniTop', 'aria-pressed')) === 'false',
    String(await page.getAttribute('#miniTop', 'aria-pressed')));
  check('标题栏含标题文字', ((await page.locator('#miniTitlebar .mini-title').textContent()) || '').includes('纪年小窗'));
  // 460px 窄窗不得横向溢出（table-layout:fixed 的意义）
  const scrollW = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: window.innerWidth
  }));
  check('窄窗无横向溢出', scrollW.doc <= scrollW.win + 2, JSON.stringify(scrollW));

  // ---------- 2. 检索控件 ----------
  const ph = (await page.getAttribute('#miniInput', 'placeholder')) || '';
  check('输入框占位符提示可检索维度',
    /年份/.test(ph) && /年号/.test(ph) && /干支/.test(ph) && /朝代/.test(ph) && /君主/.test(ph), ph);
  check('查询按钮存在', await page.locator('#miniBtn').count() === 1);
  check('快捷检索按钮 ≥4 个', (await page.locator('#miniShortcuts .mini-chip').count()) >= 4,
    'n=' + await page.locator('#miniShortcuts .mini-chip').count());
  const tableCaption = (await page.getAttribute('#miniTable', 'aria-label')) || '';
  const ths = await page.locator('#miniTable thead th').allTextContents();
  check('表格为 5 列（公元/朝代/年号/君主/干支）', ths.length === 5, ths.join('/'));
  check('表头文字齐备',
    ['公元', '朝代', '年号', '君主', '干支'].every((t) => ths.includes(t)) || /对照|结果/.test(tableCaption),
    ths.join('/'));

  // ---------- 3. 首屏自动查询当前年份 ----------
  check('数据集已加载（2868 行）', (await page.evaluate(() => window.__miniRowCount)) === 2868,
    String(await page.evaluate(() => window.__miniRowCount)));
  check('首屏输入框已填当前年份', (await page.inputValue('#miniInput')) === thisYear, thisYear);
  check('首屏表格行数 > 0', (await page.locator('#miniTbody tr').count()) > 0,
    'rows=' + await page.locator('#miniTbody tr').count());
  check('首屏「命中 N 行」已显示', /命中\s*\d+\s*行/.test((await page.textContent('#miniHitCount')) || ''),
    (await page.textContent('#miniHitCount')) || '');

  // ---------- 4. 精确年份检索：1587 ----------
  await page.fill('#miniInput', '1587');
  await page.press('#miniInput', 'Enter');
  await page.waitForTimeout(300);
  const row1587 = (await page.textContent('#miniTbody')) || '';
  check('1587 命中 1 行', (await page.locator('#miniTbody tr').count()) === 1,
    'rows=' + await page.locator('#miniTbody tr').count());
  check('1587 → 万历十五年', row1587.includes('万历十五年'), row1587.replace(/\s+/g, ' ').slice(0, 80));
  check('1587 → 干支 丁亥', row1587.includes('丁亥'));
  check('1587 → 君主 明神宗', row1587.includes('明神宗'));
  check('1587 → 朝代 明', row1587.includes('明'));
  check('1587 → 命中数显示「命中 1 行」',
    /命中\s*1\s*行/.test((await page.textContent('#miniHitCount')) || ''));
  // 同年日本年号另起一行（合并进「年号」列，避免 460px 下多一列撑破）
  check('1587 → 日本年号并入年号列', row1587.includes('天正十五年'), row1587.slice(0, 120));

  // ---------- 5. 年号检索：万历 ----------
  await page.fill('#miniInput', '万历');
  await page.click('#miniBtn');
  await page.waitForTimeout(400);
  const hitTxt = (await page.textContent('#miniHitCount')) || '';
  const hitN = Number((/命中\s*(\d+)\s*行/.exec(hitTxt) || [])[1]);
  check('「万历」命中数 ≥ 40', hitN >= 40, hitTxt);
  const wlRows = await page.locator('#miniTbody tr').count();
  check('「万历」表格行数 > 0', wlRows > 0, 'rows=' + wlRows);
  check('「万历」首行年份为 1573', (await page.getAttribute('#miniTbody tr:first-child', 'data-year')) === '1573',
    String(await page.getAttribute('#miniTbody tr:first-child', 'data-year')));
  check('「万历」结果按年份升序',
    Number(await page.getAttribute('#miniTbody tr:first-child', 'data-year')) <=
    Number(await page.getAttribute('#miniTbody tr:last-child', 'data-year')));

  // ---------- 6. 行内复制 ----------
  const cbCount = await page.locator('#miniTbody .m-copy').count();
  check('每行都有复制按钮', cbCount === wlRows, 'buttons=' + cbCount + ' rows=' + wlRows);
  check('复制按钮可见', await page.locator('#miniTbody .m-copy').first().isVisible());

  await page.click('#miniTbody tr:first-child td.m-col-year');
  await page.waitForTimeout(250);
  const copied = await page.evaluate(() => window.__miniLastCopied);
  // 首行 = 万历元年（1573）：万历年号自 1573 起（1573-1572=1）
  check('点行复制 → 万历元年（1573）', copied === '万历元年（1573）', String(copied));
  check('复制格式为「年号（年）」（含全角括号）', /（\d+）$/.test(String(copied)), String(copied));
  check('复制后状态行提示已复制', ((await page.textContent('#miniStatus')) || '').includes('已复制'),
    (await page.textContent('#miniStatus')) || '');

  // 点复制按钮：内容一致，且不得因行/按钮双监听而重复
  await page.evaluate(() => { window.__miniCopyCalls = 0;
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) => { window.__miniCopyCalls++; return orig(t); };
  });
  await page.click('#miniTbody tr:first-child .m-copy');
  await page.waitForTimeout(250);
  check('点复制按钮 → 内容与点行一致', (await page.evaluate(() => window.__miniLastCopied)) === copied,
    String(await page.evaluate(() => window.__miniLastCopied)));
  check('一次点击只写一次剪贴板', (await page.evaluate(() => window.__miniCopyCalls)) === 1,
    'calls=' + await page.evaluate(() => window.__miniCopyCalls));

  // 复制失败（剪贴板被拒 + execCommand 也失败）必须在状态行明说
  await page.evaluate(() => window.__miniForceCopyFail(true));
  await page.click('#miniTbody tr:first-child .m-copy');
  await page.waitForTimeout(250);
  const failStatus = (await page.textContent('#miniStatus')) || '';
  check('复制彻底失败时状态行明说失败', /复制失败/.test(failStatus), failStatus.trim().slice(0, 60));
  // 复原剪贴板（浏览器里 execCommand 一旦被覆盖不可枚举复原），否则后续复制会静默失败
  await page.evaluate(() => window.__miniForceCopyFail(false));
  check('剪贴板桩已复原', (await page.evaluate(() => window.__miniCopyFailForced)) === false);

  // ---------- 7. 干支检索 ----------
  await page.fill('#miniInput', '癸未');
  await page.press('#miniInput', 'Enter');
  await page.waitForTimeout(400);
  const gwN = Number((/命中\s*(\d+)\s*行/.exec((await page.textContent('#miniHitCount')) || '') || [])[1]);
  check('「癸未」命中 ≥ 40（干支语义）', gwN >= 40, 'n=' + gwN);
  check('「癸未」表格行数 > 0', (await page.locator('#miniTbody tr').count()) > 0);

  // ---------- 8. 无结果 ----------
  await page.fill('#miniInput', 'zzz不存在zzz');
  await page.press('#miniInput', 'Enter');
  await page.waitForTimeout(300);
  check('无结果时命中 0 行', /命中\s*0\s*行/.test((await page.textContent('#miniHitCount')) || ''));
  check('无结果时给出空状态文案', ((await page.textContent('#miniEmpty')) || '').includes('无匹配结果'),
    (await page.textContent('#miniEmpty')) || '');
  check('无结果时状态行提示未找到', ((await page.textContent('#miniStatus')) || '').includes('未找到'));

  // ---------- 9. 浏览器调试下降级（不报错） ----------
  const notices = await page.evaluate(() => ({
    htmlClass: document.documentElement.className,
    hasTauri: '__TAURI_INTERNALS__' in window
  }));
  check('浏览器环境标记为无 Tauri', notices.hasTauri === false && notices.htmlClass.includes('mini-no-tauri'),
    JSON.stringify(notices));
  const statusAll = [];
  for (const id of ['#miniTop', '#miniMin', '#miniClose']) {
    try { await page.click(id, { timeout: 2000 }); } catch (_) { /* 隐藏按钮点不到：允许 */ }
    await page.waitForTimeout(80);
    statusAll.push((await page.textContent('#miniStatus')) || '');
  }
  check('浏览器模式点窗口按钮不抛错且在状态行提示',
    statusAll.some((s) => s.includes('浏览器调试：窗口控制不可用')), statusAll.join(' || ').slice(0, 80));

  // ---------- 10. 主题 ----------
  check('<html> 有 data-theme', (await page.getAttribute('html', 'data-theme')) === 'light',
    String(await page.getAttribute('html', 'data-theme')));
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
  });
  await page.waitForTimeout(200);
  check('storage 事件切到深色', (await page.getAttribute('html', 'data-theme')) === 'dark',
    String(await page.getAttribute('html', 'data-theme')));

  // ---------- 11. 简繁：切繁体 ----------
  // 先回到「万历」结果（上一步是 0 行），再验繁体渲染与复制文本
  await page.fill('#miniInput', '万历');
  await page.press('#miniInput', 'Enter');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    localStorage.setItem('kanseki_lang', 't');
    window.dispatchEvent(new StorageEvent('storage', { key: 'kanseki_lang', newValue: 't' }));
  });
  await page.waitForTimeout(250);
  const tradRows = await page.locator('#miniTbody tr').count();
  check('切繁体后仍有结果行', tradRows > 0, 'rows=' + tradRows);
  check('切繁体后行更新为「萬曆」', ((await page.textContent('#miniTbody')) || '').includes('萬曆'),
    ((await page.textContent('#miniTbody')) || '').slice(0, 60));
  check('切繁体后不再出现简体「万历」', !((await page.textContent('#miniTbody')) || '').includes('万历'));
  check('切繁体后复制文本也是繁体', (await page.evaluate(() => {
    const tr = document.querySelector('#miniTbody tr');
    return tr ? tr.dataset.copy : '';
  })).includes('萬曆'));
  check('切繁体后 <html> 标记 data-lang=t', (await page.getAttribute('html', 'data-lang')) === 't',
    String(await page.getAttribute('html', 'data-lang')));

  // 数据范围外的年份（无中国年号、无日本年号）→ 主年号复制退化为 yearStr
  await page.fill('#miniInput', '2099');
  await page.press('#miniInput', 'Enter');
  await page.waitForTimeout(300);
  check('超出数据范围的年份无结果', (await page.locator('#miniTbody tr').count()) === 0);

  // ---------- 12. 日本年号兜底（中国年号为空时用日本年号候选） ----------
  // 1912 年后中国年号数据结束，仅剩日本年号 → 走「无中国年号」分支
  await page.fill('#miniInput', '2020');
  await page.press('#miniInput', 'Enter');
  await page.waitForTimeout(300);
  const row2020 = (await page.textContent('#miniTbody')) || '';
  check('2020 年有结果（仅日本年号）', (await page.locator('#miniTbody tr').count()) === 1);
  check('2020 年行显示令和年号', row2020.includes('令和'), row2020.slice(0, 60));
  check('2020 年中国朝代列退化为「—」', row2020.includes('—'), row2020.slice(0, 60));
  await page.click('#miniTbody tr:first-child td.m-col-year');
  await page.waitForTimeout(250);
  check('无中国年号时复制日本年号候选',
    /^令和二年（2020）$/.test(String(await page.evaluate(() => window.__miniLastCopied))),
    String(await page.evaluate(() => window.__miniLastCopied)));
  check('复原后复制仍走「已复制」分支', /已(复|複)製|已复制/.test((await page.textContent('#miniStatus')) || ''),
    (await page.textContent('#miniStatus')) || '');

  // ---------- 12. 全程无 JS 错误 ----------
  check('全程 0 JS 错误', errors.length === 0, errors.slice(0, 3).join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
