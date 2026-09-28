// ================================================
// js/app.js — SPA 外壳逻辑（hash 路由 + 视图切换）
// ================================================
// 视图（V0.6：把静态站顶部导航全部并入左侧栏）：
//   #/query       纪年查询（iframe pages/index.html）
//   #/jump        快速跳转（iframe pages/embed.html）
//   #/catalog     编目规范（iframe pages/catalog.html，tab 由 ?tab=N 指定）
//   #/guide       使用介绍（iframe pages/guide.html）
//   #/changelog   更新日志（iframe pages/changelog.html）
//   #/records     编目记录（占位，待上线）
//   #/sync        同步设置（坚果云 WebDAV）
//   #/about       关于
//
// iframe 内页面由构建脚本注入嵌入样式（build.mjs），隐藏其自带 header 与
// 编目规范侧栏；编目规范的整体侧栏改由本文件从 iframe 内「镜像」到 APP 侧栏。
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
// 8 个视图；iframe 视图按需懒加载（data-src -> src）
const VIEWS = ['query', 'jump', 'catalog', 'guide', 'changelog', 'records', 'sync', 'about'];

// 视图 -> iframe id（懒加载用）
const FRAMES = {
  query: 'queryFrame',
  jump: 'jumpFrame',
  catalog: 'catalogFrame',
  guide: 'guideFrame',
  changelog: 'changelogFrame',
};

// 懒加载：首次进入某视图时才真正请求 iframe（pages/*.html 体积较大）
function ensureFrame(view) {
  const id = FRAMES[view];
  if (!id) return null;
  const el = document.getElementById(id);
  if (!el) return null;
  if (!el.getAttribute('src') && el.dataset.src) {
    el.setAttribute('src', el.dataset.src);
  }
  return el;
}

// 解析 hash：'#/catalog?tab=1' -> { view:'catalog', tab:'1' }
function parseHash() {
  const raw = (location.hash || '#/query').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const view = (path || 'query').trim() || 'query';
  const params = new URLSearchParams(query);
  return {
    view: VIEWS.includes(view) ? view : 'query',
    tab: params.get('tab'),
  };
}

let currentView = 'query';

function navigate() {
  const { view: target, tab } = parseHash();

  VIEWS.forEach(v => {
    const sec = $('#view-' + v);
    if (sec) sec.classList.toggle('active', v === target);
  });
  // 顶层视图项高亮（编目规范三项共享 data-view="catalog"）
  $$('.nav-item').forEach(el => {
    if (el.dataset.view === 'catalog' && el.dataset.tab) {
      // 子项高亮以 iframe 内实际 tab 为准，由 syncCatalogSidebar() 处理
      if (target !== 'catalog') el.classList.remove('active');
      return;
    }
    el.classList.toggle('active', el.dataset.view === target);
  });

  currentView = target;

  // 懒加载 iframe
  const frame = ensureFrame(target);

  // 视图进入钩子
  if (target === 'sync') initSyncView();
  if (target === 'catalog') {
    // 等 iframe 就绪后再镜像侧栏；已就绪则直接同步
    whenFrameReady(frame, () => {
      if (tab !== null) activateCatalogTab(frame, parseInt(tab, 10));
      syncCatalogSidebar(frame);
    });
    document.getElementById('sideAnchors')?.removeAttribute('hidden');
  } else {
    hideCatalogAnchors();
  }
  if (frame && target !== 'catalog' && target !== 'query') {
    // 让注入的主题与 APP 保持一致
    applyThemeToFrame(frame);
  }
}

window.addEventListener('hashchange', navigate);

// ---------- iframe 工具 ----------
// 同源 iframe 可直读 contentDocument；失败时静默降级（不阻断导航）
function frameDoc(frame) {
  if (!frame) return null;
  try { return frame.contentDocument || null; } catch (_) { return null; }
}

// iframe 就绪后执行（已就绪则立即执行）
// 注意：未加载的 iframe 其 about:blank 文档 readyState 也是 'complete'，
// 故须同时要求 body 有子元素，否则会在真正 load 之前就误触发回调。
function whenFrameReady(frame, fn) {
  if (!frame) return;
  const doc = frameDoc(frame);
  const ready = !!(doc && doc.readyState === 'complete' && doc.body &&
    doc.body.childElementCount > 0 &&
    !/^about:blank/.test(doc.location ? doc.location.href : ''));
  if (ready) { fn(); return; }
  frame.addEventListener('load', () => fn(), { once: true });
}

// ---------- 编目规范侧栏合并 ----------
// 思路：iframe 内 catalog.html 保留渲染逻辑，本文件把它的
// 「内容导览」tab 态与 #sideAnchors（章节/分类/手册）镜像到 APP 左侧栏；
// APP 侧栏点击 -> 转发点击 iframe 内同名元素，形成单一数据源。
let anchorObserver = null;
let anchorObservedSrc = null;

// 切换 iframe 内编目规范 tab（0 细则查阅 / 1 分类表查询 / 2 工作手册）
function activateCatalogTab(frame, idx) {
  if (!Number.isFinite(idx)) return;
  const doc = frameDoc(frame);
  if (!doc) return;
  const btn = doc.querySelector('.tab-btn[data-tab="' + idx + '"]');
  if (btn && !btn.classList.contains('active')) btn.click();
}

// 结构签名：判断镜像是否需要整体重建（含标签文字，切换 tab 时会变）
function anchorSignature(root) {
  if (!root) return '';
  const items = Array.from(root.querySelectorAll('.anchor-item,.cfb-side'))
    .map(el => el.dataset.sid || el.dataset.f || el.textContent || '').join('|');
  const label = (root.querySelector('.side-label') || {}).textContent || '';
  const hasCard = root.querySelector('.side-card') ? '1' : '0';
  return items + '#' + label + '#' + hasCard;
}

// 只同步 active 态（避免滚动高亮时重建 DOM）
function syncAnchorActive(dst, src) {
  const s = src.querySelectorAll('.anchor-item,.cfb-side');
  const d = dst.querySelectorAll('.anchor-item,.cfb-side');
  if (s.length !== d.length) return false;
  d.forEach((el, i) => el.classList.toggle('active', s[i].classList.contains('active')));
  return true;
}

// APP 侧栏锚点点击 -> 转发到 iframe 内对应元素（按序号对应，结构一致）
function bindAnchorForward(dst, frame) {
  if (dst.dataset.boundForward) return;
  dst.dataset.boundForward = '1';
  dst.addEventListener('click', (e) => {
    const btn = e.target.closest('.anchor-item,.cfb-side');
    if (!btn) return;
    const doc = frameDoc(frame);
    if (!doc) return;
    const src = doc.getElementById('sideAnchors');
    if (!src) return;
    const targets = Array.from(src.querySelectorAll('.anchor-item,.cfb-side'));
    const idx = Array.from(dst.querySelectorAll('.anchor-item,.cfb-side')).indexOf(btn);
    if (idx >= 0 && targets[idx]) targets[idx].click();
  });
}

function observeAnchorSource(src, frame) {
  if (anchorObservedSrc === src) return;
  if (anchorObserver) anchorObserver.disconnect();
  anchorObserver = new MutationObserver(() => syncCatalogSidebar(frame));
  anchorObserver.observe(src, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['class'],
  });
  anchorObservedSrc = src;
}

function hideCatalogAnchors() {
  const box = document.getElementById('sideAnchors');
  if (box) box.setAttribute('hidden', '');
}

function syncCatalogSidebar(frame) {
  const doc = frameDoc(frame);
  const box = document.getElementById('sideAnchors');
  if (!doc || !box) return;
  const src = doc.getElementById('sideAnchors');
  if (!src) return;

  const sig = anchorSignature(src);
  if (box.dataset.sig !== sig) {
    box.innerHTML = src.innerHTML;
    box.dataset.sig = sig;
    box.removeAttribute('data-bound-forward');
    bindAnchorForward(box, frame);
  } else {
    syncAnchorActive(box, src);
  }
  // 内容为空（如分类表无导航）时收起整块卡片
  box.toggleAttribute('hidden', !sig || !src.innerHTML.trim());

  // 「内容导览」三项 tab 高亮（APP 侧栏对应项）
  const activeTab = doc.querySelector('.tab-btn.active');
  const idx = activeTab ? activeTab.dataset.tab : '0';
  $$('.nav-item[data-tab]').forEach(el => {
    el.classList.toggle('active', currentView === 'catalog' && el.dataset.tab === idx);
  });

  observeAnchorSource(src, frame);
}

// ---------- 主题（APP 与各 iframe 同步，共用 localStorage 'theme'） ----------
function currentTheme() {
  return localStorage.getItem('theme') || 'light';
}

function applyThemeToFrame(frame) {
  const doc = frameDoc(frame);
  if (doc && doc.documentElement) {
    doc.documentElement.setAttribute('data-theme', currentTheme());
  }
}

function applyThemeToAll() {
  Object.values(FRAMES).forEach(id => applyThemeToFrame(document.getElementById(id)));
}

function toggleAppTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyThemeToAll();
  showToast(next === 'dark' ? '已切换到暗色模式' : '已切换到亮色模式', 'ok');
}

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
    // 在 APP 内切到「使用介绍」视图（原为弹出新窗口）
    location.hash = '#/guide';
  });
  $('#openChangelogBtn')?.addEventListener('click', () => {
    location.hash = '#/changelog';
  });

  // 侧边栏「切换主题」→ 与 iframe 内页面共用 localStorage 'theme'
  $('#themeToggleBtn')?.addEventListener('click', toggleAppTheme);

  // 侧边栏「打开网页版」→ GitHub Pages 线上站
  $('#openWebBtn')?.addEventListener('click', () => {
    window.open('https://ankomaryken.github.io/kanseki-catalog/', '_blank');
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

  // 查询 iframe 也已加载，同步主题（iframe 内页面自行读 localStorage，此处兜底纠正）
  whenFrameReady(document.getElementById('queryFrame'), () => {
    applyThemeToFrame(document.getElementById('queryFrame'));
  });

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
