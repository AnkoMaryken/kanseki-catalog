// ================================================
// unit/record-io.test.js — 编目 导入/导出 纯逻辑 I/O（xlsx / csv / 映射 / 著录）
// ================================================
// 离线运行、无 DOM、无第三方依赖：
//   cd app && node --test tests/unit/record-io.test.js
// 夹具（tests/fixtures/records/）：
//   import_13col.xlsx             openpyxl 生成，14 列（序號 + 13 字段），2 行数据
//   import_template_headers.xlsx  openpyxl 生成，表头为模板原文（*類目/*書名…），
//                                 行内故意留空单元格（验证补空不错位）
//   import_shared_strings.xlsx    store(0)+deflate(8) 混合、sharedStrings 表，
//                                 含富文本 <r><t>、稀疏单元格、t="str" 公式缓存值
//   import_gbk.csv                GBK 字节（文本方式生成，非 openpyxl）
//   import_alias_utf8bom.csv      简体/别名表头，UTF-8 带 BOM
//   import_position_fallback.csv  表头完全无法识别（列1…列14）→ 触发位置回退
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { ALL_FIELDS, FIELD_DEFS } from '../../src/js/core/catalog-record-schema.js';
import {
  TABLE_COLUMNS,
  parseCsv,
  parseXlsx,
  decodeTextBuffer,
  parseTableFile,
  mapRowsToRecords,
  recordToText,
  recordsToText,
  recordsToTableRows,
  recordsToCsv,
} from '../../src/js/ui/record-io.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'records');
const fixturePath = (name) => path.join(FIXTURES, name);

async function loadBytes(name) {
  const buf = await readFile(fixturePath(name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 造一个 File 样对象（不依赖 DOM 的 Blob/File） */
function fakeFile(name, bytes, type = '') {
  return { name, type, arrayBuffer: async () => bytes };
}

/** 记录必须**只含** 13 个业务字段，且值都是字符串（不含 id/seq 等元数据） */
function assertPureRecord(rec) {
  assert.deepEqual(Object.keys(rec).sort(), [...ALL_FIELDS].sort(), '记录应只含 13 个业务字段');
  for (const f of ALL_FIELDS) {
    assert.equal(typeof rec[f], 'string', `${f} 的值应为字符串`);
  }
  assert.equal('id' in rec, false);
  assert.equal('seq' in rec, false);
}

// 一条各字段齐全的记录（纯业务字段）
const FULL_RECORD = {
  category: '史部·地理類',
  title: '日本國志',
  volume: '四十卷',
  shelf: '一·〇二·〇一 堀田',
  author: '〔清〕黃遵憲撰',
  version: '清光緒十六年（1890）廣州富文齋刻本',
  copies: '4 函 24 册（全）',
  format: '半頁 12 行 24 字，小字雙行 24 字，白口，單黑魚尾，四周雙邊',
  frontmatter: '扉頁鐫「日本國志」，光緒十六年刊',
  verso: '紙背有元人戶籍文書',
  appendix: '卷首有梁啟超序',
  series: '叢書子目：無',
  catalogers: '編目：張三；校對：李四',
};

// ================================================
// 1) TABLE_COLUMNS
// ================================================

test('TABLE_COLUMNS：14 列，序號 + 13 业务字段且顺序同模板列序', () => {
  assert.equal(TABLE_COLUMNS.length, 14);
  assert.deepEqual(TABLE_COLUMNS.map((c) => c.key), ['seq', ...ALL_FIELDS]);
  assert.equal(TABLE_COLUMNS[0].label, '序號');
  assert.deepEqual(
    TABLE_COLUMNS.slice(1).map((c) => c.label),
    ['類目', '書名', '卷數', '索書號', '著者', '版本', '函册', '版式',
      '扉頁、刊記', '紙背文獻', '附録', '叢書子目', '編目者、校對者']
  );
  // 与 schema 的 label 一致（不另造一套显示名）
  for (const col of TABLE_COLUMNS.slice(1)) assert.equal(col.label, FIELD_DEFS[col.key].label);
});

// ================================================
// 2) parseCsv
// ================================================

test('parseCsv：引号、双引号转义、单元格内换行、CRLF/LF 混用、UTF-8 BOM', () => {
  const text = '\ufeff"書名","卷數","備註"\r\n'
    + '"文選","六十卷","含,逗號"\n'
    + '"說文""解字","十五卷","第一行\n第二行"\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ['書名', '卷數', '備註']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['文選', '六十卷', '含,逗號']);
  assert.deepEqual(rows[1], ['說文"解字', '十五卷', '第一行\n第二行']);
});

test('parseCsv：TSV（制表符自动嗅探）与表头去空白', () => {
  const { headers, rows } = parseCsv('書名\t 卷數 \n文選\t六十卷\n');
  assert.deepEqual(headers, ['書名', '卷數']);
  assert.deepEqual(rows[0], ['文選', '六十卷']);
});

test('parseCsv：缺列补空不错位、丢弃行尾空行、空文本不炸', () => {
  const { headers, rows } = parseCsv('A,B,C,D\n1,,,4\n\n');
  assert.deepEqual(headers, ['A', 'B', 'C', 'D']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], ['1', '', '', '4']);

  const { headers: h2, rows: r2 } = parseCsv('   ');
  assert.deepEqual(h2, []);
  assert.deepEqual(r2, []);
});

// ================================================
// 3) decodeTextBuffer
// ================================================

test('decodeTextBuffer：GBK 字节正确解码为中文（Excel 导出的中文 CSV）', async () => {
  const text = decodeTextBuffer(await loadBytes('import_gbk.csv'));
  assert.ok(text.includes('史部·地理類'), '实际：' + text.slice(0, 40));
  assert.ok(text.includes('日本國志'));
  assert.ok(text.includes('紙背有元人戶籍文書'));
  assert.ok(text.startsWith('序號,類目,書名'));
});

test('decodeTextBuffer：UTF-8（含 BOM 与无 BOM）与 UTF-16LE 均正确', () => {
  const utf8 = new TextEncoder().encode('書名,卷數\n文選,六十卷\n');
  assert.equal(decodeTextBuffer(utf8), '書名,卷數\n文選,六十卷\n');

  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  assert.equal(decodeTextBuffer(withBom), '書名,卷數\n文選,六十卷\n');

  const utf16 = new Uint8Array([0xff, 0xfe, 0xf8, 0x66, 0x0d, 0x54]); // BOM + 書名 (UTF-16LE：書=U+66F8、名=U+540D)
  assert.equal(decodeTextBuffer(utf16), '書名');
});

// ================================================
// 4) parseXlsx 夹具（三种真实 Excel 产物）
// ================================================

test('parseXlsx：openpyxl 生成的 14 列 xlsx（inlineStr）解析正确、列对齐', async () => {
  const { headers, rows } = await parseXlsx(await loadBytes('import_13col.xlsx'));
  assert.equal(headers.length, 14);
  assert.equal(headers[0], '序號');
  assert.deepEqual(headers.slice(1), [
    '類目', '書名', '卷數', '索書號', '著者', '版本', '函册', '版式',
    '扉頁、刊記', '紙背文獻', '附録', '叢書子目', '編目者、校對者',
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], '1');                       // 数字单元格取原文
  assert.equal(rows[0][1], '史部·地理類');
  assert.equal(rows[0][2], '日本國志');
  assert.equal(rows[0][3], '四十卷');
  assert.equal(rows[0][5], '〔清〕黃遵憲撰');
  assert.equal(rows[0][8], '半頁 12 行 24 字，小字雙行 24 字，白口，單黑魚尾，四周雙邊');
  assert.equal(rows[0][10], '');                       // K2 空单元格 → 空串
  assert.equal(rows[0][11], '卷首有梁啟超序');
  assert.equal(rows[0][13], '編目：張三；校對：李四');
  assert.equal(rows[1][2], '文選');
  assert.equal(rows[1][1], '集部·別集類');
});

test('parseXlsx：模板表头（*類目/*書名…）解析正确；空单元格不错位', async () => {
  const { headers, rows } = await parseXlsx(await loadBytes('import_template_headers.xlsx'));
  assert.equal(headers.length, 13);
  assert.equal(headers[0], '*類目');
  assert.equal(headers[3], '*索書號');
  assert.equal(headers[4], '*〔撰者時代〕撰（編輯修）者');
  assert.equal(headers[6], '*函册（存缺情況）');
  assert.equal(headers[8], '扉頁、刊記等');
  assert.equal(rows.length, 2);
  // 第 1 行数据：B/C/D/E/F 等中间列为空，G/H 与 L/M 有值 —— 必须落在各自列位
  assert.equal(rows[0][0], '經部·小學類');
  assert.equal(rows[0][1], '說文解字');
  assert.equal(rows[0][2], '十五卷');
  assert.equal(rows[0][3], '三·〇五·〇二 靜嘉');
  assert.equal(rows[0][4], '');
  assert.equal(rows[0][5], '');
  assert.equal(rows[0][6], '1 函 8 册（全）');
  assert.equal(rows[0][7], '半頁 9 行 18 字，小字雙行 20 字，白口，白魚尾，四周單邊');
  assert.equal(rows[0][11], '叢書子目：說文解字注');
  assert.equal(rows[0][12], '編目：趙六');
  // 第 2 行数据：A~K 连续有值，L/M 为空
  assert.equal(rows[1][10], '有朱筆批點');
  assert.equal(rows[1][11], '');
  assert.equal(rows[1][12], '');
});

test('parseXlsx：sharedStrings（含富文本 <r><t>）与稀疏单元格、公式缓存值', async () => {
  const { headers, rows } = await parseXlsx(await loadBytes('import_shared_strings.xlsx'));
  assert.equal(headers.length, 14);
  assert.deepEqual(headers, [
    '序號', '類目', '書名', '卷數', '索書號', '著者', '版本', '函册', '版式',
    '扉頁、刊記', '紙背文獻', '附録', '叢書子目', '編目者、校對者',
  ]);
  assert.equal(rows.length, 2);
  // 行 2 跳过了 C/D（書名/卷數）两列，E/F/G/H/I 与 N 有值 —— 必须仍在各自列位
  assert.equal(rows[0][0], '史部·地理類');
  assert.equal(rows[0][1], '日本國志');
  assert.equal(rows[0][2], '');
  assert.equal(rows[0][3], '');
  assert.equal(rows[0][4], '一·〇二·〇一 堀田');
  assert.equal(rows[0][5], '〔清〕黃遵憲撰', '富文本 <r><t> 片段应拼接');
  assert.equal(rows[0][7], '4 函 24 册（全）');
  assert.equal(rows[0][8], '半頁 12 行 24 字，小字雙行 24 字，白口，單黑魚尾，四周雙邊');
  assert.equal(rows[0][9], '扉頁鐫「日本國志」');
  assert.equal(rows[0][10], '');
  assert.equal(rows[0][11], '卷首有梁啟超序');
  assert.equal(rows[0][13], '編目：張三');
  // 行 3 只有 A/C/E；C 是 t="str" 公式缓存值，E 是数字
  assert.equal(rows[1][0], '子部·儒家類');
  assert.equal(rows[1][2], '近思錄');
  assert.equal(rows[1][4], '14');
  assert.equal(rows[1][1], '');
  assert.equal(rows[1][5], '');
});

// ================================================
// 5) parseTableFile 分派
// ================================================

test('parseTableFile：按扩展名/MIME 分派 .xlsx / .csv / .tsv / .txt', async () => {
  const xlsx = await parseTableFile(fakeFile('a.xlsx', await loadBytes('import_13col.xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  assert.equal(xlsx.source, 'xlsx');
  assert.equal(xlsx.headers.length, 14);
  assert.equal(xlsx.rows[0][2], '日本國志');

  const gbkCsv = await parseTableFile(fakeFile('b.csv', await loadBytes('import_gbk.csv'), 'text/csv'));
  assert.equal(gbkCsv.source, 'csv');
  assert.equal(gbkCsv.headers[2], '書名');

  const tsv = await parseTableFile(fakeFile('c.tsv', new TextEncoder().encode('書名\t卷數\n文選\t六十卷\n')));
  assert.equal(tsv.source, 'csv');
  assert.deepEqual(tsv.headers, ['書名', '卷數']);
  assert.deepEqual(tsv.rows[0], ['文選', '六十卷']);

  // 无扩展名、靠 MIME 识别
  const byMime = await parseTableFile(fakeFile('d', new TextEncoder().encode('A,B\n1,2\n'), 'text/csv'));
  assert.equal(byMime.source, 'csv');
  assert.deepEqual(byMime.headers, ['A', 'B']);

  // 既无扩展名也无 MIME：靠 ZIP 魔数（PK\x03\x04）认成 xlsx
  const byMagic = await parseTableFile(fakeFile('e.bin', await loadBytes('import_13col.xlsx')));
  assert.equal(byMagic.source, 'xlsx');
  assert.equal(byMagic.headers.length, 14);
  assert.equal(byMagic.rows[0][2], '日本國志');
});

// ================================================
// 6) mapRowsToRecords：表头匹配 / 简繁 / 别名 / 位置回退
// ================================================

test('mapRowsToRecords：模板表头（去 * 与空白）逐字段匹配，序號列不导入', async () => {
  const { headers, rows } = await parseXlsx(await loadBytes('import_template_headers.xlsx'));
  const res = mapRowsToRecords(headers, rows);
  assert.equal(res.matchedBy, 'header');
  assert.equal(res.records.length, 2);
  assertPureRecord(res.records[0]);
  // 13 个字段全部认领 → 无未映射表头
  assert.deepEqual(res.unmappedHeaders, []);
  const r0 = res.records[0];
  assert.equal(r0.category, '經部·小學類');
  assert.equal(r0.title, '說文解字');
  assert.equal(r0.volume, '十五卷');
  assert.equal(r0.shelf, '三·〇五·〇二 靜嘉');
  assert.equal(r0.author, '');                       // 行内空单元格 → 空串
  assert.equal(r0.version, '');
  assert.equal(r0.copies, '1 函 8 册（全）');
  assert.equal(r0.format, '半頁 9 行 18 字，小字雙行 20 字，白口，白魚尾，四周單邊');
  assert.equal(r0.series, '叢書子目：說文解字注');
  assert.equal(r0.catalogers, '編目：趙六');
  const r1 = res.records[1];
  assert.equal(r1.title, '近思錄');
  assert.equal(r1.author, '〔宋〕朱熹、呂祖謙輯〔清〕江永集注');
  assert.equal(r1.appendix, '有朱筆批點');
  assert.equal(r1.series, '');
});

test('mapRowsToRecords：14 列（含序號）表头匹配并报告被忽略的序號列', async () => {
  const { headers, rows } = await parseXlsx(await loadBytes('import_13col.xlsx'));
  const res = mapRowsToRecords(headers, rows);
  assert.equal(res.matchedBy, 'header');
  assert.deepEqual(res.unmappedHeaders, ['序號']);
  assertPureRecord(res.records[1]);
  assert.equal(res.records[1].title, '文選');
  assert.equal(res.records[1].author, '〔梁〕蕭統編〔唐〕李善注');
  assert.equal(res.records[1].copies, '2 函 12 册（缺卷三十至卷三十三）');
});

test('mapRowsToRecords：GBK 中文表头（序號 + 13 繁体 label）全部匹配', async () => {
  const parsed = await parseTableFile(fakeFile('g.csv', await loadBytes('import_gbk.csv'), 'text/csv'));
  const res = mapRowsToRecords(parsed.headers, parsed.rows);
  assert.equal(res.matchedBy, 'header');
  assert.deepEqual(res.unmappedHeaders, ['序號']);
  assert.equal(res.records[0].title, '日本國志');
  assert.equal(res.records[0].shelf, '一·〇二·〇一 堀田');
  assert.equal(res.records[1].series, '文選學');
  assertPureRecord(res.records[0]);
});

test('mapRowsToRecords：简体表头与常见别名（书名/作者/索书号/册数…）匹配', async () => {
  const parsed = await parseTableFile(fakeFile('a.csv', await loadBytes('import_alias_utf8bom.csv'), 'text/csv'));
  assert.deepEqual(parsed.headers.slice(0, 5), ['序号', '类目', '书名', '卷数', '索书号']);
  const res = mapRowsToRecords(parsed.headers, parsed.rows);
  assert.equal(res.matchedBy, 'header');
  assert.deepEqual(res.unmappedHeaders, ['序号']);
  const r = res.records[0];
  assert.equal(r.title, '日本国志');
  assert.equal(r.author, '〔清〕黄遵宪撰');
  assert.equal(r.version, '清光绪十六年刻本');      // 别名「出版」
  assert.equal(r.copies, '4函24册');                 // 别名「册数」
  assert.equal(r.format, '半页12行24字');            // 别名「行款版式」
  assert.equal(r.frontmatter, '扉页镌书名');         // 别名「扉页」
  assert.equal(r.appendix, '卷首有序');
  assert.equal(r.catalogers, '编目：张三');
});

test('mapRowsToRecords：表头完全识别不出且列数 ≥13 → 按模板列序位置回退', async () => {
  const parsed = await parseTableFile(fakeFile('p.csv', await loadBytes('import_position_fallback.csv'), 'text/csv'));
  assert.deepEqual(parsed.headers, ['列1', '列2', '列3', '列4', '列5', '列6', '列7',
    '列8', '列9', '列10', '列11', '列12', '列13', '列14']);
  const res = mapRowsToRecords(parsed.headers, parsed.rows);
  assert.equal(res.matchedBy, 'position');
  assert.deepEqual(res.unmappedHeaders, parsed.headers);   // 全部未按表头使用
  const r = res.records[0];
  assertPureRecord(r);
  // 第 1 列为序號（忽略），其后按 ALL_FIELDS 顺序落位
  assert.equal(r.category, '史部·地理類');
  assert.equal(r.title, '日本國志');
  assert.equal(r.volume, '四十卷');
  assert.equal(r.shelf, '一·〇二·〇一');
  assert.equal(r.author, '〔清〕黃遵憲撰');
  assert.equal(r.version, '清光緒十六年刻本');
  assert.equal(r.copies, '4 函 24 册');
  assert.equal(r.format, '半頁 12 行 24 字');
  assert.equal(r.frontmatter, '扉頁');
  assert.equal(r.verso, '');
  assert.equal(r.appendix, '附録內容');
  assert.equal(r.series, '');
  assert.equal(r.catalogers, '編目：張三');
});

test('mapRowsToRecords：列数不足 13 且表头不匹配 → 不回退，只报未映射表头', () => {
  const res = mapRowsToRecords(['foo', 'bar'], [['1', '2']]);
  assert.equal(res.matchedBy, 'none');
  assert.deepEqual(res.unmappedHeaders, ['foo', 'bar']);
  assert.equal(res.records.length, 1);
  assertPureRecord(res.records[0]);
  for (const f of ALL_FIELDS) assert.equal(res.records[0][f], '');
});

// ================================================
// 7) recordsToTableRows / recordsToCsv
// ================================================

test('recordsToTableRows：14 列表头 + 序號自动编号 + 单元格字符串化', () => {
  const { headers, rows } = recordsToTableRows([FULL_RECORD, { title: '近思錄', seq: 42 }]);
  assert.equal(headers.length, 14);
  assert.deepEqual(headers, TABLE_COLUMNS.map((c) => c.label));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 14);
  assert.equal(rows[0][0], '1');                       // 未给 seq → 行号
  assert.equal(rows[0][1], '史部·地理類');
  assert.equal(rows[0][5], '〔清〕黃遵憲撰');
  assert.equal(rows[0][13], '編目：張三；校對：李四');
  assert.equal(rows[1][0], '42');                      // 显式 seq 优先
  assert.equal(rows[1][2], '近思錄');
  assert.equal(rows[1][3], '');                        // 缺字段 → 空串
});

test('recordsToCsv：14 列表头、引号/逗号/换行转义、CRLF 行尾', () => {
  const csv = recordsToCsv([FULL_RECORD]);
  assert.ok(csv.startsWith('序號,類目,書名,卷數,索書號,著者,版本,函册,版式,扉頁、刊記,紙背文獻,附録,叢書子目,編目者、校對者\r\n'));
  assert.ok(csv.includes('\r\n'));
  const back = parseCsv(csv);
  assert.equal(back.headers.length, 14);
  assert.deepEqual(back.rows[0], recordsToTableRows([FULL_RECORD]).rows[0]);
});

test('recordsToCsv：公式注入防护（= + - @ 与带前导空白者前置单引号）', () => {
  const rec = {
    title: '=1+1',
    volume: '+SUM(A1)',
    shelf: '-2+3',
    author: '@cmd',
    category: ' =HYPERLINK("x")',
    version: '正常值',
  };
  const csv = recordsToCsv([rec]);
  assert.ok(csv.includes("'=1+1"), 'actual: ' + csv);
  assert.ok(csv.includes("'+SUM(A1)"));
  assert.ok(csv.includes("'-2+3"), '以 - 开头的值也必须加前缀');
  assert.ok(csv.includes("'@cmd"));
  assert.ok(csv.includes('"\' =HYPERLINK(""x"")"'), '前导空白 + 引号需双重处理');
  // 解析回来时仍带单引号（安全文本），不会残留多余引号
  const back = parseCsv(csv);
  assert.equal(back.rows[0][2], "'=1+1");
  assert.equal(back.rows[0][3], "'+SUM(A1)");
  assert.equal(back.rows[0][6], '正常值');
});

test('recordsToCsv：带引号/逗号/换行的字段完整往返', () => {
  const rec = {
    title: '文選,六十卷',
    version: '第一行\n第二行',
    author: '說文"解字',
  };
  const csv = recordsToCsv([rec]);
  assert.ok(csv.includes('"文選,六十卷"'));
  assert.ok(csv.includes('"說文""解字"'));
  assert.ok(csv.includes('"第一行\n第二行"'));
  const back = parseCsv(csv);
  assert.equal(back.rows[0][2], '文選,六十卷');
  assert.equal(back.rows[0][5], '說文"解字');
  assert.equal(back.rows[0][6], '第一行\n第二行');
});

// ================================================
// 8) recordToText / recordsToText
// ================================================

test('recordToText（format 非空）：只输出一行「行款版式：{format}」，不展开模板行', () => {
  const text = recordToText(FULL_RECORD);
  const lines = text.split('\n');
  assert.equal(lines.length, 6, '实际输出：\n' + text);
  assert.equal(lines[0], '书名/卷数：日本國志/四十卷  索书号：一·〇二·〇一 堀田');
  assert.equal(lines[1], '著者：〔清〕黃遵憲撰');
  assert.equal(lines[2], '版本：清光緒十六年（1890）廣州富文齋刻本');
  assert.equal(lines[3], '册数：4 函 24 册（全）');
  assert.equal(lines[4], '行款版式：半頁 12 行 24 字，小字雙行 24 字，白口，單黑魚尾，四周雙邊');
  assert.equal(lines[5], '附注：扉頁刊記：扉頁鐫「日本國志」，光緒十六年刊 ｜ 紙背文獻：紙背有元人戶籍文書'
    + ' ｜ 附録：卷首有梁啟超序 ｜ 叢書子目：叢書子目：無 ｜ 编目者：編目：張三；校對：李四');
  // 明确不出现版式展开模板行
  assert.ok(!text.includes('单节版'), 'format 非空时不得输出模板行');
  assert.ok(!text.includes('两节版'));
  assert.ok(!text.includes('版心镌'));
});

test('recordToText（format 为空）：先「行款版式：」一行，再并列 7 行模板原文（X 保留）', () => {
  const rec = { title: '說文解字', volume: '十五卷', shelf: '三·〇五·〇二', format: '' };
  const text = recordToText(rec);
  const lines = text.split('\n');
  // 用户给定骨架：只有首行带「行款版式：」前缀，其后 7 行是并列行
  assert.equal(lines[4], '行款版式：');
  assert.equal(lines[5], '单节版：半页X行X字，小字双行X字（眉上镌评／注，行X字）；');
  assert.equal(lines[6], '两节版：上下双栏，上栏X行X字，下栏X行X字，小字双行X字；');
  assert.equal(lines[7], '三节版：上中下三栏，上栏X行X字，中栏X行X字，下栏X行X字，小字双行X字；');
  assert.equal(lines[8], '内外栏：内外双栏，内栏X行X字，外栏X行X字，小字双行X字；');
  assert.equal(lines[9], '白口（或黑口） 鱼尾：（单黑鱼尾、双黑鱼尾、花鱼尾、白鱼尾）');
  assert.equal(lines[10], '版框（左右双边、四周单边、四周双边），版框高宽（半页）：框高Xcm，寛Xcm；');
  assert.equal(lines[11], '版心镌（字数/书名/卷次/页次/刻工/出版者）');
  assert.equal(lines.length, 13);   // 4 行骨架 + 「行款版式：」+ 7 行并列模板 + 1 行附注
  assert.equal(lines[0], '书名/卷数：說文解字/十五卷  索书号：三·〇五·〇二');
});

test('recordToText：空记录 → 各字段处「（未填）」+ 版本/册数/附注模板提示', () => {
  const text = recordToText({});
  const lines = text.split('\n');
  assert.equal(lines[0], '书名/卷数：（未填）/（未填）  索书号：（未填）');
  assert.equal(lines[1], '著者：（未填）');
  assert.equal(lines[2], '版本：出版时代/出版地/出版者：××/××/××刻本（抄本、活字本、套印本、石印本等；'
    + '如是翻刻应注明“翻刻某本”；如是日本刻本、朝鲜刻本也应标注翻刻依据的版本）。配补情况。');
  assert.equal(lines[3], '册数：X册 缺存情况：（存X卷：X至X）；或（缺X卷：X至X）');
  assert.equal(lines[4], '行款版式：');
  assert.equal(lines.slice(5, 12).filter((l) => l.startsWith('行款版式：')).length, 0,
    '并列的 7 行不得再带「行款版式：」前缀');
  assert.ok(lines[12].startsWith('附注：酌情著录序跋信息；'));
  assert.equal(lines.length, 13);
  assert.equal((text.match(/（未填）/g) || []).length, 4, 'title/volume/shelf/author 四处未填');
});

test('recordToText：附注只拼非空项；全部为空时输出模板提示句', () => {
  const onlyVerso = recordToText({ title: 'A', format: 'x', verso: '紙背文書' });
  assert.ok(onlyVerso.split('\n')[5].startsWith('附注：紙背文獻：紙背文書'));
  assert.ok(!onlyVerso.includes('扉頁刊記'));

  const none = recordToText({ title: 'A', format: 'x' });
  assert.equal(none.split('\n')[5], '附注：' + (
    '酌情著录序跋信息；内封面镌有XX ，有牌记：XX；是否有纸背文献（无则不著录）；'
    + '书签书名；纸张材质；藏书印；如装帧形式特殊，可著录装帧特点，如五孔装等；'
    + '是否有日文假名或谚文等信息。'));
});

test('recordsToText：多条用一行 ──────── 分隔，无尾随空行', () => {
  const text = recordsToText([FULL_RECORD, { title: '近思錄', volume: '十四卷', format: '半頁 11 行 21 字' }]);
  const blocks = text.split('\n────────\n');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].split('\n').length, 6);
  assert.equal(blocks[1].split('\n').length, 6);
  assert.equal(blocks[1].split('\n')[0], '书名/卷数：近思錄/十四卷  索书号：（未填）');
  assert.equal(recordsToText([]), '');
  assert.equal(recordsToText([{ title: 'A', format: 'x' }]).split('\n').length, 6);
});

// ================================================
// 9) 端到端：夹具 → 记录 → 著录/CSV
// ================================================

test('端到端：xlsx 夹具 → mapRowsToRecords → recordToText / recordsToCsv 全链路', async () => {
  const parsed = await parseTableFile(fakeFile('import_13col.xlsx', await loadBytes('import_13col.xlsx'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  const { records, matchedBy } = mapRowsToRecords(parsed.headers, parsed.rows);
  assert.equal(matchedBy, 'header');
  assert.equal(records.length, 2);

  const text = recordsToText(records);
  assert.ok(text.includes('书名/卷数：日本國志/四十卷  索书号：一·〇二·〇一 堀田'));
  assert.ok(text.includes('著者：〔清〕黃遵憲撰'));
  assert.ok(text.includes('行款版式：半頁 12 行 24 字'));
  assert.ok(text.includes('冊') || text.includes('册'));
  assert.ok(text.includes('\n────────\n'));

  const csv = recordsToCsv(records);
  const back = parseCsv(csv);
  assert.equal(back.headers.length, 14);
  assert.equal(back.rows.length, 2);
  assert.equal(back.rows[1][2], '文選');
  assert.equal(back.rows[1][1], '集部·別集類');
});
