// 模拟 index.html 中 extractGanzhi 与搜索匹配逻辑, 验证干支查询需求
const vm = require('vm');
const fs = require('fs');

// 加载转换映射
const sandbox = { __out: null };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync('conv_tables.js', 'utf-8') + '\n__out = { S2T: S2T_MAP, T2S: T2S_MAP };',
  sandbox
);
const { S2T, T2S } = sandbox.__out;

// 复刻 index.html 的 convertText
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

// 复刻 extractGanzhi
function extractGanzhi(query) {
  const q = toSimplified(query.trim());
  const re = /([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])/g;
  let match;
  while ((match = re.exec(q)) !== null) {
    const gz = match[1] + match[2];
    const tgIdx = '甲乙丙丁戊己庚辛壬癸'.indexOf(match[1]);
    const dzIdx = '子丑寅卯辰巳午未申酉戌亥'.indexOf(match[2]);
    if (tgIdx >= 0 && dzIdx >= 0 && ((tgIdx % 2) === (dzIdx % 2))) {
      return { ganzhi: gz };
    }
  }
  return null;
}

// 测试用例
const cases = [
  ['癸未', '癸未'],            // 纯干支
  ['万历癸未', '癸未'],        // 年号+干支 (简体)
  ['萬曆癸未', '癸未'],        // 年号+干支 (繁体)
  ['万历十一年', null],        // 无干支
  ['甲子', '甲子'],            // 甲子
  ['癸巳', '癸巳'],
  ['戊戌', '戊戌'],
  ['后元', null],              // 无干支 (后/元 非干支)
  ['乙丑', '乙丑'],
  ['丙子', '丙子'],
  ['慶長', null],              // 日本年号 无干支
  ['万历癸卯', '癸卯'],
];

let pass = 0, fail = 0;
for (const [input, exp] of cases) {
  const got = extractGanzhi(input);
  const gotStr = got ? got.ganzhi : null;
  const ok = gotStr === exp;
  if (ok) pass++; else { fail++; console.log(`  [FAIL] ${input} -> ${gotStr} 期望 ${exp}`); }
}
console.log(`干支解析测试 通过 ${pass} 失败 ${fail}`);

// 验证万历癸未 = 万历十一年 (1583) 的对应关系
// 万历十一年: 1583年. 1583年的干支: (1583-4) % 60 = 1579 % 60 = 19 -> 癸未? 查表
const GANZHI = ['甲子','乙丑','丙寅','丁卯','戊辰','己巳','庚午','辛未','壬申','癸酉',
  '甲戌','乙亥','丙子','丁丑','戊寅','己卯','庚辰','辛巳','壬午','癸未',
  '甲申','乙酉','丙戌','丁亥','戊子','己丑','庚寅','辛卯','壬辰','癸巳',
  '甲午','乙未','丙申','丁酉','戊戌','己亥','庚子','辛丑','壬寅','癸卯',
  '甲辰','乙巳','丙午','丁未','戊申','己酉','庚戌','辛亥','壬子','癸丑',
  '甲寅','乙卯','丙辰','丁巳','戊午','己未','庚申','辛酉','壬戌','癸亥'];
function getGanzhi(year) { return GANZHI[((year - 4) % 60 + 60) % 60]; }

console.log('\n--- 万历年间癸未年验证 ---');
// 万历元年 = 1573, 万历十一年 = 1583
for (let y = 1573; y <= 1620; y++) {
  const gz = getGanzhi(y);
  if (gz === '癸未') {
    const eraYear = y - 1573 + 1;
    console.log(`  公元${y}年 = 万历${eraYear}年, 干支 ${gz}`);
  }
}

// 搜索匹配逻辑测试: 模拟 applyFilters 中的干支分支
console.log('\n--- 搜索匹配模拟 ---');
// 模拟数据行 (用万历癸未)
const mockRows = [
  { year: 1583, yearStr: '1583', ganzhi: '癸未', cnEraNames: ['万历'], jpPeriods: ['安土桃山'], cnDynasties: ['明'], searchKey: '1583 癸未 羊 明 万历 万历十一年 明神宗(朱翊钧) 安土桃山 天正 天正十一年 正亲町天皇/后阳成天皇' },
  { year: 1582, yearStr: '1582', ganzhi: '壬午', cnEraNames: ['万历'], jpPeriods: ['安土桃山'], cnDynasties: ['明'], searchKey: '1582 壬午 马 明 万历 万历十年 明神宗(朱翊钧) 安土桃山 天正 天正十年 正亲町天皇/后阳成天皇' },
];

function mockApplyFilters(rows, searchQuery) {
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
    return false;
  });
}

const searchTests = [
  ['万历', [1583, 1582]],       // 年号查询: 命中两年
  ['万历癸未', [1583]],         // 年号+干支: 只命中1583
  ['萬曆癸未', [1583]],         // 繁体同样
  ['癸未', [1583]],             // 纯干支: 命中癸未年
  ['万历十一年', [1583]],       // 年号全名: 命中 1583 (searchKey 含 "万历十一年")
];
for (const [q, exp] of searchTests) {
  const got = mockApplyFilters(mockRows, q).map(r => r.year);
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`  [${ok ? 'OK' : 'FAIL'}] "${q}" -> ${JSON.stringify(got)} 期望 ${JSON.stringify(exp)}`);
}

process.exit(fail ? 1 : 0);
