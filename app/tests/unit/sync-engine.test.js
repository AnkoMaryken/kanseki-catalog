// ================================================
// unit/sync-engine.test.js — 同步引擎集成（mock store/provider）
// ================================================
// 覆盖：队列 flush、412 冲突循环、指数退避、凭据缺失、手动/自动模式
// 说明：store 用最小 mock（记录调用），provider 用可编排脚本的 mock。
// ================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncEngine, SYNC_CONFIG, CONFLICT_NONE
} from '../../src/js/core/sync/sync-engine.js';
import { ConflictError } from '../../src/js/core/sync/provider-webdav.js';

// ---------- mock store ----------
function makeMockStore() {
  const state = {
    settings: [],
    history: [],
    links: [],
    records: [],
    meta: { webdav_username: 'user@example.com', webdav_password: 'app-password' }, // 预置凭据
    queue: []
  };
  return {
    state,
    async getAllSettings() { return state.settings; },
    async getHistory() { return state.history; },
    async getAllQuickLinks() { return state.links; },
    async getAllRecords() { return state.records; },
    async getQueue() { return state.queue; },
    async clearQueue() { state.queue = []; },
    async setMeta(k, v) { state.meta[k] = v; },
    async getMeta(k) {
      if (k === 'webdav_username' || k === 'webdav_password') {
        return state.meta[k] ? { value: state.meta[k] } : null;
      }
      return state.meta[k] !== undefined ? { value: state.meta[k] } : null;
    },
    async setSettingValue(k, v, updatedAt, deviceId) {
      const idx = state.settings.findIndex(s => s.key === k);
      const rec = { key: k, value: v, updatedAt, deviceId };
      if (idx >= 0) state.settings[idx] = rec; else state.settings.push(rec);
    },
    async clearHistory() { state.history = []; },
    async putHistoryValue(h) { state.history.push(h); },
    async clearQuickLinks() { state.links = []; },
    async putQuickLinkValue(l) { state.links.push(l); },
    async clearRecords() { state.records = []; },
    async putRecordValue(r) { state.records.push(r); }
  };
}

// ---------- 可编排 provider ----------
function makeScriptedProvider(script) {
  const calls = [];
  const p = {
    calls,
    async setCredentials(u, pw) { p.username = u; p.password = pw; },
    async pull() {
      calls.push('pull');
      if (script.pull) return script.pull();
      return { revision: 'rev-1', bundle: { settings: [], search_history: [], quick_links: [], catalog_records: [] } };
    },
    async push(bundle, expectedRevision) {
      calls.push('push:' + expectedRevision);
      if (script.push) return script.push(bundle, expectedRevision);
      return { revision: 'rev-2' };
    },
    async check() { return { ok: true, message: 'ok' }; }
  };
  return p;
}

test('队列 flush：本地变更 -> 推送 -> 清队列', async () => {
  const store = makeMockStore();
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  const provider = makeScriptedProvider({
    pull: () => ({ revision: 'rev-1', bundle: { settings: [], search_history: [], quick_links: [], catalog_records: [] } }),
    push: (bundle, rev) => ({ revision: 'rev-2' })
  });

  const engine = new SyncEngine({ store, provider });
  const res = await engine.sync('manual');

  assert.equal(res.ok, true);
  assert.equal(res.hasConflict, false);
  assert.equal(store.state.queue.length, 0, '成功后清队列');
  assert.equal(store.state.meta.revision, 'rev-2');
  assert.equal(engine.getStatus().status, 'success');
  assert.ok(engine.getStatus().lastSyncAt > 0);
});

test('首次同步（空远端 404）：本地 bundle 推上云', async () => {
  const store = makeMockStore();
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  const provider = makeScriptedProvider({
    pull: () => ({ revision: '', bundle: { settings: [], search_history: [], quick_links: [], catalog_records: [] } }),
    push: (bundle, rev) => {
      assert.equal(rev, '', '首次推送 revision 为空');
      assert.equal(bundle.settings.length, 1);
      return { revision: 'rev-init' };
    }
  });

  const engine = new SyncEngine({ store, provider });
  const res = await engine.sync('manual');
  assert.equal(res.ok, true);
  assert.equal(store.state.meta.revision, 'rev-init');
});

test('412 冲突循环：重拉 -> merge -> 再推（≤3 轮）', async () => {
  const store = makeMockStore();
  // 本地有新 theme（dark, 新），远端旧（light, 旧）-> 合并后本地胜
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 5000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  const remoteBundle = {
    settings: [{ key: 'theme', value: 'light', updatedAt: 2000, deviceId: 'B' }],
    search_history: [], quick_links: [], catalog_records: []
  };

  let pushCount = 0;
  const provider = makeScriptedProvider({
    pull: () => ({ revision: 'rev-remote', bundle: remoteBundle }),
    push: (bundle, rev) => {
      pushCount++;
      if (pushCount === 1) {
        // 第一次推送 -> 412
        throw new ConflictError('冲突', 'rev-remote');
      }
      // 第二次推送成功
      assert.equal(bundle.settings[0].value, 'dark', '合并后推送本地新值');
      return { revision: 'rev-merged' };
    }
  });

  const engine = new SyncEngine({ store, provider });
  const res = await engine.sync('manual');

  assert.equal(res.ok, true);
  assert.equal(pushCount, 2, '第一次 412，第二次成功');
  assert.equal(store.state.meta.revision, 'rev-merged');
  assert.ok(store.state.queue.length === 0);
});

test('412 重试超过 3 轮 -> 失败', async () => {
  const store = makeMockStore();
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 5000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  let pullCount = 0;
  const provider = makeScriptedProvider({
    pull: () => {
      pullCount++;
      return { revision: 'rev-' + pullCount, bundle: { settings: [], search_history: [], quick_links: [], catalog_records: [] } };
    },
    push: () => { throw new ConflictError('冲突'); }
  });

  const engine = new SyncEngine({ store, provider });
  const res = await engine.sync('manual');
  assert.equal(res.ok, false);
  assert.ok(res.message && res.message.includes('3 轮'), `消息应含 3 轮，实际: ${res.message}`);
  assert.equal(pullCount, 3, '重拉 3 轮后放弃');
});

test('凭据缺失 -> 转「需手动同步」状态', async () => {
  const store = makeMockStore();
  store.state.meta = {}; // 清空凭据
  const provider = makeScriptedProvider({});
  const engine = new SyncEngine({ store, provider });
  const res = await engine.sync('manual');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-credentials');
  assert.equal(engine.getStatus().status, 'manual');
});

test('失败指数退避：第 1 次失败 -> error 状态并调度重试', async () => {
  const store = makeMockStore();
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  const provider = makeScriptedProvider({
    pull: () => { throw new Error('网络错误'); },
    push: () => ({ revision: 'r' })
  });

  // now 可控
  let t = 0;
  const engine = new SyncEngine({ store, provider, now: () => t });
  const res = await engine.sync('manual');
  assert.equal(res.ok, false);
  assert.equal(engine.getStatus().status, 'error');
  assert.equal(engine.getStatus().lastError.message, '网络错误');
  assert.ok(engine._backoffCount === 1, '退避计数 1');
  assert.ok(engine._backoffTimer, '已调度退避重试');
  engine.stop(); // 清理定时器
});

test('5 次失败后转 manual（需手动同步）', async () => {
  const store = makeMockStore();
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  const provider = makeScriptedProvider({
    pull: () => { throw new Error('网络错误'); },
    push: () => ({ revision: 'r' })
  });

  const engine = new SyncEngine({ store, provider });
  // 连续 5 次
  for (let i = 0; i < SYNC_CONFIG.backoffSteps; i++) {
    const res = await engine.sync('manual');
    assert.equal(res.ok, false);
  }
  assert.equal(engine.getStatus().status, 'manual', '5 次后转 manual');
  engine.stop();
});

test('并发同步：同一时间只跑一次（sync in-flight 复用）', async () => {
  const store = makeMockStore();
  store.state.settings = [{ key: 'theme', value: 'dark', updatedAt: 1000, deviceId: 'A' }];
  store.state.queue = [{ table: 'settings', key: 'theme' }];

  let pullCalls = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const provider = makeScriptedProvider({
    pull: async () => {
      pullCalls++;
      await gate; // 卡住第一次
      return { revision: 'rev-1', bundle: { settings: [], search_history: [], quick_links: [], catalog_records: [] } };
    },
    push: () => ({ revision: 'rev-2' })
  });

  const engine = new SyncEngine({ store, provider });
  const p1 = engine.sync('manual');
  const p2 = engine.sync('manual');
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(pullCalls, 1, '只 pull 一次（并发复用）');
  engine.stop();
});
