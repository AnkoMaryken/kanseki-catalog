// ================================================
// js/ui/record-io.js — 古籍编目 导入/导出 纯逻辑 I/O 模块（零依赖、零 DOM 硬依赖）
// ================================================
// 职责：
//   1) 读：.xlsx（自己解 ZIP + DOMParser/退化 XML 提取器）/ .csv / .txt / .tsv
//      —— .xlsx 是 ZIP：本模块自行解析「中央目录 + 本地文件头 + store(0)/deflate(8)」，
//         deflate 优先用平台自带 DecompressionStream('deflate-raw')（Chromium / Node 22 均有），
//         若环境没有该 API（如某些 WebView / 旧运行时）再退回到本文件内置的
//         纯 JS inflate（fixed + dynamic Huffman，已自测）。→ 因此浏览器与 node:test 都能跑。
//      文本编码：自动识别 UTF-8（含 BOM）/ UTF-16(LE/BE) / GBK —— Excel 导出的中文 CSV 常为 GBK。
//   2) 映射：表头 → 13 个业务字段（模板表头 / 简繁 label / 常见别名），
//      完全匹配不上且列数 ≥13 时按「模板列序」位置回退（matchedBy='position'）。
//   3) 写：文字著录（recordToText / recordsToText）、表格行（recordsToTableRows）、CSV（recordsToCsv）。
//
// 边界：本模块只产出**纯业务字段对象**（只含 ALL_FIELDS 的 13 个 key，值均为字符串），
//       id / seq / createdAt 等同步元数据由调用方（ui/records.js + storage 层）补齐。
//
// 测试：node --test tests/unit/record-io.test.js（离线、无 DOM、无第三方依赖）
// ================================================
import { ALL_FIELDS, FIELD_DEFS } from '../core/catalog-record-schema.js';
import { toSimplified } from '../core/conv.js';

// ================================================
// 常量
// ================================================

/** 表格列（14 列 = 序號 + 13 业务字段，顺序即模板列序） */
export const TABLE_COLUMNS = [
  { key: 'seq', label: '序號' },
  ...ALL_FIELDS.map((f) => ({ key: f, label: FIELD_DEFS[f].label })),
];

/** 空字段占位符（文字著录用） */
const NOT_FILLED = '（未填）';

/** 多条记录之间的分隔线 */
export const RECORD_SEPARATOR = '────────';

/** 「附注：」各分项前缀 */
const NOTE_PARTS = [
  ['frontmatter', '扉頁刊記'],
  ['verso', '紙背文獻'],
  ['appendix', '附録'],
  ['series', '叢書子目'],
  ['catalogers', '编目者'],
];

// 模板提示句（字段为空时原样输出，供编目者按实物补齐；
// 这些句子来自用户给定的著录骨架，正文措辞不得改动）
const T_VERSION_TEMPLATE =
  '出版时代/出版地/出版者：××/××/××刻本（抄本、活字本、套印本、石印本等；'
  + '如是翻刻应注明“翻刻某本”；如是日本刻本、朝鲜刻本也应标注翻刻依据的版本）。配补情况。';
const T_COPIES_TEMPLATE = 'X册 缺存情况：（存X卷：X至X）；或（缺X卷：X至X）';
// 版式展开项（format 为空时逐行输出，X 保留，作为待补提示）
const T_FORMAT_LINES = [
  '单节版：半页X行X字，小字双行X字（眉上镌评／注，行X字）；',
  '两节版：上下双栏，上栏X行X字，下栏X行X字，小字双行X字；',
  '三节版：上中下三栏，上栏X行X字，中栏X行X字，下栏X行X字，小字双行X字；',
  '内外栏：内外双栏，内栏X行X字，外栏X行X字，小字双行X字；',
  '白口（或黑口） 鱼尾：（单黑鱼尾、双黑鱼尾、花鱼尾、白鱼尾）',
  '版框（左右双边、四周单边、四周双边），版框高宽（半页）：框高Xcm，寛Xcm；',
  '版心镌（字数/书名/卷次/页次/刻工/出版者）',
];
const T_NOTE_TEMPLATE =
  '酌情著录序跋信息；内封面镌有XX ，有牌记：XX；是否有纸背文献（无则不著录）；'
  + '书签书名；纸张材质；藏书印；如装帧形式特殊，可著录装帧特点，如五孔装等；'
  + '是否有日文假名或谚文等信息。';

// ================================================
// 表头别名表（mapRowsToRecords 用）
// 匹配顺序：templateHeader（去 * 与空白）→ label → labelT → aliases（顺序即优先级）
// 一律先 toSimplified 再规范化，故简繁/全半角/空白差异都能 absorbe
// ================================================
const HEADER_ALIASES = {
  category: ['类目', '部类', '四部类目', '分类', 'category'],
  title: ['书名', '题名', '書名（题名）', 'title', 'name'],
  volume: ['卷数', '卷次', 'volume', 'vol'],
  shelf: ['索书号', '书号', '架号', '排架号', 'shelf', 'callnumber', 'callno'],
  author: ['著者', '作者', '撰者', '编者', '著者项', 'author', 'creator'],
  version: ['版本', '版本项', '出版项', '出版信息', '出版', '刊刻', 'version', 'edition', 'publisher'],
  copies: ['函册', '册数', '函数', '存缺情况', 'copies', 'volumes'],
  format: ['版式', '行款版式', '行款', 'format', 'layout'],
  frontmatter: ['扉页、刊记', '扉页刊记', '扉页', '刊记', '内封面', 'frontmatter'],
  verso: ['纸背文献', '纸背', 'verso'],
  appendix: ['附录', '附注', '序跋', 'appendix'],
  series: ['丛书子目', '丛书', '子目', 'series'],
  catalogers: ['编目者、校对者', '编目者', '校对者', '编目', 'catalogers', 'cataloger'],
};

// ================================================
// 通用小工具
// ================================================

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const readU16 = (u8, i) => u8[i] | (u8[i + 1] << 8);
const readU32 = (u8, i) => (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0;

/** 任意二进制输入 → Uint8Array（ArrayBuffer / TypedArray / {buffer} / number[] 均支持） */
function toUint8(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer);
  throw new TypeError('parseXlsx/decodeTextBuffer 需要 ArrayBuffer 或 TypedArray');
}

/** UTF-8 字节 → 字符串（不用 TextDecoder，保证任何环境都能跑） */
export function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    let cp;
    let need;
    if (b < 0x80) { cp = b; need = 0; }
    else if (b >= 0xc2 && b <= 0xdf) { cp = b & 0x1f; need = 1; }
    else if (b >= 0xe0 && b <= 0xef) { cp = b & 0x0f; need = 2; }
    else if (b >= 0xf0 && b <= 0xf4) { cp = b & 0x07; need = 3; }
    else { out += '\ufffd'; i += 1; continue; }
    let ok = true;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) { ok = false; break; }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok) { out += '\ufffd'; i += 1; continue; }
    out += cp > 0xffff
      ? String.fromCodePoint(cp)
      : String.fromCharCode(cp);
    i += need + 1;
  }
  return out;
}

/** 去掉 BOM */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ================================================
// 1) 文本解码（UTF-8 / GBK / UTF-16 自动识别）
// ================================================

/**
 * 解码文本缓冲区，自动识别 UTF-8 与 GBK（Excel 导出的中文 CSV 常是 GBK）。
 * 判定：有 BOM 信 BOM；无 BOM 时用 TextDecoder 试着解，谁也不比谁干净就按「汉字最多 +
 * 乱码最少」择优。UTF-8 字节流被当 GBK 解通常还剩不少汉字，故额外统计替换字符与
 * 常见乱码特征字符（锟斤拷/烫烫/等）来打破平局。
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @returns {string}
 */
export function decodeTextBuffer(arrayBuffer) {
  const bytes = toUint8(arrayBuffer);
  if (bytes.length === 0) return '';

  // BOM 优先
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripBom(utf8Decode(bytes.subarray(3)));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), true);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.subarray(2), false);
  }

  const utf8 = utf8Decode(bytes);
  const gbk = decodeGbk(bytes);
  if (gbk === null) return utf8;               // 环境无 gbk 解码器（浏览器都支持 GBK）
  return scoreText(gbk) >= scoreText(utf8) ? gbk : utf8;
}

/** UTF-16 解码（手工，不依赖 TextDecoder） */
function decodeUtf16(bytes, little) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = little ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1];
    out += String.fromCharCode(code);
  }
  return out;
}

/** GBK/GB18030 解码（用平台 TextDecoder；不可用或抛错则返回 null → 调用方退回 UTF-8） */
function decodeGbk(bytes) {
  if (typeof TextDecoder === 'undefined') return null;
  for (const label of ['gb18030', 'gbk']) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch (_e) { /* 换下一个标签 */ }
  }
  return null;
}

/** 打分：汉字多、乱码少者胜 */
function scoreText(s) {
  let cjk = 0;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else if (c === 0xfffd) bad += 5;              // 替换字符
    else if (c >= 0xe000 && c <= 0xf8ff) bad += 3; // 私用区（GBK 误解 UTF-8 常见落点）
    else if (c >= 0x0080 && c <= 0x00ff) bad += 1; // 拉丁扩展乱码区
  }
  // 常见乱码词（锟斤拷 / 烫烫 / 屯屯 等）重罚
  if (/锟斤拷|锟斤|烫烫|屯屯|鐨勶|涓枃|鏂囦|馃|锛/.test(s)) bad += 20;
  return cjk - bad * 2;
}

// ================================================
// 2) CSV / TSV 解析
// ================================================

/**
 * 解析 CSV/TSV 文本 → { headers, rows }
 * 支持：引号包裹、"" 转义、单元格内换行、\r\n / \n / \r、UTF-8 BOM。
 * 首行作表头；数据行按表头列数补/留（映射阶段再决定丢弃）。
 * @param {string} text
 * @param {{delimiter?: string}} [opts] 缺省自动嗅探（\t 多于 , 则按 TSV）
 * @returns {{headers: string[], rows: string[][]}}
 */
export function parseCsv(text, opts = {}) {
  let src = stripBom(String(text == null ? '' : text));
  const delimiter = opts.delimiter || sniffDelimiter(src);
  const table = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => { pushCell(); table.push(row); row = []; };

  while (i < n) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      cell += ch; i += 1; continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushCell(); i += 1; continue; }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      pushRow(); i += 1; continue;
    }
    if (ch === '\n') { pushRow(); i += 1; continue; }
    cell += ch; i += 1;
  }
  // 收尾：最后一行没有换行符时补一次；只有空白字符的行不算数据
  if (cell.trim().length > 0 || row.some((c) => c.trim() !== '')) pushRow();

  // 去掉尾部全空行（含只有空格的）
  while (table.length && table[table.length - 1].every((c) => c.trim() === '')) table.pop();
  // 全是空白/空行 → 无表头无数据（调用方据此报「文件为空」）
  if (!table.length || table.every((r) => r.every((c) => c.trim() === ''))) return { headers: [], rows: [] };

  const width = table.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = (r) => { const o = r.slice(); while (o.length < width) o.push(''); return o; };
  const headers = pad(table[0]).map((s) => s.trim());
  const rows = table.slice(1).map(pad);
  return { headers, rows };
}

/** 嗅探分隔符：有制表符且比逗号多 → TSV */
function sniffDelimiter(text) {
  const head = text.slice(0, 8192);
  const tabs = (head.match(/\t/g) || []).length;
  const commas = (head.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

// ================================================
// 3) XML 提取（浏览器优先 DOMParser，Node 退回自写提取器）
// ================================================
// ⚠️ Node 没有 DOMParser。两套路径都要能读出同样的结果：
//    · DOMParser 路径：标准 XML 文档 + querySelector / textContent
//    · 退化路径：正则定位元素 + 手工解实体（本模块主用，已在 Node 下全量自测）
//    两条路径的差异（如 <t/> 自闭合标签）都在夹具与单测里覆盖。

/** 取第一个 <tag ...>...</tag> 的内容（退化路径用，不做嵌套恢复） */
function rawElement(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = re.exec(xml);
  return m ? m[1] : '';
}

/** 取全部 <tag ...>...</tag> 的内容 */
function rawElements(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** XML 文本 → 解码实体（内含 CDATA） */
function decodeXmlText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try { return String.fromCodePoint(cp); } catch (_e) { return ''; }
}

/** 去掉标签，保留文本（用于 <is>/<si> 内混排的情形） */
const stripTags = (s) => decodeXmlText(String(s).replace(/<[^>]*>/g, ''));

/** 列引用（A1 / $AB$12 / C）→ 0 基列号 */
export function colIndexFromRef(ref) {
  const m = /^\$?([A-Za-z]+)/.exec(String(ref || ''));
  if (!m) return -1;
  const letters = m[1].toUpperCase();
  let idx = 0;
  for (let i = 0; i < letters.length; i++) idx = idx * 26 + (letters.charCodeAt(i) - 64);
  return idx - 1;
}

/** 共享字符串表 → string[]（<si> 内拼接全部 <t>，富文本 <r><t> 片段也拼上） */
export function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of rawElements(xml, 'si')) {
    // <si> 里可能有 <rPh><t> 注音，但 Excel 的正常写法 <t> 只出现在 <si>/<r> 下，
    // 直接把 <si> 内所有 <t> 串起来即可覆盖「纯文本」与「富文本」两种形态
    const ts = rawElements(si, 't');
    out.push(ts.length ? ts.map((t) => decodeXmlText(t)).join('') : stripTags(si));
  }
  return out;
}

/** 工作表 XML → 二维数组（按 r="A1" 定位列，缺列补空串，不塌缩） */
export function parseSheetXml(xml, sharedStrings = []) {
  if (!xml) return [];
  const rows = [];
  for (const rowXml of rawElements(xml, 'row')) {
    const cells = [];
    const re = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/gi;
    let m;
    while ((m = re.exec(rowXml)) !== null) {
      const attrs = m[1] || '';
      const inner = m[3] || '';
      const ref = /\br\s*=\s*"([^"]*)"/i.exec(attrs);
      const typeM = /\bt\s*=\s*"([^"]*)"/i.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      const col = ref ? colIndexFromRef(ref[1]) : cells.length;

      let value = '';
      if (type === 'inlineStr') {
        const isInner = rawElement(inner, 'is');
        const src = isInner || inner;
        const ts = rawElements(src, 't');
        value = ts.length ? ts.map((t) => decodeXmlText(t)).join('') : stripTags(src);
      } else if (type === 's') {
        const v = rawElement(inner, 'v');
        const si = parseInt(decodeXmlText(v).trim(), 10);
        value = Number.isInteger(si) && si >= 0 && si < sharedStrings.length
          ? sharedStrings[si]
          : decodeXmlText(v);
      } else {
        // n / str / b / e / 无 t：一律原样取 <v> 文本（日期序列号、公式缓存值都保留原样）
        value = decodeXmlText(rawElement(inner, 'v'));
      }

      if (col < 0) cells.push(value);
      else cells[col] = value;
    }
    // 稀疏数组补空
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/** 抓出 <sheetData>（避免把 <cols>/<mergeCells> 里的 <c> 之类误当单元格） */
const sheetDataOf = (xml) => rawElement(xml, 'sheetData') || xml;

/** 统一把二维数组补齐为等宽，首行作表头 */
function toTable(rows) {
  if (!rows.length) return { headers: [], rows: [] };
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const pad = (r) => { const o = r.slice(); while (o.length < width) o.push(''); return o; };
  return { headers: pad(rows[0]), rows: rows.slice(1).map(pad) };
}

// ================================================
// 4) ZIP 解析 + inflate
// ================================================

/** 从尾部找 EOCD（ZIP 结尾可能带注释） */
function findEocd(u8) {
  const min = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) return i;
  }
  return -1;
}

/**
 * 解析 ZIP 的中央目录 → 条目列表。
 * 只依赖中央目录（再落到本地文件头取数据），足以读 Excel/Office 生成的文件。
 */
export function readZipEntries(u8) {
  const eocd = findEocd(u8);
  if (eocd < 0) throw new Error('不是有效的 ZIP/XLSX 文件（未找到目录结尾记录）');
  const count = readU16(u8, eocd + 10);
  const cdOffset = readU32(u8, eocd + 16);
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length) break;
    if (readU32(u8, p) !== 0x02014b50) break;
    const flags = readU16(u8, p + 8);
    const method = readU16(u8, p + 10);
    const compSize = readU32(u8, p + 20);
    const uncompSize = readU32(u8, p + 24);
    const nameLen = readU16(u8, p + 28);
    const extraLen = readU16(u8, p + 30);
    const commentLen = readU16(u8, p + 32);
    const localOffset = readU32(u8, p + 42);
    const rawName = u8.subarray(p + 46, p + 46 + nameLen);
    const name = (flags & 0x800) ? utf8Decode(rawName) : decodeZipName(rawName);
    p += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > u8.length) continue;
    if (readU32(u8, localOffset) !== 0x04034b50) continue;
    const lNameLen = readU16(u8, localOffset + 26);
    const lExtraLen = readU16(u8, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    let comp = u8.subarray(dataStart, dataStart + compSize);
    // 流式写入（compSize 为 0 且带 data descriptor）时中央目录一般仍是可靠长度；
    // 万一 compSize=0，用「到下一个条目/目录为止」兜底
    if (!compSize && uncompSize) comp = u8.subarray(dataStart, Math.min(u8.length, dataStart + uncompSize + 64));
    entries.push({ name, method, compSize, uncompSize, bytes: comp });
  }
  return entries;
}

/** ZIP 条目名（非 UTF-8 时按 CP437 还原 ASCII 部分；中文名极少见，够用） */
function decodeZipName(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const findEntry = (entries, needle) => entries.find((e) => e.name === needle)
  || entries.find((e) => e.name.toLowerCase().endsWith(needle.toLowerCase()))
  || entries.find((e) => e.name.toLowerCase().includes(needle.toLowerCase()));

/** 条目解压：method 0 原样，8 走 DecompressionStream / 内置 inflate */
async function entryBytes(entry) {
  if (!entry) return null;
  if (entry.method === 0) return entry.bytes;
  if (entry.method !== 8) throw new Error('不支持的 ZIP 压缩方式：' + entry.method);
  const raw = await inflateRaw(entry.bytes);
  return raw;
}

/** deflate 解压：优先平台 API，否则内置 inflate */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'function') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    } catch (_e) {
      // 落到内置实现（例如不支持 deflate-raw 标签的实现）
    }
  }
  return inflateRawFallback(bytes);
}

// ------------------------------------------------
// 内置 inflate（RFC1951；fixed + dynamic Huffman、stored）
// 参考实现（本项目重写，仅为「平台无 DecompressionStream」时兜底）：
// 位序按 DEFLATE 规定 LSB-first。
// ------------------------------------------------
function buildHuffman(lengths) {
  const counts = new Array(16).fill(0);
  for (const l of lengths) if (l > 0) counts[l]++;
  counts[0] = 0;
  const offs = new Array(16).fill(0);
  let total = 0;
  for (let i = 1; i < 16; i++) { offs[i] = total; total += counts[i]; }
  const symbols = new Array(total);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) symbols[offs[l]++] = s;
  }
  return { counts, symbols };
}

function decodeSym(br, huff) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bits(1);
    const count = huff.counts[len];
    if (code - first < count) return huff.symbols[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('DEFLATE 数据损坏：Huffman 码无效');
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function inflateRawFallback(input) {
  const u8 = toUint8(input);
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  const br = {
    bits(need) {
      while (bitCnt < need) {
        if (pos >= u8.length) throw new Error('DEFLATE 数据意外结束');
        bitBuf |= u8[pos++] << bitCnt;
        bitCnt += 8;
      }
      const val = bitBuf & ((1 << need) - 1);
      bitBuf >>>= need;
      bitCnt -= need;
      return val;
    },
    align() { bitBuf = 0; bitCnt = 0; },
  };

  const out = [];
  let fixedLit = null;
  let fixedDist = null;

  for (;;) {
    const last = br.bits(1);
    const type = br.bits(2);

    if (type === 0) {
      br.align();
      if (pos + 4 > u8.length) throw new Error('DEFLATE stored 块头不完整');
      const len = u8[pos] | (u8[pos + 1] << 8);
      pos += 4; // len + ~len（不校验）
      for (let i = 0; i < len; i++) out.push(u8[pos + i]);
      pos += len;
    } else {
      let litHuff;
      let distHuff;
      if (type === 1) {
        if (!fixedLit) {
          const litLens = new Array(288);
          for (let i = 0; i < 144; i++) litLens[i] = 8;
          for (let i = 144; i < 256; i++) litLens[i] = 9;
          for (let i = 256; i < 280; i++) litLens[i] = 7;
          for (let i = 280; i < 288; i++) litLens[i] = 8;
          fixedLit = buildHuffman(litLens);
          fixedDist = buildHuffman(new Array(30).fill(5));
        }
        litHuff = fixedLit; distHuff = fixedDist;
      } else if (type === 2) {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const clLens = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLens[order[i]] = br.bits(3);
        const clHuff = buildHuffman(clLens);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = decodeSym(br, clHuff);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) {
            const prev = lens[lens.length - 1];
            const rep = 3 + br.bits(2);
            for (let i = 0; i < rep; i++) lens.push(prev);
          } else if (sym === 17) {
            const rep = 3 + br.bits(3);
            for (let i = 0; i < rep; i++) lens.push(0);
          } else {
            const rep = 11 + br.bits(7);
            for (let i = 0; i < rep; i++) lens.push(0);
          }
        }
        litHuff = buildHuffman(lens.slice(0, hlit));
        distHuff = buildHuffman(lens.slice(hlit, hlit + hdist));
      } else {
        throw new Error('DEFLATE 数据损坏：保留了块类型 3');
      }

      for (;;) {
        const sym = decodeSym(br, litHuff);
        if (sym < 256) { out.push(sym); continue; }
        if (sym === 256) break;
        const li = sym - 257;
        if (li < 0 || li >= LEN_BASE.length) throw new Error('DEFLATE 数据损坏：长度码越界');
        const length = LEN_BASE[li] + (LEN_EXTRA[li] ? br.bits(LEN_EXTRA[li]) : 0);
        const dsym = decodeSym(br, distHuff);
        if (dsym >= DIST_BASE.length) throw new Error('DEFLATE 数据损坏：距离码越界');
        const dist = DIST_BASE[dsym] + (DIST_EXTRA[dsym] ? br.bits(DIST_EXTRA[dsym]) : 0);
        if (dist > out.length) throw new Error('DEFLATE 数据损坏：回引距离超出已解压数据');
        const start = out.length - dist;
        for (let i = 0; i < length; i++) out.push(out[start + i]);
      }
    }
    if (last) break;
  }
  return Uint8Array.from(out);
}

// ================================================
// 5) .xlsx 解析
// ================================================

/**
 * 解析 .xlsx → { headers, rows }
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @returns {Promise<{headers: string[], rows: string[][]}>}
 */
export async function parseXlsx(arrayBuffer) {
  const u8 = toUint8(arrayBuffer);
  if (!u8.length) return { headers: [], rows: [] };

  let entries;
  try {
    entries = readZipEntries(u8);
  } catch (err) {
    // 容错：有些工具会导出「SpreadsheetML 2003」单文件 XML
    const text = utf8Decode(u8);
    if (/<workbook[\s>]/i.test(text) && /<Worksheet/i.test(text)) {
      return toTable(parseSheetXml(sheetDataOf(text), []));
    }
    throw err;
  }

  const sheetEntry = findEntry(entries, 'xl/worksheets/sheet1.xml')
    || entries.find((e) => /^xl\/worksheets\/[^/]+\.xml$/i.test(e.name) && !/\/_rels\//i.test(e.name));
  if (!sheetEntry) throw new Error('XLSX 中没有找到工作表（xl/worksheets/*.xml）');

  const sstEntry = findEntry(entries, 'xl/sharedStrings.xml');
  const [sstBytes, sheetBytes] = await Promise.all([
    sstEntry ? entryBytes(sstEntry) : Promise.resolve(null),
    entryBytes(sheetEntry),
  ]);

  const sheetXml = utf8Decode(sheetBytes || new Uint8Array(0));
  const sharedStrings = sstBytes ? parseSharedStrings(utf8Decode(sstBytes)) : [];
  const rows = parseSheetXml(sheetDataOf(sheetXml), sharedStrings);
  return toTable(rows);
}

// ================================================
// 6) 文件分派（File / Blob / {name, arrayBuffer()} 均可）
// ================================================

/**
 * 按扩展名/MIME 分派解析：.xlsx → parseXlsx；.csv/.txt/.tsv → 解码 + parseCsv
 * @param {File|Blob|{name?:string, type?:string, arrayBuffer():Promise<ArrayBuffer>}} file
 * @returns {Promise<{headers: string[], rows: string[][], source: 'xlsx'|'csv'}>}
 */
export async function parseTableFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('parseTableFile 需要一个 File/Blob（含 arrayBuffer()）');
  }
  const name = String(file.name || '');
  const mime = String(file.type || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const kind = detectKind(name, mime, buf);

  if (kind === 'xlsx') {
    const { headers, rows } = await parseXlsx(buf);
    return { headers, rows, source: 'xlsx' };
  }
  const text = decodeTextBuffer(buf);
  const delimiter = kind === 'tsv' ? '\t' : undefined;
  const { headers, rows } = parseCsv(text, delimiter ? { delimiter } : {});
  return { headers, rows, source: 'csv' };
}

function detectKind(name, mime, buf) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name) || [, ''])[1].toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  if (mime.includes('spreadsheetml') || mime.includes('officedocument.spreadsheet')) return 'xlsx';
  if (mime.includes('tab-separated')) return 'tsv';
  if (mime.includes('csv')) return 'csv';
  // 无扩展名/未知 MIME：看 ZIP 魔数（PK\x03\x04），是 ZIP 就当 xlsx 试
  if (buf) {
    const u8 = toUint8(buf);
    if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) return 'xlsx';
  }
  return null;
}

// ================================================
// 7) 表头映射
// ================================================

/**
 * 表头 → 记录字段
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {{records: object[], unmappedHeaders: string[], matchedBy: 'header'|'position'|'none'}}
 *   records 只含 13 个业务字段（值均为字符串；不含 id/seq 等元数据）
 *   matchedBy: 'header' 按表头匹配 | 'position' 表头全不匹配且列数 ≥13 时按模板列序回退 | 'none'
 */
export function mapRowsToRecords(headers, rows) {
  const heads = Array.isArray(headers) ? headers.map((h) => String(h == null ? '' : h)) : [];
  const dataRows = Array.isArray(rows) ? rows : [];
  const keys = new Map();          // 规范化表头 → 首个列号
  const usedHeaders = new Set();   // 被认领的表头

  heads.forEach((h, i) => {
    const k = cleanHeader(h);
    if (k && !keys.has(k)) keys.set(k, i);
  });

  const fieldOfCol = new Map();
  const claim = (field, k) => {
    if (fieldOfCol.has(field)) return true;      // 该字段已认领，无需再找
    if (!k || !keys.has(k)) return false;
    fieldOfCol.set(field, keys.get(k));          // Map 迭代顺序 = 字段声明顺序 = 列序
    usedHeaders.add(keys.get(k));
    return true;
  };

  for (const field of ALL_FIELDS) {
    for (const k of headerForms(field)) if (claim(field, k)) break;
  }

  const mapped = fieldOfCol.size;
  let matchedBy = mapped > 0 ? 'header' : 'none';
  if (mapped === 0 && heads.length >= ALL_FIELDS.length) {
    // 位置回退：按模板列序（第 1 列为序號，故从第 2 列开始取 13 列）
    fieldOfCol.clear();
    ALL_FIELDS.forEach((f, i) => fieldOfCol.set(f, i + 1));
    matchedBy = 'position';
  }

  const records = dataRows.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    // 只保留 13 个业务字段（值一律为字符串）——
    // createEmptyRecord() 会带 id/seq/createdAt…，这里只按 ALL_FIELDS 取值，元数据不外泄
    const out = {};
    for (const f of ALL_FIELDS) {
      const col = fieldOfCol.has(f) ? fieldOfCol.get(f) : -1;
      out[f] = col >= 0 && cells[col] != null ? String(cells[col]) : '';
    }
    return out;
  });

  const unmappedHeaders = [];
  heads.forEach((h, i) => {
    if (!usedHeaders.has(i)) unmappedHeaders.push(h);
  });

  return { records, unmappedHeaders, matchedBy };
}

/** 一个字段的所有候选规范化表头（顺序 = 优先级） */
function headerForms(field) {
  const def = FIELD_DEFS[field] || {};
  const forms = [];
  const push = (s) => { const v = cleanHeader(s); if (v && !forms.includes(v)) forms.push(v); };
  push(stripStar(def.templateHeader));
  push(def.label);
  push(def.labelT);
  for (const a of HEADER_ALIASES[field] || []) push(a);
  return forms;
}

/** 去表头里的 * 号与空白 */
const stripStar = (s) => String(s == null ? '' : s).replace(/^[\s*＊]+/, '').trim();

/**
 * 表头规范化：去空白/星号/括号括注/常见衬字，转简体。
 * 「函册（存缺情況）」→「函册」，「扉頁、刊記等」→「扉页刊记」
 */
function cleanHeader(h) {
  let s = String(h == null ? '' : h);
  s = stripStar(s);
  s = s.replace(/[\s\u3000]+/g, '');
  s = toSimplified(s);
  s = s.replace(/[（(][^（）()]*[)）]/g, '');   // 去掉括注
  s = s.replace(/[《》〈〉【】\[\]{}'"]/g, '');
  s = s.replace(/[·・.。,，;；:：、\-—_/\\|]/g, '');
  s = s.replace(/等$/, '');
  return s.toLowerCase();
}

// ================================================
// 8) 文字著录
// ================================================

const cellOf = (rec, f) => {
  const v = rec && rec[f];
  return v == null ? '' : String(v).trim();
};
const orNotFilled = (v) => (v ? v : NOT_FILLED);

/** 「附注：」行内容：前端各分项拼接；全空则输出模板提示句 */
function buildNoteLine(rec) {
  const parts = NOTE_PARTS
    .map(([f, label]) => (cellOf(rec, f) ? label + '：' + cellOf(rec, f) : ''))
    .filter(Boolean);
  return parts.length ? '附注：' + parts.join(' ｜ ') : '附注：' + T_NOTE_TEMPLATE;
}

/**
 * 单条记录 → 文字著录。
 *
 * 输出骨架（严格按用户给定结构；字段为空处写「（未填）」）：
 *   书名/卷数：{title}/{volume}  索书号：{shelf}
 *   著者：{author}
 *   版本：{version 或版本模板提示}
 *   册数：{copies 或册数模板提示}
 *   行款版式：…
 *   附注：…
 *
 * ⚠️「行款版式」的两种分支（约定，勿改）：
 *   · format 非空 → **只输出** `行款版式：{format}` 一行，
 *     不再输出单节版/两节版/三节版/内外栏/白口鱼尾/版框/版心镌这 7 行模板；
 *   · format 为空 → 先输出 `行款版式：` 一行，再逐行输出这 7 行模板原文（X 保留），
 *     作为待补提示 —— **只有首行带 `行款版式：` 前缀**，与用户给定的文档骨架一致
 *     （骨架里这 7 行是「行款版式：」之下的并列行，不是各自独立字段）。
 *
 * @param {object} rec
 * @returns {string} 无尾随空行的多行文本
 */
export function recordToText(rec) {
  const r = rec || {};
  const title = cellOf(r, 'title');
  const volume = cellOf(r, 'volume');
  const shelf = cellOf(r, 'shelf');
  const lines = [
    `书名/卷数：${orNotFilled(title)}/${orNotFilled(volume)}  索书号：${orNotFilled(shelf)}`,
    `著者：${orNotFilled(cellOf(r, 'author'))}`,
  ];

  // 版本：非空原样输出；为空输出版本行模板提示（含括注里的刻本类型说明）
  const version = cellOf(r, 'version');
  lines.push(version ? `版本：${version}` : `版本：${T_VERSION_TEMPLATE}`);

  const copies = cellOf(r, 'copies');
  lines.push(copies ? `册数：${copies}` : `册数：${T_COPIES_TEMPLATE}`);

  const format = cellOf(r, 'format');
  if (format) lines.push(`行款版式：${format}`);
  else lines.push('行款版式：', ...T_FORMAT_LINES);

  lines.push(buildNoteLine(r));
  return lines.join('\n');
}

/**
 * 多条记录 → 文字著录，记录之间用一行 `────────` 分隔
 * @param {object[]} records
 * @returns {string}
 */
export function recordsToText(records) {
  const list = Array.isArray(records) ? records : [];
  return list.map((r) => recordToText(r)).join('\n' + RECORD_SEPARATOR + '\n');
}

// ================================================
// 9) 表格 / CSV 导出
// ================================================

/**
 * 记录 → 表格行（14 列：序號 + 13 业务字段，顺序同模板）
 * @param {object[]} records
 * @returns {{headers: string[], rows: string[][]}}
 */
export function recordsToTableRows(records) {
  const headers = TABLE_COLUMNS.map((c) => c.label);
  const list = Array.isArray(records) ? records : [];
  const rows = list.map((rec, i) => {
    const r = rec || {};
    return TABLE_COLUMNS.map(({ key }) => {
      if (key === 'seq') {
        const v = r.seq;
        // 未给 seq → 用行号兜底；显式给了空串则尊重调用方（视为「无序号」）
        return v === undefined || v === null ? String(i + 1) : String(v);
      }
      const v = r[key];
      return v === undefined || v === null ? '' : String(v);
    });
  });
  return { headers, rows };
}

/**
 * CSV 单元格：引号/逗号/换行按 RFC4180 转义；
 * 公式注入防护 —— 以 = + - @ 或前导空白开头（可被 Excel 当公式执行）的值前置单引号。
 */
export function csvCell(value) {
  const s = String(value == null ? '' : value);
  const safe = /^\s*[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/**
 * 记录 → CSV 文本（含 14 列表头，CRLF 行尾；BOM 由调用方决定加不加）
 * @param {object[]} records
 * @returns {string}
 */
export function recordsToCsv(records) {
  const { headers, rows } = recordsToTableRows(records);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
