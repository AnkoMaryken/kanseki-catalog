// ================================================
// app/tests/browser/najdb_ui.test.cjs — 国立公文书馆面板：浏览器环境行为（不联网）
// ================================================
// 网页版/浏览器调试下该站不可直连（无 CORS 头），面板必须**明确说明**而不是静默失败。
// 本套件只验证结构与降级文案，不发起任何网络请求；真链路见 najdb_live.test.cjs。
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

  await page.goto(config.resolveAppUrl('#/najdb'), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);

  // 1. 入口与图标
  check('侧栏存在入口', (await page.locator('.nav-item[data-view="najdb"]').count()) === 1);
  check('入口文字', ((await page.locator('.nav-item[data-view="najdb"] span:not(.nav-ico-da)').textContent()) || '').includes('国立公文书馆'));
  check('图标为字母 DA', ((await page.locator('.nav-item[data-view="najdb"] .nav-ico-da').textContent()) || '').trim() === 'DA');
  const box = await page.evaluate(() => {
    const el = document.querySelector('.nav-item[data-view="najdb"] .nav-ico-da');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('DA 图标可见（非 0 尺寸）', !!box && box.w > 12 && box.h > 10, JSON.stringify(box));

  // 2. 视图
  check('视图已激活', (await page.locator('#view-najdb.active').count()) === 1);
  check('検索範囲 5 项', (await page.locator('#najScope option').count()) === 5);
  check('表示件数 4 档（20/50/100/200）', (await page.locator('#najRows option').count()) === 4);
  check('检索按钮存在', (await page.locator('#najSearchBtn').count()) === 1);

  // 2b. 全部条件标签为中文（用户要求）
  const condText = ((await page.locator('#najForm').textContent()) || '');
  for (const t of ['关键词', '详细检索', '显示件数', '资料种别', '图像等种类', '利用限制', '保存场所',
    '作成年（起）', '作成年（止）', '移交元机关等', '旧藏（文库）', '参照代码（起）', '参照代码（止）',
    '内閣文庫 汉籍分类']) {
    check('中文条件标签：' + t, condText.includes(t));
  }
  // 「检索范围」是 select 的无障碍标签（选项文字本身即中文，未单独渲染标签）
  check('检索范围为中文 aria-label',
    (await page.getAttribute('#najScope', 'aria-label')) === '检索范围',
    await page.getAttribute('#najScope', 'aria-label'));
  const scopeLabels = await page.locator('#najScope option').allTextContents();
  check('检索范围选项均为中文', scopeLabels.length === 5 && scopeLabels.every((t) => /[\u4e00-\u9fa5]/.test(t)),
    scopeLabels.join('/'));
  // 不应再出现日文条件标签
  for (const jp of ['キーワード', '検索範囲', '表示件数', '資料種別']) {
    check('已无日文条件标签：' + jp, !condText.includes(jp) && !scopeLabels.some((t) => t.includes(jp)));
  }

  // 2c. 资料种别（筛选簿册 / 件名·细目 —— 用户要求）
  await page.click('#najToggle');
  await page.waitForTimeout(250);
  check('详细检索展开', await page.locator('#najAdv').isVisible());
  const typeVals = await page.locator('#najTypes input').evaluateAll((els) => els.map((e) => e.value));
  check('资料种别取值 da22/da23/da21', JSON.stringify(typeVals) === JSON.stringify(['da22', 'da23', 'da21']), typeVals.join(','));
  const typeLabels = await page.locator('#najTypes span').allTextContents();
  check('资料种别含「簿册」', typeLabels.includes('簿册'), typeLabels.join('/'));
  check('资料种别含「件名·细目」', typeLabels.some((t) => t.includes('件名')), typeLabels.join('/'));
  check('图像等种类 3 项', (await page.locator('#najImgTypes input').count()) === 3);
  check('利用限制 4 项', (await page.locator('#najLimits input').count()) === 4);
  check('保存场所 4 项', (await page.locator('#najStacks input').count()) === 4);
  check('移交元机关等选项已填充（≥140）', (await page.locator('#najInst option').count()) >= 141,
    'options=' + await page.locator('#najInst option').count());
  check('旧藏（文库）选项已填充（≥50）', (await page.locator('#najWare option').count()) >= 51,
    'options=' + await page.locator('#najWare option').count());
  // 勾选后角标计数
  await page.check('#najTypes input[value="da22"]');
  await page.waitForTimeout(150);
  check('详细条件角标计数=1', ((await page.locator('#najFilterCount').textContent()) || '').trim() === '1',
    await page.locator('#najFilterCount').textContent());
  await page.uncheck('#najTypes input[value="da22"]');

  // 2d. 内閣文庫 汉籍分类：已并入「详细检索」浮层（用户要求）
  check('已无独立的分类按钮', (await page.locator('#najNkToggle').count()) === 0);
  check('分类区在详细检索浮层内', (await page.locator('#najAdv #najNaikakuChips').count()) === 1);
  check('详细检索浮层此刻为展开态', await page.locator('#najAdv').isVisible());
  const chips = await page.locator('#najNaikakuChips .naj-chip').allTextContents();
  check('内閣文庫分类按钮 9 个', chips.length === 9, 'n=' + chips.length + ' ' + chips.join('/'));
  for (const c of ['内閣文庫（全部）', '漢籍（漢書部）', '經部', '史部', '子部', '集部', '叢書部', '新書部']) {
    check('分类含「' + c + '」', chips.includes(c));
  }
  const chipIds = await page.locator('#najNaikakuChips .naj-chip').evaluateAll((els) => els.map((e) => e.dataset.najFond));
  check('分类 ID 与实测一致', JSON.stringify(chipIds) === JSON.stringify(
    ['2308962', '3602612', '3610545', '3602613', '3611449', '3610170', '1080082', '1083362', '3682585']), chipIds.join(','));
  check('每个分类都有原站分类页入口', (await page.locator('#najNaikakuChips .naj-chip-page').count()) === 9);
  // 点分类（无关键词）→ 记下限定、浮层留着继续挑；角标计入详细条件数
  await page.click('#najNaikakuChips .naj-chip[data-naj-fond="3610545"]');
  await page.waitForTimeout(250);
  check('浮层保持展开（无关键词时）', await page.locator('#najAdv').isVisible());
  check('分类按钮显示为已选', (await page.locator('#najNaikakuChips .naj-chip.on').count()) === 1);
  const active = (await page.locator('#najNaikakuActive').textContent()) || '';
  check('显示已限定分类', active.includes('經部'), active.trim());
  check('详细条件角标含分类（=1）', ((await page.locator('#najFilterCount').textContent()) || '').trim() === '1',
    await page.locator('#najFilterCount').textContent());
  await page.click('#najFondClear');
  await page.waitForTimeout(200);
  check('可取消分类限定', await page.locator('#najNaikakuActive').isHidden());
  // 点浮层外部收起
  await page.click('#najKw');
  await page.waitForTimeout(200);
  check('点外部收起详细检索浮层', await page.locator('#najAdv').isHidden());

  // 2e. 检索条必须是**一整行**（用户要求）
  const rowTops = await page.evaluate(() => {
    const row = document.querySelector('#najForm .kdb-main');
    return [...row.children].map((el) => Math.round(el.getBoundingClientRect().top));
  });
  check('检索条所有控件在同一行（顶差≤4px）',
    rowTops.length >= 5 && (Math.max(...rowTops) - Math.min(...rowTops)) <= 4, JSON.stringify(rowTops));

  // 3. 浏览器环境必须明确说明不可用（并与「汉籍检索（日本）」口径一致）
  const notice = (await page.locator('#najResults').textContent()) || '';
  check('说明仅桌面版可用', /仅.*桌面版可用/.test(notice), notice.trim().slice(0, 50));
  check('说明指出 CORS 限制', /CORS/.test(notice));
  check('浏览器下检索按钮禁用', await page.locator('#najSearchBtn').isDisabled());

  // 4. 布局：结果区撑满视图（CSS 未加载时会退化为 150px）
  const layout = await page.evaluate(() => {
    const v = document.getElementById('view-najdb');
    const split = document.getElementById('najSplit');
    if (!v || !split) return null;
    return { viewH: Math.round(v.getBoundingClientRect().height), splitH: Math.round(split.getBoundingClientRect().height) };
  });
  check('结果区有合理高度', !!layout && layout.splitH > 150, JSON.stringify(layout));

  // 5. 侧栏「编目记录」的红色「未上线」标记（用户要求）
  check('编目记录带「未上线」角标', (await page.locator('.nav-item[data-view="records"] .nav-badge.soon').count()) === 1);
  check('角标文字为「未上线」',
    ((await page.locator('.nav-item[data-view="records"] .nav-badge').textContent()) || '').trim() === '未上线');
  const badgeStyle = await page.evaluate(() => {
    const b = document.querySelector('.nav-item[data-view="records"] .nav-badge.soon');
    if (!b) return null;
    const s = getComputedStyle(b);
    return { bg: s.backgroundColor, color: s.color };
  });
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec((badgeStyle && badgeStyle.bg) || '');
  check('角标为红色系（R 明显大于 G）',
    !!rgb && Number(rgb[1]) > 150 && Number(rgb[2]) < 100, JSON.stringify(badgeStyle));

  // 6. 无错误
  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
