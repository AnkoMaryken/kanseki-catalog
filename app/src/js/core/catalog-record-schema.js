// ================================================
// core/catalog-record-schema.js — 编目记录字段模型（纯逻辑，零 DOM）
// ================================================
// 字段源自用户提供的「【27】編目表格模板.xlsx」（全球汉籍合璧工程编目表，14 列）
//
// ⚠️ TODO-ENABLE（后期启用）：
//   本期「编目记录」为框架占位，不建 IndexedDB store、不落库。
//   手机/平板端开发时启用本模块：创建 catalog_records store
//   （IndexedDB schema v1 已预留空 store，无迁移成本），
//   并接入 sync-engine 的 LWW + 墓碑同步（与 quick_links 同策略）。
// ================================================

// 必填字段（模板中带 * 号者，8 项）
export const REQUIRED_FIELDS = [
  'category',   // *類目
  'title',      // *書名
  'volume',     // *卷數
  'shelf',      // *索書號
  'author',     // *〔撰者時代〕撰（編輯修）者
  'version',    // *版本
  'copies',     // *函册（存缺情況）
  'format',     // *版式
];

// 选填字段（6 项）
export const OPTIONAL_FIELDS = [
  'frontmatter', // 扉頁、刊記等
  'verso',       // 紙背文獻（無則不填）
  'appendix',    // 附録
  'series',      // 叢書子目
  'catalogers',  // 編目者、校對者
];

// 全部业务字段（按模板列序，seq 为自动编号不入此列）
export const ALL_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

// 字段定义：key / 简体标签（数据存储与检索用）/ 繁体显示标签 / 类型 / 提示
// 模板表头原文见 hint（繁体）
export const FIELD_DEFS = {
  category: {
    label: '類目',
    labelT: '類目',
    type: 'text',
    required: true,
    hint: '如「X部·XX類/XX編」',
    templateHeader: '*類目'
  },
  title: {
    label: '書名',
    labelT: '書名',
    type: 'text',
    required: true,
    hint: '以正文卷端所題書名爲准',
    templateHeader: '*書名'
  },
  volume: {
    label: '卷數',
    labelT: '卷數',
    type: 'text',
    required: true,
    hint: '「二卷附略例二卷」/「不分卷」',
    templateHeader: '*卷數'
  },
  shelf: {
    label: '索書號',
    labelT: '索書號',
    type: 'text',
    required: true,
    hint: '如「一·〇二·〇一 堀田」',
    templateHeader: '*索書號'
  },
  author: {
    label: '著者',
    labelT: '著者',
    type: 'text',
    required: true,
    hint: '撰/編/輯/修；注/疏/校/訂 分類著錄，時代加〔〕',
    templateHeader: '*〔撰者時代〕撰（編輯修）者'
  },
  version: {
    label: '版本',
    labelT: '版本',
    type: 'text',
    required: true,
    hint: '出版時間/地/者/方式/配補',
    templateHeader: '*版本'
  },
  copies: {
    label: '函册',
    labelT: '函册',
    type: 'text',
    required: true,
    hint: '「1函1册（缺卷二）」',
    templateHeader: '*函册（存缺情況）'
  },
  format: {
    label: '版式',
    labelT: '版式',
    type: 'text',
    required: true,
    hint: '行款/書口/魚尾/刻工/邊框/板框高廣（cm）',
    templateHeader: '*版式'
  },
  frontmatter: {
    label: '扉頁、刊記',
    labelT: '扉頁、刊記',
    type: 'textarea',
    required: false,
    hint: '按書名/作者/版元/年代順序著錄',
    templateHeader: '扉頁、刊記等'
  },
  verso: {
    label: '紙背文獻',
    labelT: '紙背文獻',
    type: 'textarea',
    required: false,
    hint: '無則不填',
    templateHeader: '紙背文獻'
  },
  appendix: {
    label: '附録',
    labelT: '附録',
    type: 'textarea',
    required: false,
    hint: '序跋信息/紙張材質/藏書印/批點/日文假名或諺文',
    templateHeader: '附録'
  },
  series: {
    label: '叢書子目',
    labelT: '叢書子目',
    type: 'textarea',
    required: false,
    hint: '著録書名/卷數/作者',
    templateHeader: '叢書子目'
  },
  catalogers: {
    label: '編目者、校對者',
    labelT: '編目者、校對者',
    type: 'text',
    required: false,
    hint: '編目者、校對者',
    templateHeader: '編目者、校對者'
  },
};

// 同步元数据字段（引擎写入，业务只读）
export const META_FIELDS = ['id', 'seq', 'createdAt', 'updatedAt', 'deletedAt', 'deviceId'];

// 生成一条空记录（全部字段空值，含默认元数据）
export function createEmptyRecord() {
  const rec = { id: null, seq: null };
  for (const f of ALL_FIELDS) rec[f] = '';
  rec.createdAt = null;
  rec.updatedAt = null;
  rec.deletedAt = null;
  rec.deviceId = '';
  return rec;
}

// 校验记录：返回 { valid, errors: {field: message} }
// 必填字段 trim 后非空；长度上限 5000 字符
export function validateRecord(rec) {
  const errors = {};
  for (const f of REQUIRED_FIELDS) {
    const v = (rec[f] || '').trim();
    if (!v) {
      errors[f] = '此项为必填';
    }
  }
  for (const f of ALL_FIELDS) {
    const v = rec[f] || '';
    if (v.length > 5000) errors[f] = '内容过长（上限 5000 字）';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// 序列化显示标签（简繁跟随全局字形）
// 注意: 为避免循环依赖，本模块不 import conv.js；显示层（ui/records.js）负责 toDisplay 转换

// 排序键: 默认按 updatedAt 降序（新编辑在前），可切换
export function sortRecords(records, dir = 'desc') {
  return [...records].sort((a, b) => {
    const ta = a.updatedAt || 0, tb = b.updatedAt || 0;
    return dir === 'asc' ? ta - tb : tb - ta;
  });
}

// 按书名/索書號/著者 搜索（简体 contains）
export function searchRecords(records, keyword) {
  const kw = (keyword || '').trim().toLowerCase();
  if (!kw) return records;
  return records.filter(r =>
    (r.title || '').toLowerCase().includes(kw) ||
    (r.shelf || '').toLowerCase().includes(kw) ||
    (r.author || '').toLowerCase().includes(kw) ||
    (r.category || '').toLowerCase().includes(kw)
  );
}

// ================================================
// TODO-ENABLE: 以下为后期启用时的 CRUD + 同步接口（本期不调用）
// ================================================

// 创建记录（后期接入 store 时由 storage 层调用）
export function makeNewRecord(data, deviceId) {
  const now = Date.now();
  return {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : genFallbackId(),
    seq: null, // 由 store 在插入时分配（max seq + 1）
    ...data,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deviceId
  };
}

// 软删除（墓碑）
export function markDeleted(rec, deviceId) {
  return Object.assign({}, rec, { deletedAt: Date.now(), updatedAt: Date.now(), deviceId });
}

// 更新（保持 createdAt，刷新 updatedAt）
export function touchUpdated(rec, data, deviceId) {
  const now = Date.now();
  const out = Object.assign({}, rec, data, { updatedAt: now, deviceId });
  if (!out.createdAt) out.createdAt = now;
  return out;
}

// 无 crypto.randomUUID 环境的兜底 ID
export function genFallbackId() {
  return 'rec-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
