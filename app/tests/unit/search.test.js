// ================================================
// unit/search.test.js — 搜索/筛选核心（真实数据）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFullData } from '../../src/js/core/dataset.js';
import { buildPinyinIndex } from '../../src/js/core/pinyin.js';
import {
  rowSearchHit, applyFilters, getFilteredData, realFilteredCount, realFilteredRows,
  setFullData, setSearchQuery, getFullData as getSearchFullData
} from '../../src/js/core/search.js';
import { getPreciseHitMark, isNearbyRow, isNearbySep } from '../../src/js/core/precise.js';

const fullData = getFullData();

test('search 模块接入 FULL_DATA', () => {
  setFullData(fullData);
  assert.equal(getSearchFullData().length, 2868);
});

test('rowSearchHit：年号精确命中（万历）', () => {
  const row = fullData.find(r => r.year === 1583);
  assert.ok(rowSearchHit(row, '万历', false));
  assert.ok(rowSearchHit(row, '万历', true));
  const row2 = fullData.find(r => r.year === 1582);
  assert.ok(rowSearchHit(row2, '万历', false)); // 万历十年也属万历
});

test('rowSearchHit：干支组合命中（万历癸未）', () => {
  const row = fullData.find(r => r.year === 1583);
  const row2 = fullData.find(r => r.year === 1582);
  assert.ok(rowSearchHit(row, '万历癸未', false));
  assert.ok(!rowSearchHit(row2, '万历癸未', false)); // 1582 是壬午
});

test('rowSearchHit：纯干支命中', () => {
  const row = fullData.find(r => r.year === 1583);
  assert.ok(rowSearchHit(row, '癸未', false));
  const row2 = fullData.find(r => r.year === 1582);
  assert.ok(!rowSearchHit(row2, '癸未', false));
});

test('applyFilters：两阶段（精确 + 模糊）', () => {
  // 精确：万历 -> 全部万历行（48 年）
  setFullData(fullData);
  setSearchQuery('万历');
  applyFilters();
  const all = realFilteredRows();
  assert.ok(all.length >= 48, '万历共 48 年');
  assert.ok(all.every(r => (r.cnEraNames || []).includes('万历')));
});

test('applyFilters：无匹配时模糊补全（年号前缀）', () => {
  // "万" 不是年号全名，触发模糊 -> 万历
  setSearchQuery('万');
  applyFilters();
  const rows = realFilteredRows();
  assert.ok(rows.length > 0, '模糊命中万历');
});

test('applyFilters：精准查询插入临近行（道光三年 -> 1823 且 道光全部年份）', () => {
  setSearchQuery('道光三年');
  applyFilters();
  const data = getFilteredData();
  const hasSep = data.some(isNearbySep);
  assert.ok(hasSep, '应有分隔行');
  const nearbyRows = data.filter(r => isNearbyRow(r));
  assert.ok(nearbyRows.length >= 29, `道光 1821-1850 共 30 年，至少 29 个临近行（实际 ${nearbyRows.length}）`);
  // 命中的 1823 行有 precise 标记
  const hitRow = data.find(r => r.year === 1823);
  assert.ok(hitRow, '1823 应在结果中');
  const mark = getPreciseHitMark().get(hitRow);
  assert.ok(mark && mark.precise, '命中行应有 precise 标记');
});

test('realFilteredCount 排除临近行', () => {
  setSearchQuery('道光三年');
  applyFilters();
  const count = realFilteredCount();
  const total = getFilteredData().length;
  const nearby = getFilteredData().filter(r => isNearbyRow(r)).length;
  assert.equal(count, total - nearby - 1); // 减分隔行
});

test('拼音检索：jingtai -> 明景泰', () => {
  buildPinyinIndex(fullData);
  setSearchQuery('jingtai');
  applyFilters();
  const rows = realFilteredRows();
  assert.ok(rows.length > 0, '拼音 jingtai 有命中');
  assert.ok(rows.some(r => (r.cnEraNames || []).includes('景泰')), '应含景泰');
});
