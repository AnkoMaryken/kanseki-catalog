// ================================================
// core/sync/store-indexeddb.js — IndexedDB 存储层（离线优先，事实源）
// ================================================
// 库: kanseki-app, version 1, 6 个 store:
//   settings        偏好（按 key 合并，LWW）        keyPath: 'key'
//   search_history  搜索历史（append-only 日志）     keyPath: 'id' (autoIncrement)
//   quick_links     快捷链接（每项 LWW + 墓碑）     keyPath: 'id'
//   sync_meta       同步元数据（revision/时间戳）    keyPath: 'key'
//   change_queue    待同步变更队列（成功推送后清空） keyPath: 'id' (autoIncrement)
//   catalog_records 编目记录（占位期空 store，schema v1 预留，后期直接启用）
//
// 设计要点：
//  - 可注入 indexedDB 实现（fake-indexeddb 单测 / Tauri webview / Capacitor）
//  - localStorage 兼容桥：theme 写回 localStorage（静态站仍读）；
//    启动时 localStorage 有值且 IndexedDB 无记录则一次性导入（幂等）
//  - 同步写入（setSettingValue / putQuickLinkValue 等）不触碰 change_queue，
//    避免 merge 回写触发同步死循环；业务写入（setSetting / appendHistory 等）
//    会 pushChange 标记 dirty
// ================================================

export const DB_NAME = 'kanseki-app';
export const DB_VERSION = 1;

// store 常量（顺序即创建顺序）
export const STORE_SETTINGS = 'settings';
export const STORE_HISTORY = 'search_history';
export const STORE_QUICK_LINKS = 'quick_links';
export const STORE_SYNC_META = 'sync_meta';
export const STORE_CHANGE_QUEUE = 'change_queue';
export const STORE_RECORDS = 'catalog_records';

export const ALL_STORES = [
  STORE_SETTINGS, STORE_HISTORY, STORE_QUICK_LINKS,
  STORE_SYNC_META, STORE_CHANGE_QUEUE, STORE_RECORDS
];

// 凭据类 key 前缀：绝不进同步 bundle（只存本机 sync_meta）
export const CRED_PREFIX = 'webdav_';

// ----------------------------------------------------------------
// 基础：可注入 indexedDB
// ----------------------------------------------------------------
let _idbImpl = null;

export function setIndexedDB(impl) { _idbImpl = impl; }
export function getIndexedDB() {
  return _idbImpl || (typeof indexedDB !== 'undefined' ? indexedDB : null);
}

// ----------------------------------------------------------------
// openDB + 迁移框架（oldVersion -> DB_VERSION 分步迁移）
// ----------------------------------------------------------------
export function openDB(opts = {}) {
  const idb = opts.indexedDB || getIndexedDB();
  if (!idb) return Promise.reject(new Error('IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = idb.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = (ev) => {
      try {
        migrate(req.result, ev.oldVersion);
      } catch (e) {
        // 迁移失败 -> abort
        try { req.transaction.abort(); } catch (_) { /* noop */ }
        reject(e);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('openDB failed'));
    req.onblocked = () => reject(new Error('openDB blocked（其他连接未关闭）'));
  });
}

// 迁移函数：v0 -> v1 创建全部 store；未来版本在此追加 if (oldVersion < N) 分支
export function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    for (const name of ALL_STORES) {
      if (!db.objectStoreNames.contains(name)) {
        if (name === STORE_SETTINGS || name === STORE_SYNC_META) {
          db.createObjectStore(name, { keyPath: 'key' });
        } else if (name === STORE_HISTORY || name === STORE_CHANGE_QUEUE) {
          db.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
        } else {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    }
  }
  // 未来版本示例：
  // if (oldVersion < 2) { ... }
}

// ----------------------------------------------------------------
// 原始 IDB 操作（Promise 封装）
// ----------------------------------------------------------------
function promisifyReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IDB request failed'));
  });
}

function runTx(db, store, mode, fn) {
  const tx = db.transaction(store, mode);
  let result;
  try {
    result = fn(tx.objectStore(store));
  } catch (e) {
    try { tx.abort(); } catch (_) { /* noop */ }
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IDB tx failed'));
    tx.onabort = () => reject(tx.error || new Error('IDB tx aborted'));
  });
}

export function idbGet(db, store, key) {
  return runTx(db, store, 'readonly', (os) => promisifyReq(os.get(key)));
}
export function idbGetAll(db, store) {
  return runTx(db, store, 'readonly', (os) => promisifyReq(os.getAll()));
}
export function idbPut(db, store, value) {
  return runTx(db, store, 'readwrite', (os) => os.put(value));
}
export function idbDelete(db, store, key) {
  return runTx(db, store, 'readwrite', (os) => os.delete(key));
}
export function idbClear(db, store) {
  return runTx(db, store, 'readwrite', (os) => os.clear());
}
export function idbCount(db, store) {
  return runTx(db, store, 'readonly', (os) => promisifyReq(os.count()));
}

// ----------------------------------------------------------------
// deviceId（跨设备 LWW tiebreak 用）
// ----------------------------------------------------------------
let _deviceId = null;

export function getDeviceId() {
  if (_deviceId) return _deviceId;
  let id = null;
  if (typeof localStorage !== 'undefined') {
    try { id = localStorage.getItem('kanseki_device_id'); } catch (_) { /* noop */ }
  }
  if (!id) {
    id = 'dev-' + (
      (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    );
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem('kanseki_device_id', id); } catch (_) { /* noop */ }
    }
  }
  _deviceId = id;
  return id;
}

// 测试用：重置缓存（fake-indexeddb 多实例场景）
export function resetDeviceId() { _deviceId = null; }

// ----------------------------------------------------------------
// localStorage 兼容桥
// ----------------------------------------------------------------
// 幂等导入：目标 store 已有数据则跳过（不覆盖）
export async function migrateFromLocalStorage(db, opts = {}) {
  const ls = opts.localStorage !== undefined
    ? opts.localStorage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return { imported: 0, skipped: 0 };
  const deviceId = opts.deviceId || getDeviceId();
  let imported = 0, skipped = 0;

  // theme -> settings.theme
  let themeVal = null;
  try { themeVal = ls.getItem('theme'); } catch (_) { /* noop */ }
  if (themeVal !== null && themeVal !== undefined) {
    const existing = await idbGet(db, STORE_SETTINGS, 'theme');
    if (existing) skipped++;
    else {
      await idbPut(db, STORE_SETTINGS, {
        key: 'theme', value: themeVal, updatedAt: Date.now(), deviceId
      });
      imported++;
    }
  }

  // kanseki_search_history -> search_history（数组逐条）
  let histRaw = null;
  try { histRaw = ls.getItem('kanseki_search_history'); } catch (_) { /* noop */ }
  let hist = null;
  try { hist = histRaw ? JSON.parse(histRaw) : null; } catch (_) { hist = null; }
  if (Array.isArray(hist) && hist.length) {
    const existing = await idbGetAll(db, STORE_HISTORY);
    if (existing.length) skipped += hist.length;
    else {
      for (const item of hist) {
        if (item && typeof item === 'object' && item.term) {
          await idbPut(db, STORE_HISTORY, {
            term: String(item.term), ts: item.ts || Date.now(), deviceId
          });
          imported++;
        } else if (typeof item === 'string' && item) {
          await idbPut(db, STORE_HISTORY, { term: item, ts: Date.now(), deviceId });
          imported++;
        }
      }
    }
  }

  // quickLinksCustom -> quick_links（数组 {name,url}）
  let qlRaw = null;
  try { qlRaw = ls.getItem('quickLinksCustom'); } catch (_) { /* noop */ }
  let ql = null;
  try { ql = qlRaw ? JSON.parse(qlRaw) : null; } catch (_) { ql = null; }
  if (Array.isArray(ql) && ql.length) {
    const existing = await idbGetAll(db, STORE_QUICK_LINKS);
    if (existing.length) skipped += ql.length;
    else {
      const base = Date.now();
      for (let i = 0; i < ql.length; i++) {
        const item = ql[i];
        if (!item || typeof item !== 'object') continue;
        if (!item.url && !item.name) continue;
        const now = base + i;
        await idbPut(db, STORE_QUICK_LINKS, {
          id: 'ql-ls-' + i + '-' + now.toString(36),
          name: item.name || '',
          url: item.url || '',
          createdAt: now, updatedAt: now, deletedAt: null,
          deviceId
        });
        imported++;
      }
    }
  }

  return { imported, skipped };
}

// 写回：theme -> localStorage（静态站兼容）；历史/快捷链接同步最新值
export async function writeBackToLocalStorage(db, opts = {}) {
  const ls = opts.localStorage !== undefined
    ? opts.localStorage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return;

  const theme = await idbGet(db, STORE_SETTINGS, 'theme');
  if (theme && theme.value !== undefined && theme.value !== null) {
    try { ls.setItem('theme', theme.value); } catch (_) { /* noop */ }
  }

  const hist = await idbGetAll(db, STORE_HISTORY);
  if (hist.length) {
    const latest = [...hist]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 100)
      .map(h => ({ term: h.term, ts: h.ts }));
    try { ls.setItem('kanseki_search_history', JSON.stringify(latest)); } catch (_) { /* noop */ }
  }

  const ql = await idbGetAll(db, STORE_QUICK_LINKS);
  const live = ql.filter(q => !q.deletedAt);
  if (live.length) {
    try {
      ls.setItem('quickLinksCustom', JSON.stringify(live.map(q => ({ name: q.name, url: q.url }))));
    } catch (_) { /* noop */ }
  }
}

// ----------------------------------------------------------------
// 高层存储类：sync-engine 与 UI 层消费的接口
// ----------------------------------------------------------------
export class KansekiStore {
  constructor(db, opts = {}) {
    this.db = db;
    this.deviceId = opts.deviceId || getDeviceId();
  }

  // ---- settings ----
  async getAllSettings() { return idbGetAll(this.db, STORE_SETTINGS); }
  async getSetting(key) { return idbGet(this.db, STORE_SETTINGS, key); }
  // 业务写入：刷新 updatedAt/deviceId + 标记 dirty
  async setSetting(key, value) {
    const now = Date.now();
    const rec = { key, value, updatedAt: now, deviceId: this.deviceId };
    await idbPut(this.db, STORE_SETTINGS, rec);
    await this.pushChange(STORE_SETTINGS, key);
    return rec;
  }
  // 同步写入：保留远端时间戳，不标记 dirty
  async setSettingValue(key, value, updatedAt, deviceId) {
    const rec = { key, value, updatedAt: updatedAt || Date.now(), deviceId: deviceId || this.deviceId };
    await idbPut(this.db, STORE_SETTINGS, rec);
    return rec;
  }

  // ---- search_history ----
  async getHistory() { return idbGetAll(this.db, STORE_HISTORY); }
  async appendHistory(term, ts) {
    const rec = { term: String(term), ts: ts || Date.now(), deviceId: this.deviceId };
    await idbPut(this.db, STORE_HISTORY, rec);
    await this.pushChange(STORE_HISTORY, String(term));
    return rec;
  }
  // 同步写入：保留远端 ts/deviceId，不标记 dirty（merge 落库用）
  async putHistoryValue({ term, ts, deviceId }) {
    const rec = { term: String(term), ts: ts || Date.now(), deviceId: deviceId || this.deviceId };
    await idbPut(this.db, STORE_HISTORY, rec);
    return rec;
  }
  async removeHistoryRecord(id) { await idbDelete(this.db, STORE_HISTORY, id); }
  async clearHistory() { await idbClear(this.db, STORE_HISTORY); }

  // ---- quick_links ----
  async getAllQuickLinks() { return idbGetAll(this.db, STORE_QUICK_LINKS); }
  async getQuickLink(id) { return idbGet(this.db, STORE_QUICK_LINKS, id); }
  async putQuickLink({ id, name, url }) {
    const now = Date.now();
    const rec = {
      id: id || 'ql-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      name: name || '', url: url || '',
      createdAt: now, updatedAt: now, deletedAt: null,
      deviceId: this.deviceId
    };
    await idbPut(this.db, STORE_QUICK_LINKS, rec);
    await this.pushChange(STORE_QUICK_LINKS, rec.id);
    return rec;
  }
  // 同步写入（保留远端元数据）
  async putQuickLinkValue(row) { await idbPut(this.db, STORE_QUICK_LINKS, row); }
  // 同步删除（物理删除，merge 落库用：合并结果即为权威）
  async removeQuickLinkValue(id) { await idbDelete(this.db, STORE_QUICK_LINKS, id); }
  async clearQuickLinks() { await idbClear(this.db, STORE_QUICK_LINKS); }
  // 软删除（墓碑）
  async removeQuickLink(id) {
    const existing = await idbGet(this.db, STORE_QUICK_LINKS, id);
    const now = Date.now();
    const tomb = Object.assign({}, existing, {
      deletedAt: now, updatedAt: now, deviceId: this.deviceId
    });
    await idbPut(this.db, STORE_QUICK_LINKS, tomb);
    await this.pushChange(STORE_QUICK_LINKS, id);
    return tomb;
  }

  // ---- sync_meta（不同步，仅本机）----
  async getMeta(key) { return idbGet(this.db, STORE_SYNC_META, key); }
  async setMeta(key, value) {
    await idbPut(this.db, STORE_SYNC_META, { key, value, updatedAt: Date.now() });
  }

  // ---- change_queue ----
  async getQueue() { return idbGetAll(this.db, STORE_CHANGE_QUEUE); }
  async pushChange(table, key) {
    await idbPut(this.db, STORE_CHANGE_QUEUE, { table, key, ts: Date.now() });
  }
  async clearQueue() { await idbClear(this.db, STORE_CHANGE_QUEUE); }

  // ---- catalog_records（预留，后期启用）----
  async getAllRecords() { return idbGetAll(this.db, STORE_RECORDS); }
  async getRecord(id) { return idbGet(this.db, STORE_RECORDS, id); }
  async putRecordValue(row) { await idbPut(this.db, STORE_RECORDS, row); }
  async removeRecord(id) { await idbDelete(this.db, STORE_RECORDS, id); }
  async clearRecords() { await idbClear(this.db, STORE_RECORDS); }

  // ---- 关闭 ----
  close() {
    try { this.db.close(); } catch (_) { /* noop */ }
  }
}

// 打开完整 store：openDB -> 迁移 -> localStorage 导入
export async function openStore(opts = {}) {
  const db = await openDB(opts);
  const store = new KansekiStore(db, { deviceId: opts.deviceId });
  if (opts.importLocalStorage !== false) {
    await migrateFromLocalStorage(db, {
      localStorage: opts.localStorage,
      deviceId: store.deviceId
    });
  }
  return store;
}
