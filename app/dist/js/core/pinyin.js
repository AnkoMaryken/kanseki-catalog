// ================================================
// core/pinyin.js — 拼音检索（纯逻辑，零 DOM）
// 从 index.html IIFE 提取（v4.3 逐字迁移）
// 依赖: PINYIN_TERMS（pinyin-terms.mjs，构建生成）
// ================================================
import { PINYIN_TERMS } from '../data/pinyin-terms.mjs';

export { PINYIN_TERMS };

// 生成某词条的全部读音组合 (每字取一个候选读音)
export function pyCombos(pyCells) {
  let combos = [[]];
  for (const cells of pyCells) {
    const next = [];
    for (const combo of combos) {
      for (const p of cells) next.push(combo.concat([p]));
    }
    combos = next;
  }
  return combos;
}

// 干支拼音表: 60 组干支 -> 全拼 (含首字母)
export const GANZHI_PY = {
  '甲子':'jiazi','乙丑':'yichou','丙寅':'bingyin','丁卯':'dingmao','戊辰':'wuchen','己巳':'jisi',
  '庚午':'gengwu','辛未':'xinwei','壬申':'renshen','癸酉':'guiyou','甲戌':'jiaxu','乙亥':'yihai',
  '丙子':'bingzi','丁丑':'dingchou','戊寅':'wuyin','己卯':'jimao','庚辰':'gengchen','辛巳':'xinsi',
  '壬午':'renwu','癸未':'guiwei','甲申':'jiashen','乙酉':'yiyou','丙戌':'bingxu','丁亥':'dinghai',
  '戊子':'wuzi','己丑':'jichou','庚寅':'gengyin','辛卯':'xinmao','壬辰':'renchen','癸巳':'guisi',
  '甲午':'jiawu','乙未':'yiwei','丙申':'bingshen','丁酉':'dingyou','戊戌':'wuxu','己亥':'jihai',
  '庚子':'gengzi','辛丑':'xinchou','壬寅':'renyin','癸卯':'guimao','甲辰':'jiachen','乙巳':'yisi',
  '丙午':'bingwu','丁未':'dingwei','戊申':'wushen','己酉':'jiyou','庚戌':'gengxu','辛亥':'xinhai',
  '壬子':'renzi','癸丑':'guichou','甲寅':'jiayin','乙卯':'yimao','丙辰':'bingchen','丁巳':'dingsi',
  '戊午':'wuwu','己未':'jiwei','庚申':'gengshen','辛酉':'xinyou','壬戌':'renxu','癸亥':'guihai'
};
// 汉字数字拼音 (年份如"万历十一年"中数字检索用; 这里主要用于年份的汉字写法)
export const CN_NUM_PY = { '0':'ling','〇':'ling','零':'ling','1':'yi','一':'yi','2':'er','二':'er','3':'san','三':'san',
  '4':'si','四':'si','5':'wu','五':'wu','6':'liu','六':'liu','7':'qi','七':'qi','8':'ba','八':'ba',
  '9':'jiu','九':'jiu','十':'shi','百':'bai','千':'qian' };

// ================================================
// 拼音索引构建状态（模块级，构建后供查询）
// ================================================
let ERA_CANDIDATES = [];   // 全部候选(年号+帝王名), 已排序
let PY_HINT_MAP = null;    // 拼音前缀/缩写键(小写) -> [candidate, ...]
let WORD_PY_PREFIX = null; // 词 -> 拼音前缀集合 (供行过滤用)
let YEAR_PY_MAP = null;    // 拼音前缀/缩写 -> [年份候选 {year, yearStr}]
let GZ_PY_MAP = null;      // 干支拼音 -> 干支 (全拼精确 + 缩写)

export function getEraCandidates() { return ERA_CANDIDATES; }
export function getPyHintMap() { return PY_HINT_MAP; }
export function getWordPyPrefix() { return WORD_PY_PREFIX; }
export function getYearPyMap() { return YEAR_PY_MAP; }
export function getGzPyMap() { return GZ_PY_MAP; }

// 构建全部拼音索引（需在 FULL_DATA 就绪后调用一次）
export function buildPinyinIndex(fullData) {
  buildEraCandidates(fullData);
  buildExtraPinyinIndex(fullData);
}

// 构建年号/帝王名候选 + 拼音前缀索引
function buildEraCandidates(fullData) {
  const cand = [];
  const seen = new Map(); // key: prefix + '|' + era -> 最早年份
  const eraSet = new Set(); // 全部年号名 (供帝王名去重)
  const addCand = (era, prefix, type, year, yearStr) => {
    if (!era || era === '—') return;
    const key = prefix + '|' + era;
    if (seen.has(key)) {
      // 同 prefix+era 只保留最早年份
      if (year < seen.get(key).year) seen.get(key).year = year;
      return;
    }
    const obj = { era, prefix, type, year, yearStr };
    seen.set(key, obj);
    cand.push(obj);
  };
  for (const row of fullData) {
    // 中国年号 + 朝代
    const dyns = (row.cnDynasties || []).filter(d => d && d !== '—');
    (row.cnEraNames || []).forEach((e, i) => {
      if (!e || e === '—') return;
      addCand(e, dyns[Math.min(i, dyns.length - 1)] || '', 'cn', row.year, row.yearStr);
      eraSet.add(e);
    });
    // 日本年号 + 时代
    const pers = (row.jpPeriods || []).filter(p => p && p !== '—');
    (row.jpEraNames || []).forEach((e, i) => {
      if (!e || e === '—') return;
      addCand(e, pers[Math.min(i, pers.length - 1)] || '', 'jp', row.year, row.yearStr);
      eraSet.add(e);
    });
  }
  // 中国帝王名 (去括号取主名; 与年号重名则跳过 — 年号候选已覆盖)
  for (const row of fullData) {
    const dyn = (row.cnDynasties || []).find(d => d && d !== '—') || '';
    (row.cnRuler || '').split(/[、,，]/).forEach(r => {
      let nm = (r || '').split('(')[0].trim();
      if (!nm || nm === '—') return;
      // 跳过与年号重名的"朝代字+名"形式 (周景王 -> 景王 已在年号)
      if (nm.length >= 2 && '周汉唐宋元明清'.includes(nm[0]) && eraSet.has(nm.slice(1))) return;
      if (eraSet.has(nm)) return; // 与年号完全重名
      addCand(nm, '', 'cnRuler', row.year, row.yearStr);
    });
  }
  // 日本天皇名 (去"天皇"后缀, 前缀留空; 与年号重名则跳过 — 年号候选已覆盖)
  for (const row of fullData) {
    const per = (row.jpPeriods || []).find(p => p && p !== '—') || '';
    (row.jpRuler || '').split(/[、,，]/).forEach(r => {
      let nm = (r || '').split('(')[0].trim().replace(/天皇/g, '');
      if (!nm || nm === '—') return;
      if (eraSet.has(nm)) return; // 明治天皇 -> 明治 与年号重名
      addCand(nm, '', 'jpRuler', row.year, row.yearStr);
    });
  }
  // 排序: 按年份升序 (历史顺序), 同年按名称
  cand.sort((a, b) => a.year - b.year || a.era.localeCompare(b.era, 'zh'));
  ERA_CANDIDATES = cand;
  // 拼音索引: 每个候选生成 全拼/缩写 的前缀键
  PY_HINT_MAP = new Map();
  for (const c of cand) {
    const term = PINYIN_TERMS.find(t => t.w === c.era);
    if (!term) continue;
    const combos = pyCombos(term.py);
    const keys = new Set();
    const fulls = new Set();
    const inis = new Set();
    const sylPrefixes = new Set();
    for (const combo of combos) {
      const full = combo.join('').toLowerCase();
      const ini = combo.map(p => p[0]).join('').toLowerCase();
      fulls.add(full);
      inis.add(ini);
      // 全拼逐字符前缀
      for (let l = 1; l <= full.length; l++) keys.add(full.slice(0, l));
      // 缩写逐字符前缀
      for (let l = 1; l <= ini.length; l++) keys.add(ini.slice(0, l));
      // 音节前缀: 查询词长度>=4 时启用 (如 "jingt" 前缀匹配 "jingtai")
      if (full.length >= 4) {
        let acc = '';
        for (const syl of combo) {
          acc += syl;
          sylPrefixes.add(acc);
        }
      }
    }
    c.pyFulls = fulls;
    c.pyInis = inis;
    c.pySylPrefixes = sylPrefixes;
    for (const k of keys) {
      if (!PY_HINT_MAP.has(k)) PY_HINT_MAP.set(k, []);
      const arr = PY_HINT_MAP.get(k);
      if (!arr.includes(c)) arr.push(c);
    }
  }
  // 词级拼音前缀集合: 行过滤时直接查 (词 -> 前缀集合)
  WORD_PY_PREFIX = new Map();
  for (const t of PINYIN_TERMS) {
    const combos = pyCombos(t.py);
    const set = new Set();
    for (const combo of combos) {
      const full = combo.join('').toLowerCase();
      const ini = combo.map(p => p[0]).join('').toLowerCase();
      for (let l = 1; l <= full.length; l++) set.add(full.slice(0, l));
      for (let l = 1; l <= ini.length; l++) set.add(ini.slice(0, l));
    }
    WORD_PY_PREFIX.set(t.w, set);
  }
}

// 年份/干支拼音候选索引 (v2.1):
function buildExtraPinyinIndex(fullData) {
  // --- 年份: 把年份字符串 (如 "2026") 映射到汉字数字读法拼音 ---
  // 例: 2026 -> 二零二六 -> er ling er liu; 前缀 er/erl/erli...; 缩写 elerl
  YEAR_PY_MAP = new Map();
  GZ_PY_MAP = new Map();
  const addKey = (map, key, obj) => {
    if (!key) return;
    key = key.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    const arr = map.get(key);
    if (!arr.some(x => x.year === obj.year && x.value === obj.value)) arr.push(obj);
  };
  // 年份数字拼音 (支持正负年份, 前N年 -> 前+n)
  for (const row of fullData) {
    const y = row.year;
    const digits = String(Math.abs(y)).split('').map(d => CN_NUM_PY[d] || d);
    const full = (y < 0 ? 'qian' : '') + digits.join('');
    const ini = (y < 0 ? 'q' : '') + digits.map(p => p[0]).join('');
    const base = { year: y, yearStr: row.yearStr, value: '公元' + row.yearStr + '年', full, ini };
    // 前缀键
    for (let l = 1; l <= full.length; l++) addKey(YEAR_PY_MAP, full.slice(0, l), base);
    for (let l = 1; l <= ini.length; l++) addKey(YEAR_PY_MAP, ini.slice(0, l), base);
  }
  // 干支拼音: 全拼精确 + 前缀 + 缩写
  const jzMap = { '甲':'j','乙':'y','丙':'b','丁':'d','戊':'w','己':'j','庚':'g','辛':'x','壬':'r','癸':'g',
                  '子':'z','丑':'c','寅':'y','卯':'m','辰':'c','巳':'s','午':'w','未':'w','申':'s','酉':'y','戌':'x','亥':'h' };
  for (const [gz, py] of Object.entries(GANZHI_PY)) {
    const ini2 = gz.split('').map(ch => jzMap[ch] || ch).join(''); // 逐字首字母缩写 (甲子 -> jz)
    const base = { gz, value: gz + '年', py, ini: ini2 };
    addKey(GZ_PY_MAP, py, base);            // 完整全拼
    addKey(GZ_PY_MAP, ini2, base);          // 缩写
    for (let l = 1; l < py.length; l++) addKey(GZ_PY_MAP, py.slice(0, l), base); // 前缀
  }
}

// 拼音匹配: 查询词为纯拼音/首字母缩写时返回候选列表 (按匹配质量排序)
// 匹配规则 (统一评分, 跨年号/年份/干支三类):
//   完整全拼 == q (4分) > 完整缩写 == q (3分) > 全拼音节前缀 (2分) > 缩写前缀 (1分)
// 干支命中需展开为该干支的全部年份; 年份按单行候选
export function matchPinyinCandidates(q, maxResults, fullData) {
  const scored = []; // {score, cand, sortYear}
  const seen = new Set();
  const pushScored = (score, c, sortYear) => {
    const k = (c.prefix || '') + '|' + (c.era || c.value || '') + '|' + c.year;
    if (seen.has(k)) return;
    seen.add(k);
    scored.push({ score, c, sortYear });
  };

  // 1) 干支拼音: 全拼精确=4, 缩写精确=3, 前缀=1; 命中后展开全部该干支年份
  const gzHits = (GZ_PY_MAP && GZ_PY_MAP.get(q)) || [];
  for (const g of gzHits) {
    let score;
    if (g.py === q) score = 4;
    else if (g.ini === q) score = 3;
    else score = 1;
    const gzRows = fullData.filter(r => r.ganzhi === g.gz);
    gzRows.forEach(r => pushScored(score, { era: g.value, prefix: '', type: 'gz', year: r.year, yearStr: r.yearStr }, r.year));
  }
  // 2) 年份拼音: 全拼精确=4, 缩写精确=3, 前缀=1
  const yearHits = (YEAR_PY_MAP && YEAR_PY_MAP.get(q)) || [];
  for (const y of yearHits) {
    let score;
    if (y.full === q) score = 4;
    else if (y.ini === q) score = 3;
    else score = 1;
    pushScored(score, { era: y.value, prefix: '', type: 'year', year: y.year, yearStr: y.yearStr }, y.year);
  }
  // 3) 年号/帝王名拼音 (v2.0 评分逻辑)
  const hits = PY_HINT_MAP.get(q) || [];
  for (const c of hits) {
    let score = 0;
    if (c.pyFulls && c.pyFulls.has(q)) score = 4;
    else if (c.pyInis && c.pyInis.has(q)) score = 3;
    else if (c.pySylPrefixes && c.pySylPrefixes.has(q)) score = 2;
    else score = 1;
    pushScored(score, c, c.year);
  }
  // 统一排序: 评分降序 (精确优先), 同级按年份升序 (历史顺序)
  scored.sort((a, b) => b.score - a.score || a.sortYear - b.sortYear);
  return scored.slice(0, maxResults).map(x => x.c);
}

// 拼音匹配判定 (用于行过滤): 行内年号/帝王名/干支/年份的拼音前缀含 q 即命中
export function rowPinyinHit(row, q) {
  if (!/^[a-z]+$/.test(q) || q.length < 1) return false;
  // v2.1: 干支拼音 (如 wuchen -> 戊辰年)
  if (GZ_PY_MAP && GZ_PY_MAP.has(q) && row.ganzhi) {
    const gzHits = GZ_PY_MAP.get(q);
    if (gzHits.some(g => g.gz === row.ganzhi)) return true;
  }
  // v2.1: 年份拼音 (如 erlingerliu -> 2026年)
  if (YEAR_PY_MAP && YEAR_PY_MAP.has(q)) {
    const yrHits = YEAR_PY_MAP.get(q);
    if (yrHits.some(y => y.year === row.year)) return true;
  }
  if (!WORD_PY_PREFIX) return false;
  const names = [];
  (row.cnEraNames || []).forEach(n => { if (n && n !== '—') names.push(n); });
  (row.jpEraNames || []).forEach(n => { if (n && n !== '—') names.push(n); });
  (row.cnRuler || '').split(/[、,，]/).forEach(r => {
    const nm = (r || '').split('(')[0].trim();
    if (nm && nm !== '—') names.push(nm);
  });
  (row.jpRuler || '').split(/[、,，]/).forEach(r => {
    let nm = (r || '').split('(')[0].trim().replace(/天皇/g, '');
    if (nm && nm !== '—') names.push(nm);
  });
  for (const n of names) {
    const pre = WORD_PY_PREFIX.get(n);
    if (pre && pre.has(q)) return true;
  }
  return false;
}
