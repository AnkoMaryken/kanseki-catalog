// ================================================
// core/sync/provider-webdav.js — WebDAV 同步传输层（坚果云，零成本）
// ================================================
// SyncProvider 接口（可插拔，见 sync-engine.js）：
//   pull() -> { revision, bundle }          GET，ETag 即 revision（0 值 404 = 首次同步）
//   push(bundle, expectedRevision) -> { revision }   PUT + If-Match 条件写，412 抛 ConflictError
//   check() -> { ok, message }              PROPFIND 健康检查
//
// transport 注入点（规避 CORS 三实现）：
//   fetch     — 浏览器直连（仅同源/已放开 CORS 环境）
//   tauri     — Tauri Rust reqwest command 桥（Windows 桌面，无 CORS）
//   capacitor — @capacitor/http 原生请求（后期 Android/iOS）
// 默认 fetch transport 形如 { request(method, url, headers, body) -> { status, headers, bodyText } }
//
// 安全：HTTP Basic（邮箱 + 应用密码）。凭据只存本机 IndexedDB（sync_meta 的
// webdav_* key，CRED_PREFIX），绝不进入同步 bundle（merge 时排除）。
// ================================================

import { CRED_PREFIX } from './store-indexeddb.js';

// WebDAV 端点常量
export const DEFAULT_WEBDAV_BASE = 'https://dav.jianguoyun.com/dav/kanseki-sync';
export const DEFAULT_SYNC_PATH = 'sync.json';

export class ConflictError extends Error {
  constructor(message, remoteRevision) {
    super(message || '同步冲突（远端已更新）');
    this.name = 'ConflictError';
    this.remoteRevision = remoteRevision || null;
  }
}

export class ProviderError extends Error {
  constructor(message, status, statusText) {
    super(message || 'WebDAV 请求失败');
    this.name = 'ProviderError';
    this.status = status || 0;
    this.statusText = statusText || '';
  }
}

// ----------------------------------------------------------------
// 默认 fetch transport（Node 18+ / 浏览器 fetch）
// 返回 { status, headers: {etag?}, bodyText, ok }
// ----------------------------------------------------------------
export function createFetchTransport(fetchFn) {
  const f = fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!f) throw new Error('fetch transport 不可用：需注入 fetchFn 或运行环境提供 fetch');
  return {
    async request(method, url, { headers = {}, body = null } = {}) {
      const resp = await f(url, {
        method,
        headers,
        body: body === null ? undefined : body,
        // 避免浏览器缓存旧 bundle
        cache: 'no-store'
      });
      const bodyText = await resp.text();
      return {
        status: resp.status,
        headers: { etag: resp.headers.get('etag') || null },
        bodyText
      };
    }
  };
}

// ----------------------------------------------------------------
// 浏览器 fetch transport（HTTP Basic 头注入）
// ----------------------------------------------------------------
export function createBrowserFetchTransport(fetchFn) {
  const base = createFetchTransport(fetchFn);
  return {
    async request(method, url, opts = {}) {
      const { auth, ...rest } = opts;
      const headers = Object.assign({}, rest.headers || {});
      if (auth) {
        const b64 = typeof btoa !== 'undefined'
          ? btoa(unescape(encodeURIComponent(auth.username + ':' + auth.password)))
          : Buffer.from(auth.username + ':' + auth.password, 'utf8').toString('base64');
        headers['Authorization'] = 'Basic ' + b64;
      }
      return base.request(method, url, Object.assign({}, rest, { headers }));
    }
  };
}

// ----------------------------------------------------------------
// WebDAV Provider
// ----------------------------------------------------------------
export class WebDavProvider {
  constructor(opts = {}) {
    // 可注入 transport / fetch / tauri / capacitor
    if (opts.transport) {
      this.transport = opts.transport;
    } else if (opts.fetch) {
      this.transport = createBrowserFetchTransport(opts.fetch);
    } else if (opts.tauri) {
      // Tauri 桥约定：invoke('webdav_request', {method, url, headers, body})
      // 返回 { status, headers: {etag}, bodyText }
      this.transport = {
        async request(method, url, { headers = {}, body = null } = {}) {
          return opts.tauri(method, url, { headers, body });
        }
      };
    } else if (opts.capacitor) {
      // @capacitor/http 约定：Http.request({method, url, headers, data, responseType:'text'})
      this.transport = {
        async request(method, url, { headers = {}, body = null } = {}) {
          const resp = await opts.capacitor.request({
            method, url, headers,
            data: body,
            responseType: 'text'
          });
          return {
            status: resp.status,
            headers: { etag: (resp.headers && (resp.headers.etag || resp.headers.ETag)) || null },
            bodyText: typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || '')
          };
        }
      };
    } else {
      this.transport = createBrowserFetchTransport();
    }

    this.baseUrl = (opts.baseUrl || DEFAULT_WEBDAV_BASE).replace(/\/+$/, '');
    this.syncPath = opts.syncPath || DEFAULT_SYNC_PATH;
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.timeoutMs = opts.timeoutMs || 30000;
  }

  setCredentials(username, password) {
    this.username = username || '';
    this.password = password || '';
  }

  get url() { return this.baseUrl + '/' + this.syncPath; }

  _auth() { return { username: this.username, password: this.password }; }

  // 包一层超时（transport 不负责超时；AbortSignal 由具体实现决定）
  async _request(method, url, opts) {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new ProviderError('请求超时', 0, 'timeout')), this.timeoutMs);
    });
    const req = this.transport.request(method, url, Object.assign({}, opts, { auth: this._auth() }));
    return Promise.race([req, timeout]);
  }

  // ---- SyncProvider 接口 ----
  // pull(): GET sync.json，0 值 404 视为首次同步（revision ''）
  async pull() {
    const resp = await this._request('GET', this.url, { headers: {} });
    if (resp.status === 404) {
      return { revision: '', bundle: { settings: [], search_history: [], quick_links: [] } };
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new ProviderError('认证失败：请检查邮箱与应用密码', resp.status, resp.statusText);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new ProviderError('下载同步数据失败', resp.status, resp.statusText);
    }
    let bundle = null;
    try {
      bundle = JSON.parse(resp.bodyText || '{}');
    } catch (e) {
      throw new ProviderError('同步数据解析失败（JSON 损坏）', resp.status);
    }
    return {
      revision: resp.headers.etag || '',
      bundle: normalizeBundle(bundle)
    };
  }

  // push(bundle, expectedRevision): PUT + If-Match 条件写
  //  expectedRevision 为 '' 表示首次同步（无远端文件）——用 If-None-Match: *
  //  412 -> ConflictError（调用方重拉远端再 merge）
  async push(bundle, expectedRevision) {
    const headers = { 'Content-Type': 'application/json' };
    if (expectedRevision) {
      headers['If-Match'] = expectedRevision;
    } else {
      headers['If-None-Match'] = '*';
    }
    const resp = await this._request('PUT', this.url, {
      headers,
      body: JSON.stringify(normalizeBundle(bundle))
    });
    if (resp.status === 412) {
      throw new ConflictError('远端已更新，需重拉合并', resp.headers.etag || '');
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new ProviderError('认证失败：请检查邮箱与应用密码', resp.status, resp.statusText);
    }
    if (resp.status === 404) {
      throw new ProviderError('同步目录不存在：请在坚果云网盘中创建 kanseki-sync 文件夹', resp.status);
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new ProviderError('上传同步数据失败', resp.status, resp.statusText);
    }
    return { revision: resp.headers.etag || String(Date.now()) };
  }

  // check(): PROPFIND 健康检查（无 body，Depth: 0）
  async check() {
    try {
      const resp = await this._request('PROPFIND', this.baseUrl, {
        headers: { Depth: '0', 'Content-Type': 'application/xml' }
      });
      if (resp.status === 207 || (resp.status >= 200 && resp.status < 300)) {
        return { ok: true, message: '连接正常' };
      }
      if (resp.status === 401 || resp.status === 403) {
        return { ok: false, message: '认证失败：请检查邮箱与应用密码' };
      }
      return { ok: false, message: 'HTTP ' + resp.status + ' ' + (resp.statusText || '') };
    } catch (e) {
      return { ok: false, message: e.message || '网络错误' };
    }
  }
}

// ----------------------------------------------------------------
// bundle 规范化：确保结构完整（增量同步与旧版本容错）
// ----------------------------------------------------------------
export function normalizeBundle(b) {
  const src = (b && typeof b === 'object') ? b : {};
  return {
    settings: Array.isArray(src.settings) ? src.settings : [],
    search_history: Array.isArray(src.search_history) ? src.search_history : [],
    quick_links: Array.isArray(src.quick_links) ? src.quick_links : [],
    // 预留：catalog_records 后期接入
    catalog_records: Array.isArray(src.catalog_records) ? src.catalog_records : []
  };
}

export { CRED_PREFIX };
