// ================================================
// unit/merge.test.js — mergeBundles 冲突合并（LWW + 墓碑 + 队列）
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeBundles, lwwWinner, isDeleted, mergeSettings, mergeHistory, mergeLwwTable,
  stripDeleted, buildApplyPlan, SYNC_CONFIG
} from '../../src/js/core/sync/sync-engine.js';
import { CRED_PREFIX } from '../../src/js/core/sync/store-indexeddb.js';

// ---------- LWW 基础 ----------
test('lwwWinner：updatedAt 大者胜', () => {
  assert.equal(lwwWinner({ updatedAt: 200, deviceId: 'A' }, { updatedAt: 100, deviceId: 'B' }), true);
  assert.equal(lwwWinner({ updatedAt: 100, deviceId: 'A' }, { updatedAt: 200, deviceId: 'B' }), false);
});

test('lwwWinner：平局 deviceId 字典序大者胜', () => {
  assert.equal(lwwWinner({ updatedAt: 100, deviceId: 'B' }, { updatedAt: 100, deviceId: 'A' }), true);
  assert.equal(lwwWinner({ updatedAt: 100, deviceId: 'A' }, { updatedAt: 100, deviceId: 'B' }), false);
});

// ---------- 并发编辑 ----------
test('并发编辑：两端都改同一 setting，时间新者胜', () => {
  const local = {
    settings: [{ key: 'theme', value: 'dark', updatedAt: 3000, deviceId: 'A' }],
    search_history: [], quick_links: [], catalog_records: []
  };
  const remote = {
    settings: [{ key: 'theme', value: 'light', updatedAt: 2000, deviceId: 'B' }],
    search_history: [], quick_links: [], catalog_records: []
  };
  const r = mergeBundles(local, remote);
  assert.equal(r.merged.settings.length, 1);
  assert.equal(r.merged.settings[0].value, 'dark'); // 本地新 -> 胜
  assert.ok(r.conflicts.includes('theme'), '应有冲突标记');
  assert.equal(r.hasConflict, true);
});

test('并发编辑：远端新则远端胜', () => {
  const local = {
    settings: [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }],
    search_history: [], quick_links: [], catalog_records: []
  };
  const remote = {
    settings: [{ key: 'theme', value: 'light', updatedAt: 5000, deviceId: 'B' }],
    search_history: [], quick_links: [], catalog_records: []
  };
  const r = mergeBundles(local, remote);
  assert.equal(r.merged.settings[0].value, 'light');
  assert.ok(r.conflicts.includes('theme'));
});

test('内容相同不算冲突（正常收敛）', () => {
  const mk = (updatedAt, deviceId) => ({
    settings: [{ key: 'lang', value: 't', updatedAt, deviceId }],
    search_history: [], quick_links: [], catalog_records: []
  });
  // 远端是旧版本但内容相同 -> 无冲突
  const r = mergeBundles(mk(3000, 'A'), mk(2000, 'B'));
  assert.equal(r.hasConflict, false);
  assert.equal(r.merged.settings[0].value, 't');
});

// ---------- 删改冲突（delete vs edit）----------
test('删改冲突：删除（墓碑）vs 编辑，时间新者胜', () => {
  const tomb = { id: 'ql1', name: '典津', url: 'https://a', updatedAt: 5000, deviceId: 'B', deletedAt: 5000 };
  const edit = { id: 'ql1', name: '典津', url: 'https://new', updatedAt: 3000, deviceId: 'A', deletedAt: null };
  const local = { settings: [], search_history: [], quick_links: [edit], catalog_records: [] };
  const remote = { settings: [], search_history: [], quick_links: [tomb], catalog_records: [] };
  const r = mergeBundles(local, remote);
  assert.ok(isDeleted(r.merged.quick_links[0]), '远端墓碑更新 -> 删除生效');
  assert.ok(r.conflicts.includes('ql1'));
});

test('删改冲突：编辑更新于墓碑 -> 编辑生效', () => {
  const tomb = { id: 'ql1', name: '典津', url: 'https://a', updatedAt: 3000, deviceId: 'B', deletedAt: 3000 };
  const edit = { id: 'ql1', name: '典津', url: 'https://new', updatedAt: 5000, deviceId: 'A', deletedAt: null };
  const local = { settings: [], search_history: [], quick_links: [edit], catalog_records: [] };
  const remote = { settings: [], search_history: [], quick_links: [tomb], catalog_records: [] };
  const r = mergeBundles(local, remote);
  assert.ok(!isDeleted(r.merged.quick_links[0]), '编辑更新 -> 复活');
  assert.equal(r.merged.quick_links[0].url, 'https://new');
});

// ---------- settings 合并 ----------
test('settings 合并：不同 key 取并集', () => {
  const local = { settings: [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }], search_history: [], quick_links: [], catalog_records: [] };
  const remote = { settings: [{ key: 'lang', value: 't', updatedAt: 2000, deviceId: 'B' }], search_history: [], quick_links: [], catalog_records: [] };
  const r = mergeBundles(local, remote);
  assert.equal(r.merged.settings.length, 2);
  assert.equal(r.hasConflict, false);
});

test('settings 合并：凭据类 key 永不进 bundle（merge 时排除）', () => {
  const local = { settings: [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }], search_history: [], quick_links: [], catalog_records: [] };
  const remote = {
    settings: [
      { key: CRED_PREFIX + 'username', value: 'evil@hacker', updatedAt: 5000, deviceId: 'B' },
      { key: CRED_PREFIX + 'password', value: 'hacked', updatedAt: 5000, deviceId: 'B' }
    ],
    search_history: [], quick_links: [], catalog_records: []
  };
  const r = mergeBundles(local, remote);
  assert.ok(!r.merged.settings.some(s => s.key.startsWith(CRED_PREFIX)), '凭据被排除');
  assert.equal(r.merged.settings.length, 1);
});

// ---------- history 截断 ----------
test('history：拼接去重 + ts 降序 + 截断 100', () => {
  const localHist = [];
  for (let i = 0; i < 80; i++) localHist.push({ term: 'local' + i, ts: i, deviceId: 'A' });
  const remoteHist = [];
  for (let i = 40; i < 90; i++) remoteHist.push({ term: 'remote' + i, ts: 1000 + i, deviceId: 'B' });
  // 其中 40-79 与 local 的 40-79 是不同的 term（避免 id 去重混淆，这里用 term 区分）
  const r = mergeBundles({
    settings: [], search_history: localHist, quick_links: [], catalog_records: []
  }, {
    settings: [], search_history: remoteHist, quick_links: [], catalog_records: []
  });
  // 80 local + 50 remote = 130，但 term 无重复 -> 截断 100
  assert.ok(r.merged.search_history.length <= 100, '截断到 100');
  // 降序：第一条 ts 最大
  const ts = r.merged.search_history.map(h => h.ts);
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i - 1] >= ts[i], 'ts 降序');
});

test('history：同 term 去重', () => {
  const local = { settings: [], search_history: [{ term: '道光', ts: 1000, deviceId: 'A' }], quick_links: [], catalog_records: [] };
  const remote = { settings: [], search_history: [{ term: '道光', ts: 2000, deviceId: 'B' }], quick_links: [], catalog_records: [] };
  const r = mergeBundles(local, remote);
  assert.equal(r.merged.search_history.length, 1, '同 term 合并');
  assert.equal(r.merged.search_history[0].ts, 2000, '取较新 ts');
});

// ---------- quick_links 墓碑合并 ----------
test('quick_links：远端新增 + 本地保留（并集）', () => {
  const local = { settings: [], search_history: [], quick_links: [{ id: 'a', name: 'A', url: 'https://a', updatedAt: 1000, deviceId: 'A', deletedAt: null }], catalog_records: [] };
  const remote = { settings: [], search_history: [], quick_links: [{ id: 'b', name: 'B', url: 'https://b', updatedAt: 1000, deviceId: 'B', deletedAt: null }], catalog_records: [] };
  const r = mergeBundles(local, remote);
  assert.equal(r.merged.quick_links.length, 2);
  assert.equal(r.hasConflict, false);
});

test('stripDeleted：剔除墓碑行（业务层不显示）', () => {
  const rows = [
    { id: 'a', deletedAt: null },
    { id: 'b', deletedAt: 1000 }
  ];
  const live = stripDeleted(rows);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, 'a');
});

// ---------- buildApplyPlan ----------
test('buildApplyPlan：合并结果转为落库计划', () => {
  const merged = {
    settings: [{ key: 'theme', value: 'dark', updatedAt: 3000, deviceId: 'A' }],
    search_history: [{ term: '道光', ts: 1000, deviceId: 'A' }],
    quick_links: [{ id: 'ql1', name: '典津', url: 'https://d', createdAt: 1000, updatedAt: 2000, deletedAt: null, deviceId: 'B' }],
    catalog_records: []
  };
  const plan = buildApplyPlan(merged);
  assert.equal(plan.settings.length, 1);
  assert.equal(plan.settings[0].key, 'theme');
  assert.equal(plan.search_history[0].term, '道光');
  assert.equal(plan.quick_links[0].id, 'ql1');
});

// ---------- 队列 flush 语义（快照一致性由 engine 层处理，此处验证配置）----------
test('SYNC_CONFIG 常量符合计划', () => {
  assert.equal(SYNC_CONFIG.debounceMs, 5000);
  assert.equal(SYNC_CONFIG.backoffBaseMs, 1000);
  assert.equal(SYNC_CONFIG.backoffMaxMs, 60000);
  assert.equal(SYNC_CONFIG.backoffSteps, 5);
  assert.equal(SYNC_CONFIG.maxHistory, 100);
  assert.equal(SYNC_CONFIG.maxConflictRounds, 3);
});
