// ================================================
// app/tests/browser/records_form.test.cjs — 编目记录（V9.5 正式版）端到端
// ================================================
// 覆盖：空态 → 新增 → 必填校验 → 落库(IndexedDB) → 重载持久化 →
//       搜索过滤 → 编辑 → 导出 CSV → 删除（软删除墓碑）
// 前置：需在 8766 端口提供 app/dist 静态服务（与既有 browser 套件一致）
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
  page.on('dialog', d => d.accept());

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  };

  // 清空 catalog_records，保证测试可重复（同版本打开不会触发 upgrade/blocked）
  const clearRecords = async () => {
    await page.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('kanseki-app', 1);
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('catalog_records', 'readwrite');
          tx.objectStore('catalog_records').clear();
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = () => { db.close(); resolve(false); };
        } catch (_) { db.close(); resolve(false); }
      };
      req.onerror = () => resolve(false);
    }));
  };

  // V1.4：编目记录默认封禁，e2e 需要解锁钩子
  await page.addInitScript(() => { window.__kansekiRecordsUnlock = true; });
  await page.goto(config.resolveAppUrl('#/records'), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(900);
  await clearRecords();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (!(await page.locator('#view-records.active').count())) {
    await page.click('.nav-item[data-view="records"]');
    await page.waitForTimeout(400);
  }

  // 1. 空状态
  check('空状态标题', (await page.locator('#recordsEmpty h3').textContent()) === '还没有编目记录');
  check('空状态可见', await page.locator('#recordsEmpty').isVisible());
  check('新增按钮可用', !(await page.locator('#addRecordBtn').isDisabled()));

  // 2. 打开表单
  await page.click('#addRecordBtn');
  await page.waitForTimeout(300);
  check('表单弹层可见', await page.locator('#recordFormOverlay').isVisible());
  check('必填 8 字段', await page.locator('#requiredFields .av-field').count() === 8);
  check('选填 5 字段', await page.locator('#optionalFields .av-field').count() === 5);
  check('字段总数 13', await page.locator('#recordFormOverlay .av-field').count() === 13);
  check('提交按钮可用（不再占位）', !(await page.locator('#recordFormSubmit').isDisabled()));
  check('新增时无删除键', await page.locator('#recordFormDelete').isHidden());

  const reqLabels = await page.locator('#requiredFields label').allTextContents();
  check('必填含書名', reqLabels.some(l => l.includes('書名')));
  check('必填含索書號', reqLabels.some(l => l.includes('索書號')));
  check('必填含卷數', reqLabels.some(l => l.includes('卷數')));

  // 3. 必填项不再拦截保存（V9.7 用户要求：留空也能先编目，稍后补全）
  await page.click('#recordFormSubmit');
  await page.waitForTimeout(600);
  check('必填留空也能保存（表单关闭）', await page.locator('#recordFormOverlay').isHidden());
  check('空记录已落库', (await page.locator('.rec-item').count()) === 1);
  check('提示写明还缺必填项', /必填/.test((await page.locator('#toast').textContent()) || ''),
    ((await page.locator('#toast').textContent()) || '').trim());
  // 删掉这条空记录，恢复干净状态继续后续用例
  await page.click('.rec-item [data-rec-del]');
  await page.waitForTimeout(700);
  check('清理空记录', (await page.locator('.rec-item').count()) === 0);

  // 4. 填必填项并保存（空提交已把表单关闭，这里重新打开）
  await page.click('#addRecordBtn');
  await page.waitForTimeout(300);
  check('可再次打开表单', await page.locator('#recordFormOverlay').isVisible());
  await page.fill('#rec-category', '史部·傳記類');
  await page.fill('#rec-title', '日本国志');
  await page.fill('#rec-volume', '四十卷');
  await page.fill('#rec-shelf', '一·〇二·〇一 堀田');
  await page.fill('#rec-author', '〔清〕黄遵憲 撰');
  await page.fill('#rec-version', '清光緒刻本');
  await page.fill('#rec-copies', '4册');
  await page.fill('#rec-format', '半頁十行二十字');
  await page.fill('#rec-catalogers', '张编目');
  await page.click('#recordFormSubmit');
  await page.waitForTimeout(600);
  check('保存后弹层关闭', await page.locator('#recordFormOverlay').isHidden());
  // 提示文案必须区分新增/编辑（回归：closeForm() 会清空 state.editing，
  // 曾在读取前被置空导致新增也显示「已保存修改」）
  check('新增提示为「已新增」', ((await page.locator('#toast').textContent()) || '').includes('已新增'),
    ((await page.locator('#toast').textContent()) || '').trim());
  check('列表出现 1 条', (await page.locator('.rec-item').count()) === 1);
  check('書名正确', (await page.locator('.rec-item-title').first().textContent()).includes('日本国志'));
  check('显示序號 #1', (await page.locator('.rec-seq').first().textContent()).includes('#1'));
  check('搜索框计数已更新', (await page.locator('#recordsCount').textContent()).includes('共 1 条'));

  // 5. 重载后仍在（IndexedDB 持久化）
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (!(await page.locator('#view-records.active').count())) {
    await page.click('.nav-item[data-view="records"]');
    await page.waitForTimeout(400);
  }
  check('重载后记录仍在', (await page.locator('.rec-item').count()) === 1);

  // 6. 搜索过滤
  await page.fill('#recordsSearch', '不存在的书名xyz');
  await page.waitForTimeout(300);
  check('无命中走空态', (await page.locator('#recordsEmpty h3').textContent()) === '没有匹配的记录');
  check('无命中时列表为空', (await page.locator('.rec-item').count()) === 0);
  await page.fill('#recordsSearch', '日本');
  await page.waitForTimeout(300);
  check('按書名命中', (await page.locator('.rec-item').count()) === 1);
  await page.fill('#recordsSearch', '堀田');
  await page.waitForTimeout(300);
  check('按索書號命中', (await page.locator('.rec-item').count()) === 1);
  await page.fill('#recordsSearch', '');
  await page.waitForTimeout(300);

  // 7. 编辑
  await page.click('.rec-item [data-rec-edit]');
  await page.waitForTimeout(300);
  check('编辑时表单有删除键', await page.locator('#recordFormDelete').isVisible());
  check('编辑时带入原值', (await page.inputValue('#rec-title')) === '日本国志');
  await page.fill('#rec-title', '日本国志（校订本）');
  await page.click('#recordFormSubmit');
  await page.waitForTimeout(600);
  check('编辑提示为「已保存修改」', ((await page.locator('#toast').textContent()) || '').includes('已保存修改'),
    ((await page.locator('#toast').textContent()) || '').trim());
  check('编辑已保存', (await page.locator('.rec-item-title').first().textContent()).includes('校订本'));
  check('编辑未新增条目', (await page.locator('.rec-item').count()) === 1);

  // 8. 导出表格 CSV（浏览器调试路径走下载）
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.click('#recordsExportTableBtn'),
  ]);
  check('导出触发下载', !!download && /汉籍编目记录_\d{8}\.csv/.test(download.suggestedFilename()),
    download ? download.suggestedFilename() : '无下载事件');
  if (download) {
    const fs = require('fs');
    const p = await download.path();
    const csv = fs.readFileSync(p, 'utf8');
    check('CSV 含表头', csv.includes('書名') && csv.includes('索書號'));
    check('CSV 含记录', csv.includes('日本国志（校订本）'));
  }
  // 防公式注入：以 = 开头的内容必须前置单引号，Excel 才不会当公式执行
  const cell = await page.evaluate(() => window.__recordsInternals
    ? window.__recordsInternals.csvCell('=1+2') : null);
  check('CSV 单元格防公式注入', cell === "'=1+2", String(cell));
  // 前导空格绕过也要拦住（' =1+1'）
  const cellSp = await page.evaluate(() => window.__recordsInternals
    ? window.__recordsInternals.csvCell(' =1+1') : null);
  check('CSV 防公式注入（前导空格）', cellSp === "' =1+1", JSON.stringify(cellSp));

  // 9. 删除（软删除墓碑）
  await page.click('.rec-item [data-rec-del]');
  await page.waitForTimeout(600);
  check('删除后列表为空', (await page.locator('.rec-item').count()) === 0);
  check('删除后回到空态', await page.locator('#recordsEmpty').isVisible());
  const tombCount = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('kanseki-app', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('catalog_records', 'readonly');
      const r = tx.objectStore('catalog_records').getAll();
      r.onsuccess = () => {
        const rows = r.result || [];
        db.close();
        resolve(rows.filter(x => x && x.deletedAt).length);
      };
      r.onerror = () => { db.close(); resolve(-1); };
    };
    req.onerror = () => resolve(-1);
  }));
  // 本轮有两条生命周期（先前的空草稿 + 这条正式记录），各留一条墓碑
  check('保留软删除墓碑（供同步传播）', tombCount >= 1, '墓碑数 ' + tombCount);

  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
