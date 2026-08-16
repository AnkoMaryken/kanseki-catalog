// ================================================
// unit/dataset.test.js — 数据集构建（FULL_DATA 2868 行）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFullDataset, getFullData, buildEraSets, buildEraScopeMaps,
  DATA_VERSION, CN_DYNASTIES, JP_PERIODS
} from '../../src/js/core/dataset.js';
import { getGanzhi } from '../../src/js/core/ganzhi.js';

const fullData = getFullData();

test('DATA_VERSION 已定义', () => {
  assert.equal(DATA_VERSION, 'v4.3');
});

test('FULL_DATA.length === 2868', () => {
  assert.equal(fullData.length, 2868);
});

test('数据范围：-841 至 2026', () => {
  const years = fullData.map(r => r.year);
  assert.equal(Math.min(...years), -841);
  assert.equal(Math.max(...years), 2026);
});

test('CN_DYNASTIES 22 个朝代', () => {
  assert.equal(CN_DYNASTIES.length, 22);
});

test('JP_PERIODS 9 个时代', () => {
  assert.equal(JP_PERIODS.length, 9);
});

test('行字段完整性（含干支/生肖/朝代/时代/年号）', () => {
  const sample = fullData.find(r => r.year === 1583);
  assert.ok(sample);
  assert.equal(sample.ganzhi, '癸未');
  assert.equal(sample.zodiac, '羊');
  assert.ok((sample.cnEraNames || []).includes('万历'));
  assert.ok((sample.jpPeriods || []).includes('安土桃山'));
  assert.ok((sample.cnDynasties || []).includes('明'));
});

test('行字段完整性：1821 道光元年', () => {
  const sample = fullData.find(r => r.year === 1821);
  assert.ok(sample);
  assert.ok((sample.cnEraNames || []).includes('道光'));
  assert.equal(sample.ganzhi, '辛巳');
});

test('buildEraSets：中日年号集合', () => {
  const { ALL_CN_ERAS, ALL_JP_ERAS } = buildEraSets(fullData);
  assert.ok(ALL_CN_ERAS.size > 400, '中国年号 > 400');
  assert.ok(ALL_JP_ERAS.size > 100, '日本年号 > 100');
  assert.ok(ALL_CN_ERAS.has('万历'));
  assert.ok(ALL_JP_ERAS.has('贞观')); // 中日重名
});

test('buildEraScopeMaps：年号归属（崇祯只属明）', () => {
  const { ERA_CN_SCOPE, ERA_JP_SCOPE } = buildEraScopeMaps();
  const chongzhen = ERA_CN_SCOPE.get('崇祯');
  assert.ok(chongzhen);
  assert.ok(chongzhen.has('明'));
  assert.equal(chongzhen.size, 1, '崇祯只属明，1644 不误归清');
  const zhenguanCn = ERA_CN_SCOPE.get('贞观');
  assert.ok(zhenguanCn && zhenguanCn.has('唐'));
  const zhenguanJp = ERA_JP_SCOPE.get('贞观');
  assert.ok(zhenguanJp, '贞观也是日本年号');
});

test('getGanzhi 与数据行一致', () => {
  for (const year of [4, 1583, 1821, 2026, -841]) {
    const row = fullData.find(r => r.year === year);
    if (row) assert.equal(row.ganzhi, getGanzhi(year));
  }
});

test('buildFullDataset 幂等（多次构建结果一致）', () => {
  const a = buildFullDataset();
  const b = buildFullDataset();
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b);
});
