// ================================================
// app/tests/browser/records_io.test.cjs — 编目记录「导入表格 / 表格预览 / 文字预览 / 双格式导出」
// ================================================
// 覆盖（V9.7 用户要求）：
//   · 一键导入 Excel(.xlsx) 与 CSV（GBK 中文表头）→ 落库
//   · 表格预览（同「编目表格」模板 14 列）
//   · 文字预览（按文字著录格式成文）
//   · 导出「表格（CSV）」与「文字（TXT）」两种
//   · 必填留空也能保存（软校验，见 records_form 套件）
// 前置：8766 提供 app/dist 静态服务
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const config = require('../../../tests/helpers/config.js');

const FIX = path.join(__dirname, '..', 'fixtures', 'records');
const CSV_GBK = path.join(FIX, 'import_gbk.csv');
const XLSX_13 = path.join(FIX, 'import_13col.xlsx');

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
  await page.evaluate(() => { try { localStorage.removeItem('kanseki_records_view'); } catch (_) {} });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  if (!(await page.locator('#view-records.active').count())) {
    await page.click('.nav-item[data-view="records"]');
    await page.waitForTimeout(400);
  }

  // ---------- 1. 导入 CSV（GBK 中文表头） ----------
  check('导入按钮存在', (await page.locator('#recordsImportBtn').count()) === 1);
  check('文件输入接受 xlsx/csv', /xlsx/.test(await page.getAttribute('#recordsImportFile', 'accept')),
    await page.getAttribute('#recordsImportFile', 'accept'));
  await page.setInputFiles('#recordsImportFile', CSV_GBK);
  await page.waitForTimeout(1500);
  check('CSV 导入 2 条', (await page.locator('.rec-item').count()) === 2,
    'items=' + await page.locator('.rec-item').count());
  const listText = (await page.locator('#recordsList').textContent()) || '';
  check('导入内容正确（日本國志）', listText.includes('日本國志'));
  check('导入内容正确（文選）', listText.includes('文選'));
  check('导入后提示已导入', /已导入/.test((await page.locator('#toast').textContent()) || ''),
    ((await page.locator('#toast').textContent()) || '').trim());

  // ---------- 2. 表格预览 ----------
  await page.click('.rec-vs[data-rec-view="table"]');
  await page.waitForTimeout(400);
  check('切到表格预览', await page.locator('#recordsTableWrap').isVisible());
  check('卡片列表已隐藏', await page.locator('#recordsList').isHidden());
  const heads = await page.locator('#recordsTableWrap table.rec-table thead th').allTextContents();
  check('表头 14 列', heads.length === 14, 'n=' + heads.length + ' ' + heads.join('/'));
  for (const h of ['序號', '類目', '書名', '卷數', '索書號', '著者', '版本', '函册', '版式']) {
    check('表头含「' + h + '」', heads.includes(h));
  }
  const bodyRows = await page.locator('#recordsTableWrap table.rec-table tbody tr').count();
  check('表格有 2 行数据', bodyRows === 2, 'rows=' + bodyRows);
  const tableText = (await page.locator('#recordsTableWrap').textContent()) || '';
  check('表格含書名与版本', tableText.includes('日本國志') && tableText.includes('清光緒十六年'));

  // ---------- 3. 文字预览 ----------
  await page.click('.rec-vs[data-rec-view="text"]');
  await page.waitForTimeout(400);
  check('切到文字预览', await page.locator('#recordsTextWrap').isVisible());
  check('表格预览已隐藏', await page.locator('#recordsTableWrap').isHidden());
  const textPreview = (await page.locator('#recordsTextWrap').textContent()) || '';
  check('文字含「书名/卷数：」', textPreview.includes('书名/卷数：'));
  check('文字含「索书号：」', textPreview.includes('索书号：'));
  check('文字含著者与版本', textPreview.includes('黃遵憲') && textPreview.includes('清光緒十六年'));
  check('文字含「行款版式：」', textPreview.includes('行款版式：'));
  check('文字含「附注：」', textPreview.includes('附注：'));
  check('文字预览 2 条', (await page.locator('#recordsTextWrap .rec-text-item').count()) === 2);

  // ---------- 4. 导出文字（TXT） ----------
  const [dlTxt] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.click('#recordsExportTextBtn'),
  ]);
  check('导出文字触发下载', !!dlTxt && /\.txt$/.test(dlTxt.suggestedFilename()),
    dlTxt ? dlTxt.suggestedFilename() : '无下载事件');
  if (dlTxt) {
    const txt = fs.readFileSync(await dlTxt.path(), 'utf8');
    check('TXT 含文字著录骨架', txt.includes('书名/卷数：') && txt.includes('行款版式：'));
    check('TXT 含记录内容', txt.includes('日本國志'));
    check('TXT 多条用分隔线', txt.includes('────────'));
  }

  // ---------- 5. 导出表格（CSV） ----------
  const [dlCsv] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
    page.click('#recordsExportTableBtn'),
  ]);
  check('导出表格触发下载', !!dlCsv && /\.csv$/.test(dlCsv.suggestedFilename()),
    dlCsv ? dlCsv.suggestedFilename() : '无下载事件');
  if (dlCsv) {
    const csv = fs.readFileSync(await dlCsv.path(), 'utf8');
    check('CSV 14 列表头', csv.split('\r\n')[0].split(',').length === 14, csv.split('\r\n')[0].slice(0, 80));
    check('CSV 含记录内容', csv.includes('日本國志'));
  }

  // ---------- 6. 导入 Excel(.xlsx) ----------
  await page.click('.rec-vs[data-rec-view="card"]');
  await page.waitForTimeout(300);
  await page.setInputFiles('#recordsImportFile', XLSX_13);
  await page.waitForTimeout(1800);
  const afterXlsx = await page.locator('.rec-item').count();
  check('xlsx 导入后记录数增加', afterXlsx > 2, 'items=' + afterXlsx);
  check('xlsx 导入后提示已导入', /已导入/.test((await page.locator('#toast').textContent()) || ''),
    ((await page.locator('#toast').textContent()) || '').trim());

  // ---------- 7. 表格预览包含全部记录 ----------
  await page.click('.rec-vs[data-rec-view="table"]');
  await page.waitForTimeout(400);
  const allRows = await page.locator('#recordsTableWrap table.rec-table tbody tr').count();
  check('表格行数＝记录数', allRows === afterXlsx, 'rows=' + allRows + ' items=' + afterXlsx);

  check('0 JS 错误', errors.length === 0, errors.slice(0, 3).join('; '));

  let fail = 0;
  for (const r of results) { console.log(r); if (r.startsWith('FAIL')) fail++; }
  console.log('TOTAL | ' + results.length + ' | FAIL ' + fail);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
