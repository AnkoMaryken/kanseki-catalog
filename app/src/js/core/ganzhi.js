// ================================================
// core/ganzhi.js — 干支 & 生肖 & 中文数字（纯逻辑，零 DOM）
// 从 index.html IIFE 提取（v4.3 逐字迁移）
// ================================================
import { toSimplified } from './conv.js';

// ========================================
// 干支 & 生肖
// ========================================
export const GANZHI = ['甲子','乙丑','丙寅','丁卯','戊辰','己巳','庚午','辛未','壬申','癸酉',
  '甲戌','乙亥','丙子','丁丑','戊寅','己卯','庚辰','辛巳','壬午','癸未',
  '甲申','乙酉','丙戌','丁亥','戊子','己丑','庚寅','辛卯','壬辰','癸巳',
  '甲午','乙未','丙申','丁酉','戊戌','己亥','庚子','辛丑','壬寅','癸卯',
  '甲辰','乙巳','丙午','丁未','戊申','己酉','庚戌','辛亥','壬子','癸丑',
  '甲寅','乙卯','丙辰','丁巳','戊午','己未','庚申','辛酉','壬戌','癸亥'];
export const ZODIAC = ['鼠','牛','虎','兔','龙','蛇','马','羊','猴','鸡','狗','猪'];

export function getGanzhi(year) {
  return GANZHI[((year - 4) % 60 + 60) % 60];
}
export function getZodiac(year) {
  return ZODIAC[((year - 4) % 12 + 12) % 12];
}

// 数字转中文序数（年号用）
export function yearNumToChinese(n) {
  if (n <= 0) return '';
  if (n === 1) return '元年';
  const digits = ['', '一','二','三','四','五','六','七','八','九'];
  const units = ['', '十','百','千'];
  if (n < 10) return digits[n] + '年';
  if (n < 20) return '十' + (n === 10 ? '年' : digits[n % 10] + '年');
  if (n < 100) return digits[Math.floor(n / 10)] + '十' + (n % 10 === 0 ? '年' : digits[n % 10] + '年');
  return n + '年';
}

// ========================================
// 干支解析（筛选/精准查询共用）
// ========================================
export const GZ_TIANGAN_S = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸'];
export const GZ_TIANGAN_T = ['甲','乙','丙','丁','戊','己','庚','辛','壬','癸']; // 天干繁简相同
export const GZ_DIZHI_S = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
export const GZ_DIZHI_T = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥']; // 地支繁简相同
// 地支繁体别名 (罕见, 但兼容输入)
export const DIZHI_T_ALIAS = {};

// 干支解析: 识别查询词中的干支 (支持简体/繁体写法)
// 返回: { ganzhi: '癸未' } 或 null (无干支)
// 支持格式: '癸未' / '癸未年' / '万历癸未' / '萬曆癸未'
export function extractGanzhi(query) {
  // 先归一化为简体再解析 (干支繁简同形, 但保险起见)
  const q = toSimplified(query.trim());
  const re = /([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])/g;
  let match;
  while ((match = re.exec(q)) !== null) {
    const gz = match[1] + match[2];
    // 校验是否为有效干支组合 (阳干配阳支, 阴干配阴支)
    const tgIdx = GZ_TIANGAN_S.indexOf(match[1]);
    const dzIdx = GZ_DIZHI_S.indexOf(match[2]);
    if (tgIdx >= 0 && dzIdx >= 0 && ((tgIdx % 2) === (dzIdx % 2))) {
      return { ganzhi: gz };
    }
    if (match.index + 2 < q.length && re.lastIndex === match.index + 2) continue;
  }
  return null;
}

// 判断查询词中是否包含干支 (用于"万历癸未"这类年号+干支组合)
export function queryContainsGanzhi(q) {
  return extractGanzhi(q) !== null;
}

// 中文数字转整数 (一~九十九; 支持 十/廿/三十/四十三 等)
export function chineseNumToInt(s) {
  const digits = { '〇':0,'零':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,
    '十':10,'廿':20,'卅':30 };
  if (s === '十') return 10;
  if (s === '廿') return 20;
  if (s === '卅') return 30;
  if (s.length === 1) return digits[s] !== undefined ? digits[s] : NaN;
  // 两位/三位: X十Y / 十Y / X十
  const hasShi = s.indexOf('十');
  if (hasShi === -1) {
    // 纯数字串 (十以下)
    let n = 0;
    for (const ch of s) { if (digits[ch] === undefined || digits[ch] >= 10) return NaN; n = n * 10 + digits[ch]; }
    return n;
  }
  let n = 0;
  if (hasShi === 0) {
    n = 10;
  } else {
    const first = digits[s[0]];
    if (first === undefined || first >= 10) return NaN;
    n = first * 10;
  }
  if (hasShi === s.length - 1) return n;
  const last = digits[s[s.length - 1]];
  if (last === undefined || last >= 10) return NaN;
  return n + last;
}
