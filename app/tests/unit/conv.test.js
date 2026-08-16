// ================================================
// unit/conv.test.js — 简繁转换核心（移植自 tests/test_conv.js 断言）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toTraditional, toSimplified, toDisplay, toLang,
  setLangState, getDisplayLang, queryForDisplay
} from '../../src/js/core/conv.js';

// 转换测试用例 [简体输入, 期望繁体输出]（数据以简体存储，toTraditional 输出繁体）
const cases = [
  ['万历', '萬曆'], ['万历癸未', '萬曆癸未'],
  ['癸未', '癸未'], ['贞观', '貞觀'], ['贞观元年', '貞觀元年'],
  ['后元', '後元'], ['高后', '高后'], ['乾隆', '乾隆'],
  ['圣历', '聖曆'], ['咸亨', '咸亨'], ['汉冲帝', '漢沖帝'],
  ['龙', '龍'], ['丑', '丑'], ['庆长', '慶長'],
  ['昭和', '昭和'], ['天保', '天保'], ['弘历', '弘曆'],
  ['天皇', '天皇'], ['万寿', '萬壽'], ['宝龟', '寶龜'],
  ['后朱雀', '後朱雀'], ['后醍醐', '後醍醐'], ['应长', '應長'],
  ['宽仁', '寬仁'], ['长历', '長曆'], ['贞永', '貞永'],
  ['复制', '複製'], ['数据', '數據'], ['兴国', '興國'],
  ['神护景云', '神護景雲'], ['观应', '觀應'], ['乾统', '乾統'],
  ['丑', '丑'], ['咸亨', '咸亨'], ['康熙', '康熙'],
  ['雍正', '雍正'], ['道光', '道光'], ['嘉庆', '嘉慶'],
  ['乙巳', '乙巳'], ['癸亥', '癸亥'], ['文永', '文永'],
  ['安永', '安永'], ['元禄', '元祿'], ['享保', '享保'],
  ['明和', '明和'], ['宝永', '寶永'], ['正德', '正德'],
  ['延宝', '延寶'], ['天和', '天和'], ['贞亨', '貞亨'],
  ['元禄', '元祿'], ['宝历', '寶曆'], ['宽政', '寬政'],
  ['宽永', '寬永'], ['庆安', '慶安'], ['承应', '承應'],
  ['明历', '明曆'], ['万治', '萬治'], ['宽文', '寬文'],
];

test('简繁转换：输入简体转繁体（toTraditional）', () => {
  for (const [src, exp] of cases) {
    const got = toTraditional(src);
    assert.equal(got, exp, `toTraditional(${src}) 期望 ${exp} 实际 ${got}`);
  }
});

test('简繁转换：输入繁体转简体（toSimplified）', () => {
  for (const [src, exp] of cases) {
    const got = toSimplified(exp);
    assert.equal(got, src, `toSimplified(${exp}) 期望 ${src} 实际 ${got}`);
  }
});

test('简繁转换：双向可逆（s2t 再 t2s 还原）', () => {
  const roundTrip = ['万历','贞观','乾隆','高后','后元','汉冲帝','圣历','咸亨','复辟','神护景云','乾道','癸丑','庆历','宝历','天复'];
  for (const s of roundTrip) {
    const t = toTraditional(s);
    const back = toSimplified(t);
    assert.equal(back, s, `可逆失败 ${s} -> ${t} -> ${back}`);
  }
});

test('显示字形状态：默认简体，setLangState 切换', () => {
  setLangState('s');
  assert.equal(getDisplayLang(), 's');
  assert.equal(toDisplay('万历'), '万历');
  setLangState('t');
  assert.equal(getDisplayLang(), 't');
  assert.equal(toDisplay('万历'), '萬曆');
  setLangState('s'); // 还原，避免污染其他测试
});

test('toLang 显式目标字形（双向可靠）', () => {
  assert.equal(toLang('万历', 't'), '萬曆');
  assert.equal(toLang('萬曆', 's'), '万历');
  assert.equal(toLang('乾隆', 't'), '乾隆'); // 简繁同形
});

test('queryForDisplay 跟随显示字形', () => {
  setLangState('s');
  assert.equal(queryForDisplay('万历'), '万历');
  setLangState('t');
  assert.equal(queryForDisplay('万历'), '萬曆');
  assert.equal(queryForDisplay('萬曆'), '萬曆'); // 繁体输入直接保留
  setLangState('s');
});
