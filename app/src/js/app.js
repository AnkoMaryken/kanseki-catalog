// ================================================
// js/app.js — SPA 外壳逻辑（hash 路由 + 视图切换）
// ================================================
// 视图（V0.7）：
//   #/query       纪年查询（iframe pages/index.html）
//   #/catalog     编目规范（iframe pages/catalog.html，tab 由 ?tab=N 指定）
//   #/guide       使用介绍（iframe pages/guide.html）
//   #/changelog   更新日志（iframe pages/changelog.html）
//   #/jump        快速跳转（iframe pages/embed.html）           —— 归入「应用」组
//   #/records     编目记录（占位，待上线）                        —— 归入「应用」组
//   #/sync        同步设置（坚果云 WebDAV）
//   #/login       账号（iframe pages/login.html；登录/注册）
//   #/account     个人中心（iframe pages/profile.html；需登录）
//   #/about       关于
//
// V0.7 新增：
//   · 侧栏顶部工具条：收起侧栏 + 「窗口」菜单（最小化/最大化/关闭/
//     置顶/全屏/居中/尺寸预设）；品牌文字不再占用左上角
//   · 侧栏底部用户区：未登录显示「登录」，已登录显示头像+昵称，
//     菜单提供「个人中心 / 退出登录」；状态读取自 localStorage
//     （与网页版共用 kanseki_user / kanseki_profile，账号体系一致）
//   · 编目记录／同步设置／关于三视图改用 .app-view/.av-* 统一风格
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

// ---------- 用户状态（V0.7） ----------
// 与网页版共用同一套 localStorage 键，账号体系保持一致：
//   kanseki_user    = { email, name, id }        登录态
//   kanseki_profile = { name, avatar, ... }      个人资料（头像等）
// 外壳不引用 user-state.js——该模块依赖网页版页面结构（.user-dropdown），
// 桌面版侧栏结构不同，故此处只复用其数据格式，自行渲染。
const USER_KEY = 'kanseki_user';
const PROFILE_KEY = 'kanseki_profile';

function readLS(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}

function getUser() {
  const u = readLS(USER_KEY);
  return (u && u.email) ? u : null;
}

function getUserName() {
  const p = readLS(PROFILE_KEY) || {};
  if (p.name) return p.name;
  const u = getUser();
  if (u && u.name) return u.name;
  if (u && u.email) return u.email.split('@')[0];
  return '';
}

// 头像渲染：优先自定义图片，其次自定义颜色+字符，最后按邮箱哈希取色
function userAvatarHTML(size) {
  const u = getUser();
  const p = readLS(PROFILE_KEY) || {};
  const av = p.avatar || null;
  const name = getUserName();
  const ch = (av && av.type === 'color' && av.char) ? av.char : ((name && name.trim()) ? name.trim()[0] : '?');
  const base = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;`;
  if (av && av.type === 'img' && av.data) {
    return `<img src="${escAttr(av.data)}" alt="" style="${base}">`;
  }
  let bg = '#52525b';
  if (av && av.type === 'color' && av.bg) {
    bg = av.bg;
  } else {
    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#f43f5e'];
    let idx = 0;
    const em = (u && u.email) || name || '?';
    for (let i = 0; i < em.length; i++) idx = (idx + em.charCodeAt(i)) % colors.length;
    bg = colors[idx];
  }
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:${escAttr(bg)};color:${escAttr((av && av.fg) || '#fff')};font-size:${Math.round(size * 0.46)}px;font-weight:600;line-height:1;">${escHtml(ch)}</span>`;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return escHtml(s); }

// 刷新侧栏底部用户区（登录态变化后调用）
function renderUserBox() {
  const btn = $('#sideUserBtn');
  const av = $('#sideUserAvatar');
  const nm = $('#sideUserName');
  const sub = $('#sideUserSub');
  const menu = $('#sideUserMenu');
  const head = $('#sumHead');
  const profileItem = menu?.querySelector('[data-usermenu="profile"]');
  const logoutBtn = $('#sideLogoutBtn');
  const loginItem = menu?.querySelector('[data-usermenu="login"]');
  if (!btn || !av || !nm || !sub) return;

  const u = getUser();
  if (u) {
    const name = getUserName();
    av.innerHTML = userAvatarHTML(28);
    av.style.background = 'none';
    nm.textContent = name || u.email;
    sub.textContent = u.email || '已登录';
    btn.title = '账号：' + (u.email || name);
    if (head) head.textContent = u.email || name;
    profileItem?.removeAttribute('hidden');
    logoutBtn?.removeAttribute('hidden');
    loginItem?.setAttribute('hidden', '');
  } else {
    av.innerHTML = '';
    av.style.background = '';
    av.textContent = '?';
    nm.textContent = '登录';
    sub.textContent = '登录后可同步编目记录';
    btn.title = '登录 / 注册';
    if (head) head.textContent = '未登录';
    profileItem?.setAttribute('hidden', '');
    logoutBtn?.setAttribute('hidden', '');
    loginItem?.removeAttribute('hidden');
  }
}

function logoutUser() {
  try { localStorage.removeItem(USER_KEY); } catch (_) { /* 忽略 */ }
  // 保留 kanseki_profile（头像等资料），仅清登录态——与网页版 user-state.js 行为一致
  renderUserBox();
  closeUserMenu();
  showToast('已退出登录', 'ok');
}

// 用户菜单开合
function toggleUserMenu(force) {
  const btn = $('#sideUserBtn');
  const menu = $('#sideUserMenu');
  if (!btn || !menu) return;
  const next = (typeof force === 'boolean') ? force : menu.hidden;
  menu.hidden = !next;
  btn.setAttribute('aria-expanded', String(next));
}
function closeUserMenu() { toggleUserMenu(false); }

// ---------- 侧栏收起 / 展开（V0.7） ----------
const COLLAPSE_KEY = 'kanseki_app_sidebar_collapsed';

function applyCollapse(collapsed) {
  const shell = $('#app');
  if (!shell) return;
  shell.classList.toggle('sb-collapsed', !!collapsed);
  // 收起/展开按钮位于自绘标题栏，收起后仍在原位，可直接反向切回
  const btn = $('#collapseBtn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    const t = collapsed ? '展开侧边栏' : '收起侧边栏';
    btn.title = t;
    btn.setAttribute('aria-label', t);
  }
  // 收起后侧栏不可交互，需把焦点移出，避免 Tab 进入隐藏区域
  if (collapsed) {
    document.querySelectorAll('.app-sidebar a, .app-sidebar button').forEach(el => el.setAttribute('tabindex', '-1'));
  } else {
    document.querySelectorAll('.app-sidebar a, .app-sidebar button').forEach(el => el.removeAttribute('tabindex'));
  }
}

function toggleSidebar() {
  const shell = $('#app');
  if (!shell) return;
  const next = !shell.classList.contains('sb-collapsed');
  try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch (_) { /* 忽略 */ }
  applyCollapse(next);
}

// ---------- 窗口控制（V0.7，V0.8.1 修正命令名） ----------
// Tauri v2 无构建工具方式调用窗口 API：走 __TAURI_INTERNALS__.invoke('plugin:window|...')
// 权限见 tauri/capabilities/default.json（需显式列出 allow-* 项）
//
// ⚠️ 命令名必须是 snake_case（与服务端注册名一致），不能写 camelCase：
//    · tauri-2.12.0/src/window/plugin.rs 的 generate_handler! 注册的是
//      is_maximized / toggle_maximize / set_size / set_fullscreen …
//    · ACL 清单（tauri/gen/schemas/acl-manifests.json）里
//      core:window:allow-toggle-maximize 的 commands 也是 "toggle_maximize"
//    此前误传 camelCase（toggleMaximize），ACL 直接拒绝并报
//    「Command plugin:window|toggleMaximize not allowed by ACL」；
//    只有 minimize / maximize / unmaximize / center / close 这类单词命令
//    恰好两种写法同形才「碰巧可用」——这就是「窗口栏很多操作无法使用」的成因。
//
// ⚠️ 带参 setter 的参数名一律是 `value`（Rust 宏签名为 label + value），
//    不是 camelCase 字段名（alwaysOnTop / width+height 都是错的）：
//    · set_fullscreen / set_always_on_top -> value: boolean
//    · set_size                           -> value: { Logical|Physical: {width,height} }
//    · start_resize_dragging              -> value: 'North' | 'SouthEast' …（PascalCase）
const winState = { alwaysOnTop: false, maximized: false, fullscreen: false };

async function winInvoke(cmd, args) {
  if (!isTauri) throw new Error('非 Tauri 环境');
  return window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd, args);
}

// 取当前窗口 label（Tauri v2 要求多数窗口命令带 label）
function currentWindowLabel() {
  try {
    return window.__TAURI_INTERNALS__.metadata?.currentWindow?.label
      || window.__TAURI_INTERNALS__.metadata?.currentWebview?.label
      || 'main';
  } catch (_) { return 'main'; }
}

async function runWinAction(action, payload) {
  if (!isTauri) {
    showToast('窗口操作仅在桌面版可用（当前为浏览器调试）', 'err');
    return;
  }
  const label = currentWindowLabel();
  const call = (cmd, args) => winInvoke(cmd, Object.assign({ label }, args || {}));
  try {
    switch (action) {
      case 'min': await call('minimize'); break;
      case 'max':
        // V0.8.1: 不再对布尔量取反，改为命令执行后回读真实状态，
        // 避免与拖边框 / Win+↑ / 双击标题栏等外部改动后的状态不同步
        await call('toggle_maximize');
        await refreshMaxState();
        break;
      case 'close': await call('close'); break;
      case 'center': await call('center'); showToast('窗口已居中'); break;
      case 'fullscreen':
        winState.fullscreen = !winState.fullscreen;
        await call('set_fullscreen', { value: winState.fullscreen });
        showToast(winState.fullscreen ? '已进入全屏（再点一次退出）' : '已退出全屏');
        break;
      case 'ontop':
        winState.alwaysOnTop = !winState.alwaysOnTop;
        await call('set_always_on_top', { value: winState.alwaysOnTop });
        syncTopCheck();
        showToast(winState.alwaysOnTop ? '窗口已置顶' : '已取消置顶');
        break;
      case 'size': {
        const [w, h] = String(payload || '').split('x').map(Number);
        if (!w || !h) break;
        // set_size 收 tauri::Size：显式用 Logical，由内核按 DPI 换算，
        // 无需自行乘 devicePixelRatio（旧写法会在大字号屏幕下算错）
        await call('set_size', { value: { Logical: { width: w, height: h } } });
        await call('center');
        // 设定尺寸会让窗口退出最大化态，同步图标
        await refreshMaxState();
        showToast(`窗口尺寸已设为 ${w}×${h}`);
        break;
      }
      default: break;
    }
  } catch (e) {
    showToast('窗口操作失败：' + (e && e.message ? e.message : e), 'err');
  }
}

// 回读最大化真实状态并刷新 UI（命令名同前，须为 snake_case）
async function refreshMaxState() {
  try {
    const m = !!(await winInvoke('is_maximized', { label: currentWindowLabel() }));
    if (m !== winState.maximized) { winState.maximized = m; }
    syncMaxLabel();
  } catch (_) { /* 忽略：不影响主流程 */ }
}

function syncMaxLabel() {
  const el = $('#winMaxLabel');
  if (el) el.textContent = winState.maximized ? '还原' : '最大化';
  // 自绘标题栏：最大化图标 ←→ 还原图标
  const maxBtn = $('#tbMax');
  if (maxBtn) {
    const t = winState.maximized ? '还原' : '最大化';
    maxBtn.title = t;
    maxBtn.setAttribute('aria-label', t);
    maxBtn.setAttribute('aria-pressed', String(winState.maximized));
  }
  const icoMax = document.querySelector('#tbMax .tb-ico-max');
  const icoRes = document.querySelector('#tbMax .tb-ico-restore');
  if (icoMax) icoMax.toggleAttribute('hidden', !!winState.maximized);
  if (icoRes) icoRes.toggleAttribute('hidden', !winState.maximized);
  // 最大化时禁用缩放热区（CSS 亦有兜底）
  const shell = $('#app');
  if (shell) shell.classList.toggle('is-maximized', !!winState.maximized);
}
function syncTopCheck() {
  const item = document.querySelector('.st-menu-item[data-win="ontop"]');
  if (item) item.classList.toggle('on', winState.alwaysOnTop);
}

// 启动时回读窗口真实状态（避免菜单勾选与窗口实际不符）
async function initWinState() {
  if (!isTauri) return;
  const label = currentWindowLabel();
  const call = (cmd, args) => winInvoke(cmd, Object.assign({ label }, args || {}));
  // 命令名须 snake_case，见本节顶部说明
  try { winState.maximized = !!(await call('is_maximized')); } catch (_) { /* 忽略 */ }
  try { winState.fullscreen = !!(await call('is_fullscreen')); } catch (_) { /* 忽略 */ }
  try { winState.alwaysOnTop = !!(await call('is_always_on_top')); } catch (_) { /* 忽略 */ }
  syncMaxLabel();
  syncTopCheck();
}

// 窗口尺寸变化时回读最大化态（用户拖边框、双击标题栏、系统 Win+↑ 均触发）
let resizeSyncTimer = null;
function scheduleWinStateSync() {
  if (!isTauri) return;
  clearTimeout(resizeSyncTimer);
  resizeSyncTimer = setTimeout(async () => {
    const label = currentWindowLabel();
    try {
      const m = !!(await winInvoke('is_maximized', { label }));
      if (m !== winState.maximized) { winState.maximized = m; syncMaxLabel(); }
    } catch (_) { /* 忽略 */ }
  }, 160);
}

// 窗口菜单开合
function toggleWinMenu(force) {
  const btn = $('#winBtn');
  const menu = $('#winMenu');
  if (!btn || !menu) return;
  const next = (typeof force === 'boolean') ? force : menu.hidden;
  menu.hidden = !next;
  btn.setAttribute('aria-expanded', String(next));
}
function closeWinMenu() { toggleWinMenu(false); }

// 关于页的版本 / 环境 / 窗口尺寸信息
const APP_VERSION = '0.8.0';
function refreshAboutInfo() {
  const envEl = $('#aboutEnv');
  const sizeEl = $('#aboutWinSize');
  if (envEl) envEl.textContent = isTauri ? 'Windows 桌面版（Tauri）' : '浏览器调试';
  if (sizeEl) {
    sizeEl.textContent = window.innerWidth + '×' + window.innerHeight +
      (isTauri ? '' : '（浏览器视口）');
  }
}

// ---------- 视图切换 ----------
// 10 个视图；iframe 视图按需懒加载（data-src -> src）
const VIEWS = ['query', 'jump', 'catalog', 'guide', 'changelog', 'login', 'account', 'records', 'sync', 'about'];

// 视图 -> iframe id（懒加载用）
const FRAMES = {
  query: 'queryFrame',
  jump: 'jumpFrame',
  catalog: 'catalogFrame',
  guide: 'guideFrame',
  changelog: 'changelogFrame',
  login: 'loginFrame',
  account: 'accountFrame',
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
  if (target === 'about') refreshAboutInfo();
  // 账号页由 iframe 承载，登录成功后需回读 localStorage 刷新侧栏用户区
  if (target === 'login' || target === 'account') {
    whenFrameReady(frame, () => {
      const doc = frameDoc(frame);
      // 登录页在成功后会 location.href 跳转，此处监听其 localStorage 变化；
      // 跨 iframe 的 storage 事件在同源下可用（浏览器与 WebView2 均支持）
      if (doc && !doc.__kansekiUserHooked) {
        doc.__kansekiUserHooked = true;
        doc.addEventListener('submit', () => {
          setTimeout(() => { renderUserBox(); }, 400);
        }, true);
      }
      applyThemeToFrame(frame);
    });
  }
  if (target === 'catalog') {
    // 等 iframe 就绪后再同步弹窗数据源；已就绪则直接同步
    whenFrameReady(frame, () => {
      if (tab !== null) activateCatalogTab(frame, parseInt(tab, 10));
      syncCatalogSidebar(frame);
    });
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

// 弹窗内锚点点击 -> 转发到 iframe 内对应元素（按序号对应，结构一致）
// 注意：监听器挂在常驻的 #anchorPopBody 上，innerHTML 替换不会移除它，
// 故只在首次绑定时注册，不可用 dataset 标记做「重绑」。
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
    // 跳转后收起弹窗，让用户直接看到主区滚动结果
    closeAnchorPop();
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
  closeAnchorPop();
}

// 「内容导览」弹窗（V0.8）：镜像 iframe 内 #sideAnchors，但显示在浮层中，
// 不再占用侧栏纵向空间（V0.7 内联展开会把导航挤出视野）。
const ANCHOR_POP_TITLES = ['章节导航', '分类导航', '工作手册'];

function anchorPopBody() { return $('#anchorPopBody'); }

function openAnchorPop(tabIdx) {
  const pop = $('#anchorPop');
  const body = anchorPopBody();
  if (!pop || !body) return;
  const frame = document.getElementById(FRAMES.catalog);
  const doc = frameDoc(frame);
  const src = doc && doc.getElementById('sideAnchors');
  if (!src || !src.innerHTML.trim()) {
    showToast('当前页面暂无可导航内容');
    return;
  }
  const title = $('#anchorPopTitle');
  if (title) title.textContent = ANCHOR_POP_TITLES[tabIdx] || '内容导览';
  body.innerHTML = src.innerHTML;
  bindAnchorForward(body, frame);
  const sig = anchorSignature(src);
  body.dataset.sig = sig;
  pop.removeAttribute('hidden');
  // 打开动画结束后焦点移到关闭键，便于键盘操作
  $('#anchorPopClose')?.focus({ preventScroll: true });
}

function closeAnchorPop() {
  const pop = $('#anchorPop');
  if (pop && !pop.hasAttribute('hidden')) pop.setAttribute('hidden', '');
}

function isAnchorPopOpen() {
  const pop = $('#anchorPop');
  return !!pop && !pop.hasAttribute('hidden');
}

function syncCatalogSidebar(frame) {
  const doc = frameDoc(frame);
  // 弹窗打开时同步内容；关闭时仍需读取源数据以便即时打开
  const src = doc && doc.getElementById('sideAnchors');
  const body = anchorPopBody();
  if (!src || !body) return;

  const sig = anchorSignature(src);
  if (isAnchorPopOpen() && body.dataset.sig !== sig) {
    body.innerHTML = src.innerHTML;
    body.dataset.sig = sig;
    bindAnchorForward(body, frame);
  } else if (isAnchorPopOpen()) {
    syncAnchorActive(body, src);
  } else {
    // 关闭态只记录签名，打开时按需重建
    body.dataset.sig = sig;
  }

  // 空内容时收起弹窗，避免弹出空白面板
  if (isAnchorPopOpen() && !src.innerHTML.trim()) closeAnchorPop();

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

// 外壳自身也挂 data-theme —— 这样编目记录/同步设置/关于三视图的
// CSS 变量能跟随明暗切换（V0.7 新增；此前外壳恒为亮色）
function applyThemeToShell() {
  document.documentElement.setAttribute('data-theme', currentTheme());
}

function applyThemeToFrame(frame) {
  const doc = frameDoc(frame);
  if (doc && doc.documentElement) {
    doc.documentElement.setAttribute('data-theme', currentTheme());
  }
}

function applyThemeToAll() {
  applyThemeToShell();
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

  // ---------- 侧栏收起 / 展开 ----------
  applyCollapse(localStorage.getItem(COLLAPSE_KEY) === '1');
  $('#collapseBtn')?.addEventListener('click', toggleSidebar);

  // ---------- 自绘标题栏：三键 + 缩放手柄 ----------
  $('#tbMin')?.addEventListener('click', () => runWinAction('min'));
  $('#tbMax')?.addEventListener('click', () => runWinAction('max'));
  $('#tbClose')?.addEventListener('click', () => runWinAction('close'));
  // 无边框窗口八向缩放：热区 mousedown → start_resize_dragging
  // 参数名须为 value，取值为 PascalCase 方向名（见本节顶部说明）
  $('#winResize')?.addEventListener('mousedown', (e) => {
    const zone = e.target.closest('[data-dir]');
    if (!zone || !isTauri) return;
    e.preventDefault();
    const label = currentWindowLabel();
    winInvoke('start_resize_dragging', { label, value: zone.dataset.dir })
      .catch(() => { /* 最大化态等情形静默忽略 */ });
  });
  if (!isTauri) $('#app')?.classList.add('no-tauri');
  window.addEventListener('resize', scheduleWinStateSync);

  // ---------- 编目规范「内容导览」弹窗（V0.8） ----------
  // 导航项右侧 ▸ 按钮：先切到对应 tab，再弹出该页导览
  $$('.nav-dir').forEach(el => {
    const open = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(el.dataset.dirOpen, 10);
      const item = el.closest('.nav-item');
      if (item && !item.classList.contains('active')) item.click();
      // 等 iframe 切 tab 渲染完再读锚点（tab 切换含渲染，需留时间）
      setTimeout(() => openAnchorPop(idx), 420);
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });
  });
  $('#anchorPopClose')?.addEventListener('click', closeAnchorPop);
  // 点遮罩关闭（点面板内部不关）
  $('#anchorPop')?.addEventListener('click', (e) => {
    if (e.target.id === 'anchorPop') closeAnchorPop();
  });

  // ---------- 窗口菜单 ----------
  $('#winBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = $('#winMenu').hidden;
    closeUserMenu();
    toggleWinMenu(willOpen);
  });
  $('#winMenu')?.addEventListener('click', (e) => {
    const item = e.target.closest('.st-menu-item');
    if (!item) return;
    closeWinMenu();
    if (item.dataset.win) runWinAction(item.dataset.win);
    else if (item.dataset.size) runWinAction('size', item.dataset.size);
  });
  syncMaxLabel();
  syncTopCheck();
  initWinState();

  // ---------- 侧栏用户区 ----------
  renderUserBox();
  $('#sideUserBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = $('#sideUserMenu').hidden;
    closeWinMenu();
    toggleUserMenu(willOpen);
  });
  $('#sideUserMenu')?.addEventListener('click', (e) => {
    const a = e.target.closest('[data-usermenu]');
    if (a) {
      // 站内视图跳转：交由 hash 路由处理，并收起菜单
      closeUserMenu();
      if (a.dataset.usermenu === 'login') location.hash = '#/login';
      if (a.dataset.usermenu === 'profile') location.hash = '#/account';
    }
  });
  $('#sideLogoutBtn')?.addEventListener('click', logoutUser);

  // 点击空白处关闭两个下拉
  document.addEventListener('click', () => { closeWinMenu(); closeUserMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 弹窗优先级最高，其次两个下拉
      if (isAnchorPopOpen()) { closeAnchorPop(); return; }
      closeWinMenu(); closeUserMenu();
    }
    // F11 全屏（与窗口菜单一致）
    if (e.key === 'F11') { e.preventDefault(); runWinAction('fullscreen'); }
  });
  // 跨窗口/跨 iframe 的登录态变化（同一浏览器内其它标签页登录后同步）
  window.addEventListener('storage', (e) => {
    if (e.key === USER_KEY || e.key === PROFILE_KEY) renderUserBox();
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

  refreshAboutInfo();
  window.addEventListener('resize', refreshAboutInfo);
  // 外壳自身主题（三视图 CSS 变量依赖 documentElement 的 data-theme）
  applyThemeToShell();

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
  statusEl.className = 'av-alert';
  statusEl.textContent = '连接测试中…';

  provider.setCredentials(user, pass);
  if (isTauri) {
    try {
      const r = await tauriInvoke('webdav_check', {
        url: 'https://dav.jianguoyun.com/dav/kanseki-sync',
        username: user,
        password: pass
      });
      statusEl.className = 'av-alert ' + (r.ok ? 'ok' : 'err');
      statusEl.textContent = r.ok ? '✓ 连接正常' : '✗ ' + r.message;
    } catch (e) {
      statusEl.className = 'av-alert err';
      statusEl.textContent = '✗ 连接失败：' + (e && e.message);
    }
  } else {
    const r = await provider.check();
    statusEl.className = 'av-alert ' + (r.ok ? 'ok' : 'err');
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
