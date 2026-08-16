// ================================================
// core/search.js — 搜索与筛选核心（状态 + 纯逻辑，零 DOM）
// 从 index.html IIFE 提取（v4.3 逐字迁移）
// 依赖: conv / ganzhi / dataset / pinyin / precise
// ================================================
import { toSimplified } from './conv.js';
import { extractGanzhi } from './ganzhi.js';
import {
  detectPreciseHit, insertNearbyRows, isNearbyRow, isNearbySep,
  findEraNameInQuery, buildEraAlertInfo
} from './precise.js';
import { rowPinyinHit } from './pinyin.js';

// ========================================
// Filter definitions（纯数据，UI 层渲染用）
// ========================================
export const CHINA_FILTER_GROUPS = [
  {name:'先秦', dynasties:['西周','春秋','战国','秦']},
  {name:'秦汉', dynasties:['西汉','新','东汉']},
  {name:'魏晋南北朝', dynasties:['三国','西晋','东晋','南北朝']},
  {name:'隋唐五代', dynasties:['隋','唐','五代十国']},
  {name:'宋辽金夏', dynasties:['北宋','辽','西夏','金','南宋']},
  {name:'元明清', dynasties:['元','明','清']}
];

export const JAPAN_FILTER_GROUPS = [
  {name:'古代', periods:['飞鸟','奈良','平安']},
  {name:'中世', periods:['镰仓','南北朝','室町']},
  {name:'近世', periods:['安土桃山','江户']},
  {name:'近现代', periods:['近现代']}
];

// ========================================
// 搜索状态（模块级）
// ========================================
let fullData = [];
let filteredData = [];
let currentPage = 1;
let perPage = 50;
let sortDir = 'asc';
let searchQuery = '';
let selectedChinaFilters = new Set();
let selectedChinaEras = new Set();
let selectedJapanFilters = new Set();

// V4.3: 重名提醒缓存（ui 层）——lastEraAlert 由 ui 层管理，这里不做

export function getFilteredData() { return filteredData; }
export function getCurrentPage() { return currentPage; }
export function getPerPage() { return perPage; }
export function getSortDir() { return sortDir; }
export function getSearchQuery() { return searchQuery; }
export function getSelectedChinaFilters() { return selectedChinaFilters; }
export function getSelectedChinaEras() { return selectedChinaEras; }
export function getSelectedJapanFilters() { return selectedJapanFilters; }

export function setFullData(data) { fullData = data; }
export function getFullData() { return fullData; }

// 行级搜索命中判定
// fuzzy=false: 精确匹配 (干支语义 + searchKey 包含 + 公元前特判)
// fuzzy=true:  精确为空时启用模糊补全 (年号前缀+片段)
export function rowSearchHit(row, q, fuzzy) {
  // --- 干支语义解析 ---
  const gzMatch = extractGanzhi(q);
  if (gzMatch) {
    const gz = gzMatch.ganzhi;
    // 纯干支查询: 只要年份干支匹配即命中
    const ganzhiHit = row.ganzhi === gz;

    // 提取干支前后可能的年号关键词 (如"万历癸未"中的"万历")
    const before = q.slice(0, q.indexOf(gz[0]));
    const after = q.slice(q.indexOf(gz[1]) + 1);
    const eraKeyword = (before + after).trim();

    if (eraKeyword) {
      // 年号+干支组合查询: 需同时满足年号与干支
      const eraHit = row.cnEraNames.some(e => e.includes(eraKeyword)) ||
                     row.jpEraNames.some(j => j.includes(eraKeyword)) ||
                     row.jpPeriods.some(p => p.includes(eraKeyword)) ||
                     row.cnDynasties.some(d => d.includes(eraKeyword));
      if (ganzhiHit && eraHit) return true;
      // 组合查询失败时不额外放行, 继续走常规搜索
    } else {
      // 纯干支: 命中即返回
      if (ganzhiHit) return true;
    }
  }

  // --- 常规文本匹配 (基于预构建的简体 searchKey) ---
  if (row.searchKey && row.searchKey.includes(q)) return true;

  // --- 模糊匹配: "年号 + 片段" (如"同治一"→同治十一年, "同治戊"→同治戊辰) ---
  if (fuzzy && q.length >= 3 && row.searchKey) {
    if (eraPrefixHit(row, q)) return true;
  }

  // 公元前年份特判
  if (row.year < 0) {
    const bcStr = '前' + Math.abs(row.year);
    if (bcStr.includes(q) || String(row.year).includes(q)) return true;
  }

  return false;
}

// 模糊命中判定: 查询拆为"年号前缀+片段", 行内任一候选包含该片段
// 例: q="同治一" -> 同治十一年/二十一年; q="同治戊" -> 同治戊戌/戊寅
export function eraPrefixHit(row, q) {
  const eraNames = [];
  if (row.cnEraNames) row.cnEraNames.forEach(e => { if (e && e !== '—') eraNames.push(e); });
  if (row.jpEraNames) row.jpEraNames.forEach(j => { if (j && j !== '—') eraNames.push(j); });
  if (row.jpPeriods) row.jpPeriods.forEach(p => { if (p && p !== '—') eraNames.push(p); });
  for (const name of eraNames) {
    if (!name || name.length < 2 || !q.startsWith(name) || q.length <= name.length) continue;
    const rest = q.slice(name.length);
    if (!rest) continue;
    // 年号全名候选或年号+干支候选, 包含剩余片段即命中
    if (row.eraFullCandidates && row.eraFullCandidates.some(c => c.startsWith(name) && c.includes(rest))) return true;
    if (row.eraGzCandidates && row.eraGzCandidates.some(c => c.startsWith(name) && c.includes(rest))) return true;
  }
  return false;
}

// 排序（V4.2: 临近行/分隔行不参与排序）
export function sortData() {
  const real = filteredData.filter(r => !isNearbyRow(r) && !isNearbySep(r));
  real.sort((a, b) => {
    if (sortDir === 'asc') return a.year - b.year;
    return b.year - a.year;
  });
  filteredData = real;
}

// 主过滤流程（两阶段: 筛选器 → 搜索词精确→模糊 → 精准查询）
// 返回: { filteredData, preciseHit }（不渲染 DOM，由 ui 层调用渲染）
export function applyFilters(options) {
  const renderHooks = options && options.hooks; // { onRender } 可选

  // 1. 先按筛选器 (朝代/年号/时代) 过滤
  let base = fullData.filter(row => {
    // China dynasty filter — check against array
    if (selectedChinaFilters.size > 0) {
      const cnMatch = row.cnDynasties.some(d => selectedChinaFilters.has(d));
      if (!cnMatch) return false;
    }
    // China era name filter — check against array
    if (selectedChinaEras.size > 0) {
      const eraMatch = row.cnEraNames.some(e => selectedChinaEras.has(e));
      if (!eraMatch) return false;
    }
    // Japan period filter — check against array
    if (selectedJapanFilters.size > 0) {
      const jpMatch = row.jpPeriods.some(p => selectedJapanFilters.has(p));
      if (!jpMatch) return false;
    }
    return true;
  });

  // 2. 搜索词两阶段匹配 (精确优先, 精确为空时才启用模糊补全)
  //    避免"万历十一年"被模糊片段误匹配到"万历二十一年"等行
  if (searchQuery.trim()) {
    // 查询词转简体后匹配 (繁简无差别)
    const q = toSimplified(searchQuery.trim()).toLowerCase();
    // v2.0: 拼音/首字母查询走拼音行匹配 (如 "jingtai" -> 景泰年间)
    if (/^[a-z]+$/.test(q)) {
      const pinyinRows = base.filter(r => rowPinyinHit(r, q));
      filteredData = pinyinRows.length > 0 ? pinyinRows : base.filter(r => rowSearchHit(r, q, true));
    } else {
      const exact = base.filter(r => rowSearchHit(r, q, false));
      filteredData = exact.length > 0 ? exact : base.filter(r => rowSearchHit(r, q, true));
    }
  } else {
    filteredData = base;
  }

  // V4.2: 精准查询检测 (排序后进行, 用排序后真实行重新定位, 避免 index 错位)
  let preciseHit = null;
  if (searchQuery.trim() && filteredData.length > 0) {
    const q = toSimplified(searchQuery.trim()).toLowerCase();
    const realBeforeSort = filteredData;
    sortData();
    preciseHit = detectPreciseHit(q, realBeforeSort, fullData);
  } else {
    sortData();
  }
  currentPage = 1;

  // V4.2: 精准命中 → 排序后插入整个年号年份 (紧跟命中行)
  // 注意: insertNearbyRows 仅在首次 (无临近块) 时插入, 幂等
  if (preciseHit && !filteredData.some(r => isNearbySep(r))) {
    // 命中行在排序后的真实行中重新定位 (detectPreciseHit 的 index 基于排序前)
    const real = filteredData.filter(r => !isNearbyRow(r) && !isNearbySep(r));
    const hitYear = preciseHit.year;
    const reIdx = real.findIndex(r => r.year === hitYear);
    if (reIdx >= 0) {
      preciseHit.index = reIdx;
    }
    filteredData = insertNearbyRows(filteredData, preciseHit, fullData);
  }

  if (renderHooks && renderHooks.onRender) renderHooks.onRender();
  return { filteredData, preciseHit };
}

// V4.2: 真实行 (剔除临近行/分隔行) 计数与列表
export function realFilteredCount() {
  return filteredData.filter(r => !isNearbyRow(r) && !isNearbySep(r)).length;
}
export function realFilteredRows() {
  return filteredData.filter(r => !isNearbyRow(r) && !isNearbySep(r));
}

// 设置排序方向并触发重排（ui 层调用）
export function toggleSortDir() {
  sortDir = sortDir === 'asc' ? 'desc' : 'asc';
}

// 设置每页条数
export function setPerPage(n) {
  perPage = n;
  currentPage = 1;
}

export function setCurrentPage(n) {
  currentPage = n;
}

export function setSearchQuery(q) {
  searchQuery = q;
}

// 筛选操作（ui 层点击标签时调用）
export function toggleFilter(type, value) {
  if (type === 'china') {
    if (selectedChinaFilters.has(value)) {
      selectedChinaFilters.delete(value);
    } else {
      selectedChinaFilters.add(value);
    }
    // Clear era sub-filters when dynasty selection changes
    selectedChinaEras.clear();
  } else if (type === 'china-era') {
    if (selectedChinaEras.has(value)) {
      selectedChinaEras.delete(value);
    } else {
      selectedChinaEras.add(value);
    }
  } else {
    if (selectedJapanFilters.has(value)) {
      selectedJapanFilters.delete(value);
    } else {
      selectedJapanFilters.add(value);
    }
  }
}

export function clearFilters() {
  selectedChinaFilters.clear();
  selectedChinaEras.clear();
  selectedJapanFilters.clear();
}

// 重名年号提醒计算（纯逻辑，返回 null 或 { eraName, reason, cnTags, jpTags }）
export function computeEraAlertForQuery(query, eraCnScope, eraJpScope) {
  if (!query || !query.trim()) return null;
  const q = toSimplified(query.trim()).toLowerCase();
  const eraName = findEraNameInQuery(q, fullData);
  if (!eraName) return null;
  return buildEraAlertInfo(eraName, eraCnScope, eraJpScope);
}
