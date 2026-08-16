// ================================================
// unit/idb.test.js — IndexedDB 存储层（fake-indexeddb）
// ================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';

import {
  openStore, openDB, migrate, setIndexedDB,
  DB_NAME, DB_VERSION, ALL_STORES,
  STORE_SETTINGS, STORE_HISTORY, STORE_QUICK_LINKS, STORE_SYNC_META,
  STORE_CHANGE_QUEUE, STORE_RECORDS,
  idbGet, idbGetAll, idbPut, idbDelete, idbCount
} from '../../src/js/core/sync/store-indexeddb.js';

// 每个测试前重置 fake-indexeddb（避免跨测试污染）
let counter = 0;
beforeEach(async () => {
  counter++;
  // 删除旧库（fake-indexeddb 同实例数据会残留）
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // 旧连接未关闭时也继续
    });
  } catch (_) { /* noop */ }
  setIndexedDB(indexedDB);
});

test('openDB：创建 kanseki-app v1 + 6 个 store', async () => {
  const db = await openDB({ indexedDB });
  assert.equal(db.name, DB_NAME);
  assert.equal(db.version, DB_VERSION);
  assert.equal(db.objectStoreNames.length, 6);
  for (const s of ALL_STORES) {
    assert.ok(db.objectStoreNames.contains(s), `store ${s} 存在`);
  }
  db.close();
});

test('openDB：重复打开不迁移（幂等）', async () => {
  const db1 = await openDB({ indexedDB });
  const db2 = await openDB({ indexedDB });
  assert.equal(db2.version, 1);
  db1.close();
  db2.close();
});

test('openStore：写入 settings 并标记队列', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.setSetting('theme', 'dark');
  const s = await store.getSetting('theme');
  assert.equal(s.value, 'dark');
  assert.ok(s.updatedAt > 0);
  const q = await store.getQueue();
  assert.ok(q.some(item => item.table === STORE_SETTINGS && item.key === 'theme'));
  store.close();
});

test('openStore：search_history 写入 + 读取', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.appendHistory('道光', 1000);
  await store.appendHistory('贞观', 2000);
  const hist = await store.getHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].term, '道光');
  store.close();
});

test('openStore：quick_links 写入 + 墓碑删除', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  const link = await store.putQuickLink({ name: '典津', url: 'https://dianjin.cc' });
  assert.ok(link.id);
  const all = await store.getAllQuickLinks();
  assert.equal(all.length, 1);
  // 墓碑删除
  await store.removeQuickLink(link.id);
  const after = await store.getAllQuickLinks();
  assert.ok(after[0].deletedAt, '墓碑 deletedAt 非空');
  store.close();
});

test('sync_meta：凭据与 revision 存本机', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.setMeta('webdav_username', 'user@example.com');
  await store.setMeta('revision', '"abc"');
  const u = await store.getMeta('webdav_username');
  assert.equal(u.value, 'user@example.com');
  const rev = await store.getMeta('revision');
  assert.equal(rev.value, '"abc"');
  store.close();
});

test('catalog_records：预留 store 可用', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.putRecordValue({ id: 'r1', title: '日本国志', updatedAt: 1, deviceId: 'A' });
  const recs = await store.getAllRecords();
  assert.equal(recs.length, 1);
  store.close();
});

test('change_queue：push/clear 生命周期', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.pushChange(STORE_SETTINGS, 'theme');
  await store.pushChange(STORE_HISTORY, '道光');
  const q1 = await store.getQueue();
  assert.equal(q1.length, 2);
  await store.clearQueue();
  const q2 = await store.getQueue();
  assert.equal(q2.length, 0);
  store.close();
});

test('migrateFromLocalStorage：theme/history/quick_links 单向导入', async () => {
  const fakeLS = {
    getItem(k) {
      if (k === 'theme') return 'dark';
      if (k === 'kanseki_search_history') return JSON.stringify([{ term: '万历', ts: 100 }, { term: '贞观', ts: 200 }]);
      if (k === 'quickLinksCustom') return JSON.stringify([{ name: '典津', url: 'https://dianjin.cc' }]);
      return null;
    },
    setItem() {}
  };
  const store = await openStore({ indexedDB, localStorage: fakeLS });
  const theme = await store.getSetting('theme');
  assert.equal(theme.value, 'dark');
  const hist = await store.getHistory();
  assert.equal(hist.length, 2);
  const links = await store.getAllQuickLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].name, '典津');
  store.close();
});

test('migrateFromLocalStorage：已有数据则跳过（幂等）', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.setSetting('theme', 'light');
  // 二次导入不应覆盖
  const fakeLS = {
    getItem: (k) => k === 'theme' ? 'dark' : null,
    setItem() {}
  };
  await store.setSetting('theme', 'light'); // 已有记录
  // 用 migrateFromLocalStorage 直接验证幂等
  const { migrateFromLocalStorage } = await import('../../src/js/core/sync/store-indexeddb.js');
  const r = await migrateFromLocalStorage(store.db, { localStorage: fakeLS });
  assert.equal(r.skipped, 1);
  const theme = await store.getSetting('theme');
  assert.equal(theme.value, 'light', '不覆盖已有值');
  store.close();
});

test('writeBackToLocalStorage：theme 写回 localStorage', async () => {
  const store = await openStore({ indexedDB, localStorage: null });
  await store.setSetting('theme', 'dark');
  const ls = { setItem(k, v) { this._s[k] = v; }, getItem() { return null; }, _s: {} };
  const { writeBackToLocalStorage } = await import('../../src/js/core/sync/store-indexeddb.js');
  await writeBackToLocalStorage(store.db, { localStorage: ls });
  assert.equal(ls._s['theme'], 'dark');
  store.close();
});

test('idb 原始操作：get/put/delete/count', async () => {
  const db = await openDB({ indexedDB });
  await idbPut(db, STORE_SETTINGS, { key: 'a', value: 1, updatedAt: 1, deviceId: 'A' });
  assert.equal(await idbCount(db, STORE_SETTINGS), 1);
  const got = await idbGet(db, STORE_SETTINGS, 'a');
  assert.equal(got.value, 1);
  await idbDelete(db, STORE_SETTINGS, 'a');
  assert.equal(await idbCount(db, STORE_SETTINGS), 0);
  db.close();
});
