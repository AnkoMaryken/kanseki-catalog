// ================================================
// unit/naj-dl.test.js — 国立公文书馆「整册 PDF 下载」核心单测（V9.8）
// ================================================
// 夹具取自实站真实响应（2026-10 抓取后截取 3 条），未做规范化：
//   file_page_volumes.html  —— /file/1081945（古逸叢書，共 50 册）前 3 行，含行内嵌的分类树
//   viewer_page_591091.html —— /img/591091（爾雅３）下载网格前 3 页，含逐页 cid
//   manifest_591091.json    —— /api/iiif/591091/manifest.json 前 3 个 canvas
//
// 本文件重点守两件事（用户硬性要求）：
//   1) 解析正确：册清单、逐页 cid、IIIF canvas 一个都不能少；
//   2) **零缺册**：只要有一册没完成 / 页数对不上 / 页数不可核验 / 文件名重复，
//      auditTask 就必须拒绝放行 —— 尤其是「下了第 13 册却漏了第 2 册」这种情形。
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  numericId, chunk, nativePdfUrl, buildCidBody, viewerUrl, manifestUrl,
  parseVolumeListPage, parseViewerPage, parseManifest, parseViewerTitle,
  sanitizeName, applyTemplate, truncateForNas, buildVolumeNames,
  createTask, auditTask, sequenceProblem, buildReportCsv, buildManifestJsonl,
  summarizeTask, retryableVolumes, BATCH_LIMIT, DEFAULT_TEMPLATES, NAME_TOKENS, TEMPLATE_PRESETS,
  parseBatchInput, normalizeCode, matchReferenceCandidates, referenceOfItem,
  decidePlanSource, planErrorText,
} from '../../src/js/core/naj-dl.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'naj');
const fx = (n) => readFileSync(join(FIX, n), 'utf8');

// ---------------------------------------------------------------- 基础工具

test('numericId：从请求号/URL 取末段数字 ID', () => {
  assert.equal(numericId('da11/591227'), '591227');
  assert.equal(numericId('https://www.digital.archives.go.jp/item/591091'), '591091');
  assert.equal(numericId(''), '');
  assert.equal(numericId('keine-zahl'), '');
});

test('chunk：按批切分，且批大小兜底为 ≥1', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2, 3], 0), [[1], [2], [3]]); // 0 兜底为 1，绝不产出空批死循环
  assert.deepEqual(chunk([], 50), []);
});

test('原生端点常量与 URL：PDF 上限 50 页、图像 100 页（取自原站 data-limit-count）', () => {
  assert.equal(BATCH_LIMIT.imagePdf, 50);
  assert.equal(BATCH_LIMIT.imageJpeg, 100);
  assert.equal(BATCH_LIMIT.imageJp2, 100);
  assert.equal(
    nativePdfUrl('591091', 'imagePdf'),
    'https://www.digital.archives.go.jp/contentDownload/591091?type=imagePdf',
  );
  assert.equal(viewerUrl('591091'), 'https://www.digital.archives.go.jp/img/591091');
  assert.equal(manifestUrl('591091'), 'https://www.digital.archives.go.jp/api/iiif/591091/manifest.json');
});

test('buildCidBody：cid 逐页重复且做 percent-encoding（`/` 必须编码）', () => {
  const body = buildCidBody(['da12/C104174385500', 'da12/C104174385600']);
  assert.equal(body, 'cid=da12%2FC104174385500&cid=da12%2FC104174385600');
});

// ---------------------------------------------------------------- 目录页解析

test('parseVolumeListPage：解析出全部册（真实 /file/ 夹具）', () => {
  const p = parseVolumeListPage(fx('file_page_volumes.html'));
  assert.equal(p.bookTitle, '古逸叢書');
  assert.equal(p.total, 3);
  assert.deepEqual(p.volumes.map((v) => v.id), ['591227', '591091', '590950']);
  assert.deepEqual(p.volumes.map((v) => v.no), [1, 2, 3]);
  assert.equal(p.volumes[0].title, '古逸叢書叙目');
  assert.equal(p.volumes[1].title, '爾雅３');
  assert.equal(p.volumes[0].recordValue, 'da11/591227');
  assert.match(p.volumes[0].url, /\/item\/591227$/);
});

test('parseVolumeListPage：分类链剔除顶层「内閣文庫」与本书自身（真实夹具）', () => {
  const p = parseVolumeListPage(fx('file_page_volumes.html'));
  // 原站层级为 内閣文庫 ＞ 漢書 ＞ 叢書の部 ＞ 古逸叢書
  assert.deepEqual(p.categoryPath, ['漢書', '叢書の部']);
  assert.ok(!p.categoryPath.includes('内閣文庫'));
  assert.ok(!p.categoryPath.includes('古逸叢書'));
});

test('parseVolumeListPage：没有 ID 的行被跳过，绝不用序号臆造册号', () => {
  const html = `<html><head><title>测试书</title></head><body>
    <li class="archive-result-table__body-item" role="row" aria-labelledby="row-1-title">
      <div class="archive-result-table__body-item-cell cell-number" role="cell">
        <span class="archive-result-table__body-item-cell-label">1</span></div>
      <h3 id="row-1-title" class="result-header__title"><a href="/item/111111">真的有册</a></h3>
      <input type="checkbox" name="id" value="da11/111111">
    </li>
    <li class="archive-result-table__body-item" role="row" aria-labelledby="row-2-title">
      <div class="archive-result-table__body-item-cell cell-number" role="cell">
        <span class="archive-result-table__body-item-cell-label">2</span></div>
      <h3 id="row-2-title" class="result-header__title"><a href="/item/">无 ID 行</a></h3>
    </li></body></html>`;
  const p = parseVolumeListPage(html);
  assert.equal(p.total, 1);
  assert.equal(p.volumes[0].id, '111111');
});

test('parseVolumeListPage：空页/异常输入不抛错，返回 0 册', () => {
  for (const bad of ['', null, undefined, '<html></html>', 'not html at all']) {
    const p = parseVolumeListPage(bad);
    assert.equal(p.total, 0);
  }
});

// ---------------------------------------------------------------- 查看器页解析

test('parseViewerPage：逐页 cid 顺序正确（真实夹具）', () => {
  const v = parseViewerPage(fx('viewer_page_591091.html'));
  assert.equal(v.kindHint, 'iiifcanvas');
  assert.equal(v.maxCount, 86);
  assert.equal(v.limit, 100);
  assert.equal(v.pages.length, 3);
  assert.deepEqual(v.pages.map((p) => p.cid), [
    'da12/C104174385500', 'da12/C104174385600', 'da12/C104174385700',
  ]);
  assert.deepEqual(v.pages.map((p) => p.no), [1, 2, 3]);
});

test('parseViewerPage 回归：__item-footer 不得被当成新页（否则取不到 cid）', () => {
  // 该页每项内部有 <div class="p-viewer-download__item-footer">；
  // 若按前缀匹配切片，会在页脚处截断，checkbox 的 value 丢失 → 整册判为「无可下载页」。
  const v = parseViewerPage(fx('viewer_page_591091.html'));
  assert.equal(v.pages.length, 3);
  assert.ok(v.pages.every((p) => p.cid.startsWith('da12/')));
});

test('parseViewerPage：无下载网格时返回空，不臆造页', () => {
  const v = parseViewerPage('<html><body><p>该资料不提供下载</p></body></html>');
  assert.equal(v.pages.length, 0);
  assert.equal(v.kindHint, '');
});

test('parseViewerTitle：从查看器页补书名（实测格式「ビューア | 書名」）', () => {
  // 只贴 ID 批量提交时，.json 端点偶发改回 HTML，此时靠查看器页拿书名（实测踩过）
  assert.equal(parseViewerTitle('<html><head><title>ビューア | 古逸叢書叙目</title></head></html>'), '古逸叢書叙目');
  assert.equal(parseViewerTitle('<title>国立公文書館デジタルアーカイブ | 爾雅３</title>'), '爾雅３');
  // 无「|」时整体作为书名
  assert.equal(parseViewerTitle('<title>古逸叢書</title>'), '古逸叢書');
  // 标题缺失时退回查看器页头部的上位书名链接
  assert.equal(
    parseViewerTitle('<html><body><a class="viewer-header__title-link" href="/file/1081945">古逸叢書</a></body></html>'),
    '古逸叢書',
  );
  // 纯「ビューア」之类的无信息标题不当作书名
  assert.equal(parseViewerTitle('<title>ビューア</title><body></body>'), '');
  assert.equal(parseViewerTitle(''), '');
});

// ---------------------------------------------------------------- IIIF 清单

test('parseManifest：取 canvas、页数与图片地址（真实夹具）', () => {
  const m = parseManifest(fx('manifest_591091.json'));
  assert.equal(m.label, '爾雅３');
  assert.equal(m.pageCount, 3);
  assert.equal(m.license, 'https://www.digital.archives.go.jp/secondary-use');
  assert.match(m.canvases[0].imageUrl, /\/full\/max\/0\/native\.jpg$/);
  assert.match(m.canvases[0].serviceId, /M1000000000000101774_0001\.jp2$/);
});

test('parseManifest：结构不符返回 null（不把 HTML/空对象当清单）', () => {
  assert.equal(parseManifest('{"a":1}'), null);
  assert.equal(parseManifest('<!DOCTYPE html>'), null);
  assert.equal(parseManifest('{bad json'), null);
});

// ---------------------------------------------------------------- 命名模板

test('sanitizeName：Windows 非法字符、连续点、空白', () => {
  assert.equal(sanitizeName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  assert.equal(sanitizeName('书名..卷'), '书名.卷');
  assert.equal(sanitizeName('  尔雅３  '), '尔雅３');
  assert.equal(sanitizeName('...'), '未命名');
  assert.equal(sanitizeName(''), '未命名');
});

test('applyTemplate：字段替换与补零', () => {
  const ctx = { 书名: '爾雅３', 册次: 7, 册名: '卷七', 总册数: 50 };
  assert.equal(applyTemplate('{册次:03}_{册名}', ctx), '007_卷七');
  assert.equal(applyTemplate('{书名}_{册次}', ctx), '爾雅３_7');
  assert.equal(applyTemplate('{不存在的字段}', ctx), '未命名'); // 空值渲染后落「未命名」，不是空文件名
  assert.equal(applyTemplate('{总册数}册', ctx), '50册');
});

test('truncateForNas：按字节截断且保留扩展名', () => {
  const long = '书'.repeat(200); // 3 字节/字 → 600 字节
  const out = truncateForNas(`${long}.pdf`, 255);
  const bytes = [...out].reduce((n, c) => n + (c.codePointAt(0) < 0x80 ? 1 : 3), 0);
  assert.ok(bytes <= 255, `期望 ≤255 字节，实得 ${bytes}`);
  assert.ok(out.endsWith('.pdf'));
  assert.equal(truncateForNas('短名.pdf', 255), '短名.pdf');
});

test('buildVolumeNames：同名册自动去重（绝不互相覆盖）', () => {
  const vols = [
    { no: 1, id: '1', title: '卷上' },
    { no: 2, id: '2', title: '卷上' },
    { no: 3, id: '3', title: '卷上' },
  ];
  const named = buildVolumeNames(vols, '{册名}', { 书名: '书' });
  const names = named.map((v) => v.fileName);
  assert.deepEqual(names, ['卷上.pdf', '卷上_2.pdf', '卷上_3.pdf']);
  assert.equal(new Set(names).size, 3);
});

test('buildVolumeNames：模板自带 .pdf 不重复叠加扩展名', () => {
  const named = buildVolumeNames([{ no: 1, id: '1', title: '甲' }], '{册名}.pdf', {});
  assert.equal(named[0].fileName, '甲.pdf');
});

test('NAME_TOKENS/TEMPLATE_PRESETS：字段与预设齐备', () => {
  for (const k of ['书名', '分类', '册次', '册名', '册ID', '主册ID', '总册数', '日期']) {
    assert.ok(NAME_TOKENS.some((t) => t.key === k), `缺少字段 ${k}`);
  }
  assert.ok(TEMPLATE_PRESETS.length >= 3);
  assert.ok(DEFAULT_TEMPLATES.file.includes('{册次'));
});

// ---------------------------------------------------------------- 任务模型

function sampleTask(overrides = {}) {
  const plan = parseVolumeListPage(fx('file_page_volumes.html'));
  const task = createTask({
    book: { id: '1081945', title: plan.bookTitle, categoryPath: plan.categoryPath, url: '' },
    options: { kind: 'imagePdf', outDir: 'D:/out', templates: DEFAULT_TEMPLATES },
    volumes: plan.volumes,
  });
  Object.assign(task, overrides);
  return task;
}

/** 把某一册标记为已完成（页数可指定） */
function markDone(task, no, pages, channel = 'native', name) {
  const v = task.volumes.find((x) => x.no === no);
  v.status = 'done';
  v.channel = channel;
  v.pages = v.pages || pages;
  v.pageCount = pages;
  v.files = [{
    path: `D:/out/书/${name || v.fileName}`,
    name: name || v.fileName,
    bytes: 1000 * pages,
    sha256: 'x'.repeat(64),
    pages,
    channel,
  }];
  return v;
}

test('createTask：清单冻结、命名预渲染、初始全部 pending', () => {
  const task = sampleTask();
  assert.equal(task.book.id, '1081945');
  assert.equal(task.volumes.length, 3);
  assert.ok(task.volumes.every((v) => v.status === 'pending'));
  assert.ok(task.volumes.every((v) => v.fileName.endsWith('.pdf')));
  assert.equal(task.volumes[0].fileName, '001_古逸叢書叙目.pdf');
  assert.equal(task.folderName, '古逸叢書_漢書-叢書の部');
  assert.match(task.zipName, /^古逸叢書_\d{8}\.zip$/);
  assert.deepEqual(task.volumes.map((v) => v.id), ['591227', '591091', '590950']);
});

test('sequenceProblem：序号重复/空洞都能查出来', () => {
  const t = sampleTask();
  assert.equal(sequenceProblem(t), '');
  t.volumes[2].no = 2;
  assert.match(sequenceProblem(t), /重复/);
  const t2 = sampleTask();
  t2.volumes[1].no = 5;
  assert.match(sequenceProblem(t2), /不连续/);
});

test('auditTask：全部完成且页数相符 → 放行', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  const a = auditTask(t);
  assert.equal(a.ok, true, a.problems.join(' | '));
  assert.deepEqual(a.missing, []);
  assert.equal(a.stats.done, 3);
  assert.equal(a.stats.pages, 206);
  assert.equal(a.stats.native, 3);
});

test('auditTask ★零缺册：第 13 册完成但第 2 册缺失 → 必须拒绝，并点名第 2 册', () => {
  // 造 13 册：1..13，唯独第 2 册没完成
  const vols = Array.from({ length: 13 }, (_, i) => ({ no: i + 1, id: String(100000 + i), title: `第${i + 1}册` }));
  const t = createTask({
    book: { id: '9', title: '十三册书', categoryPath: [], url: '' },
    options: { outDir: 'D:/out', templates: DEFAULT_TEMPLATES },
    volumes: vols,
  });
  for (const no of [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) markDone(t, no, 40);
  t.volumes[1].status = 'failed';
  t.volumes[1].error = '原站 HTTP 403（已限流）';
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.deepEqual(a.missing, [2]);
  assert.ok(a.problems.some((p) => p.includes('第 2 册')), a.problems.join(' | '));
  assert.equal(a.stats.done, 12);
  assert.equal(a.stats.failed, 1);
  // 未完成的册必须能被「只重试未完成册」捞出来
  assert.deepEqual(retryableVolumes(t).map((v) => v.no), [2]);
});

test('auditTask：页数不符（期望 41 实得 40）→ 拒绝', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  t.volumes[1].pages = 87;                       // 期望 87
  t.volumes[1].files[0].pages = 86;              // 实得 86
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /第 2 册页数不符/.test(p)));
  assert.deepEqual(a.missing, [2]);
});

test('auditTask：页数不可核验（拿不到 /DCTDecode 计数）→ 不计完成', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  t.volumes[1].files[0].pages = 0;
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /页数不可核验/.test(p)));
  assert.deepEqual(a.missing, [2]);
});

test('auditTask：分批产物按各 part 页数求和比对', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 98); markDone(t, 3, 98);
  // 第 2 册 98 页被拆成 50 + 48
  const v = t.volumes[1];
  v.files = [
    { path: 'D:/out/书/002_1-50.pdf', name: '002_1-50.pdf', bytes: 1, sha256: 'a', pages: 50 },
    { path: 'D:/out/书/002_51-98.pdf', name: '002_51-98.pdf', bytes: 1, sha256: 'b', pages: 48 },
  ];
  assert.equal(auditTask(t).ok, true, auditTask(t).problems.join(' | '));
  v.files[1].pages = 47; // 少一页
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /第 2 册页数不符/.test(p)));
});

test('auditTask：文件名重复 → 拒绝（会互相覆盖）', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  t.volumes[2].fileName = t.volumes[1].fileName;
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /文件名重复/.test(p)));
});

test('auditTask：序号重复 → 拒绝', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  t.volumes[2].no = 2;
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.ok(a.problems.some((p) => /册序号重复/.test(p)));
});

test('auditTask：一册未开始也算缺失（不接受「大部分完成」当完成）', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86);
  const a = auditTask(t);
  assert.equal(a.ok, false);
  assert.deepEqual(a.missing, [3]);
  assert.equal(a.stats.pending, 1);
});

test('auditTask：兜底通道完成的册同样计入 native/iiif 统计', () => {
  const t = sampleTask();
  markDone(t, 1, 22, 'native'); markDone(t, 2, 86, 'iiif'); markDone(t, 3, 98, 'native');
  const a = auditTask(t);
  assert.equal(a.ok, true);
  assert.equal(a.stats.native, 2);
  assert.equal(a.stats.iiif, 1);
});

// ---------------------------------------------------------------- 报告与清单

test('buildReportCsv：表头齐备、每册每产物一行、含逗号时正确转义', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  t.volumes[1].error = '原站, 限流';
  const csv = buildReportCsv(t);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 4); // 表头 + 3 行
  assert.match(lines[0], /册序号,册ID,册名,期望页数,本文件页数,状态,通道,文件名,字节,SHA-256,错误/);
  assert.ok(lines.some((l) => l.includes('原生PDF')));
  assert.ok(lines.some((l) => l.includes('"原站, 限流"')));
});

test('buildManifestJsonl：每册一行且可 JSON.parse', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  const lines = buildManifestJsonl(t).trim().split('\n');
  assert.equal(lines.length, 3);
  const first = JSON.parse(lines[0]);
  assert.equal(first.no, 1);
  assert.equal(first.id, '591227');
  assert.equal(first.files[0].pages, 22);
  assert.equal(first.files[0].sha256, 'x'.repeat(64));
});

test('summarizeTask：摘要文本反映完成度与门禁结论', () => {
  const t = sampleTask();
  markDone(t, 1, 22); markDone(t, 2, 86); markDone(t, 3, 98);
  const s1 = summarizeTask(t);
  assert.equal(s1.ok, true);
  assert.match(s1.text, /3\/3 册完成/);
  assert.match(s1.text, /已过完整性门禁/);
  t.volumes[1].status = 'failed';
  const s2 = summarizeTask(t);
  assert.equal(s2.ok, false);
  assert.match(s2.text, /未过门禁（缺 1 册）/);
});

// ---------------------------------------------------------------- 批量输入解析（V9.9）

test('parseBatchInput：ID / 链接 / 索书号三种写法都能认，注释与空行跳过', () => {
  const text = [
    '# 第一批',
    '591091',
    'https://www.digital.archives.go.jp/item/591227',
    'https://www.digital.archives.go.jp/file/1081945',
    '',
    '別０３８－０００１-0002',
    '   ',
    '# 第二批',
    'https://www.digital.archives.go.jp/img/590950',
  ].join('\n');
  const out = parseBatchInput(text);
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((x) => x.mode), ['id', 'id', 'id', 'ref', 'id']);
  assert.deepEqual(out.map((x) => x.id), ['591091', '591227', '1081945', '', '590950']);
  assert.equal(out[3].raw, '別０３８－０００１-0002');
});

test('parseBatchInput：重复条目自动去重（同 ID 只留一条）', () => {
  const out = parseBatchInput('591091\nhttps://www.digital.archives.go.jp/item/591091\n591091');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '591091');
});

test('parseBatchInput：空的/纯注释输入返回空数组，不抛错', () => {
  assert.deepEqual(parseBatchInput(''), []);
  assert.deepEqual(parseBatchInput(null), []);
  assert.deepEqual(parseBatchInput('# 只有注释\n\n'), []);
});

test('parseBatchInput：短数字不算 ID（避免把页码当书号）', () => {
  const out = parseBatchInput('12\n12345');
  assert.equal(out[0].mode, 'ref');   // 12 → 当作索书号去反查
  assert.equal(out[1].mode, 'id');    // 5 位以上数字才算 ID
});

// ---------------------------------------------------------------- 册清单来源判定（V10.2 断网 bug）

test('decidePlanSource：只有原站明确"没有子册"才允许按单册处理', () => {
  // 正常目录页
  assert.equal(decidePlanSource({ ok: true, status: 200, volumes: 50 }), 'file-page');
  // 叶子册：原站没有目录页（404）或 200 且确实 0 行 → 单册
  assert.equal(decidePlanSource({ ok: true, status: 404, volumes: 0 }), 'single');
  assert.equal(decidePlanSource({ ok: true, status: 200, volumes: 0 }), 'single');
});

test('decidePlanSource ★断网/异常一律报错，绝不降级成单册', () => {
  // 这正是「断网后重新下载，每本书只下了一册」的根因
  assert.equal(decidePlanSource({ ok: false, error: 'network' }), 'error');       // 请求失败
  assert.equal(decidePlanSource(null), 'error');
  assert.equal(decidePlanSource(undefined), 'error');
  assert.equal(decidePlanSource({ ok: true, status: 200, volumes: 0, truncated: true }), 'error'); // 被掐断
  assert.equal(decidePlanSource({ ok: true, status: 403, volumes: 0 }), 'error'); // 限流
  assert.equal(decidePlanSource({ ok: true, status: 500, volumes: 0 }), 'error'); // 站方异常
  // 即便页面上解析出 0 行，只要响应被截断也不能当"没有子册"
  assert.equal(decidePlanSource({ ok: true, status: 200, volumes: 0, truncated: true }), 'error');
});

test('planErrorText：区分"网络中断"与"站方异常"两种提示', () => {
  assert.match(planErrorText('network'), /网络/);
  assert.match(planErrorText('site'), /原站|异常/);
  assert.notEqual(planErrorText('network'), planErrorText('site'));
});

// ---------------------------------------------------------------- 索书号匹配（V10.0）

test('normalizeCode：全角/半角、连接符、空格都归一（实测全角是原站著录格式）', () => {
  assert.equal(normalizeCode('子046-0012'), normalizeCode('子０４６－００１２'));
  assert.equal(normalizeCode('子 046 - 0012'), normalizeCode('子046-0012'));
  assert.equal(normalizeCode('別０３８－０００１-0002'), '別03800010002');
});

test('matchReferenceCandidates：只认「請求番号」相符的，不被件名番号撞车骗到', () => {
  // 真实场景：查 子046-0012，原站全字段命中 4 条，其中「絳帖平」只是件名番号 0046 相同
  const items = [
    { id: '1079353', title: '傷寒意珠篇', url: 'https://www.digital.archives.go.jp/file/1079353',
      fields: [{ label: '請求番号', value: '子０４６－００１２' }, { label: '数量', value: '2冊' }] },
    { id: '4428495', title: '傷寒意珠篇１', url: 'https://www.digital.archives.go.jp/item/4428495',
      fields: [{ label: '請求番号', value: '子０４６－００１２' }] },
    { id: '619990', title: '絳帖平1・2', url: 'https://www.digital.archives.go.jp/item/619990',
      fields: [{ label: '請求番号', value: '子０９６－０００１' }, { label: '件名番号', value: '0046' }] },
  ];
  const { exact, loose, all } = matchReferenceCandidates(items, '子046-0012');
  assert.equal(all.length, 3);
  assert.deepEqual(exact.map((x) => x.id), ['1079353', '4428495']);  // /file/ 排在最前
  assert.equal(loose.length, 1);
  assert.equal(loose[0].id, '619990');   // 撞车的被排除在精确相符之外
  assert.equal(exact[0].refCode, '子０４６－００１２');
});

test('matchReferenceCandidates：空输入/无字段不炸，返回空精确集', () => {
  assert.deepEqual(matchReferenceCandidates([], 'x').exact, []);
  assert.deepEqual(matchReferenceCandidates([{ id: '1', title: 't' }], 'x').exact, []);
  assert.deepEqual(matchReferenceCandidates(null, 'x').all, []);
});

// ---------------------------------------------------------------- 端到端（离线）：从真实页面到任务与审计

test('端到端：真实目录页 → 建任务 → 3 册全成 → 过门禁', () => {
  const plan = parseVolumeListPage(fx('file_page_volumes.html'));
  const viewer = parseViewerPage(fx('viewer_page_591091.html'));
  const man = parseManifest(fx('manifest_591091.json'));

  const task = createTask({
    book: { id: '1081945', title: plan.bookTitle, categoryPath: plan.categoryPath, url: '' },
    options: { kind: 'imagePdf', outDir: 'D:/out', templates: DEFAULT_TEMPLATES },
    volumes: plan.volumes,
  });

  // 第 1 册 22 页走原生；第 2 册 86 页走 IIIF 兜底；第 3 册 3 页走原生
  markDone(task, 1, 22, 'native');
  markDone(task, 3, man.pageCount, 'native');
  markDone(task, 2, viewer.maxCount, 'iiif');   // 86

  const audit = auditTask(task);
  assert.equal(audit.ok, true, audit.problems.join(' | '));
  assert.equal(audit.stats.total, 3);
  assert.equal(audit.stats.pages, 22 + 86 + man.pageCount);
  assert.equal(audit.stats.iiif, 1);
  assert.match(buildReportCsv(task), /IIIF兜底/);
});
