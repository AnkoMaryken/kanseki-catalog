// ================================================
// core/sync/sync-engine.js — 同步引擎（离线优先 + LWW 冲突合并）
// ================================================
// 原则：IndexedDB 是唯一事实来源；写操作本地先行、UI 立即反映；同步异步后台进行。
// 个人单用户 -> LWW 策略：updatedAt 大者胜；平局 deviceId 字典序大者胜；删除=墓碑参与 LWW。
//
// mergeBundles(local, remote) -> { merged, hasConflict } 纯函数（可单测）：
//   settings        按 key LWW（凭据类 key webdav_* 排除，永不进 bundle）
//   search_history  append 拼接去重，按 ts 降序截断 100
//   quick_links     逐项 LWW + 墓碑（deletedAt 参与比较）
//   catalog_records 预留（同 quick_links 策略）
//
// 调度：写库 -> pushChange 标记 dirty -> 防抖 5s 推送；失败指数退避 1s->60s（5 次后
// 转「需手动同步」）；push 前 bundle 快照进 change_queue，成功后清空。
// ================================================

import { STORE_SETTINGS, STORE_HISTORY, STORE_QUICK_LINKS, STORE_RECORDS, CRED_PREFIX } from './store-indexeddb.js';

// 配置常量
export const SYNC_CONFIG = {
  debounceMs: 5000,        // 防抖窗口
  backoffBaseMs: 1000,     // 首次退避 1s
  backoffMaxMs: 60000,     // 退避封顶 60s
  backoffSteps: 5,         // 5 次失败后转「需手动同步」
  maxHistory: 100,         // 历史上限
  maxConflictRounds: 3,    // 412 重试循环上限
  syncFileName: 'sync.json'
};

// 冲突方向（日志/UI 用）
export const CONFLICT_NONE = 'none';
export const CONFLICT_LOCAL_WINS = 'local_wins';
export const CONFLICT_REMOTE_WINS = 'remote_wins';
export const CONFLICT_MERGED = 'merged';

// ----------------------------------------------------------------
// LWW 比较器：updatedAt 大者胜，平局 deviceId 字典序大者胜
// 返回 true 表示 a 胜出
// ----------------------------------------------------------------
export function lwwWinner(a, b) {
  const ta = a.updatedAt || 0, tb = b.updatedAt || 0;
  if (ta !== tb) return ta > tb;
  return String(a.deviceId || '') > String(b.deviceId || '');
}

// 墓碑感知：deletedAt 非空视为删除标记；删除也参与 LWW
export function isDeleted(row) { return !!(row && row.deletedAt); }

// ----------------------------------------------------------------
// 表级合并
// ----------------------------------------------------------------

// settings：按 key 合并，LWW；排除凭据 key
// 冲突判定：双方都有记录且内容不同、LWW 分不出（时间戳/设备平局）才算冲突；
// 一方胜出（版本更新）是正常收敛，不算冲突。
export function mergeSettings(localArr, remoteArr) {
  const map = new Map(); // key -> { row, source }
  const conflicts = [];
  for (const row of localArr) {
    if (!row || row.key === undefined) continue;
    if (String(row.key).startsWith(CRED_PREFIX)) continue;
    map.set(row.key, { row, source: 'local' });
  }
  for (const row of remoteArr) {
    if (!row || row.key === undefined) continue;
    if (String(row.key).startsWith(CRED_PREFIX)) continue;
    const key = row.key;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { row, source: 'remote' });
    } else if (lwwWinner(row, cur.row)) {
      // 远端新 -> 远端胜
      if (!sameSetting(cur.row, row)) conflicts.push(key);
      map.set(key, { row, source: 'remote' });
    } else if (lwwWinner(cur.row, row)) {
      // 本地新 -> 本地胜
      if (!sameSetting(cur.row, row)) conflicts.push(key);
    } else {
      // 完全平局 -> 内容相同则无冲突，否则算冲突（本地优先）
      if (!sameSetting(cur.row, row)) conflicts.push(key);
    }
  }
  return {
    rows: [...map.values()].map(v => v.row),
    conflicts
  };
}

// 内容相同判定：仅比较业务值（updatedAt/deviceId 不同是版本收敛，不算冲突）
function sameSetting(a, b) {
  return JSON.stringify(a.value) === JSON.stringify(b.value);
}

// search_history：append 拼接，按 term 去重（同词保留较新 ts），按 ts 降序截断 100
export function mergeHistory(localArr, remoteArr) {
  const map = new Map(); // term -> { ts, deviceId }
  for (const row of [...localArr, ...remoteArr]) {
    if (!row || row.term === undefined) continue;
    const term = String(row.term);
    const ts = row.ts || 0;
    const cur = map.get(term);
    if (!cur || ts > cur.ts) {
      map.set(term, { ts, deviceId: row.deviceId || '' });
    }
  }
  const rows = [...map.entries()].map(([term, v]) => ({ term, ts: v.ts, deviceId: v.deviceId }));
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { rows: rows.slice(0, SYNC_CONFIG.maxHistory), conflicts: [] };
}

// 通用 LWW + 墓碑合并（quick_links / catalog_records）
export function mergeLwwTable(localArr, remoteArr, idKey = 'id') {
  const map = new Map();
  const conflicts = [];
  for (const row of localArr) {
    if (!row || row[idKey] === undefined) continue;
    map.set(row[idKey], { row, source: 'local' });
  }
  for (const row of remoteArr) {
    if (!row || row[idKey] === undefined) continue;
    const key = row[idKey];
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { row, source: 'remote' });
    } else if (lwwWinner(row, cur.row)) {
      // 远端新 -> 远端胜（若内容不同则算冲突；否则是正常收敛）
      if (!sameRow(cur.row, row)) conflicts.push(key);
      map.set(key, { row, source: 'remote' });
    } else if (lwwWinner(cur.row, row)) {
      // 本地新 -> 本地胜
      if (!sameRow(cur.row, row)) conflicts.push(key);
    } else {
      // 完全平局
      if (!sameRow(cur.row, row)) conflicts.push(key);
    }
  }
  return { rows: [...map.values()].map(v => v.row), conflicts };
}

function sameRow(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 干净输出：剔除墓碑（业务层不显示 deletedAt 行）
export function stripDeleted(rows) {
  return rows.filter(r => !isDeleted(r));
}

// ----------------------------------------------------------------
// mergeBundles 主入口（纯函数）
// ----------------------------------------------------------------
export function mergeBundles(localBundle, remoteBundle) {
  const l = normalizeBundleShape(localBundle);
  const r = normalizeBundleShape(remoteBundle);

  const s = mergeSettings(l.settings, r.settings);
  const h = mergeHistory(l.search_history, r.search_history);
  const q = mergeLwwTable(l.quick_links, r.quick_links);
  const c = mergeLwwTable(l.catalog_records, r.catalog_records, 'id');

  const allConflicts = [...s.conflicts, ...q.conflicts, ...c.conflicts];
  const hasConflict = allConflicts.length > 0;

  return {
    merged: {
      settings: s.rows,
      search_history: h.rows,
      quick_links: q.rows,
      catalog_records: c.rows
    },
    conflicts: allConflicts,
    hasConflict
  };
}

export function normalizeBundleShape(b) {
  const src = (b && typeof b === 'object') ? b : {};
  return {
    settings: Array.isArray(src.settings) ? src.settings : [],
    search_history: Array.isArray(src.search_history) ? src.search_history : [],
    quick_links: Array.isArray(src.quick_links) ? src.quick_links : [],
    catalog_records: Array.isArray(src.catalog_records) ? src.catalog_records : []
  };
}

// 将合并结果落库（保留远端元数据）。返回 { inserted, updated, tombstones, conflicts }
export function buildApplyPlan(mergedBundle) {
  const plan = {
    settings: [],        // {key, value, updatedAt, deviceId}
    search_history: [],  // {term, ts, deviceId}
    quick_links: [],     // {id, name, url, createdAt, updatedAt, deletedAt, deviceId}
    catalog_records: []
  };
  for (const row of mergedBundle.settings) {
    if (!row || row.key === undefined) continue;
    plan.settings.push({
      key: row.key, value: row.value,
      updatedAt: row.updatedAt || 0, deviceId: row.deviceId || ''
    });
  }
  for (const row of mergedBundle.search_history) {
    plan.search_history.push({ term: String(row.term), ts: row.ts || 0, deviceId: row.deviceId || '' });
  }
  for (const row of mergedBundle.quick_links) {
    plan.quick_links.push({
      id: row.id, name: row.name || '', url: row.url || '',
      createdAt: row.createdAt || 0, updatedAt: row.updatedAt || 0,
      deletedAt: row.deletedAt || null, deviceId: row.deviceId || ''
    });
  }
  for (const row of mergedBundle.catalog_records) {
    plan.catalog_records.push(Object.assign({}, row));
  }
  return plan;
}

// ----------------------------------------------------------------
// 同步引擎类：debounce + backoff + dirty + queue 快照
// ----------------------------------------------------------------
export class SyncEngine {
  constructor({ store, provider, onChange = null, onError = null, now = () => Date.now() }) {
    if (!store || !provider) throw new Error('SyncEngine 需要 store 与 provider');
    this.store = store;
    this.provider = provider;
    this.onChange = onChange || null;
    this.onError = onError || null;
    this.now = now;

    this.state = {
      status: 'idle',       // idle|syncing|success|error|manual
      lastSyncAt: 0,        // 上次成功同步时间
      lastError: null,      // { ts, message }
      pendingCount: 0,      // 待同步变更数（change_queue 长度）
      conflicts: [],        // 最近一次同步的冲突 key 列表
      revision: ''          // 当前已知远端 revision
    };

    this._debounceTimer = null;
    this._backoffTimer = null;
    this._backoffCount = 0;
    this._syncInFlight = null;   // 进行中的 sync 承诺
    this._manualRequested = false;
    this._started = false;
  }

  getStatus() { return Object.assign({}, this.state); }

  _emit() { if (this.onChange) this.onChange(this.getStatus()); }

  _setError(message) {
    this.state.lastError = { ts: this.now(), message };
    if (this.onError) this.onError(this.state.lastError);
  }

  // ---- 启动/停止 ----
  start() {
    if (this._started) return;
    this._started = true;
    this._refreshPending().then(() => {
      // 启动即尝试一次同步（若配置了凭据且非手动状态）
      this.sync('auto').catch(() => { /* 错误已记录 */ });
    });
  }

  stop() {
    this._started = false;
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
    if (this._backoffTimer) { clearTimeout(this._backoffTimer); this._backoffTimer = null; }
  }

  // ---- 数据变更入口（由 store 层/UI 层调用）----
  markDirty() {
    if (!this._started) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._refreshPending().then(() => this.sync('auto')).catch(() => { /* noop */ });
    }, SYNC_CONFIG.debounceMs);
  }

  // 强制手动同步（用户点击「立即同步」）
  async sync(mode = 'manual') {
    if (mode === 'manual') this._manualRequested = true;
    if (this._syncInFlight) return this._syncInFlight;
    this._syncInFlight = this._runSync();
    try {
      return await this._syncInFlight;
    } finally {
      this._syncInFlight = null;
    }
  }

  async _runSync() {
    this.state.status = 'syncing';
    this._emit();

    try {
      const creds = await this._loadCredentials();
      if (!creds.username || !creds.password) {
        this.state.status = 'manual';
        this.state.lastError = { ts: this.now(), message: '未配置同步凭据' };
        this._emit();
        return { ok: false, reason: 'no-credentials' };
      }
      this.provider.setCredentials(creds.username, creds.password);

      // 1) 快照本地 bundle + 队列（push 前快照）
      const localBundle = await this._snapshotBundle();
      const queue = await this.store.getQueue();

      // 2) pull 远端
      const remote = await this.provider.pull();

      // 3) merge（远端 vs 本地）
      const result = mergeBundles(localBundle, remote.bundle);
      const changed = JSON.stringify(localBundle) !== JSON.stringify(result.merged);

      // 4) 若本地有变化 -> 应用合并结果落库（保留远端元数据）
      if (changed) {
        await this._applyMerged(result.merged);
        // 应用后重新快照（merged 可能来自远端，需重新序列化推送）
        this.state.conflicts = result.conflicts;
      } else {
        this.state.conflicts = [];
      }

      // 5) 推送（条件写 + 412 重试循环 ≤3 轮）
      const finalBundle = await this._snapshotBundle();
      const pushResult = await this._pushWithRetry(finalBundle, remote.revision);

      // 6) 成功 -> 记录 revision + 清队列
      await this.store.setMeta('revision', pushResult.revision);
      await this.store.setMeta('last_sync_at', this.now());
      await this.store.clearQueue();

      this._backoffCount = 0;
      this.state.status = 'success';
      this.state.lastSyncAt = this.now();
      this.state.revision = pushResult.revision;
      this._emit();
      return { ok: true, hasConflict: result.hasConflict, conflicts: result.conflicts };
    } catch (e) {
      this._backoffCount++;
      this._setError(e.message || String(e));
      if (this._backoffCount >= SYNC_CONFIG.backoffSteps) {
        this.state.status = 'manual'; // 需手动同步
      } else {
        this.state.status = 'error';
        this._scheduleBackoff();
      }
      this._emit();
      return { ok: false, reason: e.name || 'error', message: e.message || String(e) };
    }
  }

  async _pushWithRetry(bundle, expectedRevision) {
    let rev = expectedRevision;
    let attempt = 0;
    while (true) {
      try {
        const r = await this.provider.push(bundle, rev);
        return r;
      } catch (e) {
        if (e && e.name === 'ConflictError') {
          attempt++;
          if (attempt >= SYNC_CONFIG.maxConflictRounds) {
            throw new Error('同步冲突重试超过 ' + SYNC_CONFIG.maxConflictRounds + ' 轮');
          }
          // 重拉远端 -> 再 merge -> 更新本地 -> 继续推
          const remote = await this.provider.pull();
          rev = remote.revision;
          const localBundle = await this._snapshotBundle();
          const result = mergeBundles(localBundle, remote.bundle);
          if (JSON.stringify(localBundle) !== JSON.stringify(result.merged)) {
            await this._applyMerged(result.merged);
          }
          bundle = await this._snapshotBundle();
          this.state.conflicts = result.conflicts;
          this._emit();
        } else {
          throw e;
        }
      }
    }
  }

  _scheduleBackoff() {
    if (this._backoffTimer) clearTimeout(this._backoffTimer);
    const delay = Math.min(
      SYNC_CONFIG.backoffBaseMs * Math.pow(2, this._backoffCount - 1),
      SYNC_CONFIG.backoffMaxMs
    );
    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      if (this._started) this.sync('auto').catch(() => { /* noop */ });
    }, delay);
  }

  // ---- 本地 bundle 快照 ----
  async _snapshotBundle() {
    const [settings, history, links, records] = await Promise.all([
      this.store.getAllSettings(),
      this.store.getHistory(),
      this.store.getAllQuickLinks(),
      this.store.getAllRecords()
    ]);
    return {
      settings: settings.map(s => ({ key: s.key, value: s.value, updatedAt: s.updatedAt, deviceId: s.deviceId })),
      search_history: history.map(h => ({ term: h.term, ts: h.ts, deviceId: h.deviceId })),
      quick_links: links.map(l => ({ id: l.id, name: l.name, url: l.url, createdAt: l.createdAt, updatedAt: l.updatedAt, deletedAt: l.deletedAt, deviceId: l.deviceId })),
      catalog_records: records
    };
  }

  async _loadCredentials() {
    const u = await this.store.getMeta('webdav_username');
    const p = await this.store.getMeta('webdav_password');
    return {
      username: u && u.value ? String(u.value) : '',
      password: p && p.value ? String(p.value) : ''
    };
  }

  // 应用合并结果：写库（同步写入，不触发 markDirty；保留远端元数据）
  async _applyMerged(merged) {
    const plan = buildApplyPlan(merged);
    for (const row of plan.settings) {
      await this.store.setSettingValue(row.key, row.value, row.updatedAt, row.deviceId);
    }
    // 历史：先清再写（合并结果已是最终形态，含去重/截断）
    await this.store.clearHistory();
    for (const row of plan.search_history) {
      await this.store.putHistoryValue(row);
    }
    // 快捷链接：合并结果即权威——先清后写（含墓碑，业务层自行过滤 deletedAt）
    await this.store.clearQuickLinks();
    for (const row of plan.quick_links) {
      await this.store.putQuickLinkValue(row);
    }
    // 编目记录（预留）：同策略
    await this.store.clearRecords();
    for (const row of plan.catalog_records) {
      await this.store.putRecordValue(row);
    }
  }

  // 刷新 pendingCount
  async _refreshPending() {
    try {
      const q = await this.store.getQueue();
      this.state.pendingCount = q.length;
      this._emit();
    } catch (_) { /* noop */ }
  }
}
