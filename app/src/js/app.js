// ================================================
// js/app.js — SPA 外壳逻辑（hash 路由 + 视图切换）
// ================================================
// 视图：
//   #/query   纪年查询（iframe 承载 pages/index.html）
//   #/records 编目记录（占位）
//   #/sync    同步设置（坚果云 WebDAV）
//   #/about   关于
//
// 依赖 Phase 1 core 模块：store-indexeddb / sync-engine / provider-webdav
// 在 Tauri 环境用 Rust 桥 transport（无 CORS）；浏览器调试用 fetch 兜底。
// ================================================
import { openStore } from './core/sync/store-indexeddb.js';
import { SyncEngine } from './core/sync/sync-engine.js';
import { WebDavProvider } from './core/sync/provider-webdav.js';
import { initRecordsView } from './ui/records.js';

// ---------- 工具 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showToast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2600);
}
// 供子模块复用（ui/records.js）
window.__kansekiToast = showToast;

// 检测 Tauri 环境
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Tauri v2 无构建工具方式调用 Rust command（官方支持，无需 @tauri-apps/api 包）
async function tauriInvoke(cmd, args) {
  if (isTauri) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  throw new Error('非 Tauri 环境');
}

// 创建 WebDAV transport：Tauri 环境走 Rust 桥，否则 fetch
function createProviderTransport() {
  if (isTauri) {
    // Tauri 桥（对应 src/http.rs 的 webdav_request command）
    return {
      async request(method, url, { headers = {}, body = null, auth = null } = {}) {
        const resp = await tauriInvoke('webdav_request', {
          req: {
            method, url, headers,
            body: body === null ? null : String(body),
            username: auth ? auth.username : null,
            password: auth ? auth.password : null
          }
        });
        return {
          status: resp.status,
          headers: resp.headers || {},
          bodyText: resp.body_text || ''
        };
      }
    };
  }
  // 浏览器调试：fetch（同源页面可测；坚果云 CORS 在浏览器受限，仅用于本地联调）
  return {
    async request(method, url, { headers = {}, body = null, auth = null } = {}) {
      const h = Object.assign({}, headers);
      if (auth && auth.username && auth.password) {
        h['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(auth.username + ':' + auth.password)));
      }
      const resp = await fetch(url, {
        method,
        headers: h,
        body: body === null ? undefined : String(body),
        cache: 'no-store'
      });
      const text = await resp.text();
      return {
        status: resp.status,
        headers: { etag: resp.headers.get('etag') || null },
        bodyText: text
      };
    }
  };
}

// ---------- 全局状态 ----------
let store = null;
let engine = null;
let provider = null;

// ---------- 视图切换 ----------
const VIEWS = ['query', 'records', 'sync', 'about'];

function navigate() {
  const hash = location.hash || '#/query';
  const view = hash.replace('#/', '').split('?')[0] || 'query';
  const target = VIEWS.includes(view) ? view : 'query';

  VIEWS.forEach(v => {
    const sec = $('#view-' + v);
    if (sec) sec.classList.toggle('active', v === target);
  });
  $$('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === target);
  });

  // 视图进入钩子
  if (target === 'sync') initSyncView();
}

window.addEventListener('hashchange', navigate);

async function init() {
  // 绑定导航（点击也更新 hash）
  $$('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = el.getAttribute('href');
    });
  });

  // 关于页按钮
  $('#openGuideBtn')?.addEventListener('click', () => {
    // 在新 iframe 打开使用介绍（复用查询 iframe 的容器思路：直接整页打开）
    window.open('pages/guide.html', '_blank');
  });
  $('#openChangelogBtn')?.addEventListener('click', () => {
    window.open('pages/changelog.html', '_blank');
  });

  // 编目占位视图初始化（表单弹层 + 校验）
  initRecordsView();

  // 同步视图
  $('#syncTestBtn')?.addEventListener('click', testConnection);
  $('#syncSaveBtn')?.addEventListener('click', saveCredentials);
  $('#syncNowBtn')?.addEventListener('click', () => engine && engine.sync('manual'));

  // 初始化存储与同步引擎
  try {
    store = await openStore({});
    provider = new WebDavProvider({ transport: createProviderTransport() });

    // 载入已保存凭据
    const savedUser = await store.getMeta('webdav_username');
    const savedPass = await store.getMeta('webdav_password');
    if (savedUser) $('#syncUser').value = savedUser.value || '';
    if (savedPass) $('#syncPass').value = savedPass.value || '';

    engine = new SyncEngine({
      store,
      provider,
      onChange: (status) => updateSyncStatus(status),
      onError: (err) => { if (err && err.message) showToast('同步错误：' + err.message, 'err'); }
    });
    engine.start();
    updateSyncStatus(engine.getStatus());
  } catch (e) {
    console.error('存储初始化失败', e);
    showToast('存储初始化失败：' + (e && e.message), 'err');
  }

  navigate();
}

// ---------- 同步视图 ----------
async function testConnection() {
  const user = $('#syncUser').value.trim();
  const pass = $('#syncPass').value;
  if (!user || !pass) {
    showToast('请先填写邮箱与应用密码', 'err');
    return;
  }
  const statusEl = $('#syncStatus');
  statusEl.hidden = false;
  statusEl.className = 'sync-status';
  statusEl.textContent = '连接测试中…';

  provider.setCredentials(user, pass);
  if (isTauri) {
    try {
      const r = await tauriInvoke('webdav_check', {
        url: 'https://dav.jianguoyun.com/dav/kanseki-sync',
        username: user,
        password: pass
      });
      statusEl.className = 'sync-status ' + (r.ok ? 'ok' : 'err');
      statusEl.textContent = r.ok ? '✓ 连接正常' : '✗ ' + r.message;
    } catch (e) {
      statusEl.className = 'sync-status err';
      statusEl.textContent = '✗ 连接失败：' + (e && e.message);
    }
  } else {
    const r = await provider.check();
    statusEl.className = 'sync-status ' + (r.ok ? 'ok' : 'err');
    statusEl.textContent = r.ok ? '✓ 连接正常' : '✗ ' + r.message;
  }
}

async function saveCredentials() {
  const user = $('#syncUser').value.trim();
  const pass = $('#syncPass').value;
  if (!user || !pass) {
    showToast('请先填写邮箱与应用密码', 'err');
    return;
  }
  await store.setMeta('webdav_username', user);
  await store.setMeta('webdav_password', pass);
  provider.setCredentials(user, pass);
  showToast('凭据已保存（仅存本机）', 'ok');
  updateSyncStatus(engine.getStatus());
}

function updateSyncStatus(status) {
  if (!status) return;
  const dot = $('#syncStatusDot');
  const text = $('#syncStatusText');

  // 侧边栏状态
  if (status.status === 'success') {
    dot.className = 'status-dot ok';
    text.textContent = '已同步';
  } else if (status.status === 'syncing') {
    dot.className = 'status-dot sync';
    text.textContent = '同步中…';
  } else if (status.status === 'error') {
    dot.className = 'status-dot err';
    text.textContent = '同步失败';
  } else if (status.status === 'manual') {
    dot.className = 'status-dot err';
    text.textContent = '需手动同步';
  } else {
    dot.className = 'status-dot';
    text.textContent = '未同步';
  }

  // 同步视图详情
  const stateEl = $('#syncState');
  const lastEl = $('#syncLastTime');
  const pendingEl = $('#syncPending');
  if (stateEl) {
    stateEl.textContent = {
      idle: '未配置', syncing: '同步中…', success: '已同步', error: '同步失败', manual: '需手动同步'
    }[status.status] || '未配置';
  }
  if (lastEl) {
    lastEl.textContent = status.lastSyncAt
      ? new Date(status.lastSyncAt).toLocaleString('zh-CN')
      : '—';
  }
  if (pendingEl) pendingEl.textContent = String(status.pendingCount ?? 0);

  // 日志
  const log = $('#syncLog');
  if (log) {
    const items = [];
    if (status.lastError) {
      items.push({ text: new Date(status.lastError.ts).toLocaleTimeString('zh-CN') + ' 错误：' + status.lastError.message, cls: 'err' });
    }
    if (status.conflicts && status.conflicts.length) {
      items.push({ text: '检测到冲突：' + status.conflicts.slice(0, 5).join('、'), cls: 'err' });
    }
    if (status.lastSyncAt) {
      items.push({ text: new Date(status.lastSyncAt).toLocaleTimeString('zh-CN') + ' 同步成功', cls: 'ok' });
    }
    if (!items.length) items.push({ text: '暂无同步记录', cls: '' });
    log.innerHTML = items.slice(0, 5).map(i =>
      `<li class="${i.cls}">${i.text}</li>`).join('');
  }
}

function initSyncView() {
  if (engine) updateSyncStatus(engine.getStatus());
}

// ---------- 启动 ----------
window.addEventListener('DOMContentLoaded', init);
