// ================================================
// js/core/kanseki-parse.js — 全国漢籍データベース 页面解析（纯函数，无 DOM）
// ================================================
// 数据源页面为上世纪风格的大写 HTML（HEAD/BODY 无闭合、FONT 排版），
// 但**每条记录页末尾有一段 HTML 注释形式的机读字段块**，那才是权威字段来源：
//
//   <!--
//   <nu>0225040</nu>           记录号
//   <oy>0223015</oy>           所属丛书母记录号
//   <co>小方壺齋輿地叢鈔第三帙第一册</co>   丛书名（含册次）
//   <ti><key>乍ㄚ圖說</key>一卷</ti>       书名：<key> 内为书名标目
//   <pinyin><ti><key>ZHA4 A1 TU2 SHUO1</key></ti></pinyin>
//   <au>淸<key>姚瑩</key>撰</au>           著者：<key> 内为人名
//   <or>東北大</or>            收藏机构
//   ...（si 索书号 / se 文库 / yr 刊年 / pb 出版者 / ed 版本 / fi·sf·tg 四部分类 …）
//   -->
//
// ⚠️ 已知坑：<pinyin> 块内**内嵌** <ti>/<au>，若不做屏蔽，罗马字会被当成
//    书名/著者混进结果（本模块先摘出 pinyin 块再解析其余标签）。
//
// 本模块与仓库根 kanseki_extract.py 的解析规则一致，两处改动需同步。
// ================================================

const ENTITIES = {
  '&nbsp;': ' ', '&ensp;': ' ', '&emsp;': ' ', '&thinsp;': ' ',
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
};

/** HTML 实体解码（含数字实体） */
export function decodeEntities(s) {
  if (!s) return '';
  let out = String(s).replace(/&(nbsp|ensp|emsp|thinsp|amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] || m);
  out = out.replace(/&#(\d+);/g, (_, d) => {
    const n = parseInt(d, 10);
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => {
    const n = parseInt(h, 16);
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
  return out;
}

/** 去标签 + 实体解码 + 空白压缩 */
export function clean(s) {
  if (!s) return '';
  let t = String(s).replace(/<br\s*\/?>/gi, ' ');
  t = t.replace(/<[^>]*>/g, '');
  t = decodeEntities(t).replace(/\u00a0/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** <key>…</key> → { key, rest } */
export function splitKey(inner) {
  const m = String(inner || '').match(/<key>([\s\S]*?)<\/key>/i);
  if (!m) return { key: clean(inner), rest: '' };
  const key = clean(m[1]);
  const rest = clean(inner.slice(0, m.index) + inner.slice(m.index + m[0].length));
  return { key, rest };
}

// ---------------------------------------------------------------- 检索结果页
/**
 * 解析检索结果页。
 * @returns {{total:number, entries:Array, isForm:boolean}}
 *   isForm=true 表示服务器返回的是检索表单页（说明检索词无效/为空），而非结果页
 */
export function parseResultPage(html) {
  const empty = { total: 0, entries: [], isForm: false };
  if (!html) return empty;
  if (html.indexOf('レコードがありません') >= 0) return empty; // 无记录

  const m = html.match(/([\d,]+)\s*レコード見つかりました/);
  if (!m) return { total: 0, entries: [], isForm: true }; // 表单页：未执行检索
  const total = parseInt(m[1].replace(/,/g, ''), 10) || 0;

  const start = html.indexOf('<OL>');
  const body = start >= 0 ? html.slice(start) : html;
  const blocks = [];
  const reLi = /<LI>([\s\S]*?)(?=<LI>|<\/OL>|$)/gi;
  let b;
  while ((b = reLi.exec(body)) !== null) blocks.push(b[1]);

  const entries = [];
  for (const blk of blocks) {
    const pm = blk.match(/\?record=(data\/[^"&]+)/);
    if (!pm) continue;
    const path = pm[1];

    // 题名：该条内所有指向本记录的 <A>
    const titles = [];
    const reA = /<A\s+HREF="([^"]*)"[^>]*>([\s\S]*?)<\/A>/gi;
    let a;
    while ((a = reA.exec(blk)) !== null) {
      if (a[1].indexOf('?record=') >= 0) {
        const t = clean(a[2]);
        if (t && titles.indexOf(t) < 0) titles.push(t);
      }
    }

    // FONT 块：-2 普通 = 著者/出版项；#999999 = 丛书项；#ff6666 = 机构
    let authorBib = '', series = '', institution = '';
    const reF = /<FONT([^>]*)>([\s\S]*?)<\/FONT>/gi;
    let f;
    while ((f = reF.exec(blk)) !== null) {
      const attrs = (f[1] || '').toLowerCase();
      const txt = clean(f[2]);
      if (attrs.indexOf('#999999') >= 0) series = txt;
      else if (attrs.indexOf('#ff6666') >= 0) institution = txt;
      else if (attrs.replace(/\s/g, '').indexOf('size="-2"') >= 0 && txt && !authorBib) authorBib = txt;
    }

    entries.push({
      recordPath: path,
      title: titles.join(' ; '),
      authorBib,
      series,
      institution,
      hasImage: /\bjpg\b/i.test(blk),
      url: 'http://kanji.zinbun.kyoto-u.ac.jp/kanseki?record=' + path,
    });
  }
  return { total, entries, isForm: false };
}

// ---------------------------------------------------------------- 记录详情页
/**
 * 解析记录详情页。
 * @param {string} html
 * @param {{path?:string,url?:string}} [meta]
 */
export function parseRecordPage(html, meta = {}) {
  const rec = { recordPath: meta.path || '', url: meta.url || '' };
  if (!html || html.indexOf('レコードがありません') >= 0) {
    rec.error = 'no-record';
    return rec;
  }

  const cm = html.match(/<!--([\s\S]*?)-->/);
  let comment = cm ? cm[1] : '';
  const body = cm ? html.slice(0, cm.index) : html;

  // ① 先摘出 pinyin 块（内含 <ti>/<au>，不屏蔽会污染书名与著者）
  const pinyinBlocks = [];
  comment = comment.replace(/<pinyin>([\s\S]*?)<\/pinyin>/gi, (_, inner) => {
    pinyinBlocks.push(inner);
    return '\n';
  });

  // ② 其余 2 字母标签
  const tags = {};
  const reTag = /<([a-z]{2})>([\s\S]*?)<\/\1>/gi;
  let t;
  while ((t = reTag.exec(comment)) !== null) {
    const k = t[1].toLowerCase();
    (tags[k] = tags[k] || []).push(t[2]);
  }

  for (const k of Object.keys(tags)) {
    const values = tags[k];
    if (k === 'ti') {
      rec.ti = values.map((v) => clean(v));
      rec.tiKey = values.map((v) => splitKey(v).key).filter(Boolean);
    } else if (k === 'au') {
      rec.au = values.map((v) => clean(v));
      rec.auKey = values.map((v) => splitKey(v).key).filter(Boolean);
    } else if (k === 'st' || k === 'pt') {
      rec[k] = values.map((v) => splitKey(v).key).filter(Boolean);
    } else {
      rec[k] = values.map((v) => clean(v)).filter(Boolean);
    }
  }

  // ③ 拼音
  for (const blk of pinyinBlocks) {
    const re = /<(ti|au)>([\s\S]*?)<\/\1>/gi;
    let p;
    while ((p = re.exec(blk)) !== null) {
      const key = p[1].toLowerCase() === 'ti' ? 'pinyinTi' : 'pinyinAu';
      const v = splitKey(p[2]).key;
      if (v) (rec[key] = rec[key] || []).push(v);
    }
  }

  // ④ 可见部分：分类、书名、母丛书、卷头画像、子目清单
  const cls = body.match(/<FONT\s+SIZE="-1">([\s\S]*?)<\/FONT>/i);
  if (cls) rec.classificationVisible = clean(cls[1]);

  const h2s = [];
  const reH2 = /<H2>([\s\S]*?)<\/H2>/gi;
  let h;
  while ((h = reH2.exec(body)) !== null) {
    const v = clean(h[1]);
    if (v) h2s.push(v);
  }
  if (h2s.length) rec.titleVisible = h2s.join(' ; ');

  // 源数据本身没有书名的记录（机读块无 <ti>、可见标题亦空，只剩拼音），实测约占 1%。
  // 显式标注来源，不静默留空、也不用拼音冒充书名。
  if (!rec.ti || !rec.ti.length) {
    if (rec.titleVisible) {
      rec.ti = [rec.titleVisible];
      rec.tiSource = '可见标题回填';
    } else {
      rec.tiSource = '源记录无书名（仅有拼音）';
    }
  }

  // 母丛书（页首指向亲记录的链接 + 紧随的出版项）
  const top = body.slice(0, 3000);
  const pm = top.match(/<A\s+HREF="[^"]*\?record=[^"]*"[^>]*>([\s\S]*?)<\/A>/i);
  if (pm) {
    rec.parentTitle = clean(pm[1]);
    const after = top.slice(pm.index + pm[0].length, pm.index + pm[0].length + 800);
    const fm = after.match(/<FONT[^>]*>([\s\S]*?)<\/FONT>/i);
    if (fm) rec.parentBib = clean(fm[1]);
  }

  const im = body.match(/<IMG\s+SRC="([^"]+)"/i);
  rec.hasImage = !!im;
  if (im) rec.imageUrl = decodeEntities(im[1]);

  // 子目清单（丛书母记录）：&nbsp;<册名><UL> <A>题名</A> <FONT -2>著者</FONT> …
  const children = [];
  const reGroup = /&nbsp;([^<>&]{0,40}?)<UL>([\s\S]*?)<\/UL>/g;
  let g;
  while ((g = reGroup.exec(body)) !== null) {
    const group = clean(g[1]);
    const seg = g[2];
    const reChild = /<A\s+HREF="[^"]*\?record=(data\/[^"&]+)[^"]*"[^>]*>([\s\S]*?)<\/A>(?:\s*<FONT[^>]*>([\s\S]*?)<\/FONT>)?/gi;
    let c;
    while ((c = reChild.exec(seg)) !== null) {
      children.push({ group, title: clean(c[2]), author: clean(c[3] || ''), recordPath: c[1] });
    }
  }
  if (children.length) rec.childrenList = children;

  if (meta.path) {
    const parts = String(meta.path).split('/');
    if (parts.length > 1) rec.institutionDir = parts[1];
  }
  return rec;
}

// ---------------------------------------------------------------- 展示辅助
/** 列显示名（与 kanseki_extract.py 的 FIELD_LABELS 对应） */
export const FIELD_LABELS = {
  nu: '记录号', or: '收藏机构', se: '文库/专藏', si: '索书号', rn: '馆藏/书目号',
  co: '丛书名(含册次)', oy: '所属丛书记录号', ti: '书名', tiKey: '书名标目',
  tiSource: '书名来源', st: '附加题名', pt: '别题名', au: '著者', auKey: '著者标目',
  pinyinTi: '书名拼音', pinyinAu: '著者拼音', fi: '部', sf: '类', tg: '属',
  ki: '目（四级分类）', yr: '刊年', pb: '出版者', ed: '版本', sd: '藏板',
  vi: '数量/卷册', no: '附注', ko: '子目记录号',
  parentTitle: '母丛书名', parentBib: '母丛书出版项',
};

const LIST_FIELDS = new Set(['ti', 'tiKey', 'st', 'pt', 'au', 'auKey', 'pinyinTi', 'pinyinAu', 'no', 'ko']);

/** 记录 → 展示用键值对数组（跳过空值与仅内部使用的字段） */
export function recordToPairs(rec) {
  const pairs = [];
  for (const k of Object.keys(FIELD_LABELS)) {
    const v = rec[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const text = Array.isArray(v) ? v.join(' ; ') : String(v);
    if (!text) continue;
    pairs.push({ key: k, label: FIELD_LABELS[k], value: text });
  }
  return pairs;
}

/** 逗号/空格分隔的多值输入 → 去重数组 */
export function splitTerms(input) {
  return String(input || '')
    .split(/[\s,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

export { LIST_FIELDS };
