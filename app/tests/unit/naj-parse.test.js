// ================================================
// unit/naj-parse.test.js — 国立公文書館デジタルアーカイブ 解析器单测
// ================================================
// 夹具全部取自实站真实响应（2026-10 抓取），未做规范化：
//   result_page.html  —— 检索结果页（命中数头 + 前 2 条，kw0=論語 / ks0=kw_all，命中 715）
//   result_empty.html —— 零结果页（「該当する資料が見つかりませんでした。」）
//   record_item.json  —— 件名・細目 JSON-LD（/item/1017408）
//   record_file.json  —— 簿冊 JSON-LD（/file/3879332「増訂四書大全」，真实汉籍）
// 回归重点：
//   1) JSON-LD 的属性键是**紧凑前缀名**（dct:title），不是展开 URI
//      —— 取错键会静默返回空标题（曾发生）
//   2) `prov:*Time = "0000"` 是该站的「年代不详」占位，必须归零
//   3) `dct:source` 指向 ead:Acquisition 空白节点：媒体の種別在那里，
//      且**绝不能**把 `_:xxx` 当成出処显示
//   4) 零结果页没有 archive-result-table / count-number，须单独识别为 total=0
//   5) 结果页条目内部还有 ol>li（階層），不能按 <li> 粗暴切分
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clean, decodeEntities, stripBrackets, splitNajPath, toPageUrl, isNajUrl,
  buildSearchUrl, buildRecordUrl, parseSearchPage, parseResultItem,
  parseRecordJson, recordToPairs, itemToPairs, citationOf, citationOfItem, SCOPES,
  classifySearch, TYPES, IMG_TYPES, LIMITS, STACKS, ROWS_OPTIONS,
  INSTITUTIONS, OLD_HOLDINGS, NAIKAKU_BUNKO,
} from '../../src/js/core/naj-parse.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'naj');
const fx = (name) => readFileSync(join(FIX, name), 'utf8');

// ---------------------------------------------------------------- 基础工具
test('decodeEntities/clean：实体与空白归一', () => {
  assert.equal(decodeEntities('a&nbsp;b&#32;c'), 'a b c');
  assert.equal(decodeEntities('&amp;&lt;&gt;'), '&<>');
  assert.equal(clean(' 甲 <BR> 乙 &nbsp; 丙 '), '甲 乙 丙');
  // 行内标签不得插入空格：原站标题拆成多 span，插空格会得到「後 漢書」这种假标题
  assert.equal(clean('論<span class="text-highlight">語</span>集註'), '論語集註');
  assert.equal(clean('<span>後</span><span>漢書</span>'), '後漢書');
  // 块级标签仍作为分隔
  assert.equal(clean('<div>甲</div><div>乙</div>'), '甲 乙');
});

test('stripBrackets：去掉日文著录方括号', () => {
  assert.equal(stripBrackets('[請求番号]'), '請求番号');
  assert.equal(stripBrackets('［保存場所］'), '保存場所');
  assert.equal(stripBrackets('作成・取得者'), '作成・取得者');
});

test('splitNajPath/toPageUrl/isNajUrl：层级与页面地址', () => {
  assert.deepEqual(splitNajPath('https://www.digital.archives.go.jp/file/3879332'),
    { level: 'file', id: '3879332' });
  assert.deepEqual(splitNajPath('https://example.com/x'), { level: '', id: '' });
  assert.equal(toPageUrl('http://www.digital.archives.go.jp/item/1017408'),
    'https://www.digital.archives.go.jp/item/1017408');
  assert.equal(toPageUrl('_:bnode123'), ''); // 空白节点不得当链接
  assert.equal(isNajUrl('https://www.digital.archives.go.jp/file/1'), true);
  assert.equal(isNajUrl('https://www.digital.archives.go.jp.evil.com/file/1'), false);
});

// ---------------------------------------------------------------- 检索 URL
test('buildSearchUrl：按原站参数习惯拼装（ks0/kw0/rows/page）', () => {
  const u = buildSearchUrl({ keyword: '論語', scope: 'kw_title', rows: 20, page: 2 });
  assert.equal(u, 'https://www.digital.archives.go.jp/search?ks0=kw_title&kw0=%E8%AB%96%E8%AA%9E&rows=20&page=2');
  // 默认范围 = kw_all（原站的「すべて」）
  assert.match(buildSearchUrl({ keyword: '漢書' }), /ks0=kw_all/);
  assert.match(buildSearchUrl({ keyword: '漢書' }), /rows=20/);
  assert.match(buildSearchUrl({ keyword: '漢書' }), /page=1/);
  // 关键词两端空白须去掉
  assert.match(buildSearchUrl({ keyword: '  漢書  ' }), /kw0=%E6%BC%A2%E6%9B%B8/);
  assert.equal(SCOPES.length, 5);
  assert.equal(SCOPES[0].value, 'kw_all');
});

test('buildRecordUrl：由记录页 URL 或 level+id 生成 JSON-LD 地址', () => {
  assert.equal(buildRecordUrl('https://www.digital.archives.go.jp/file/3879332'),
    'https://www.digital.archives.go.jp/file/3879332.json');
  assert.equal(buildRecordUrl('item', '1017408'),
    'https://www.digital.archives.go.jp/item/1017408.json');
  assert.equal(buildRecordUrl('https://example.com/x'), '');
});

// ---------------------------------------------------------------- 详细检索（V9.6）
test('TYPES：资料种别取值与实测一致（da22 簿册 / da23 件名·细目 / da21 资料群）', () => {
  const byVal = Object.fromEntries(TYPES.map((t) => [t.value, t.label]));
  assert.equal(byVal.da22, '簿册');
  assert.equal(byVal.da23, '件名·细目');
  assert.equal(byVal.da21, '资料群');
  // 界面标签全部中文（用户要求）
  for (const t of TYPES) assert.ok(/[\u4e00-\u9fa5]/.test(t.label), t.label + ' 应为中文');
});

test('buildSearchUrl：详细检索条件按原站参数名拼装', () => {
  const u = buildSearchUrl({
    keyword: '漢書', scope: 'kw_all', types: ['da22'], imgTypes: ['01'],
    limits: ['01'], stacks: ['01'], yearFrom: 1700, yearTo: 1900,
    inst: '00a', ware: '01', referenceFrom: 'A', referenceTo: 'B',
    fond: '3602612', rows: 50, page: 3,
  });
  const q = new URL(u).searchParams;
  assert.equal(q.get('ks0'), 'kw_all');
  assert.equal(q.get('kw0'), '漢書');
  assert.equal(q.get('type'), 'da22');
  assert.equal(q.get('img_type'), '01');
  assert.equal(q.get('limit'), '01');
  assert.equal(q.get('stack'), '01');
  assert.equal(q.get('date_y_from'), '1700');
  assert.equal(q.get('date_y_to'), '1900');
  assert.equal(q.get('inst'), '00a');
  assert.equal(q.get('ware'), '01');
  assert.equal(q.get('reference_from'), 'A');
  assert.equal(q.get('reference_to'), 'B');
  assert.equal(q.get('fond'), '3602612');
  assert.equal(q.get('rows'), '50');
  assert.equal(q.get('page'), '3');
});

test('buildSearchUrl：多选条件重复出现、单值写法兼容、缺省不发送', () => {
  const u = buildSearchUrl({ keyword: '論語', types: ['da22', 'da23'], imgTypes: ['01', '11'] });
  const pairs = [...new URL(u).searchParams.entries()].filter(([k]) => k === 'type' || k === 'img_type');
  assert.deepEqual(pairs, [['type', 'da22'], ['type', 'da23'], ['img_type', '01'], ['img_type', '11']]);
  // 单值写法（旧接口）仍可用
  assert.match(buildSearchUrl({ keyword: 'x', imgType: '01' }), /img_type=01/);
  // 未提供的条件一律不出现（避免给原站送空参数）
  const bare = buildSearchUrl({ keyword: 'x' });
  for (const k of ['type', 'img_type', 'limit', 'stack', 'date_y_from', 'date_y_to', 'inst', 'ware', 'fond', 'reference_from']) {
    assert.equal(new URL(bare).searchParams.has(k), false, k + ' 不应出现');
  }
  // 年份空串不发送
  assert.equal(new URL(buildSearchUrl({ keyword: 'x', yearFrom: '', yearTo: '' })).searchParams.has('date_y_from'), false);
});

test('NAIKAKU_BUNKO：内閣文庫漢籍分类 ID 与实测一致（含新書部）', () => {
  assert.equal(NAIKAKU_BUNKO.id, '2308962');
  const g = Object.fromEntries(NAIKAKU_BUNKO.groups.map((x) => [x.label, x]));
  assert.equal(g['漢籍（漢書部）'].id, '3602612');
  assert.equal(g['經部'].id, '3610545');
  assert.equal(g['史部'].id, '3602613');
  assert.equal(g['子部'].id, '3611449');
  assert.equal(g['集部'].id, '3610170');
  assert.equal(g['叢書部'].id, '1080082');
  assert.equal(g['新書部'].id, '1083362');
  // 每项都能定位到原站分类页（便于无关键词时直接浏览）
  for (const x of NAIKAKU_BUNKO.groups) {
    assert.match(x.pageUrl, /^https:\/\/www\.digital\.archives\.go\.jp\/fonds\/\d+$/);
    assert.ok(x.jp && x.jp.length > 0, x.label + ' 应保留原站名称');
  }
});

test('INSTITUTIONS/OLD_HOLDINGS：选项自原站表单提取（含红葉山文庫）', () => {
  assert.ok(INSTITUTIONS.length >= 140, '机关数 ' + INSTITUTIONS.length);
  assert.ok(OLD_HOLDINGS.length >= 50, '文库数 ' + OLD_HOLDINGS.length);
  assert.ok(INSTITUTIONS.some(([v, l]) => v === '00a' && l === '内閣官房'));
  assert.ok(OLD_HOLDINGS.some(([v, l]) => v === '01' && l === '紅葉山文庫'));
  assert.ok(OLD_HOLDINGS.some(([v, l]) => v === '02' && l === '昌平坂学問所'));
});

// ---------------------------------------------------------------- 结果页
test('parseSearchPage：命中数、区间、条目数、条件回显', () => {
  const r = parseSearchPage(fx('result_page.html'));
  assert.equal(r.total, 715);
  assert.equal(r.from, 1);
  assert.equal(r.to, 20);
  assert.equal(r.rows, 20);
  assert.equal(r.items.length, 2);      // 夹具只截了前 2 条，命中数仍是真实的 715
  assert.equal(r.isForm, false);
  assert.equal(r.isEmpty, false);
  assert.deepEqual(r.echo, { kw0: '論語', ks0: 'kw_all' });
});

test('parseSearchPage：首条字段齐备（簿冊 + 階層 + 請求番号）', () => {
  const it = parseSearchPage(fx('result_page.html')).items[0];
  assert.equal(it.no, '1');
  assert.equal(it.kind, '簿冊');
  assert.equal(it.level, 'file');
  assert.equal(it.id, '3879332');
  assert.equal(it.recordId, 'da11/3879332');
  assert.equal(it.title, '増訂四書大全');
  assert.equal(it.url, 'https://www.digital.archives.go.jp/file/3879332');
  assert.equal(it.hierarchy.length, 2);       // 内部 ol>li 未被误当成结果条目
  assert.equal(it.hierarchy[0].title, '寄贈・寄託文書');
  assert.equal(it.hierarchy[1].url, 'https://www.digital.archives.go.jp/fonds/3791162');
  const by = Object.fromEntries(it.fields.map(f => [f.label, f.value]));
  assert.equal(by['請求番号'], '寄贈02349100');
  assert.equal(by['媒体の種別'], '紙');
  assert.equal(by['数量'], '24');
  // 字段标签不带方括号；正文里的 text-highlight 高亮标签被剥掉
  assert.ok(!it.fields.some(f => /[[［\]]/.test(f.label)));
  assert.ok(by['関連事項'].includes('論語'));
  assert.ok(!by['関連事項'].includes('<span'));
});

test('parseSearchPage：缺 count-range 块时区间必须是 null（不得猜）', () => {
  // 回归：旧实现拿不到 count-range 时会退化为「扫全页前两个数字」，
  // 静默给出 from=1/to=2，把 36 页算成 358 页。宁可没有区间。
  const html = '<div class="count-number" data-count="715">715</div>'
    + '<div><span>7</span><span>9</span><span>11</span></div>'
    + '<ul class="archive-result-table__body"><li class="archive-result-table__body-item" role="row">'
    + '<div class="result-header__title"><a href="https://www.digital.archives.go.jp/file/1">甲</a></div>'
    + '</li></ul>';
  const r = parseSearchPage(html);
  assert.equal(r.total, 715);
  assert.equal(r.from, null);
  assert.equal(r.to, null);
  assert.equal(r.rows, null);
  assert.equal(r.items.length, 1);
});

test('parseSearchPage：满页 20 条时切片正确、末条字段完整、可重复调用', () => {
  const html = fx('result_page_20.html');
  const a = parseSearchPage(html);
  assert.equal(a.items.length, 20);
  assert.equal(a.from, 1);
  assert.equal(a.to, 20);
  assert.equal(a.rows, 20);
  // 末条不能被 </ul> 截断（模块级 /g 正则靠 lastIndex 复位，重复调用必须结果一致）
  assert.ok(a.items[19].title.length > 0, '末条标题非空');
  assert.ok(a.items[19].url.startsWith('https://www.digital.archives.go.jp/'));
  assert.ok(a.items[19].fields.length > 0, '末条著录字段非空');
  const b = parseSearchPage(html);
  assert.deepEqual(b.items.map(i => i.title), a.items.map(i => i.title));
  assert.deepEqual(b.items[19], a.items[19]);
});

test('classifySearch：四种情形必须区分（改版导致解析不出 ≠ 没有命中）', () => {
  // 正常命中
  assert.equal(classifySearch(parseSearchPage(fx('result_page.html'))), 'ok');
  // 零结果
  assert.equal(classifySearch(parseSearchPage(fx('result_empty.html'))), 'empty');
  // 检索表单页
  assert.equal(classifySearch(parseSearchPage('<form class="archive-finder-form"></form>')), 'form');
  // 有命中数但条目类名变了（原站改版）——绝不能报「没有命中」
  const weird = '<span class="count-number" data-count="715">715</span>'
    + '<div class="archive-result-table"><ul class="archive-result-table__body">'
    + '<li class="SOMETHING-ELSE">x</li></ul></div>';
  const parsed = parseSearchPage(weird);
  assert.equal(parsed.total, 715);
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.isEmpty, false);
  assert.equal(classifySearch(parsed), 'unparsed');
  // 命中数取不到且无条目 → 按空处理
  assert.equal(classifySearch({ total: null, items: [], isEmpty: false, isForm: false }), 'empty');
  assert.equal(classifySearch(null), 'unparsed');
});

test('parseSearchPage：零结果页 → total=0 且 isEmpty', () => {
  const r = parseSearchPage(fx('result_empty.html'));
  assert.equal(r.total, 0);
  assert.equal(r.isEmpty, true);
  assert.equal(r.isForm, false);
  assert.equal(r.items.length, 0);
  assert.deepEqual(r.echo, { kw0: 'zzzqqq', ks0: 'kw_all' });
});

test('parseSearchPage：检索表单页（未执行检索）→ isForm', () => {
  const r = parseSearchPage('<html><body><form class="archive-finder-form" action="/search"></form></body></html>');
  assert.equal(r.isForm, true);
  assert.equal(r.isEmpty, false);
  assert.equal(r.total, null);
  assert.equal(r.items.length, 0);
});

test('parseResultItem：标题链接缺失时不臆造标题', () => {
  const it = parseResultItem('<div class="archive-result-table__body-item-cell-label">3</div>');
  assert.equal(it.title, '');
  assert.equal(it.url, '');
  assert.equal(it.level, '');
  assert.equal(it.no, '3');
});

test('itemToPairs：按 资料种别/阶层/字段 顺序展开且剔除空值', () => {
  const pairs = itemToPairs(parseSearchPage(fx('result_page.html')).items[0]);
  assert.equal(pairs[0].label, 'No.');
  assert.equal(pairs[1].label, '資料種別');
  assert.equal(pairs[2].label, '階層');
  assert.equal(pairs[2].value, '寄贈・寄託文書 ＞ 小杉煕・醇旧蔵書');
  assert.ok(pairs.every(p => p.value !== ''));
});

test('citationOfItem：出典含馆名、书名、请求番号与可点链接', () => {
  const c = citationOfItem(parseSearchPage(fx('result_page.html')).items[0]);
  assert.equal(c, '国立公文書館所蔵「増訂四書大全」（寄贈02349100） https://www.digital.archives.go.jp/file/3879332');
});

// ---------------------------------------------------------------- 详情 JSON-LD
test('parseRecordJson：件名（item）字段全解析', () => {
  const rec = parseRecordJson(fx('record_item.json'));
  assert.equal(rec.uri, 'http://www.digital.archives.go.jp/item/1017408');
  assert.equal(rec.level, 'item');
  assert.equal(rec.levelName, '件名·细目');
  assert.equal(rec.title, '国民年金特別会計法');
  assert.equal(rec.identifier, '平１４法制00415100-01200');
  assert.equal(rec.creator, '内閣法制局第三部（大蔵省関係）');
  assert.equal(rec.physloc, '本館');
  assert.equal(rec.dateFrom, '1961');
  assert.equal(rec.dateText, '1961');
  assert.equal(rec.parentUri, 'http://www.digital.archives.go.jp/file/1017155');
  assert.equal(rec.parentPageUrl, 'https://www.digital.archives.go.jp/file/1017155');
  assert.equal(rec.iiifManifest, 'https://www.digital.archives.go.jp/api/iiif/1017408/manifest.json');
  assert.match(rec.thumbnail, /^https:\/\/www\.digital\.archives\.go\.jp\/thumb\/1017408\//);
  assert.equal(rec.contentUrl, 'https://www.digital.archives.go.jp/img/1017408');
  assert.equal(rec.pageUrl, 'https://www.digital.archives.go.jp/item/1017408');
  // ead:materialspec 空白节点解析成 階層情報/資料種別/目録データ種別
  const specLabels = rec.specs.map(s => s.label);
  assert.ok(specLabels.includes('階層情報'));
  assert.ok(specLabels.includes('資料種別'));
  assert.equal(rec.specs.find(s => s.label === '階層情報').value,
    '行政文書 ＞ 内閣法制局 ＞ 法令案審議録関係');
  // 紧凑前缀键取到了值（回归：曾因按展开 URI 取键而全空）
  assert.notEqual(rec.title, '');
});

test('parseRecordJson：簿冊（file）——0000 年代归零、媒体の種別回填、无 _: 外泄', () => {
  const rec = parseRecordJson(fx('record_file.json'));
  assert.equal(rec.level, 'file');
  assert.equal(rec.levelName, '簿册');
  assert.equal(rec.title, '増訂四書大全');
  assert.equal(rec.identifier, '寄贈02349100');
  assert.equal(rec.dateFrom, '');
  assert.equal(rec.dateTo, '');
  assert.equal(rec.dateText, '');
  assert.equal(rec.medium, '紙');            // 来自 dct:source 的 ead:Acquisition 节点
  assert.equal(rec.source, '');
  const pairs = recordToPairs(rec);
  assert.ok(pairs.some(p => p.label === '媒体の種別' && p.value === '紙'));
  assert.ok(!pairs.some(p => /^_:/ .test(p.value)), '不得显示 JSON-LD 空白节点标识');
  assert.ok(!pairs.some(p => p.value === ''), '空值不得进入展示对');
  assert.equal(pairs.find(p => p.label === '作成年月日'), undefined); // 年代不详则不显示该行
});

test('parseRecordJson：非法输入返回 null 而不抛错', () => {
  assert.equal(parseRecordJson('not json'), null);
  assert.equal(parseRecordJson(''), null);
  assert.equal(parseRecordJson('{"@graph":[]}'), null);
  assert.equal(parseRecordJson(null), null);
});

test('citationOf：含馆名/书名/参照码/链接', () => {
  const rec = parseRecordJson(fx('record_item.json'));
  assert.equal(citationOf(rec),
    '国立公文書館所蔵「国民年金特別会計法」（平１４法制00415100-01200） https://www.digital.archives.go.jp/item/1017408');
});
