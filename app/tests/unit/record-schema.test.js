// ================================================
// unit/record-schema.test.js — 编目记录字段模型（14 字段 + 校验）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_FIELDS, OPTIONAL_FIELDS, ALL_FIELDS, FIELD_DEFS,
  createEmptyRecord, validateRecord, sortRecords, searchRecords,
  makeNewRecord, markDeleted, touchUpdated
} from '../../src/js/core/catalog-record-schema.js';

test('字段模型：必填 8 项 + 选填 5 项 = 13 项（+seq 自动编号 = 模板 14 列）', () => {
  assert.equal(REQUIRED_FIELDS.length, 8);
  assert.equal(OPTIONAL_FIELDS.length, 5);
  assert.equal(ALL_FIELDS.length, 13);
  // 模板 14 列 = 13 业务字段 + seq（序号，自动）
  assert.equal(REQUIRED_FIELDS.length + OPTIONAL_FIELDS.length + 1, 14);
});

test('字段模型：与模板表头对齐', () => {
  const expectedHeaders = [
    '類目', '書名', '卷數', '索書號', '著者', '版本', '函册', '版式',
    '扉頁、刊記', '紙背文獻', '附録', '叢書子目', '編目者、校對者'
  ];
  for (const f of ALL_FIELDS) {
    assert.ok(FIELD_DEFS[f], `字段 ${f} 应有定义`);
    assert.ok(FIELD_DEFS[f].label, `字段 ${f} 应有 label`);
    assert.ok(FIELD_DEFS[f].templateHeader, `字段 ${f} 应有 templateHeader`);
  }
  // 检查模板表头原文（繁体）
  assert.equal(FIELD_DEFS.title.templateHeader, '*書名');
  assert.equal(FIELD_DEFS.shelf.templateHeader, '*索書號');
  assert.equal(FIELD_DEFS.frontmatter.templateHeader, '扉頁、刊記等');
});

test('必填字段均标记 required', () => {
  for (const f of REQUIRED_FIELDS) {
    assert.equal(FIELD_DEFS[f].required, true, `${f} 应必填`);
  }
  for (const f of OPTIONAL_FIELDS) {
    assert.equal(FIELD_DEFS[f].required, false, `${f} 应选填`);
  }
});

test('createEmptyRecord：全部字段空值 + 元数据', () => {
  const rec = createEmptyRecord();
  for (const f of ALL_FIELDS) assert.equal(rec[f], '');
  assert.equal(rec.id, null);
  assert.equal(rec.seq, null);
  assert.equal(rec.deletedAt, null);
});

test('validateRecord：必填校验', () => {
  const empty = createEmptyRecord();
  const res = validateRecord(empty);
  assert.equal(res.valid, false);
  for (const f of REQUIRED_FIELDS) {
    assert.ok(res.errors[f], `必填字段 ${f} 应报错`);
  }
  // 填满必填后通过
  const good = createEmptyRecord();
  for (const f of REQUIRED_FIELDS) good[f] = '测试值';
  const res2 = validateRecord(good);
  assert.equal(res2.valid, true);
  assert.deepEqual(res2.errors, {});
});

test('validateRecord：长度上限 5000', () => {
  const rec = createEmptyRecord();
  for (const f of REQUIRED_FIELDS) rec[f] = 'x';
  rec.title = 'x'.repeat(5001);
  const res = validateRecord(rec);
  assert.equal(res.valid, false);
  assert.ok(res.errors.title);
});

test('makeNewRecord：自动元数据', () => {
  const rec = makeNewRecord({ title: '日本国志', category: '史部·地理類' }, 'dev-A');
  assert.ok(rec.id);
  assert.equal(rec.title, '日本国志');
  assert.ok(rec.createdAt > 0);
  assert.equal(rec.createdAt, rec.updatedAt);
  assert.equal(rec.deletedAt, null);
  assert.equal(rec.deviceId, 'dev-A');
});

test('touchUpdated：保持 createdAt 刷新 updatedAt', () => {
  const rec = makeNewRecord({ title: 'A' }, 'dev-A');
  const updated = touchUpdated(rec, { title: 'B' }, 'dev-B');
  assert.equal(updated.createdAt, rec.createdAt);
  assert.ok(updated.updatedAt >= rec.updatedAt);
  assert.equal(updated.title, 'B');
  assert.equal(updated.deviceId, 'dev-B');
});

test('markDeleted：墓碑（deletedAt 非空）', () => {
  const rec = makeNewRecord({ title: 'A' }, 'dev-A');
  const tomb = markDeleted(rec, 'dev-B');
  assert.ok(tomb.deletedAt > 0);
  assert.ok(tomb.updatedAt >= tomb.deletedAt);
  assert.equal(tomb.deviceId, 'dev-B');
});

test('sortRecords：默认 updatedAt 降序，可切升序', () => {
  const a = { updatedAt: 100, title: 'a' };
  const b = { updatedAt: 200, title: 'b' };
  const c = { updatedAt: 150, title: 'c' };
  assert.deepEqual(sortRecords([a, b, c]).map(r => r.title), ['b', 'c', 'a']);
  assert.deepEqual(sortRecords([a, b, c], 'asc').map(r => r.title), ['a', 'c', 'b']);
});

test('searchRecords：按书名/索書號/著者/類目搜索', () => {
  const records = [
    { title: '日本国志', shelf: '一·〇二·〇一', author: '黄遵宪', category: '史部' },
    { title: '文选', shelf: '二·〇一·〇三', author: '萧统', category: '集部' }
  ];
  assert.equal(searchRecords(records, '日本').length, 1);
  assert.equal(searchRecords(records, '一·〇二').length, 1);
  assert.equal(searchRecords(records, '黄遵宪').length, 1);
  assert.equal(searchRecords(records, '史部').length, 1);
  assert.equal(searchRecords(records, '').length, 2);
  assert.equal(searchRecords(records, '不存在').length, 0);
});
