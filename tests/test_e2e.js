// 端到端验证: 加载 index.html 的数据区 + 转换函数, 构建真实数据集并测试搜索
const fs = require('fs');
const vm = require('vm');

// 提取 index.html 内联脚本
const html = fs.readFileSync('index.html', 'utf-8');
const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/;
const m = re.exec(html);
let code = m[1];

// 截取: 从 'const GANZHI' 到 'return data;' 之后到 buildFullDataset 结束
// 但需要转换函数 (toSimplified) 和 yearNumToChinese, getGanzhi 等
// 策略: 执行完整脚本需要 DOM. 改用分段: 截取数据区相关代码
// 1. 转换映射 (conv_tables.js)
// 2. 数据区: const GANZHI ... return data 部分 (含 yearNumToChinese, getGanzhi, CN_DYNASTIES, JP_PERIODS, buildFullDataset, toSimplified)

// 提取所需代码段
function sliceBetween(code, startMarker, endMarker) {
  const s = code.indexOf(startMarker);
  if (s < 0) throw new Error('找不到 ' + startMarker);
  const e = code.indexOf(endMarker, s);
  if (e < 0) throw new Error('找不到 ' + endMarker);
  return code.slice(s, e + endMarker.length);
}

let extracted = '';
// 转换函数 (toSimplified 等) 依赖 S2T_MAP/T2S_MAP + convertText + toSimplified
const convFuncStart = code.indexOf('// 简繁转换 (映射表来自');
const convFuncEnd = code.indexOf('\n// 干支 & 生肖');
if (convFuncStart < 0 || convFuncEnd < 0) throw new Error('找不到转换函数区');
extracted += code.slice(convFuncStart, convFuncEnd);

// 数据区: const GANZHI 到 buildFullDataset 的 return data;
const dataStart = code.indexOf('const GANZHI');
// 兼容 CRLF/LF 行尾: 找 return data; 后的函数闭合 }
const dataRet = code.indexOf('return data;');
let dataEnd = -1;
if (dataRet >= 0) {
  const tail = code.slice(dataRet);
  const mEnd = /return data;\r?\n\}/.exec(tail);
  if (mEnd) dataEnd = dataRet + mEnd[0].length - 1;
}
if (dataStart < 0 || dataEnd < 0) throw new Error('找不到数据区');
extracted += '\n' + code.slice(dataStart, dataEnd + 1);

// 运行
const sandbox = {};
vm.createContext(sandbox);
// 补充 escapeHtml (测试环境无 DOM)
const helper = `
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
`;
const script = fs.readFileSync('conv_tables.js', 'utf-8') + '\n' + helper + '\n' + extracted + '\n__out = { FULL_DATA: buildFullDataset(), S2T: S2T_MAP, T2S: T2S_MAP };';
vm.runInContext(script, sandbox);
const { FULL_DATA, S2T, T2S } = sandbox.__out;
console.log('FULL_DATA 行数:', FULL_DATA.length);
console.log('示例行:', JSON.stringify(FULL_DATA.find(r => r.year === 1583), null, 1).slice(0, 600));

// 复刻搜索逻辑
function convertText(text, mapObj) {
  if (!text || !mapObj) return text;
  const keys = Object.keys(mapObj).sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh'));
  let result = '', i = 0;
  while (i < text.length) {
    let matched = false;
    for (const k of keys) {
      if (text.startsWith(k, i)) { result += mapObj[k]; i += k.length; matched = true; break; }
    }
    if (!matched) { result += text[i]; i++; }
  }
  return result;
}
const toSimplified = (t) => convertText(t, T2S);

function extractGanzhi(query) {
  const q = toSimplified(query.trim());
  const re = /([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])/g;
  let match;
  while ((match = re.exec(q)) !== null) {
    const gz = match[1] + match[2];
    const tgIdx = '甲乙丙丁戊己庚辛壬癸'.indexOf(match[1]);
    const dzIdx = '子丑寅卯辰巳午未申酉戌亥'.indexOf(match[2]);
    if (tgIdx >= 0 && dzIdx >= 0 && ((tgIdx % 2) === (dzIdx % 2))) return { ganzhi: gz };
  }
  return null;
}

function applyFilters(rows, searchQuery) {
  const q = toSimplified(searchQuery.trim()).toLowerCase();
  return rows.filter(row => {
    const gzMatch = extractGanzhi(q);
    if (gzMatch) {
      const gz = gzMatch.ganzhi;
      const ganzhiHit = row.ganzhi === gz;
      const before = q.slice(0, q.indexOf(gz[0]));
      const after = q.slice(q.indexOf(gz[1]) + 1);
      const eraKeyword = (before + after).trim();
      if (eraKeyword) {
        const eraHit = row.cnEraNames.some(e => e.includes(eraKeyword)) ||
                       row.jpPeriods.some(p => p.includes(eraKeyword)) ||
                       row.cnDynasties.some(d => d.includes(eraKeyword));
        if (ganzhiHit && eraHit) return true;
      } else {
        if (ganzhiHit) return true;
      }
    }
    if (row.searchKey && row.searchKey.includes(q)) return true;
    if (row.year < 0) {
      const bcStr = '前' + Math.abs(row.year);
      if (bcStr.includes(q) || String(row.year).includes(q)) return true;
    }
    return false;
  });
}

console.log('\n===== 真实数据搜索测试 =====');
const tests = [
  ['万历', '应为万历年间所有年份 (1573-1620 至少几十条)'],
  ['萬曆', '繁体万历, 应等同"万历"'],
  ['万历癸未', '应只命中 1583'],
  ['萬曆癸未', '繁体组合, 应只命中 1583'],
  ['癸未', '应命中所有癸未年 (每60年一条, 数据范围约47条)'],
  ['万历十一年', '应命中 1583'],
  ['貞觀', '繁体贞观, 应命中贞观年间'],
  ['贞观', '简体贞观'],
  ['乙丑', '应命中所有乙丑年'],
  ['後醍醐', '繁体后醍醐天皇'],
];

for (const [q, desc] of tests) {
  const result = applyFilters(FULL_DATA, q);
  const years = result.slice(0, 8).map(r => r.year);
  console.log(`\n"${q}" (${desc})`);
  console.log(`  命中 ${result.length} 条, 前8个年份: ${years.join(', ')}`);
}

// 特殊验证: 万历癸未
console.log('\n===== 万历癸未详细验证 =====');
const wz = applyFilters(FULL_DATA, '万历癸未');
wz.forEach(r => {
  const cnEraNames = r.cnEraNames.join(',');
  console.log(`  公元${r.year} (${r.ganzhi}) 年号: ${cnEraNames} ${r.cnEra.replace(/<[^>]*>/g,'')}`);
});
