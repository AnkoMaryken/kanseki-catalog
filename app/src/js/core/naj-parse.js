// ================================================
// core/naj-parse.js — 国立公文書館デジタルアーカイブ 解析器（纯函数，零 DOM）
// ================================================
// 数据源：https://www.digital.archives.go.jp
//
// 两条数据通道（均为实测结论，2026-10 活体探测）：
//   1) 检索：GET /search?ks0=<范围>&kw0=<词>&rows=<N>&page=<P>
//      —— 服务端渲染 HTML，类名稳定（archive-result-table__body-item /
//         result-header__title / result-tree__item-label / result-summary__item）
//   2) 详情：GET /{item|file|fonds}/<ID>.json —— JSON-LD（@graph + @context），
//      字段远比 HTML 干净，故详情一律走它。
//
// 原站检索习惯（照搬，勿擅自改）：
//   · 単語は 1 語ずつ kw0 に入れる；空の kw0 は 400 を返すので必ず値を持たせる
//   · 検索範囲は ks0 = kw_all / kw_title / kw_creator / kw_item / kw_id
//     （ks0 を付けずに kw0 だけ渡すと 400。ks0=kw_all が「すべて」）
//   · 表示件数は rows、ページは page（1 始まり）
//   · 参照コード範囲は reference_from / reference_to、資料種別は type（未使用）
//
// 本模块只做「字符串 → 结构」的纯转换，便于在 node:test 下直接单测。
// ================================================

export const NAJ_ORIGIN = 'https://www.digital.archives.go.jp';

/** 检索范围取值（与原站下拉一致；标签为中文） */
export const SCOPES = [
  { value: 'kw_all', label: '全部（遍及各项目）' },
  { value: 'kw_title', label: '题名' },
  { value: 'kw_creator', label: '作成者' },
  { value: 'kw_item', label: '件名·细目' },
  { value: 'kw_id', label: '参照代码' },
];

/** 资料种别（原站 type）——用于「只筛簿册」或「只筛件名」（d22/d23 实测有效） */
export const TYPES = [
  { value: 'da22', label: '簿册' },
  { value: 'da23', label: '件名·细目' },
  { value: 'da21', label: '资料群' },
];

/** 图像等种类（原站 img_type；实测仅 01 有独立结果） */
export const IMG_TYPES = [
  { value: '01', label: '图像' },
  { value: '11', label: '影音' },
  { value: '02', label: '电子公文' },
];

/** 利用限制（原站 limit） */
export const LIMITS = [
  { value: '01', label: '公开' },
  { value: '02', label: '需审查' },
  { value: '03', label: '部分公开' },
  { value: '04', label: '不公开' },
];

/** 保存场所（原站 stack） */
export const STACKS = [
  { value: '01', label: '本馆' },
  { value: '02', label: '分馆' },
  { value: '03', label: '电子公文等系统' },
  { value: '04', label: '外部书库' },
];

/** 表示件数（原站 rows） */
export const ROWS_OPTIONS = [20, 50, 100, 200];

/**
 * 内閣文庫漢籍分类（原站資料群 ID，实测确认）。
 *
 * 原站层级：内閣文庫 → 漢書（其中文典籍部）→ 経の部／史の部／子の部／集の部／叢書の部／新書の部
 * 检索方式：`fond=<ID>` 与原站行为一致（实测会真实收窄命中数，如 内閣文庫 2214 → 漢書 2107）。
 * 标签按用户要求用中文（經/史/子/集/叢書/新書），并保留原站名称便于核对。
 */
export const NAIKAKU_BUNKO = {
  id: '2308962',
  title: '内閣文庫',
  pageUrl: `${NAJ_ORIGIN}/fonds/2308962`,
  groups: [
    { id: '3602612', label: '漢籍（漢書部）', jp: '漢書', pageUrl: `${NAJ_ORIGIN}/fonds/3602612` },
    { id: '3610545', label: '經部', jp: '経の部', pageUrl: `${NAJ_ORIGIN}/fonds/3610545` },
    { id: '3602613', label: '史部', jp: '史の部', pageUrl: `${NAJ_ORIGIN}/fonds/3602613` },
    { id: '3611449', label: '子部', jp: '子の部', pageUrl: `${NAJ_ORIGIN}/fonds/3611449` },
    { id: '3610170', label: '集部', jp: '集の部', pageUrl: `${NAJ_ORIGIN}/fonds/3610170` },
    { id: '1080082', label: '叢書部', jp: '叢書の部', pageUrl: `${NAJ_ORIGIN}/fonds/1080082` },
    { id: '1083362', label: '新書部', jp: '新書の部', pageUrl: `${NAJ_ORIGIN}/fonds/1083362` },
    { id: '3682585', label: '和書部（日文典籍）', jp: '和書', pageUrl: `${NAJ_ORIGIN}/fonds/3682585` },
  ],
};

/** 层级路径片段 → 中文层级名（原站：資料群 / 簿冊 / 件名・細目） */
const LEVEL_NAMES = {
  fonds: '资料群',
  file: '簿册',
  item: '件名·细目',
};

// ---------------------------------------------------------------- 基础工具

export function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&#32;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 去掉标签 + 实体还原 + 空白归一
 *
 * ⚠️ 行内标签直接删除、**不插空格**：原站标题常拆成多个 span
 * （如 `<span>後</span><span>漢書</span>`），若一律以空格替换标签，
 * 会解析成「後 漢書」这种带空格的假标题（与 JSON-LD 的真值「後漢書」不一致）。
 * 块级标签与 <br> 才视为空白分隔。
 */
const BLOCK_TAG = /<\/?(?:br|p|div|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|h[1-6]|section|article|header|footer)\b[^>]*>/gi;

export function clean(s) {
  const spaced = String(s == null ? '' : s).replace(BLOCK_TAG, ' ');
  const noTags = spaced.replace(/<[^>]*>/g, '');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

/** 去掉日文著录里的方括号：`[請求番号]` → `請求番号` */
export function stripBrackets(s) {
  return String(s || '').replace(/^[\s[［【]+|[\s\]］】]+$/g, '').trim();
}

/** 从 URL 取资源类型与 ID：/file/3879332 → { level:'file', id:'3879332' } */
export function splitNajPath(url) {
  const m = String(url || '').match(/\/(fonds|file|item)\/(\d+)/);
  if (!m) return { level: '', id: '' };
  return { level: m[1], id: m[2] };
}

/** 该 URL 是否属于本馆站点（用于「打开原网页」前的校验） */
export function isNajUrl(url) {
  return /^https:\/\/www\.digital\.archives\.go\.jp\//i.test(String(url || ''));
}

/** 人类可读页面地址（JSON-LD 里的 @id 是 http，需转 https；空白节点返回空串） */
export function toPageUrl(uriOrId) {
  const s = String(uriOrId || '');
  const m = s.match(/\/(fonds|file|item)\/(\d+)/);
  if (m) return `${NAJ_ORIGIN}/${m[1]}/${m[2]}`;
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  return '';
}

/** 移交元机关等（原站 inst，147 项；机关名为专名，沿用原站著录） */
export const INSTITUTIONS = [
  ['00a', '内閣官房'], ['00b', '人事院'], ['00c', '内閣府'], ['00e', '法務省'], ['00f', '外務省'], ['00g', '財務省'],
  ['00h', '文部科学省'], ['00i', '厚生労働省'], ['00j', '農林水産省'], ['00k', '経済産業省'], ['00l', '国土交通省'], ['00m', '環境省'],
  ['00n', '防衛省'], ['00r', '会計検査院'], ['00s', '総務省'], ['00t', '復興庁'], ['00u', 'デジタル庁'], ['10c', '宮内庁'],
  ['10d', '公正取引委員会'], ['10e', '原子力防災会議'], ['10g', '国税庁'], ['10h', '文化庁'], ['10i', '中央労働委員会'], ['10k', '中小企業庁'],
  ['10l', '観光庁'], ['10m', '原子力規制委員会'], ['10n', '防衛装備庁'], ['10o', 'スポーツ庁'], ['20c', '警察庁'], ['20d', '公害等調整委員会'],
  ['20e', '公安審査委員会'], ['20f', '個人情報保護委員会'], ['20g', '国家公安委員会'], ['20j', '林野庁'], ['20k', '特許庁'], ['20l', '海上保安庁'],
  ['30a', '内閣法制局'], ['30c', '防衛庁'], ['30e', '公安調査庁'], ['30j', '水産庁'], ['30k', '資源エネルギー庁'], ['30l', '気象庁'],
  ['40c', '金融庁'], ['40d', '消防庁'], ['40e', '出入国在留管理庁'], ['40l', '運輸安全委員会'], ['50c', '消費者庁'], ['50e', '検察庁'],
  ['60c', 'カジノ管理委員会'], ['70c', 'こども家庭庁'], ['A00', '＊人事院'], ['B00', '＊内閣・総理府'], ['C00', '＊公正取引委員会'], ['D00', '＊警察庁'],
  ['E00', '＊公害等調整委員会'], ['F00', '＊宮内庁'], ['G00', '＊総務庁'], ['H00', '＊防衛庁'], ['I00', '＊経済企画庁'], ['J00', '＊科学技術庁'],
  ['K00', '＊環境庁'], ['L00', '＊沖縄開発庁'], ['M00', '＊金融監督庁'], ['N00', '＊法務省'], ['O00', '＊外務省'], ['P00', '＊大蔵省'],
  ['Q00', '＊文部省'], ['R00', '＊厚生省'], ['R01', '＊社会保険庁'], ['S00', '＊農林水産省'], ['S01', '＊食糧庁'], ['T00', '＊通商産業省'],
  ['U00', '＊運輸省'], ['01u', '＊気象庁'], ['V00', '＊郵政省'], ['30d', '＊郵政事業庁'], ['W00', '＊労働省'], ['X00', '＊建設省'],
  ['Y00', '＊自治省'], ['501', '内閣府（官報）'], ['Z00', '最高裁判所'], ['Z01', '最高裁判所（司法行政文書）'], ['00w', '民事判決原本'], ['Z09', '軍法会議関係文書'],
  ['Z10', '刑事参考記録'], ['101', '国立公文書館'], ['102', '科学技術振興機構'], ['103', '農林水産消費安全技術センター'], ['104', '経済産業研究所'], ['105', '平和祈念事業特別基金'],
  ['106', '情報処理推進機構'], ['107', '都市再生機構'], ['108', '和歌山大学'], ['109', '住宅金融支援機構'], ['110', '国際観光振興機構'], ['111', '鉄道建設・運輸施設整備支援機構'],
  ['112', '郵便貯金・簡易生命保険管理機構'], ['113', '情報通信研究機構'], ['114', '人間文化研究機構'], ['115', '日本中央競馬会'], ['116', '富山大学'], ['117', '土木研究所'],
  ['118', '宇宙航空研究開発機構'], ['119', '郵便貯金簡易生命保険管理・郵便局ネットワーク支援機構'], ['120', '日本スポーツ振興センター'], ['121', '日本学術振興会'], ['122', '国立高等専門学校機構'], ['123', '水産研究・教育機構'],
  ['124', '環境再生保全機構'], ['125', '筑波技術大学'], ['126', '高知大学'], ['127', '家畜改良センター'], ['128', '医薬品医療機器総合機構'], ['129', '日本学生支援機構'],
  ['130', '産業技術総合研究所'], ['131', '横浜国立大学'], ['132', '沖縄科学技術大学院大学学園'], ['133', '年金積立金管理運用独立行政法人'], ['134', '教職員支援機構'], ['135', '日本芸術文化振興会'],
  ['136', '量子科学技術研究開発機構'], ['137', '埼玉大学'], ['138', '東京学芸大学'], ['139', '上越教育大学'], ['140', '福井大学'], ['141', '静岡大学'],
  ['142', '愛知教育大学'], ['143', '岡山大学'], ['144', '統計センター'], ['145', '日本政策金融公庫'], ['146', '信州大学'], ['147', '自然科学研究機構'],
  ['148', '造幣局'], ['149', '沖縄振興開発金融公庫'], ['150', '外国人技能実習機構'], ['151', '日本司法支援センター'], ['152', '新潟大学'], ['153', '長岡技術科学大学'],
  ['154', '浜松医科大学'], ['155', '大阪教育大学'], ['156', '奈良国立大学機構'], ['157', '奈良先端科学技術大学院大学'], ['158', '大分大学'], ['159', '琉球大学'],
  ['zza', '寄贈資料'], ['zzb', '寄託資料'], ['zzc', 'オーストラリア国立公文書館'],
];



/** 旧藏（文库）（原站 ware，52 项；文库名为专名，沿用原站著录） */
export const OLD_HOLDINGS = [
  ['01', '紅葉山文庫'], ['02', '昌平坂学問所'], ['03', '医学館'], ['04', '和学講談所'], ['05', '編修地志備用典籍'], ['06', '多聞櫓'],
  ['07', '林羅山'], ['08', '林家（大学頭）'], ['09', '豊後佐伯藩主毛利高標献上本'], ['10', '近江西大路藩主市橋長昭献上本'], ['11', '木村兼葭堂'], ['12', '堀氏花迺家文庫'],
  ['13', '塙氏温故堂文庫'], ['21', '内務省'], ['22', '外務省'], ['23', '大蔵省'], ['24', '司法省'], ['25', '教部省'],
  ['26', '宮内省'], ['27', '文部省'], ['28', '農商務省'], ['29', '元老院'], ['30', '左院'], ['31', '枢密院'],
  ['32', '会計検査院'], ['33', '逓信省'], ['41', '太政官正院歴史課・修史局・修史館・内閣臨時修史局'], ['42', '太政官正院地志課・地理寮地誌課・内務省地理局'], ['43', '大学校・大学'], ['44', '書籍館'],
  ['45', '駅逓局'], ['46', '制度取調局'], ['47', '拓殖局'], ['48', '統計院'], ['49', '法制局'], ['50', '賞勲局'],
  ['51', '翻訳局'], ['61', '押小路家'], ['62', '甘露寺家'], ['63', '蜷川家'], ['64', '広橋家'], ['65', '山科家'],
  ['66', '伊勢・春木家'], ['67', '伊勢・松木家'], ['68', '中御門家'], ['69', '日野家'], ['70', '坊城家'], ['71', '万里小路家'],
  ['72', '興福寺大乗院'], ['73', '高野山釈迦文院'], ['91', '町田久成'], ['99', 'その他'],
];

// ---------------------------------------------------------------- 检索

/**
 * 构造检索 URL（严格照原站参数习惯，顺序稳定便于测试）
 *
 * 只传 `keyword`(+scope/rows/page) 时输出与 V9.5 初版完全一致；
 * 其余为「详细检索」条件，缺省即不发送该参数。
 *
 * @param {{keyword:string, scope?:string, rows?:number, page?:number,
 *          types?:string[], imgType?:string, limit?:string, stack?:string,
 *          yearFrom?:string|number, yearTo?:string|number,
 *          inst?:string, ware?:string, fond?:string,
 *          referenceFrom?:string, referenceTo?:string}} opt
 */
export function buildSearchUrl(opt = {}) {
  const params = new URLSearchParams();
  const scope = opt.scope || 'kw_all';
  params.set('ks0', scope);
  params.set('kw0', String(opt.keyword == null ? '' : opt.keyword).trim());

  // 详细检索（原站字段顺序：種別 / 画像 / 利用制限 / 保存場所 / 年月日 / 機関 / 文庫 / 参照コード / 資料群）
  // 这几项原站都是复选框、可多选；单值写法（imgType/limit/stack）仍兼容
  const push = (name, v) => {
    const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
    for (const x of arr) if (x) params.append(name, x);
  };
  push('type', opt.types);
  push('img_type', opt.imgTypes || opt.imgType);
  push('limit', opt.limits || opt.limit);
  push('stack', opt.stacks || opt.stack);
  // 作成年（公历）：原站的 date_e_* 是年号选择器，纯公历年直接给 date_y_* 即可（实测有效）
  if (opt.yearFrom !== undefined && opt.yearFrom !== null && String(opt.yearFrom) !== '') {
    params.set('date_y_from', String(opt.yearFrom));
  }
  if (opt.yearTo !== undefined && opt.yearTo !== null && String(opt.yearTo) !== '') {
    params.set('date_y_to', String(opt.yearTo));
  }
  if (opt.inst) params.append('inst', opt.inst);
  if (opt.ware) params.append('ware', opt.ware);
  if (opt.referenceFrom) params.set('reference_from', opt.referenceFrom);
  if (opt.referenceTo) params.set('reference_to', opt.referenceTo);
  if (opt.fond) params.append('fond', opt.fond);

  params.set('rows', String(opt.rows || 20));
  params.set('page', String(opt.page || 1));
  return `${NAJ_ORIGIN}/search?${params.toString()}`;
}

/** 构造单条记录的机器可读地址 */
export function buildRecordUrl(levelOrId, maybeId) {
  if (maybeId === undefined) {
    const { level, id } = splitNajPath(levelOrId);
    if (!level) return '';
    return `${NAJ_ORIGIN}/${level}/${id}.json`;
  }
  return `${NAJ_ORIGIN}/${levelOrId}/${maybeId}.json`;
}

const RE_ITEM = /<li[^>]*class="[^"]*archive-result-table__body-item[^"]*"[^>]*>/g;

/**
 * 解析检索结果页
 * @returns {{total:number|null, from:number|null, to:number|null, rows:number|null,
 *            items:Array, isEmpty:boolean, isForm:boolean, echo:{kw0:string,ks0:string}}}
 */
export function parseSearchPage(html) {
  const t = String(html == null ? '' : html);

  // 原站回显的检索条件（用于「本次检索条件」摘要，比前端自记更可信）
  const kwEcho = t.match(/name="kw0"\s+value="([^"]*)"/);
  const ksEcho = t.match(/name="ks0"\s+value="([^"]*)"/);

  // 三种页面形态（实测）：
  //   ① 检索结果页：有 archive-result-table + count-number
  //   ② 零结果页：只有「該当する資料が見つかりませんでした。」，无表格无计数
  //   ③ 检索表单页（未执行检索）：只有 archive-finder-form，无表格无零结果提示
  const isEmpty = /該当する資料が見つかりませんでした/.test(t);
  const hasTable = t.indexOf('archive-result-table') >= 0;
  const isForm = !isEmpty && !hasTable && t.indexOf('archive-finder-form') >= 0;
  const out = {
    total: isEmpty ? 0 : null,
    from: null,
    to: null,
    rows: null,
    items: [],
    isEmpty,
    isForm,
    echo: {
      kw0: kwEcho ? decodeEntities(kwEcho[1]) : '',
      ks0: ksEcho ? decodeEntities(ksEcho[1]) : '',
    },
  };

  // 命中数：优先 data-count，其次 count-number 文本
  const dc = t.match(/class="count-number"[^>]*data-count="(\d+)"/);
  if (dc) out.total = parseInt(dc[1], 10);
  else {
    const cn = t.match(/class="count-number"[^>]*>([\d,]+)</);
    if (cn) out.total = parseInt(cn[1].replace(/,/g, ''), 10);
    else {
      const jp = t.match(/検索結果数[\s\S]{0,120}?([\d,]{1,})\s*件/);
      if (jp) out.total = parseInt(jp[1].replace(/,/g, ''), 10);
    }
  }

  // 显示区间：`1 ~ 20件を表示`
  // ⚠️ 只在 count-range 块内取数。若该块不存在（原站改版/降级页），
  //    绝不能退化为「扫全页任意两个数字」——那会静默给出 1–2 这种错区间，
  //    进而把分页从 36 页算成 358 页。宁可返回 null（界面走「未取得区间」分支）。
  const rangeBlock = t.match(/class="archive-result-header__count-range"[\s\S]{0,400}?<\/span>\s*<\/div>/);
  if (rangeBlock) {
    const nums = [...rangeBlock[0].matchAll(/<span[^>]*>\s*([\d,]+)\s*<\/span>/g)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(n => Number.isFinite(n));
    if (nums.length >= 2) { out.from = nums[0]; out.to = nums[1]; }
    else if (nums.length === 1) { out.from = nums[0]; out.to = nums[0]; }
  }
  out.rows = (out.from != null && out.to != null) ? (out.to - out.from + 1) : null;

  if (isForm || isEmpty) return out;

  // 结果条目：按 opening tag 位置切片（内部还有 ol>li，不能按 li 粗暴切）
  const starts = [];
  let m;
  RE_ITEM.lastIndex = 0;
  while ((m = RE_ITEM.exec(t)) !== null) starts.push({ start: m.index, end: m.index + m[0].length });
  const ulEnd = t.indexOf('</ul>', starts.length ? starts[starts.length - 1].end : 0);

  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].end;
    const to = (i + 1 < starts.length) ? starts[i + 1].start : (ulEnd > from ? ulEnd : t.length);
    const item = parseResultItem(t.slice(from, to));
    if (item) out.items.push(item);
  }
  return out;
}

/**
 * 分类检索结果，供界面区分四种情形（`naj-db.js` 据此显示不同文案）。
 *
 * ⚠️ 不能只看 `items.length`：原站改版导致条目类名变化时，
 * `total` 仍是真实命中数而 `items` 为空 —— 若一律当「没有命中」，
 * 界面就会一边显示「命中 715 件」一边说「没有命中」，把改版伪装成空结果。
 * @returns {'form'|'empty'|'ok'|'unparsed'}
 */
export function classifySearch(parsed) {
  if (!parsed) return 'unparsed';
  if (parsed.isForm) return 'form';
  if (parsed.items && parsed.items.length > 0) return 'ok';
  if (parsed.total !== null && parsed.total !== undefined && parsed.total > 0) return 'unparsed';
  return 'empty';
}

/** 解析单条结果（入参为该条目自身的 HTML 片段） */
export function parseResultItem(frag) {
  const f = String(frag || '');
  const noM = f.match(/archive-result-table__body-item-cell-label">([^<]*)</);
  const kindM = f.match(/cmn-category-label__text">([^<]*)</);
  const titleM = f.match(/class="result-header__title"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  const idM = f.match(/class="csv-export"[^>]*name="id"[^>]*value="([^"]+)"/) ||
              f.match(/name="id"[^>]*value="([^"]+)"/);

  // 标题链接缺失（原站偶有）时用 id 兜底，绝不臆造标题
  const url = titleM ? decodeEntities(titleM[1]) : '';
  const { level, id } = splitNajPath(url);
  const title = titleM ? clean(titleM[2]) : '';

  const hierarchy = [];
  const treeRe = /class="result-tree__item-label">\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let tm;
  while ((tm = treeRe.exec(f)) !== null) {
    hierarchy.push({ url: decodeEntities(tm[1]), title: clean(tm[2]) });
  }

  const fields = [];
  const sumRe = /class="result-summary__label"[^>]*>([\s\S]*?)<\/dt>[\s\S]*?class="result-summary__value"[^>]*>([\s\S]*?)<\/dd>/g;
  let sm;
  while ((sm = sumRe.exec(f)) !== null) {
    const label = stripBrackets(clean(sm[1]));
    const value = clean(sm[2]);
    if (label) fields.push({ label, value });
  }

  // 「画像等」列：有图时给出图片地址（无图则该列为空）
  const imgM = f.match(/cell-image[\s\S]{0,1200}?<img[^>]*src="([^"]+)"/);
  const imageUrl = imgM ? toAbsolute(decodeEntities(imgM[1])) : '';

  return {
    no: noM ? clean(noM[1]) : '',
    kind: kindM ? clean(kindM[1]) : (LEVEL_NAMES[level] || ''),
    level,
    id,
    recordId: idM ? decodeEntities(idM[1]) : '',
    title,
    url: url || (level ? `${NAJ_ORIGIN}/${level}/${id}` : ''),
    hierarchy,
    fields,
    imageUrl,
    hasImage: !!imageUrl,
  };
}

function toAbsolute(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  return NAJ_ORIGIN + (u.startsWith('/') ? u : '/' + u);
}

/** 结果条目 → 展示用键值对（详情面板/结果卡末尾统一用这个） */
export function itemToPairs(item) {
  if (!item) return [];
  const pairs = [];
  if (item.no) pairs.push({ label: 'No.', value: item.no });
  if (item.kind) pairs.push({ label: '資料種別', value: item.kind });
  if (item.hierarchy && item.hierarchy.length) {
    pairs.push({ label: '階層', value: item.hierarchy.map(h => h.title).join(' ＞ ') });
  }
  for (const p of (item.fields || [])) pairs.push(p);
  return pairs.filter(p => p.value !== '' && p.value != null);
}

// ---------------------------------------------------------------- 详情（JSON-LD）

// ⚠️ 实测要点：该站 JSON-LD 的属性键是**紧凑前缀名**（`dct:title`、`foaf:name`…），
// 而不是展开后的完整 URI；@context 里才有映射。两种写法都要认，
// 否则会静默取到空值（曾因此把空标题当真值）。
const KEY_ALIASES = {
  title: ['dct:title', 'http://purl.org/dc/terms/title'],
  creator: ['foaf:name', 'http://xmlns.com/foaf/0.1/name'],
  identifier: ['dct:identifier', 'http://purl.org/dc/terms/identifier'],
  physloc: ['ead:physloc', 'http://www.digital.archives.go.jp/voc/ead/physloc'],
  abstract: ['dct:abstract', 'http://purl.org/dc/terms/abstract'],
  language: ['dct:language', 'http://purl.org/dc/terms/language'],
  dateFrom: ['prov:startedAtTime', 'http://www.w3.org/ns/prov#startedAtTime'],
  dateTo: ['prov:endedAtTime', 'http://www.w3.org/ns/prov#endedAtTime'],
  license: ['dct:license', 'http://purl.org/dc/terms/license'],
  accessRestrict: ['ead:accessrestrict', 'http://www.digital.archives.go.jp/voc/ead/accessrestrict'],
  useRestrict: ['ead:userestrict', 'http://www.digital.archives.go.jp/voc/ead/userestrict'],
  medium: ['dct:medium', 'http://purl.org/dc/terms/medium'],
  source: ['dct:source', 'http://purl.org/dc/terms/source'],
  contentUrl: ['owl:sameAs', 'http://www.w3.org/2002/07/owl#sameAs'],
  iiifManifest: ['rdfs:seeAlso', 'http://www.w3.org/2000/01/rdf-schema#seeAlso'],
  thumbnail: ['foaf:thumbnail', 'http://xmlns.com/foaf/0.1/thumbnail'],
  parentUri: ['dct:isPartOf', 'http://purl.org/dc/terms/isPartOf'],
  materialspec: ['ead:materialspec', 'http://www.digital.archives.go.jp/voc/ead/materialspec'],
  subject: ['dct:subject', 'http://purl.org/dc/terms/subject'],
};

/** 取属性值（可能是标量、{@id}、{@value}、数组），统一返回字符串数组 */
// 注意：按别名顺序取**第一个能取到值**的键。若某别名存在但值为空数组，
// 必须继续看后面的别名（否则 `dct:title: []` 会遮蔽完整 URI 键上的标题）。
function values(node, keys) {
  if (!node) return [];
  for (const k of (Array.isArray(keys) ? keys : [keys])) {
    const v = node[k];
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    const out = [];
    for (const x of arr) {
      if (x == null) continue;
      if (typeof x === 'string') out.push(x);
      else if (typeof x === 'object' && x['@id']) out.push(x['@id']);
      else if (typeof x === 'object' && x['@value'] != null) out.push(String(x['@value']));
    }
    if (out.length) return out;
  }
  return [];
}

function first(node, keys) {
  const vs = values(node, keys);
  return vs.length ? vs[0] : '';
}

/** 是否为真实资源 URI（排除 JSON-LD 空白节点 `_:xxx`） */
function isResourceId(id) {
  return /^https?:\/\//i.test(String(id || ''));
}

/** 空白节点的可读文本（rdfs:label / dct:title）；无则不返回原始 `_:` 串 */
function bnodeText(byId, id) {
  const n = byId && byId[id];
  if (!n) return '';
  return first(n, ['rdfs:label', 'http://www.w3.org/2000/01/rdf-schema#label']) ||
         first(n, KEY_ALIASES.title) || '';
}

/** 该站用 `0000` 表示「年代不详」——必须归零，不能当真年份显示 */
function normDate(v) {
  const s = String(v == null ? '' : v).trim();
  return /^0+$/.test(s) ? '' : s;
}

/**
 * 解析单条记录的 JSON-LD
 * @param {string} text
 * @returns {object|null}
 */
export function parseRecordJson(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (_) { return null; }
  if (!data) return null;

  const graph = Array.isArray(data['@graph']) ? data['@graph'] : (Array.isArray(data) ? data : [data]);
  const byId = {};
  for (const n of graph) if (n && n['@id']) byId[n['@id']] = n;

  // 主节点：真实 http(s) 资源 URI + 带标题；再退化为任意带标题者
  let main = graph.find(n => n && isResourceId(n['@id']) && /\/(fonds|file|item)\/\d+$/.test(n['@id']) && first(n, KEY_ALIASES.title));
  if (!main) main = graph.find(n => n && isResourceId(n['@id']) && first(n, KEY_ALIASES.title));
  if (!main) main = graph.find(n => n && isResourceId(n['@id']) && /\/(fonds|file|item)\/\d+$/.test(n['@id']));
  if (!main) return null;

  const uri = main['@id'] || '';
  const { level, id } = splitNajPath(uri);

  // ead:materialspec 指向空白节点（rdfs:label + rdf:value），承载 資料種別/目録データ種別/階層情報
  const specs = [];
  for (const ref of values(main, KEY_ALIASES.materialspec)) {
    const bn = byId[ref];
    if (!bn) continue;
    const label = first(bn, ['rdfs:label', 'http://www.w3.org/2000/01/rdf-schema#label']);
    const value = first(bn, ['rdf:value', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#value']);
    if (label || value) specs.push({ label, value });
  }

  // dct:source 指向 ead:Acquisition 空白节点：其 dct:medium 才是「媒体の種別」；
  // 该节点若无 label/title，则「出処」显示为空（绝不显示 `_:xxx` 这种内部标识）
  const sourceId = first(main, KEY_ALIASES.source);
  const sourceNode = sourceId ? byId[sourceId] : null;
  const sourceText = bnodeText(byId, sourceId) || (isResourceId(sourceId) ? sourceId : '');

  const rec = {
    uri,
    level,
    id,
    levelName: LEVEL_NAMES[level] || '',
    type: String(first(main, ['@type']) || '').replace(/^ead:/, ''),
    title: first(main, KEY_ALIASES.title),
    creator: first(main, KEY_ALIASES.creator),
    identifier: first(main, KEY_ALIASES.identifier),
    physloc: first(main, KEY_ALIASES.physloc),
    abstract: first(main, KEY_ALIASES.abstract),
    language: first(main, KEY_ALIASES.language),
    dateFrom: normDate(first(main, KEY_ALIASES.dateFrom)),
    dateTo: normDate(first(main, KEY_ALIASES.dateTo)),
    license: first(main, KEY_ALIASES.license),
    accessRestrict: first(main, KEY_ALIASES.accessRestrict),
    useRestrict: first(main, KEY_ALIASES.useRestrict),
    // 簿冊的「媒体の種別」挂在 dct:source 指向的 ead:Acquisition 空白节点上，此处回填
    medium: first(main, KEY_ALIASES.medium) || (sourceNode ? first(sourceNode, KEY_ALIASES.medium) : ''),
    source: sourceText,
    contentUrl: first(main, KEY_ALIASES.contentUrl),
    iiifManifest: first(main, KEY_ALIASES.iiifManifest),
    thumbnail: first(main, KEY_ALIASES.thumbnail),
    parentUri: first(main, KEY_ALIASES.parentUri),
    parentPageUrl: toPageUrl(first(main, KEY_ALIASES.parentUri)),
    specs,
    pageUrl: toPageUrl(uri),
  };
  rec.dateText = [rec.dateFrom, rec.dateTo].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' - ');
  rec.pairs = recordToPairs(rec);
  return rec;
}

/** 详情 → 展示用键值对（顺序即面板显示顺序） */
export function recordToPairs(rec) {
  if (!rec) return [];
  const specOf = (name) => {
    const s = (rec.specs || []).find(x => x.label === name);
    return s ? s.value : '';
  };
  const raw = [
    { label: 'URI', value: rec.uri },
    { label: 'レファレンスコード', value: rec.identifier },
    { label: 'タイトル', value: rec.title },
    { label: '作成者・取得者', value: rec.creator },
    { label: '作成年月日', value: rec.dateText },
    { label: '階層', value: specOf('階層情報') },
    { label: '資料種別', value: specOf('資料種別') },
    { label: '目録データ種別', value: specOf('目録データ種別') },
    { label: '保存場所', value: rec.physloc },
    { label: '利用制限', value: rec.accessRestrict },
    { label: 'コンテンツ公開', value: rec.useRestrict },
    { label: '媒体の種別', value: rec.medium },
    { label: '出処', value: rec.source },
    { label: '言語', value: rec.language },
    { label: 'ライセンス', value: rec.license },
    { label: '資料内容', value: rec.abstract },
    { label: 'コンテンツURL', value: rec.contentUrl },
    { label: 'IIIFマニフェスト', value: rec.iiifManifest },
    { label: '上位資料', value: rec.parentPageUrl || rec.parentUri },
    { label: 'サムネイル', value: rec.thumbnail },
  ];
  return raw.filter(p => p.value !== '' && p.value != null);
}

/** 引用例（该站要求注明出典，目录元数据为 CC0） */
export function citationOf(recOrItem) {
  if (!recOrItem) return '';
  const title = recOrItem.title || '';
  const code = recOrItem.identifier || '';
  const url = recOrItem.pageUrl || recOrItem.url || '';
  return `国立公文書館所蔵「${title}」${code ? '（' + code + '）' : ''}${url ? ' ' + url : ''}`;
}

/** 结果条目 → 引用例（列表里直接用） */
export function citationOfItem(item) {
  if (!item) return '';
  const code = (item.fields || []).find(f => f.label === '請求番号');
  return `国立公文書館所蔵「${item.title}」${code ? '（' + code.value + '）' : ''}${item.url ? ' ' + item.url : ''}`;
}
