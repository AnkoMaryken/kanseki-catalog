const fs = require('fs');

// 1. 验证 conv_tables.js 语法
try {
  new Function(fs.readFileSync('conv_tables.js', 'utf-8'));
  console.log('conv_tables.js 语法 OK');
} catch (e) {
  console.log('conv_tables.js ERROR:', e.message);
  process.exit(1);
}

// 2. 加载映射 (vm 内把映射挂载到 sandbox 上)
const vm = require('vm');
const sandbox = { __out: null };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync('conv_tables.js', 'utf-8') + '\n__out = { S2T: S2T_MAP, T2S: T2S_MAP };',
  sandbox
);
const ctx = sandbox.__out;

function convert(text, mapObj) {
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

// 繁简判断: 若源串包含明确的繁体字形 (即 T2S 映射能改变它), 则走 t2s
function isTraditional(src) {
  const t2sKeys = Object.keys(ctx.T2S);
  // 逐个字符: 若该字符在 T2S 中且转换结果 ≠ 自身, 且它不在 S2T 中(避免简繁同形字混淆)
  for (const c of src) {
    if (ctx.T2S[c] && ctx.T2S[c] !== c && (!ctx.S2T[c] || ctx.S2T[c] === c)) {
      return true;
    }
  }
  return false;
}

const tests = [
  // [输入, 期望输出]
  ['万历', '萬曆'], ['萬曆', '万历'], ['万历癸未', '萬曆癸未'],
  ['癸未', '癸未'], ['貞觀', '贞观'], ['貞觀元年', '贞观元年'],
  ['后元', '後元'], ['高后', '高后'], ['乾隆', '乾隆'],
  ['圣历', '聖曆'], ['咸亨', '咸亨'], ['汉冲帝', '漢沖帝'],
  ['龙', '龍'], ['丑', '丑'], ['慶長', '庆长'],
  ['昭和', '昭和'], ['天保', '天保'], ['弘曆', '弘历'],
  ['天皇', '天皇'], ['萬壽', '万寿'], ['寶龜', '宝龟'],
  ['後朱雀', '后朱雀'], ['後醍醐', '后醍醐'], ['應長', '应长'],
  ['寬仁', '宽仁'], ['長曆', '长历'], ['貞永', '贞永'],
  ['複製', '复制'], ['數據', '数据'], ['興國', '兴国'],
  ['神護景雲', '神护景云'], ['觀應', '观应'], ['乾統', '乾统'],
  ['醜', '丑'], ['鹹亨', '咸亨'], ['康熙', '康熙'],
  ['雍正', '雍正'], ['道光', '道光'], ['嘉慶', '嘉庆'],
  ['乙巳', '乙巳'], ['癸亥', '癸亥'], ['文永', '文永'],
  ['安永', '安永'], ['元祿', '元禄'], ['享保', '享保'],
  ['明和', '明和'], ['寶永', '宝永'], ['正德', '正德'],
  ['延寶', '延宝'], ['天和', '天和'], ['貞亨', '贞亨'],
  ['元祿', '元禄'], ['寶曆', '宝历'], ['寬政', '宽政'],
  ['寬永', '宽永'], ['慶安', '庆安'], ['承應', '承应'],
  ['明曆', '明历'], ['萬治', '万治'], ['寬文', '宽文'],
];

let pass = 0, fail = 0;
for (const [src, exp] of tests) {
  const got = isTraditional(src) ? convert(src, ctx.T2S) : convert(src, ctx.S2T);
  if (got === exp) pass++;
  else { fail++; console.log('  [FAIL]', src, '->', got, '期望', exp); }
}
console.log('转换测试 通过', pass, '失败', fail);

// 3. 验证转换的可逆性 (s2t 再 t2s 应还原)
let reversibilityFail = 0;
const roundTrip = ['万历','贞观','乾隆','高后','后元','汉冲帝','圣历','咸亨','复辟','神护景云','乾道','癸丑','庆历','宝历','天复'];
for (const s of roundTrip) {
  const t = convert(s, ctx.S2T);
  const back = convert(t, ctx.T2S);
  if (back !== s) { reversibilityFail++; console.log('  [可逆FAIL]', s, '->', t, '->', back); }
}
console.log('可逆性测试 失败数:', reversibilityFail);

process.exit(fail || reversibilityFail ? 1 : 0);
