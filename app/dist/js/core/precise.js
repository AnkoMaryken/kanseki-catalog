// ================================================
// core/precise.js — 精准查询/临近行/重名提醒（纯逻辑，零 DOM）
// 从 index.html IIFE 提取（v4.3 逐字迁移）
// 注意: updateEraAlert 的 DOM 部分留在 ui 层，这里只保留数据计算
// ================================================
import { chineseNumToInt, extractGanzhi } from './ganzhi.js';
import { toSimplified, toDisplay } from './conv.js';

// V4.2: 精准命中行标记 (模块级, 不污染 FULL_DATA)
// key: row 对象引用 -> { precise: true, jpFlash: bool }
const preciseHitMark = new Map();

export function getPreciseHitMark() { return preciseHitMark; }

// 该行是否命中日本年号关键词 (用于闪烁提醒)
export function isJapanEraHit(row, keyword) {
  return (row.jpEraNames || []).some(j => j && j !== '—' && j.includes(keyword)) ||
         (row.jpPeriods || []).some(p => p && p !== '—' && p.includes(keyword));
}

// ========================================
// V4.2 精准查询检测: 年号+年份 / 年号+干支 命中单一目标行
// 返回 { index, year, isJp, eraName, scope } 或 null
//   eraName: 命中的年号名 (如 "道光")
//   scope: 归属范围 (如 "清" / "平安") 用于收集整个年号的年份
// ========================================
export function detectPreciseHit(q, rows, fullData) {
  if (!q || q.length < 3) return null;
  const gzMatch = extractGanzhi(q);
  let eraKeyword = '';
  let yearNum = null;

  if (gzMatch) {
    // 年号+干支: "道光丁酉" -> 道光 + 丁酉
    const gz = gzMatch.ganzhi;
    const before = q.slice(0, q.indexOf(gz[0]));
    const after = q.slice(q.indexOf(gz[1]) + 1);
    eraKeyword = (before + after).trim();
    if (!eraKeyword) return null; // 纯干支不触发
    // 目标年: 该干支年份中, 年号命中且最接近
    const gzRows = rows.filter(r => r.ganzhi === gz);
    let hit = null;
    for (const r of gzRows) {
      const eraHit = (r.cnEraNames || []).some(e => e && e.includes(eraKeyword)) ||
                     (r.jpEraNames || []).some(j => j && j.includes(eraKeyword)) ||
                     (r.jpPeriods || []).some(p => p && p.includes(eraKeyword)) ||
                     (r.cnDynasties || []).some(d => d && d.includes(eraKeyword));
      if (eraHit) { hit = r; break; }
    }
    if (!hit) return null;
    // 取命中的年号全名与归属
    const { eraName, scope } = resolveEraScope(hit, eraKeyword);
    return { index: rows.indexOf(hit), year: hit.year, isJp: isJapanEraHit(hit, eraKeyword), eraName, scope };
  }

  // 年号+年份: "道光三年" / "道光 3" / "道光1843"
  const eraNames = [];
  for (const row of fullData) {
    (row.cnEraNames || []).forEach(e => { if (e && e !== '—' && e.length >= 2) eraNames.push(e); });
    (row.jpEraNames || []).forEach(e => { if (e && e !== '—' && e.length >= 2) eraNames.push(e); });
  }
  const uniqEras = [...new Set(eraNames)].sort((a, b) => b.length - a.length);
  for (const era of uniqEras) {
    if (!q.startsWith(era) || q.length <= era.length) continue;
    const rest = q.slice(era.length);
    // 中文数字年份: 道光三年 / 道光十一年 / 道光二十三年
    const cnNumMatch = rest.match(/^([〇零一二三四五六七八九十百]+)年?$/);
    if (cnNumMatch) {
      const n = chineseNumToInt(cnNumMatch[1]);
      if (n >= 1 && n <= 60) {
        // 目标年 = 年号起始年 + n - 1 (按公历推算; 若行命中则直接取行)
        // 先尝试: rows 中 cnEra/jpEra 含 era 的起始行
        const eraRows = rows.filter(r =>
          (r.cnEraNames || []).some(e => e === era) || (r.jpEraNames || []).some(e => e === era));
        if (eraRows.length > 0) {
          const startRow = eraRows[0];
          const targetYear = startRow.year + n - 1;
          const hit = eraRows.find(r => r.year === targetYear);
          if (hit) {
            const { eraName, scope } = resolveEraScope(hit, era);
            return { index: rows.indexOf(hit), year: hit.year, isJp: isJapanEraHit(hit, era), eraName, scope };
          }
          // 目标年不在结果集 (可能被筛选过滤) — 用起始年所在行
          const { eraName, scope } = resolveEraScope(startRow, era);
          return { index: rows.indexOf(startRow), year: startRow.year, isJp: isJapanEraHit(startRow, era), eraName, scope };
        }
      }
    }
    // 阿拉伯数字年份: 道光3 / 道光1843
    const numMatch = rest.match(/^(\d+)$/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n >= 1000 && n <= 3000) {
        const hit = rows.find(r => r.year === n &&
          ((r.cnEraNames || []).some(e => e === era) || (r.jpEraNames || []).some(e => e === era)));
        if (hit) {
          const { eraName, scope } = resolveEraScope(hit, era);
          return { index: rows.indexOf(hit), year: hit.year, isJp: isJapanEraHit(hit, era), eraName, scope };
        }
      }
    }
  }
  return null;
}

// 解析命中行的年号全名与归属 (用于收集整个年号的年份)
// 优先: 行内 cnEraNames/jpEraNames 精确包含 keyword 的年号; scope = 该行所在朝代/时代
export function resolveEraScope(row, keyword) {
  const cn = (row.cnEraNames || []).filter(e => e && e !== '—');
  const jp = (row.jpEraNames || []).filter(e => e && e !== '—');
  // 精确匹配优先, 其次包含
  let eraName = cn.find(e => e === keyword) || jp.find(e => e === keyword)
             || cn.find(e => e.includes(keyword)) || jp.find(e => e.includes(keyword));
  if (!eraName) eraName = keyword;
  let scope = '';
  const cnDyn = (row.cnDynasties || []).find(d => d && d !== '—');
  const jpPer = (row.jpPeriods || []).find(p => p && p !== '—');
  if (cn.some(e => e === eraName || e.includes(keyword))) scope = cnDyn || '';
  else if (jp.some(e => e === eraName || e.includes(keyword))) scope = jpPer || '';
  return { eraName, scope };
}

// V4.2: 在命中行后插入「整个年号」的全部年份 (命中年置顶, 其余年份随后列出)
// 注意: 不修改 FULL_DATA 行对象, 临近行以克隆形式插入, 精准/闪烁标记用模块级状态
export function insertNearbyRows(rows, hitMeta, fullData) {
  const hitRow = rows[hitMeta.index];
  // 记录命中行标记 (深色强调 + 日本闪烁)
  if (hitRow) {
    preciseHitMark.set(hitRow, { precise: true, jpFlash: !!hitMeta.isJp });
  }

  // 收集该年号在归属范围内的全部年份行 (如 道光 → 清 1821~1850 全部)
  // 命中年置顶, 其余按年份升序列出
  const nearby = [];
  const seen = new Set();
  if (hitMeta.eraName) {
    const era = hitMeta.eraName;
    const scope = hitMeta.scope || '';
    const eraRows = [];
    for (const r of fullData) {
      if (seen.has(r.year)) continue;
      const cnHit = (r.cnEraNames || []).some(e => e === era) &&
                    (!scope || (r.cnDynasties || []).some(d => d === scope));
      const jpHit = (r.jpEraNames || []).some(e => e === era) &&
                    (!scope || (r.jpPeriods || []).some(p => p === scope));
      if (cnHit || jpHit) { eraRows.push(r); seen.add(r.year); }
    }
    // 排序: 命中年置顶, 其余按年份升序
    eraRows.sort((a, b) => {
      if (a.year === hitMeta.year) return -1;
      if (b.year === hitMeta.year) return 1;
      return a.year - b.year;
    });
    eraRows.forEach(r => {
      if (r.year === hitMeta.year) return; // 命中行本身保留在原位
      nearby.push({ row: r, offset: r.year - hitMeta.year });
    });
  }

  if (nearby.length === 0) return rows;

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i === hitMeta.index) {
      out.push(rows[i]);
      // 隔行插入分组标签
      out.push({ __nearbySep: true });
      nearby.forEach(n => out.push(Object.assign({}, n.row, { __nearby: n.offset })));
    } else {
      out.push(rows[i]);
    }
  }
  return out;
}

// V4.2: 渲染时判断行是否临近行/分隔行
export function isNearbyRow(row) { return !!(row && row.__nearby); }
export function isNearbySep(row) { return !!(row && row.__nearbySep); }
export function nearbyOffset(row) { return row.__nearby || 0; }

// 从查询词中提取年号关键词 (最长匹配)
export function findEraNameInQuery(q, fullData) {
  if (!q) return null;
  const eraNames = new Set();
  for (const row of fullData) {
    (row.cnEraNames || []).forEach(e => { if (e && e !== '—') eraNames.add(e); });
    (row.jpEraNames || []).forEach(e => { if (e && e !== '—') eraNames.add(e); });
  }
  const list = [...eraNames].sort((a, b) => b.length - a.length);
  for (const era of list) {
    if (q.includes(era)) return era;
  }
  return null;
}

// V4.2: 重名年号提醒 — 纯数据计算（UI 渲染放 ui/era-alert.js）
// 返回 null 或 { eraName, reason, cnTagsHtml, jpTagsHtml }
//   cnTagsHtml/jpTagsHtml 已含 toDisplay 转换的朝代/时代名与年份区间
export function computeEraAlert(query, eraCnScope, eraJpScope) {
  if (!query || !query.trim()) return null;
  const q = toSimplified(query.trim()).toLowerCase();
  // 提取查询中的年号关键词 (从搜索词中找命中的年号)
  // 注意: 这里直接以 q 本身作为候选年号查询, 由调用方传入 findEraNameInQuery 结果
  return { q };
}

// 供 ui/era-alert.js 使用的完整计算: 输入年号名, 输出重名信息
export function buildEraAlertInfo(eraName, eraCnScope, eraJpScope) {
  if (!eraName) return null;
  const cnOcc = eraCnScope.get(eraName) || new Map();
  const jpOcc = eraJpScope.get(eraName) || new Map();

  const totalOcc = cnOcc.size + jpOcc.size;
  const hasCrossCn = cnOcc.size > 1;          // 中国内部跨朝代重名
  const hasCrossJp = jpOcc.size > 1;          // 日本内部跨时代重名
  const hasCnJp = cnOcc.size > 0 && jpOcc.size > 0; // 中日重名

  if (totalOcc <= 1) return null;

  const fmtRange = r => (r[0] < 0 ? '前' + Math.abs(r[0]) : r[0]) + '–' + (r[1] < 0 ? '前' + Math.abs(r[1]) : r[1]);
  const cnTags = [...cnOcc.entries()].map(([d, r]) =>
    `<span class="ea-tag">${toDisplay(d)} ${fmtRange(r)}</span>`).join('');
  const jpTags = [...jpOcc.entries()].map(([p, r]) =>
    `<span class="ea-tag ea-jp">${toDisplay(p)} ${fmtRange(r)}</span>`).join('');

  let reason = '';
  if (hasCnJp) reason = '「' + toDisplay(eraName) + '」同時是中國與日本年號，請注意區分所查對象！';
  else if (hasCrossCn) reason = '「' + toDisplay(eraName) + '」在中國歷史上被多個朝代使用，請確認朝代！';
  else if (hasCrossJp) reason = '「' + toDisplay(eraName) + '」在日本歷史上被多個時代使用，請確認時代！';
  else reason = '「' + toDisplay(eraName) + '」存在重名，請注意區分！';

  return { eraName, reason, cnTags, jpTags };
}
