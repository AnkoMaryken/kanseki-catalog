// ================================================
// unit/ganzhi.test.js — 干支解析核心（移植自 tests/test_ganzhi.js 断言）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getGanzhi, getZodiac, extractGanzhi, queryContainsGanzhi,
  chineseNumToInt, yearNumToChinese, GANZHI
} from '../../src/js/core/ganzhi.js';

// 干支解析用例 [输入, 期望干支或 null]
const cases = [
  ['癸未', '癸未'],            // 纯干支
  ['万历癸未', '癸未'],        // 年号+干支 (简体)
  ['萬曆癸未', '癸未'],        // 年号+干支 (繁体)
  ['万历十一年', null],        // 无干支
  ['甲子', '甲子'],            // 甲子
  ['癸巳', '癸巳'],
  ['戊戌', '戊戌'],
  ['后元', null],              // 无干支
  ['乙丑', '乙丑'],
  ['丙子', '丙子'],
  ['慶長', null],              // 日本年号 无干支
  ['万历癸卯', '癸卯'],
];

test('干支解析 extractGanzhi', () => {
  for (const [input, exp] of cases) {
    const got = extractGanzhi(input);
    const gotStr = got ? got.ganzhi : null;
    assert.equal(gotStr, exp, `extractGanzhi(${input}) 期望 ${exp} 实际 ${gotStr}`);
  }
});

test('干支合法性：阳干配阳支、阴干配阴支', () => {
  // 甲(0 阳)配子(0 阳) 合法；甲配丑(1 阴) 不合法
  assert.ok(extractGanzhi('甲子'));
  assert.ok(extractGanzhi('乙丑'));
  assert.ok(!extractGanzhi('甲丑')); // 阳干配阴支 -> 非法
  assert.ok(!extractGanzhi('乙子')); // 阴干配阳支 -> 非法
});

test('queryContainsGanzhi', () => {
  assert.equal(queryContainsGanzhi('癸未'), true);
  assert.equal(queryContainsGanzhi('万历癸未'), true);
  assert.equal(queryContainsGanzhi('万历十一年'), false);
  assert.equal(queryContainsGanzhi(''), false);
});

test('getGanzhi 年份对应', () => {
  // 公元 4 年 = 甲子
  assert.equal(getGanzhi(4), '甲子');
  assert.equal(getGanzhi(1583), '癸未'); // 万历十一年
  assert.equal(getGanzhi(1821), '辛巳'); // 道光元年
  assert.equal(getGanzhi(2026), '丙午');
});

test('getZodiac 生肖对应', () => {
  assert.equal(getZodiac(4), '鼠');     // 甲子鼠
  assert.equal(getZodiac(1583), '羊');  // 癸未羊
  assert.equal(getZodiac(2026), '马');  // 丙午马
});

test('GANZHI 表共 60 组，首尾相接', () => {
  assert.equal(GANZHI.length, 60);
  assert.equal(GANZHI[0], '甲子');
  assert.equal(GANZHI[59], '癸亥');
});

test('yearNumToChinese / chineseNumToInt 互逆', () => {
  assert.equal(yearNumToChinese(11), '十一年');
  assert.equal(yearNumToChinese(23), '二十三年');
  assert.equal(yearNumToChinese(1), '元年');
  assert.equal(yearNumToChinese(10), '十年');
  assert.equal(chineseNumToInt('十一'), 11);
  assert.equal(chineseNumToInt('二十三'), 23);
  assert.equal(chineseNumToInt('一'), 1);
  assert.equal(chineseNumToInt('十'), 10);
  assert.equal(chineseNumToInt('廿'), 20);
  assert.equal(chineseNumToInt('卅'), 30);
  // 与真实年号对应（万历十一年 = 1583）
  assert.equal(yearNumToChinese(11).replace('年', ''), '十一');
  assert.equal(chineseNumToInt(yearNumToChinese(23).replace('年', '')), 23);
});
