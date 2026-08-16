// ================================================
// core/dataset.js — 数据构建与索引（纯逻辑，零 DOM）
// 从 index.html IIFE 提取（v4.3 逐字迁移）
// 由 CN_DYNASTIES/JP_PERIODS 构建 FULL_DATA（2868 行）
// ================================================
import { CN_DYNASTIES, JP_PERIODS } from '../data/dynasties.mjs';
import { getGanzhi, getZodiac, yearNumToChinese } from './ganzhi.js';
import { toSimplified } from './conv.js';

export { CN_DYNASTIES, JP_PERIODS };

// 数据版本（与 APP 版本一起校验；静态参考数据不参与同步）
export const DATA_VERSION = 'v4.3';

// 构建年份对照数据
export function buildFullDataset() {
  const data = [];

  // Determine year ranges
  // China data: -841 to 1912
  // Japan data: 645 to 2026
  // Combined: -841 to 2026
  const startYear = -841;
  const endYear = 2026;

  // Pre-process Chinese era data for quick lookup
  const cnEraMap = new Map(); // year -> [{dynasty, eraName, eraFull, ruler, notes}]

  for (const dynasty of CN_DYNASTIES) {
    for (const era of dynasty.eras) {
      const yrStart = era.r[0];
      const yrEnd = era.r[1] || yrStart;

      // Handle sub-eras first
      if (era.subEras) {
        for (const sub of era.subEras) {
          const sStart = sub.r[0];
          const sEnd = sub.r[1] || sStart;
          for (let y = sStart; y <= sEnd; y++) {
            if (!cnEraMap.has(y)) cnEraMap.set(y, []);
            cnEraMap.get(y).push({
              dynasty: dynasty.name,
              eraName: sub.name,
              eraFull: sub.name + yearNumToChinese(y - sStart + 1),
              ruler: era.ruler,
              notes: era.notes || dynasty.name
            });
          }
        }
      } else {
        for (let y = yrStart; y <= yrEnd; y++) {
          if (!cnEraMap.has(y)) cnEraMap.set(y, []);
          cnEraMap.get(y).push({
            dynasty: dynasty.name,
            eraName: era.name,
            eraFull: era.name + yearNumToChinese(y - yrStart + 1),
            ruler: era.ruler,
            notes: era.notes || dynasty.name
          });
        }
      }
    }
  }

  // Pre-process Japanese era data
  const jpEraMap = new Map(); // year -> [{period, eraName, eraFull, ruler, notes}]

  for (const period of JP_PERIODS) {
    for (const era of period.eras) {
      const yrStart = era.r[0];
      const yrEnd = era.r[1] || yrStart;

      if (era.subEras) {
        for (const sub of era.subEras) {
          const sStart = sub.r[0];
          const sEnd = sub.r[1] || sStart;
          for (let y = sStart; y <= sEnd; y++) {
            if (!jpEraMap.has(y)) jpEraMap.set(y, []);
            jpEraMap.get(y).push({
              period: period.name,
              eraName: sub.name,
              eraFull: sub.name + yearNumToChinese(y - sStart + 1),
              ruler: era.ruler,
              notes: era.notes || ''
            });
          }
        }
      } else {
        for (let y = yrStart; y <= yrEnd; y++) {
          if (!jpEraMap.has(y)) jpEraMap.set(y, []);
          jpEraMap.get(y).push({
            period: period.name,
            eraName: era.name,
            eraFull: era.name + yearNumToChinese(y - yrStart + 1),
            ruler: era.ruler,
            notes: era.notes || ''
          });
        }
      }
    }
  }

  // Build year by year — every year is ONE row, eras merged in cells
  for (let year = startYear; year <= endYear; year++) {
    const yearStr = year < 0 ? '前' + Math.abs(year) : String(year);
    const ganzhi = getGanzhi(year);
    const zodiac = getZodiac(year);

    const cnEntries = cnEraMap.get(year) || [];
    const jpEntries = jpEraMap.get(year) || [];
    const hasJapanData = year >= 645;

    // Sort Chinese entries by dynasty group then era name
    cnEntries.sort((a, b) => {
      const order = ['先秦','秦汉','魏晋南北朝','隋唐五代','宋辽金夏','元明清'];
      const aGrp = CN_DYNASTIES.find(d => d.name === a.dynasty);
      const bGrp = CN_DYNASTIES.find(d => d.name === b.dynasty);
      const aIdx = aGrp ? order.indexOf(aGrp.group) : 99;
      const bIdx = bGrp ? order.indexOf(bGrp.group) : 99;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return a.eraName.localeCompare(b.eraName, 'zh');
    });

    // Merge Chinese entries into single cell: era name only (dynasty in separate col)
    const cnDynastyArr = [...new Set(cnEntries.map(e => e.dynasty))];
    const cnEraBaseNames = [...new Set(cnEntries.map(e => e.eraName))]; // raw era names for filtering
    const cnEraLines = cnEntries.length > 0
      ? cnEntries.map(e => {
          const yrDisplay = year < 0 ? '前' + Math.abs(year) : year;
          const copyText = e.eraFull + '（' + yrDisplay + '）';
          return `<span class="era-entry"><span class="era-text">${e.eraFull}</span><button class="era-copy-btn" data-copy="${escapeHtml(copyText)}" title="复制 ${copyText}" aria-label="复制年号"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></span>`;
        }).join('<br>')
      : '—';
    const cnRulerArr = [...new Set(cnEntries.map(e => e.ruler))];
    const cnNotesArr = [...new Set(cnEntries.map(e => e.notes).filter(Boolean))];

    // Merge Japanese entries
    const jpPeriodArr = [...new Set(jpEntries.map(e => e.period))];
    const jpEraLines = jpEntries.length > 0
      ? jpEntries.map(e => {
          const yrDisplay = year < 0 ? '前' + Math.abs(year) : year;
          const copyText = e.eraFull + '（' + yrDisplay + '）';
          return `<span class="era-entry"><span class="era-text">${e.period}·${e.eraFull}</span><button class="era-copy-btn" data-copy="${escapeHtml(copyText)}" title="复制 ${copyText}" aria-label="复制日本年号"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button></span>`;
        }).join('<br>')
      : (hasJapanData ? '—' : '—');
    const jpRulerArr = [...new Set(jpEntries.map(e => e.ruler))];
    const jpNotesArr = [...new Set(jpEntries.map(e => e.notes).filter(Boolean))];

    const allNotes = [...cnNotesArr, ...jpNotesArr];

    // 模糊补全候选 (简体): 年号全名 (如"同治十一年") 与 年号+干支 (如"同治戊戌")
    // 用于搜索建议: 输入"同治一"提示"同治十一年/二十一年", 输入"同治戊"提示"同治戊戌/戊寅"
    const eraFullCandidates = [...new Set(cnEntries.map(e => e.eraFull).concat(jpEntries.map(e => e.eraFull)))]
      .filter(s => s && s.length >= 2);
    const eraGzCandidates = [...new Set(
      cnEntries.map(e => e.eraName + getGanzhi(year)).concat(jpEntries.map(e => e.eraName + getGanzhi(year)))
    )].filter(s => s && s.length >= 3);

    // 简体归一化搜索串: 用于繁简无差别检索 (一次构建, 长期复用)
    // 包含 eraFull (如"万历十一年") 以便"万历十一年"这类写法也能命中
    const cnEraFullNames = [...new Set(cnEntries.map(e => e.eraFull))];
    const jpEraFullNames = [...new Set(jpEntries.map(e => e.eraFull))];
    const searchKeyParts = [
      yearStr, ganzhi, zodiac,
      cnDynastyArr.join('、'), cnEraBaseNames.join('、'), cnEraFullNames.join('、'), cnRulerArr.join('、'),
      jpPeriodArr.join('、'),
      jpEntries.map(e => e.eraName).join('、'), jpEraFullNames.join('、'), jpRulerArr.join('、'),
      allNotes.join('；')
    ].filter(Boolean);
    // 统一转为简体, 保证"萬曆"也能匹配"万历"
    const searchKey = toSimplified(searchKeyParts.join(' '));

    data.push({
      year,
      yearStr,
      ganzhi,
      zodiac,
      // 简体归一化检索串 (全字段, 用于繁简无差别匹配)
      searchKey,
      // 模糊补全候选 (简体): "年号全名" 与 "年号+干支" 列表
      eraFullCandidates,
      eraGzCandidates,
      // for filtering (arrays)
      cnDynasties: cnDynastyArr.length > 0 ? cnDynastyArr : ['—'],
      cnEraNames: cnEraBaseNames.length > 0 ? cnEraBaseNames : ['—'],
      jpEraNames: [...new Set(jpEntries.map(e => e.eraName))].filter(Boolean).length > 0
        ? [...new Set(jpEntries.map(e => e.eraName))].filter(Boolean) : ['—'],
      jpPeriods: jpPeriodArr.length > 0 ? jpPeriodArr : (hasJapanData ? ['—'] : ['—']),
      // for display (strings with HTML)
      cnDynasty: cnDynastyArr.length > 0 ? cnDynastyArr.join('、') : '—',
      cnEra: cnEraLines,
      cnRuler: cnRulerArr.length > 0 ? cnRulerArr.join('、') : '—',
      jpPeriod: jpPeriodArr.length > 0 ? jpPeriodArr.join('、') : (hasJapanData ? '—' : '—'),
      jpEra: jpEraLines,
      jpRuler: jpRulerArr.length > 0 ? jpRulerArr.join('、') : (hasJapanData ? '—' : '—'),
      notes: allNotes.join('；')
    });
  }

  return data;
}

// 构建并返回初始化好的数据集（一次构建，缓存复用）
let _fullData = null;
export function getFullData() {
  if (!_fullData) _fullData = buildFullDataset();
  return _fullData;
}

// V4.2: 中日年号全集 (用于判断某年号是否专属日本/重名)
export function buildEraSets(fullData) {
  const allCn = new Set();
  const allJp = new Set();
  for (const row of fullData) {
    (row.cnEraNames || []).forEach(e => { if (e && e !== '—') allCn.add(e); });
    (row.jpEraNames || []).forEach(e => { if (e && e !== '—') allJp.add(e); });
  }
  return { ALL_CN_ERAS: allCn, ALL_JP_ERAS: allJp };
}

// V4.3: 年号 → 朝代/时代 归属映射 (直接从 CN_DYNASTIES/JP_PERIODS 生成, 不经行合并)
// 用于重名提醒: 崇祯只属「明」, 不会因 1644 年明亡清立而被归给「清」
export function buildEraScopeMaps() {
  const cnScope = new Map(); // 年号名 -> Map(朝代 -> [minYear, maxYear])
  const jpScope = new Map(); // 年号名 -> Map(时代 -> [minYear, maxYear])
  for (const d of CN_DYNASTIES) {
    for (const e of (d.eras || [])) {
      const pushEra = (name, r) => {
        if (!name || name === '—' || name === '-') return;
        if (!cnScope.has(name)) cnScope.set(name, new Map());
        const m = cnScope.get(name);
        if (!m.has(d.name)) m.set(d.name, [r[0], r[1]]);
        else { const v = m.get(d.name); v[0] = Math.min(v[0], r[0]); v[1] = Math.max(v[1], r[1]); }
      };
      if (e.subEras) e.subEras.forEach(s => pushEra(s.name, s.r));
      else pushEra(e.name, e.r);
    }
  }
  for (const p of JP_PERIODS) {
    for (const e of (p.eras || [])) {
      const pushEra = (name, r) => {
        if (!name || name === '—' || name === '-') return;
        if (!jpScope.has(name)) jpScope.set(name, new Map());
        const m = jpScope.get(name);
        if (!m.has(p.name)) m.set(p.name, [r[0], r[1]]);
        else { const v = m.get(p.name); v[0] = Math.min(v[0], r[0]); v[1] = Math.max(v[1], r[1]); }
      };
      if (e.subEras) e.subEras.forEach(s => pushEra(s.name, s.r));
      else pushEra(e.name, e.r);
    }
  }
  return { ERA_CN_SCOPE: cnScope, ERA_JP_SCOPE: jpScope };
}

// 转义 HTML（数据构建时用于 data-copy 属性）
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
