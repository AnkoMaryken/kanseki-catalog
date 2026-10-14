// ================================================
// js/core/naj-dl.js — 国立公文书馆「整册 PDF 下载」核心（纯函数，无 DOM/无网络）
// ================================================
// 本模块只做「解析 + 命名 + 任务状态机 + 零缺册审计」，不碰网络与文件系统，
// 因此可在 node:test 下用真实页面夹具完整单测（见 tests/unit/naj-dl.test.js）。
//
// 三条硬规则（用户要求：绝不能「下了第 13 册、漏了第 2 册」）：
//   1) 册清单先落盘冻结，下载期间不再重新解析（清单即契约）；
//   2) 每册只有通过「页数校验」才允许置 done；页数不可核验的产物**不算完成**；
//   3) 打包前必须过 auditTask()，册数/序号/页数/重名任一项不过即拒绝打包。
// ================================================
import { clean, decodeEntities } from './naj-parse.js';

export const NAJ_ORIGIN = 'https://www.digital.archives.go.jp';

/** 原生下载端点的格式取值（取自原站 naj-viewer.js 的 chageFormatOption 调用） */
export const NATIVE_KINDS = {
  iiifcanvas: [
    { label: '原生 JPEG', value: 'imageJpeg', ext: '.zip' },
    { label: '原生 JPEG2000', value: 'imageJp2', ext: '.zip' },
    { label: '原生 PDF', value: 'imagePdf', ext: '.pdf' },
  ],
  pdf: [
    { label: '原生 JPEG', value: 'pdfJpeg', ext: '.zip' },
    { label: '原生 PDF', value: 'pdfPdf', ext: '.pdf' },
  ],
};

/** 每批页数上限（取自查看器页 data-limit-count：图像 100 / PDF 50） */
export const BATCH_LIMIT = { imageJpeg: 100, imageJp2: 100, imagePdf: 50, pdfJpeg: 50, pdfPdf: 50 };

// ---------------------------------------------------------------- 基础工具

/** 取 URL 末段数字 ID（`da11/591227` 或 `.../item/591227` → 591227） */
export function numericId(s) {
  const m = String(s == null ? '' : s).match(/(\d{3,})\s*$/);
  return m ? m[1] : '';
}

/** 把数组切成若干批 */
export function chunk(arr, size) {
  const n = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** 构造原生下载地址 */
export function nativePdfUrl(recordId, kind = 'imagePdf') {
  return `${NAJ_ORIGIN}/contentDownload/${encodeURIComponent(String(recordId).trim())}?type=${encodeURIComponent(kind)}`;
}

/** 构造 POST 正文（cid 逐页重复；encodeURIComponent 等价编码） */
export function buildCidBody(cids) {
  return (cids || [])
    .map((c) => `cid=${encodeURIComponent(String(c))}`)
    .join('&');
}

/** 查看器页地址 */
export function viewerUrl(recordId) {
  return `${NAJ_ORIGIN}/img/${encodeURIComponent(String(recordId).trim())}`;
}

/**
 * 从查看器页取记录标题（兜底用）。
 *
 * 实测（2026-10）：该站 `.json` 端点在连接被掐断时会**改回 HTML**，
 * 于是「只给 ID 时补书名」会失败；此时用查看器页最稳：
 *   <title>ビューア | 古逸叢書叙目</title>                → 取「|」之后
 *   <a class="viewer-header__title-link">古逸叢書</a>     → 上位书名（退一步用）
 */
export function parseViewerTitle(html) {
  const t = String(html == null ? '' : html);
  const m = t.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    let s = clean(m[1]);
    // 去掉「ビューア | 」「国立公文書館…」等前后缀
    s = s.replace(/^[^|｜]*[|｜]\s*/, '').replace(/\s*[|｜][^|｜]*$/, '').trim();
    if (s && !/^(ビューア|デジタルアーカイブ|国立公文書館)/.test(s)) return s;
  }
  const h = t.match(/class="viewer-header__title-link"[^>]*>([\s\S]*?)<\/a>/);
  return h ? clean(h[1]) : '';
}

/** IIIF 清单地址 */
export function manifestUrl(recordId) {
  return `${NAJ_ORIGIN}/api/iiif/${encodeURIComponent(String(recordId).trim())}/manifest.json`;
}

// ---------------------------------------------------------------- 目录页（/file/<ID>）解析

const RE_ROW = /<li[^>]*class="[^"]*archive-result-table__body-item[^"]*"[^>]*>/g;

/**
 * 解析 /file/<主册ID> 目录页，得到「这本书的全部册」。
 *
 * 实测（2026-10，古逸叢書 1081945）：
 *   · 该页 50 个 <li role="row">，每行含
 *       name="id" value="da11/591227"（子册请求号）、
 *       <h3 id="row-N-title"><a href="…/item/591227">书名</a>、
 *       <ol class="result-tree"> 分类链（内閣文庫 ＞ 漢書 ＞ 叢書の部 ＞ 古逸叢書）
 *   · 而 JSON-LD（/file/<ID>.json）**不含** dct:hasPart，IIIF 清单只有 1 个 canvas
 *     —— 故「所有册」只能从本页解析，这是唯一可行解。
 *
 * @returns {{bookTitle:string, categoryPath:string[], total:number, volumes:Array}}
 */
export function parseVolumeListPage(html) {
  const t = String(html == null ? '' : html);
  const titleM = t.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let bookTitle = titleM ? clean(titleM[1]) : '';

  const starts = [];
  let m;
  RE_ROW.lastIndex = 0;
  while ((m = RE_ROW.exec(t)) !== null) starts.push({ start: m.index, end: m.index + m[0].length });

  const volumes = [];
  let categoryPath = [];
  for (let i = 0; i < starts.length; i++) {
    // ⚠️ 必须按「下一个行开标签」切片，不能按 </li>：
    //    该页每行内部还嵌着 <ol class="result-tree"> 的 <li class="result-tree__item">，
    //    按 </li> 会在第一个分类项处截断，导致分类链丢失（实测踩过）。
    const from = starts[i].end;
    const to = (i + 1 < starts.length) ? starts[i + 1].start : t.length;
    const frag = t.slice(from, to);

    const idM = frag.match(/name="id"[^>]*value="([^"]+)"/);
    const titleM2 = frag.match(/class="result-header__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const noM = frag.match(/archive-result-table__body-item-cell-label">([^<]*)</);
    const kindM = frag.match(/cmn-category-label__text">([^<]*)</);
    const recordValue = idM ? decodeEntities(idM[1]) : '';
    const url = titleM2 ? decodeEntities(titleM2[1]) : '';
    const title = titleM2 ? clean(titleM2[2]) : '';
    const id = numericId(recordValue) || numericId(url);
    if (!id) continue; // 无 ID 的行（表头等）跳过，绝不用序号臆造册号

    const hierarchy = [];
    const treeRe = /class="result-tree__item-label"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/g;
    let tm;
    while ((tm = treeRe.exec(frag)) !== null) hierarchy.push(clean(tm[1]));

    if (!categoryPath.length && hierarchy.length) {
      // 去掉顶层「内閣文庫」与末段（= 本书自身），避免与书名重复
      const inner = hierarchy.filter((x) => x && x !== '内閣文庫');
      if (inner.length && inner[inner.length - 1] === bookTitle) inner.pop();
      categoryPath = inner;
    }

    volumes.push({
      no: noM ? parseInt(clean(noM[1]), 10) || (volumes.length + 1) : (volumes.length + 1),
      id,
      recordValue,
      title: title || `第${volumes.length + 1}册`,
      url: url || `${NAJ_ORIGIN}/item/${id}`,
      kind: kindM ? clean(kindM[1]) : '',
      hierarchy,
    });
  }

  if (!bookTitle) bookTitle = volumes.length ? (volumes[0].hierarchy.slice(-1)[0] || '') : '';
  return { bookTitle, categoryPath, total: volumes.length, volumes };
}

// ---------------------------------------------------------------- 查看器页（/img/<ID>）解析

/**
 * 解析查看器页，取出逐页 cid（下载表单要用）与页数。
 *
 * 实测结构：
 *   <div class="p-viewer-download__grid p-viewer-download__grid-img"
 *        data-limit-count="100" data-max-count="86" …>
 *     <div class="p-viewer-download__item" data-page="1">
 *       <input class="p-viewer-download__checkbox" value="da12/C104174385500">
 *       <img data-src="/content/item/da12/C104174385500/cover/M…_0001.jp2.jpg">
 *
 * @returns {{recordId:string, kindHint:'iiifcanvas'|'pdf'|'', limit:number, maxCount:number,
 *            pages:Array<{no:number, cid:string, thumb:string}>, grids:number}}
 */
export function parseViewerPage(html) {
  const t = String(html == null ? '' : html);
  const gridRe = /<div[^>]*class="[^"]*p-viewer-download__grid(?![-\w])[^"]*"[^>]*>/g;
  const grids = [];
  let g;
  while ((g = gridRe.exec(t)) !== null) grids.push({ start: g.index + g[0].length, tag: g[0] });

  const out = { recordId: '', kindHint: '', limit: 0, maxCount: 0, pages: [], grids: grids.length };

  for (let i = 0; i < grids.length; i++) {
    const from = grids[i].start;
    const to = (i + 1 < grids.length) ? grids[i + 1].start : t.length;
    const frag = t.slice(from, to);
    const isImg = /grid-img/.test(grids[i].tag);
    const isPdf = /grid-pdf/.test(grids[i].tag);
    const limitM = grids[i].tag.match(/data-limit-count="(\d+)"/);
    const maxM = grids[i].tag.match(/data-max-count="(\d+)"/);

    // 逐项按开标签切片。
    // ⚠️ 类名必须精确匹配 p-viewer-download__item ——
    //    同一容器里还有 p-viewer-download__item-footer，写成前缀匹配会在页脚处提前截断，
    //    于是取不到 checkbox 的 value（cid），整页被判为「无可下载页」（实测踩过）。
    const itemTagRe = /<div[^>]*class="[^"]*p-viewer-download__item(?![-\w])[^"]*"[^>]*>/g;
    const starts = [];
    let im;
    while ((im = itemTagRe.exec(frag)) !== null) starts.push({ start: im.index, end: im.index + im[0].length, tag: im[0] });

    const pages = [];
    for (let k = 0; k < starts.length; k++) {
      const block = frag.slice(starts[k].end, (k + 1 < starts.length) ? starts[k + 1].start : frag.length);
      const pageM = starts[k].tag.match(/data-page="(\d+)"/);
      const cidM = block.match(/class="[^"]*p-viewer-download__checkbox[^"]*"[^>]*value="([^"]+)"/)
        || block.match(/value="([^"]+)"[^>]*class="[^"]*p-viewer-download__checkbox/);
      const thumbM = block.match(/<img[^>]*data-src="([^"]+)"/);
      pages.push({
        no: pageM ? parseInt(pageM[1], 10) : pages.length + 1,
        cid: cidM ? decodeEntities(cidM[1]) : '',
        thumb: thumbM ? decodeEntities(thumbM[1]) : '',
      });
    }

    // 只采纳带 cid 的页；两套网格同时存在时，取页数多的那一套
    const usable = pages.filter((p) => p.cid);
    if (!usable.length) continue;
    if (usable.length > out.pages.length) {
      out.pages = usable;
      out.kindHint = isPdf ? 'pdf' : (isImg ? 'iiifcanvas' : '');
      out.limit = limitM ? parseInt(limitM[1], 10) : 0;
      out.maxCount = maxM ? parseInt(maxM[1], 10) : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- IIIF 清单解析（兜底通道）

/**
 * 解析 IIIF Presentation 2.0 清单（该站 /api/iiif/<ID>/manifest.json）。
 * 注意：实测该站单次响应有 3000px 上限，`full/max` 亦只回 3000×2312；
 *       要原扫描分辨率须分区多次请求（P2 再做，P1 用整页）。
 */
export function parseManifest(json) {
  const j = typeof json === 'string' ? safeJson(json) : json;
  if (!j || !j.sequences || !j.sequences.length) return null;
  const seq = j.sequences[0] || {};
  const canvases = [];
  for (const c of (seq.canvases || [])) {
    const img = (c.images && c.images[0] && c.images[0].resource) || {};
    const service = img.service || {};
    canvases.push({
      id: c['@id'] || '',
      label: c.label || '',
      width: c.width || 0,
      height: c.height || 0,
      imageUrl: img['@id'] || '',
      serviceId: service['@id'] || '',
      thumbnail: (c.thumbnail && c.thumbnail['@id']) || '',
    });
  }
  return {
    label: j.label || '',
    attribution: j.attribution || '',
    license: j.license || '',
    metadata: j.metadata || [],
    pageCount: canvases.length,
    canvases,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ---------------------------------------------------------------- 命名模板

/** 命名模板可用字段（界面据此给出可点选的字段按钮） */
export const NAME_TOKENS = [
  { key: '书名', desc: '主册书名（目录页标题）' },
  { key: '分类', desc: '分类链，如 漢書-叢書の部' },
  { key: '册次', desc: '册序号（可用 {册次:03} 补零）' },
  { key: '册名', desc: '子册标题' },
  { key: '册ID', desc: '子册请求号' },
  { key: '主册ID', desc: '主册 ID' },
  { key: '总册数', desc: '本书总册数' },
  { key: '日期', desc: '任务创建日期 YYYYMMDD' },
];

export const DEFAULT_TEMPLATES = {
  folder: '{书名}_{分类}',
  file: '{册次:03}_{册名}',
  zip: '{书名}_{日期}',
};

export const TEMPLATE_PRESETS = [
  { id: 'catalog', label: '编目习惯（分类/书名/册次_册名）', tpl: { folder: '{书名}_{分类}', file: '{册次:03}_{册名}', zip: '{书名}_{日期}' } },
  { id: 'simple', label: '极简（书名/01.pdf）', tpl: { folder: '{书名}', file: '{册次:03}', zip: '{书名}' } },
  { id: 'origin', label: '原站式（主册ID + 册ID）', tpl: { folder: 'www.digital.archives.go.jp【{主册ID}】{书名}', file: '{册ID}_{册名}', zip: '{主册ID}_{书名}' } },
];

/** 单段文件名净化（与 Rust 端 sanitize_segment 保持一致） */
export function sanitizeName(s) {
  let out = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '.');
  out = out.replace(/^[\s.]+|[\s.]+$/g, '');
  return out || '未命名';
}

/** 模板渲染：{字段} 与 {字段:03}（数字补零） */
export function applyTemplate(tpl, ctx) {
  const src = String(tpl == null ? '' : tpl);
  const rendered = src.replace(/\{([^{}:]+)(?::(\d+))?\}/g, (all, key, pad) => {
    const k = String(key).trim();
    let v = ctx && ctx[k] != null ? ctx[k] : '';
    if (pad) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) v = String(n).padStart(parseInt(pad, 10), '0');
    }
    return String(v);
  });
  return sanitizeName(rendered);
}

/** 路径长度保护（群晖 SMB：单段 ≤255 字节、全路径 ≤240 字节） */
export function truncateForNas(name, maxBytes = 255) {
  const s = String(name == null ? '' : name);
  if (byteLen(s) <= maxBytes) return s;
  const ext = (s.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0];
  const stem = ext ? s.slice(0, -ext.length) : s;
  let out = '';
  for (const ch of stem) {
    if (byteLen(out + ch) + byteLen(ext) > maxBytes - 1) break;
    out += ch;
  }
  return (out || '未命名') + ext;
}

function byteLen(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : (c < 0x800 ? 2 : (c < 0x10000 ? 3 : 4));
  }
  return n;
}

/**
 * 为一组册渲染文件名，并**保证互不重名**（重名者追加 _2、_3…）。
 * 结果一经生成即写入任务文件冻结，续传时不得重算。
 */
export function buildVolumeNames(volumes, tpl, common = {}, opts = {}) {
  const used = new Map();
  const maxBytes = opts.maxBytes || 255;
  return (volumes || []).map((v, i) => {
    const ctx = {
      书名: common.书名 || '',
      分类: common.分类 || '',
      主册ID: common.主册ID || '',
      总册数: common.总册数 != null ? common.总册数 : (volumes || []).length,
      日期: common.日期 || '',
      册次: v.no != null ? v.no : (i + 1),
      册名: v.title || '',
      册ID: v.id || '',
    };
    let name = truncateForNas(applyTemplate(tpl, ctx), maxBytes);
    if (name.toLowerCase().endsWith('.pdf')) name = name.slice(0, -4);
    const key = name.toLowerCase();
    const n = (used.get(key) || 0) + 1;
    used.set(key, n);
    if (n > 1) name = `${name}_${n}`;
    return { ...v, fileName: `${name}.pdf`, ctx };
  });
}

// ---------------------------------------------------------------- 任务模型

export const VOLUME_STATUS = ['pending', 'running', 'partial', 'failed', 'done'];

/**
 * 建立任务（清单即契约：解析出的册清单一次性冻结，下载期间不再改动顺序与身份）
 */
export function createTask({ book, options, volumes }) {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const common = {
    书名: book.title || '',
    分类: (book.categoryPath || []).join('-'),
    主册ID: book.id || '',
    日期: date,
    总册数: volumes.length,
  };
  const tpl = { ...DEFAULT_TEMPLATES, ...(options.templates || {}) };
  const named = buildVolumeNames(volumes, tpl.file, common);
  return {
    version: 1,
    createdAt: now.toISOString(),
    date,
    book: { id: book.id, title: book.title, categoryPath: book.categoryPath || [], url: book.url || '' },
    options: {
      kind: options.kind || 'imagePdf',
      concurrency: options.concurrency || 1,
      delayMs: options.delayMs != null ? options.delayMs : 1200,
      outDir: options.outDir || '',
      templates: tpl,
      common,
    },
    folderName: applyTemplate(tpl.folder, common),
    zipName: `${applyTemplate(tpl.zip, common)}.zip`,
    volumes: named.map((v) => ({
      no: v.no,
      id: v.id,
      recordValue: v.recordValue || '',
      title: v.title,
      url: v.url,
      fileName: v.fileName,
      ctx: v.ctx,
      pages: null,          // 由查看器页/IIIF 清单填入（期望页数）
      status: 'pending',
      channel: '',          // native | iiif
      attempts: 0,
      // 一册可因「单批上限」被拆成多个 PDF（如 98 页 → 50+48）；
      // 审计按各 part 页数之和与期望页数比对，缺一页即不算完成
      files: [],
      pageCount: 0,
      error: '',
    })),
    zip: null,
    audit: null,
  };
}

/** 序号连续性检查（1..N 不重不漏） */
export function sequenceProblem(task) {
  const vols = (task && task.volumes) || [];
  const seen = new Set();
  const dup = [];
  for (const v of vols) {
    if (seen.has(v.no)) dup.push(v.no);
    seen.add(v.no);
  }
  if (dup.length) return `册序号重复：${dup.join('、')}`;
  const nums = vols.map((v) => v.no).sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) return `册序号不连续：第 ${i + 1} 位是 ${nums[i]}`;
  }
  return '';
}

/**
 * 零缺册审计 —— 打包前的门禁。任何一项不过即拒绝打包。
 *
 * 判据刻意从严：
 *   · 一册必须至少有一个产物，且各 part 的页数之和 == 期望页数（期望未知则不通过）；
 *   · 页数不可核验（如 PDF 用了对象流、拿不到 /DCTDecode 计数）一律**不计完成**；
 *   · 文件名重复视为不合格（会互相覆盖）。
 * @returns {{ok:boolean, problems:string[], missing:number[], stats:object}}
 */
export function auditTask(task) {
  const problems = [];
  const vols = (task && task.volumes) || [];
  const missing = [];

  const seq = sequenceProblem(task);
  if (seq) problems.push(seq);

  for (const v of vols) {
    const files = Array.isArray(v.files) ? v.files.filter(Boolean) : [];
    const known = files.reduce((s, f) => s + (Number(f.pages) || 0), 0);
    if (v.status !== 'done' || !files.length) {
      missing.push(v.no);
      problems.push(`第 ${v.no} 册未完成（状态：${v.status}${v.error ? '，' + v.error : ''}）`);
      continue;
    }
    if (!(known > 0)) {
      missing.push(v.no);
      problems.push(`第 ${v.no} 册页数不可核验（不计为完成）`);
      continue;
    }
    if (v.pages != null && known !== Number(v.pages)) {
      missing.push(v.no);
      problems.push(`第 ${v.no} 册页数不符：期望 ${v.pages}，实得 ${known}`);
    }
  }

  const nameCount = new Map();
  for (const v of vols) {
    if (!v.fileName) continue;
    const k = String(v.fileName).toLowerCase();
    nameCount.set(k, (nameCount.get(k) || 0) + 1);
  }
  for (const [k, n] of nameCount) {
    if (n > 1) problems.push(`文件名重复 ${n} 次：${k}（会导致互相覆盖）`);
  }

  const allFiles = vols.flatMap((v) => (Array.isArray(v.files) ? v.files.filter(Boolean) : []));
  const done = vols.filter((v) => v.status === 'done' && (v.files || []).length).length;
  const stats = {
    total: vols.length,
    done,
    failed: vols.filter((v) => v.status === 'failed').length,
    partial: vols.filter((v) => v.status === 'partial').length,
    pending: vols.filter((v) => v.status === 'pending' || v.status === 'running').length,
    native: vols.filter((v) => (v.files || []).length && v.channel === 'native').length,
    iiif: vols.filter((v) => (v.files || []).length && v.channel === 'iiif').length,
    parts: allFiles.length,
    pages: allFiles.reduce((s, f) => s + (Number(f.pages) || 0), 0),
    bytes: allFiles.reduce((s, f) => s + (Number(f.bytes) || 0), 0),
  };
  return { ok: problems.length === 0, problems, missing, stats };
}

/** 报告 CSV（每册每个产物一行；含通道与 SHA-256，便于事后核对「哪一册走了兜底」） */
export function buildReportCsv(task) {
  const head = ['册序号', '册ID', '册名', '期望页数', '本文件页数', '状态', '通道', '文件名', '字节', 'SHA-256', '错误'];
  const rows = [head.join(',')];
  for (const v of ((task && task.volumes) || [])) {
    const files = Array.isArray(v.files) ? v.files.filter(Boolean) : [];
    if (!files.length) {
      rows.push([v.no, v.id, v.title, v.pages != null ? v.pages : '', '', v.status, '', v.fileName || '', '', '', (v.error || '')].map(csvCell).join(','));
      continue;
    }
    for (const f of files) {
      rows.push([
        v.no, v.id, v.title, v.pages != null ? v.pages : '',
        f.pages != null ? f.pages : '',
        v.status,
        v.channel === 'native' ? '原生PDF' : (v.channel === 'iiif' ? 'IIIF兜底' : ''),
        f.name || '', f.bytes || '', f.sha256 || '',
        // 只把换行压平（CSV 不能含裸换行）；逗号交给 csvCell 加引号，不丢信息
        (v.error || '').replace(/[\r\n]+/g, ' '),
      ].map(csvCell).join(','));
    }
  }
  return rows.join('\r\n') + '\r\n';
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 清单 JSONL（逐册一行，含来源 URL 与校验值，便于溯源与补下） */
export function buildManifestJsonl(task) {
  return ((task && task.volumes) || []).map((v) => JSON.stringify({
    no: v.no,
    id: v.id,
    title: v.title,
    pages: v.pages,
    status: v.status,
    channel: v.channel,
    fileName: v.fileName,
    files: (Array.isArray(v.files) ? v.files : []).map((f) => ({
      path: f.path, name: f.name, bytes: f.bytes, sha256: f.sha256, pages: f.pages,
    })),
    pageUrls: v.pageUrls || undefined,
    error: v.error || undefined,
  })).join('\n') + '\n';
}

/** 任务摘要（界面顶部一行话） */
export function summarizeTask(task) {
  const a = auditTask(task);
  const s = a.stats;
  const mb = (s.bytes / 1048576).toFixed(1);
  return {
    ...s,
    mb,
    ok: a.ok,
    text: `${s.done}/${s.total} 册完成 · ${s.pages} 页 · ${mb} MB` +
      (s.iiif ? ` · 兜底 ${s.iiif} 册` : '') +
      (a.ok ? ' · 已过完整性门禁' : ` · 未过门禁（缺 ${a.missing.length} 册）`),
  };
}

/** 未完成的册（用于「只重试失败/未完成册」） */
export function retryableVolumes(task) {
  return ((task && task.volumes) || []).filter((v) => v.status !== 'done');
}

// ---------------------------------------------------------------- 批量输入

/**
 * 解析「批量下载」输入框：每行一条，`#` 开头为注释。
 * 支持三种写法：
 *   · 纯数字 ID          591091
 *   · 原站链接           https://www.digital.archives.go.jp/item/591091
 *   · 索书号/請求番号     別０３８－０００１-0002（需走原站 kw_id 检索反查，见 buildReferenceSearchUrl）
 * 同一条目自动去重（按 ID，或按原文）。
 * @returns {Array<{raw:string, mode:'id'|'ref', id:string}>}
 */
export function parseBatchInput(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/\/(?:item|file|fonds|img)\/(\d{3,})/);
    if (m) { out.push({ raw: line, mode: 'id', id: m[1] }); continue; }
    if (/^\d{3,}$/.test(line)) { out.push({ raw: line, mode: 'id', id: line }); continue; }
    out.push({ raw: line, mode: 'ref', id: '' });
  }
  const seen = new Set();
  return out.filter((x) => {
    const k = x.id || x.raw;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 逐行读取批量输入（纯文本，便于界面显示行号与错误定位） */
export function splitBatchLines(text) {
  return String(text == null ? '' : text).split(/\r?\n/);
}

// ---------------------------------------------------------------- 册清单来源判定

/**
 * 判定「目录页」这次请求的结果该怎么处理。
 *
 * ⚠️ 这是 V10.2 修的一个真 bug：断网/请求失败时若"静默回落成单册"，
 * 一本 50 册的书会被当成只有 1 册，于是**每本书只下载了其中一册**。
 * 因此只有「确实问到了原站、且原站明确说没有子册」才允许按单册处理；
 * 网络失败、被掐断（truncated）、403/5xx 一律**报错**，绝不降级。
 *
 * @returns {'file-page'|'single'|'error'}
 */
export function decidePlanSource(res) {
  if (!res || res.ok !== true) return 'error';         // 请求本身失败（断网/超时/被拒）
  const status = Number(res.status);
  if (status === 404) return 'single';                 // 叶子册：原站没有目录页 → 单册
  if (status >= 400) return 'error';                   // 403/5xx：不能当成"没有子册"
  if (res.truncated) return 'error';                   // 响应被掐断：解析结果不可信
  if ((res.volumes || 0) >= 1) return 'file-page';     // 正常目录页
  return 'single';                                     // 200 且确实没有子册行 → 单册
}

/** 网络失败时给用户看的提示（区分"没网"与"站方异常"） */
export function planErrorText(kind) {
  return kind === 'network'
    ? '读取书目信息失败（网络中断或超时）。为避免把多册书误当成单册下载，本次未开始下载，请连网后重试。'
    : '读取书目信息失败（原站响应异常或结构变更）。为避免误判册数，本次未开始下载，请稍后重试。';
}

// ---------------------------------------------------------------- 索书号（請求番号）匹配

/**
 * 归一化号码，便于比较：全角→半角、去空格与连接符、大写。
 * 实测：原站著录是**全角**「子０４６－００１２」，而用户手上常是半角「子046-0012」，
 * 直接按原文检索会 0 命中 —— 这是「批量导入索书号导入不了」的主因。
 */
export function normalizeCode(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    // 全角 ASCII（！-～）→ 半角
    if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCharCode(c - 0xFEE0);
    else if (c === 0x3000) out += ' ';          // 全角空格
    else out += ch;
  }
  return out.toUpperCase().replace(/[\s　]+/g, '').replace(/[-－—–ー]/g, '');
}

/** 从检索条目里取「請求番号」字段 */
export function referenceOfItem(item) {
  const f = ((item && item.fields) || []).find((x) => /請求番号|請求番號/.test(x.label || ''));
  return f ? String(f.value || '').trim() : '';
}

/**
 * 在检索结果里挑出与索书号相符的记录。
 * 判据：归一化后的「請求番号」必须等于输入（实测会混进仅"件名番号"相同的无关记录，
 * 例如查 子046-0012 时命中「絳帖平」（請求番号 子０９６－０００１，件名番号 0046）——
 * 所以**不能只看命中数**，必须核对請求番号本身）。
 *
 * 优先级：精确相符且为 /file/（簿冊，带全部子册）> 精确相符的其它 > 无
 * @returns {{exact:Array, loose:Array, all:Array}}
 */
export function matchReferenceCandidates(items, code) {
  const target = normalizeCode(code);
  const list = Array.isArray(items) ? items.filter((x) => x && x.id) : [];
  const withCode = list.map((it) => ({ ...it, refCode: referenceOfItem(it) }));
  const exact = withCode.filter((it) => target && normalizeCode(it.refCode) === target);
  const loose = withCode.filter((it) => !exact.includes(it));
  exact.sort((a, b) => {
    const af = /\/file\//.test(a.url || '') ? 0 : 1;
    const bf = /\/file\//.test(b.url || '') ? 0 : 1;
    return af - bf;
  });
  return { exact, loose, all: withCode };
}
