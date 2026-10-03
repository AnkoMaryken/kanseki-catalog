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
import { initKansekiDbView } from './ui/kanseki-db.js';

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
  // 登录态唯一入口：这里统一驱动「账号」项的路由，
  // 避免各调用点（init / 登录后 / 退出 / storage 事件）各自同步而漏改
  refreshAccountNav();
}

function logoutUser() {
  try { localStorage.removeItem(USER_KEY); } catch (_) { /* 忽略 */ }
  // 保留 kanseki_profile（头像等资料），仅清登录态——与网页版 user-state.js 行为一致
  renderUserBox();
  closeUserMenu();
  showToast('已退出登录', 'ok');
  // 退出后个人中心不再可访问（该页有登录门禁，留着会跳回登录页），
  // 若正停留在个人中心则退回登录页
  if (currentView === 'account') location.hash = '#/login';
}

// ---------- 侧栏「账号」动态路由（V0.8.2） ----------
// 未登录 → 登录页；已登录 → 个人中心。
// 原实现把「账号」写死为 #/login，于是登录后点它又回到登录页（用户反馈的问题）。
const LANG_KEY = 'kanseki_lang';

function currentLangPref() {
  try { return localStorage.getItem(LANG_KEY) === 's' ? 's' : 't'; } catch (_) { return 't'; }
}

function refreshAccountNav() {
  const a = $('#navAccount');
  if (!a) return;
  const logged = !!getUser();
  const target = logged ? 'account' : 'login';
  // href 与 data-view 都要改：前者决定点击去向，后者决定高亮匹配
  a.setAttribute('href', '#/' + target);
  a.dataset.view = target;
  a.title = logged ? '个人中心' : '登录 / 注册';
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
        // V0.8.1: 不再对布尔量取反后写死，改为操作后回读真实状态
        // V0.8.2: ① 改用幂等的 maximize / unmaximize（便于失败重试）
        //         ② 目标状态明确 → 界面立即按目标翻转，无延迟感
        //         ③ 未到位则重试，解决「启动初期首条窗口命令被静默丢弃」
        applyMaxUI(!winState.maximized);            // ① 立即反馈
        if (!await setMaximized(winState.maximized)) {   // ②③ 幂等重试直到到位
          showToast('窗口操作未能生效，请再试一次', 'err');
        }
        break;
      case 'close': await call('close'); break;
      case 'center':
        await call('center');
        showToast('窗口已居中');
        break;
      case 'fullscreen': {
        // 期望值：状态变量取反；命令可能被丢弃，故回读校验并重试
        const want = !winState.fullscreen;
        let okFs = false;
        for (let i = 0; i < 3 && !okFs; i++) {
          try { await call('set_fullscreen', { value: want }); } catch (_) { /* 靠回读判断 */ }
          for (let j = 0; j < 8; j++) {
            let cur = null;
            try { cur = !!(await call('is_fullscreen')); } catch (_) { /* 重试 */ }
            if (cur === want) { okFs = true; break; }
            await new Promise(r => setTimeout(r, 130));
          }
        }
        if (okFs) {
          winState.fullscreen = want;
          showToast(want ? '已进入全屏（再点一次退出）' : '已退出全屏');
        } else {
          showToast('全屏切换未能生效，请再试一次', 'err');
        }
        break;
      }
      case 'ontop': {
        // 同样回读校验：置顶失败会让用户以为「点了没用」
        const want = !winState.alwaysOnTop;
        let okTop = false;
        for (let i = 0; i < 3 && !okTop; i++) {
          try { await call('set_always_on_top', { value: want }); } catch (_) { /* 靠回读判断 */ }
          for (let j = 0; j < 8; j++) {
            let cur = null;
            try { cur = !!(await call('is_always_on_top')); } catch (_) { /* 重试 */ }
            if (cur === want) { okTop = true; break; }
            await new Promise(r => setTimeout(r, 130));
          }
        }
        if (okTop) {
          winState.alwaysOnTop = want;
          syncTopCheck();
          showToast(want ? '窗口已置顶' : '已取消置顶');
        } else {
          showToast('置顶切换未能生效，请再试一次', 'err');
        }
        break;
      }
      case 'size': {
        const [w, h] = String(payload || '').split('x').map(Number);
        if (!w || !h) break;
        // set_size 收 tauri::Size：显式用 Logical，由内核按 DPI 换算，
        // 无需自行乘 devicePixelRatio（旧写法会在大字号屏幕下算错）
        // 命令可能被丢弃 → 回读实际尺寸校验并重试（幂等，重复设置无害）
        //
        // 校验用 window.innerWidth/Height：无边框窗口（decorations:false）
        // 的视口即等于 set_size 设的逻辑尺寸，且二者同为 CSS/逻辑像素尺度；
        // 不调用内核的 inner_size —— 那需要额外授予窗口查询权限，且返回的
        // 是物理像素，还得自行按 DPI 换算，反而更容易出错。
        let okSize = false;
        for (let i = 0; i < 3 && !okSize; i++) {
          try { await call('set_size', { value: { Logical: { width: w, height: h } } }); }
          catch (_) { /* 靠回读判断 */ }
          try { await call('center'); } catch (_) { /* 居中失败不影响尺寸 */ }
          for (let j = 0; j < 8; j++) {
            if (Math.abs(window.innerWidth - w) <= 4 && Math.abs(window.innerHeight - h) <= 4) {
              okSize = true; break;
            }
            await new Promise(r => setTimeout(r, 140));
          }
        }
        // 设定尺寸会让窗口退出最大化态，同步图标（期望值明确为 false）
        await setMaximized(false);
        if (okSize) showToast(`窗口尺寸已设为 ${w}×${h}`);
        else showToast('窗口尺寸未能生效，请再试一次', 'err');
        break;
      }
      default: break;
    }
  } catch (e) {
    showToast('窗口操作失败：' + (e && e.message ? e.message : e), 'err');
  }
}

// 回读最大化真实状态并刷新 UI
//
// ⚠️ 这里是最容易出错的地方，改动前请先读完本节。
//
// 【一】窗口缩放状态不能靠本地变量推断
//    Windows 上最大化会触发动画，命令返回时窗口尺寸尚未更新完毕，此刻立刻
//    回读 is_maximized 有概率拿到**旧值**（仍返回未最大化）。
//
// 【二】读到旧值就会把图标改错 —— 这是「点了没反应」的真正成因
//    实测（app/scripts/diag_max8.cjs，60ms 高频采样 + 指令流追踪）点击最大化后
//    图标变化为：+121ms →「还原」 → +195ms **又被改回「最大化」**，
//    而此时窗口尺寸已是 1440×912（窗口确实最大化了，只是图标错了）。
//    即：点击本身生效了，是后续的尺寸变化回读在动画未结束时读到旧值，
//    把刚设好的正确图标覆盖成了错的。用户看到的就是「点了没反应」。
//    （历史上这项还被误判为「点击无效」而反复返工，务必以此为鉴。）
//
// 【三】对策
//    ① 幂等命令：不用 toggle_maximize（翻转语义，重试会翻回去），改用
//       目标明确的 maximize / unmaximize —— 没到位就再发一次，重复无副作用。
//    ② 保护期：程序化改状态后的一段时间内（见 maxSyncGraceUntil），
//       尺寸变化回读不采信，由本流程独占状态写入；期满再做一次权威校准。
//    ③ 二次确认：保护期外的回读要与当前显示不一致时，再读一次，两次一致
//       才采信（单次读到旧值不足以推翻界面）。
let maxToggleBusy = false;   // 状态写入窗口内：屏蔽 resize 回读，避免读到动画中间态

// 保护期截止时刻：程序化改窗口状态后的这段时间内，resize 回读不采信
// （Windows 最大化动画期间 is_maximized 仍返回旧值，采信就会把图标改错）
// 详见 scheduleWinStateSync 顶部说明
let maxSyncGraceUntil = 0;

// 只更新界面（状态 + 图标），不发命令
function applyMaxUI(state) {
  winState.maximized = !!state;
  syncMaxLabel();
}

// 回读真实状态；读取失败返回 null（保留现状，不误改）
async function readMaxState(label) {
  try { return !!(await winInvoke('is_maximized', { label })); }
  catch (_) { return null; }
}

// 等待真实状态到达期望值；返回最终读到的值（未读到返回 null）
async function waitMaxState(target, label, tries, interval) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await readMaxState(label);
    if (last === target) return last;
    if (i < tries - 1) await new Promise(r => setTimeout(r, interval));
  }
  return last;
}

// 幂等地把窗口设为最大化（true）/ 非最大化（false）
//
// 为什么用幂等命令 + 重试：见上方【三】。
// maximize / unmaximize 目标状态明确，重复调用没有副作用，因此可以安全地
// 「没到位就再发一次」—— 这是不能用 toggle 重试的根本原因（翻转语义下
// 重试会把窗口翻回去）。
async function setMaximized(target) {
  const label = currentWindowLabel();
  maxToggleBusy = true;
  // 保护期：动画期间内核会返回旧值，此期间禁止 resize 回读改写图标
  // （须覆盖到「窗口动画彻底结束」，故给足 1.8s）
  maxSyncGraceUntil = Date.now() + 1800;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // ① 已在目标状态就不发命令（幂等命令虽无害，但可省掉一次动画触发）
      if (attempt > 0) {
        const cur = await readMaxState(label);
        if (cur === target) return true;
      }

      // ② 发命令（失败不中断，交给下面的回读判断）
      try { await winInvoke(target ? 'maximize' : 'unmaximize', { label }); }
      catch (_) { /* 命令被拒绝等情形，靠回读判断并重试 */ }

      // ③ 等状态到位（单轮最多约 1.4s，覆盖 Windows 最大化动画）
      const reached = await waitMaxState(target, label, 10, 140);
      if (reached === target) return true;

      // ④ 没到位：再等一拍后重试（处理「命令尚在途中」等情形）
      await new Promise(r => setTimeout(r, 260));
    }
    // 三轮都没成功：以真实状态为准，绝不骗用户
    const real = await readMaxState(label);
    if (real !== null) applyMaxUI(real);
    return false;
  } finally {
    maxToggleBusy = false;
    // 保护期不随函数结束而结束：动画可能仍在收尾（实测图标在 195ms 时
    // 被回读改错），故保留至 1.8s 期满，由 runResizeSync 期满后再校准。
    scheduleWinStateSync();
  }
}

function syncMaxLabel() {
  // 调试追踪（默认关闭）：窗口状态这类「动画期间读到旧值」的问题极难复现，
  // 排查时需要知道**是谁**在什么时候把图标改写了。开放此开关后，任何一次
  // 图标改写都会连同调用栈记录在 window.__kansekiMaxTrace 中（保留最近 40 条）。
  // 打开方式：控制台执行 window.__KANSEKI_MAX_TRACE = true
  // （探针脚本 app/scripts/probe_v082.cjs 即用它定位过竞态元凶）
  if (typeof window !== 'undefined' && window.__KANSEKI_MAX_TRACE) {
    try {
      (window.__kansekiMaxTrace = window.__kansekiMaxTrace || []).push({
        t: Math.round(performance.now()),
        max: !!winState.maximized,
        stack: String(new Error().stack || '').split('\n').slice(1, 4).join(' | '),
      });
      if (window.__kansekiMaxTrace.length > 40) window.__kansekiMaxTrace.shift();
    } catch (_) { /* 追踪失败不影响功能 */ }
  }
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
  // 命令名须 snake_case，见本节顶部说明。
  // 回读失败时多试几次（启动初期偶发拿不到值），拿不到就保持初值不动，
  // 由后续的 resize 回读与用户操作纠正 —— 不要臆测一个状态写进界面。
  //
  // ⚠️ 启动期也可能撞上「最大化动画」：用户点击得早（或被 index.html 的
  //    早期暂存器补发）时，本函数与动画并行，动画期间回读会拿到旧值并写错
  //    图标 —— 实测过一次：+2769ms 写了「未最大化」，直到 +4819ms 才被保护期
  //    后的权威校准纠正，视觉上就是图标抖一下。
  //    对策：与 runResizeSync 同一套判断 —— 处于写入窗口或其保护期内则不采信
  //    本次回读（跳过最大化状态的写入），把判断让给正在执行的操作流程。
  //    注意只是"跳过这一项写入"，后面的图标刷新与置顶勾选仍要照常执行。
  // 注意：命中了保护期/忙碌标记时，上面循环会 break 且不写入最大化状态，
  // 即保留操作流程刚设好的值（这正是「不采信旧读数」的落地方式），
  // 后面的图标刷新与置顶勾选仍照常执行。
  for (let i = 0; i < 3; i++) {
    const m = await readMaxState(label);
    if (maxToggleBusy || Date.now() < maxSyncGraceUntil) break;
    if (m !== null) { winState.maximized = m; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  try { winState.fullscreen = !!(await call('is_fullscreen')); } catch (_) { /* 忽略 */ }
  try { winState.alwaysOnTop = !!(await call('is_always_on_top')); } catch (_) { /* 忽略 */ }
  syncMaxLabel();
  syncTopCheck();
}

// 窗口尺寸变化时回读最大化态（用户拖边框、双击标题栏、系统 Win+↑ 均触发）
//
// ⚠️⚠️ 这里是本次「点了没反应」的真正元凶，务必保留两道防护。
//    实测（app/scripts/diag_max8.cjs）点击最大化后图标变化序列：
//      +121ms 变为「还原」 → +195ms **又被改回「最大化」**
//      而窗口尺寸已是 1440×912（即窗口确实最大化了，图标却错了）
//    原因：Windows 最大化动画期间会**连续触发** resize 事件，此时内核的
//    is_maximized 仍返回**旧值 false**；本处理器读到旧值就把刚设好的图标
//    改了回来。而 setMaximized 早在 ~30ms 就完成了（is_maximized 已能正确
//    返回 true），故它结束时设的「忙碌」标记拦不住 195ms 才发生的这次回读。
//
//    防护① 保护期：程序化改状态后一段时间内，本处理器不采信回读；
//    防护② 二次确认：与当前显示不一致时再读一次，两次一致才采信
//          （单次读到旧值不足以推翻界面）。
let resizeSyncTimer = null;
let graceRecheckTimer = null;

function scheduleWinStateSync() {
  if (!isTauri) return;
  clearTimeout(resizeSyncTimer);
  resizeSyncTimer = setTimeout(runResizeSync, 200);
}

async function runResizeSync() {
  // 防护①：保护期内不采信回读，等保护期结束再做一次权威回读
  if (Date.now() < maxSyncGraceUntil) {
    clearTimeout(graceRecheckTimer);
    graceRecheckTimer = setTimeout(runResizeSync, maxSyncGraceUntil - Date.now() + 120);
    return;
  }
  if (maxToggleBusy) return;   // 正在执行程序化切换，由它独占状态写入

  const label = currentWindowLabel();
  const m1 = await readMaxState(label);
  if (m1 === null || m1 === winState.maximized) return;

  // 防护②：再确认一次，两次读数一致才采信（动画结束后内核才会返回真值）
  await new Promise(r => setTimeout(r, 260));
  if (Date.now() < maxSyncGraceUntil || maxToggleBusy) return;
  const m2 = await readMaxState(label);
  if (m2 !== null && m2 === m1) applyMaxUI(m2);
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
const APP_VERSION = '0.13.1';
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
// 11 个视图；iframe 视图按需懒加载（data-src -> src）
const VIEWS = ['query', 'jump', 'catalog', 'kanseki', 'kansekidb', 'guide', 'changelog', 'login', 'account', 'records', 'sync', 'about'];

// 视图 -> iframe id（懒加载用）
const FRAMES = {
  query: 'queryFrame',
  jump: 'jumpFrame',
  catalog: 'catalogFrame',
  kanseki: 'kansekiFrame',
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
  // V9.4：日本藏本检索面板（首次进入时初始化表单与机构列表）
  if (target === 'kansekidb') initKansekiDbView();
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
          watchLoginSuccess();
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

// ---------- 登录成功通知钩子（V0.8.2） ----------
// 登录页在 iframe 内，登录成功后若照常 location.href 回首页，
// 会在该框架里塞进一份完整首页（界面错乱）。故登录页检测到被外壳承载时，
// 改为调用本钩子（同源可直接调用），由外壳负责刷新用户区与切换视图。
let loginWatchTimer = null;

window.kansekiOnLoggedIn = function () {
  if (loginWatchTimer) { clearInterval(loginWatchTimer); loginWatchTimer = null; }
  renderUserBox();                              // 侧栏头像/昵称 +「账号」项路由一并刷新
  if (currentView === 'login') location.hash = '#/account';
  showToast('登录成功', 'ok');
};

// ---------- 登录成功后自动进入个人中心（V0.8.2） ----------
// 兜底路径：登录页正常会调用 window.kansekiOnLoggedIn 通知外壳（见上），
// 但若该页版本较旧、或用户在页内用其它方式完成了登录，外壳未必收到通知，
// 故再轮询登录态兜底：一旦出现 kanseki_user 就切到个人中心。
function watchLoginSuccess() {
  if (loginWatchTimer) return; // 已有轮询在跑（防止重复提交叠加多个定时器）
  const startedAt = Date.now();
  loginWatchTimer = setInterval(() => {
    const logged = !!getUser();
    const timeout = Date.now() - startedAt > 15000; // 15s 上限，失败提交不至于长期轮询
    if (logged) {
      window.kansekiOnLoggedIn();   // 统一走钩子，避免两处逻辑不一致
    } else if (timeout) {
      clearInterval(loginWatchTimer);
      loginWatchTimer = null;
    }
  }, 350);
}

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

// 取同源 iframe 内的侧栏镜像源（#sideAnchors）。
// 容错（V9.0）：目标页没有该元素时返回 null —— 新增的「古籍类目查询」页无侧栏，
// 若被传入（视图切换、观察器回调等），下游一律按「无可镜像内容」处理，不得抛错。
function anchorSourceOf(frame) {
  const doc = frameDoc(frame);
  if (!doc) return null;
  try { return doc.getElementById('sideAnchors') || null; } catch (_) { return null; }
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
    const src = anchorSourceOf(frame);
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
  const src = anchorSourceOf(frame);
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
  if (!doc) return;
  // 弹窗打开时同步内容；关闭时仍需读取源数据以便即时打开
  // 容错：非编目规范页（如 V9.0 古籍类目查询）没有 #sideAnchors，静默返回
  const src = anchorSourceOf(frame);
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

// ---------- 一键简繁切换（V0.8.2） ----------
// 网页版 index.html 已把整套字形逻辑封在 IIFE 内，外部不可见，
// 故其中显式导出了 window.KansekiLang（get/set/toggle/KEY）。
// 桌面外壳不重复实现转换，只做三件事：
//   1. 点击按钮 → 调用 iframe 内的 KansekiLang.toggle()
//   2. 同步按钮外观（显示「将要切到的字形」）与 localStorage（供 storage 事件广播）
//   3. 对已加载的其它 iframe 同步字形（catalog/guide/changelog 等不支持切换，
//      只处理真正实现了接口的页面；未实现者静默跳过）
//
// 注意：字形状态由 index.html 自行持久化（kanseki_lang）。此处写 localStorage
// 是为了让「另一个已打开的窗口/标签页」经 storage 事件跟随，而非重复存状态。

// 取 iframe 内的字形接口（未实现该接口的页面返回 null）
function frameLang(frame) {
  try {
    const w = frame && frame.contentWindow;
    const api = w && w.KansekiLang;
    return (api && typeof api.get === 'function') ? api : null;
  } catch (_) { return null; }
}

// 支持简繁切换的视图
// 纪年查询页与 V9.0 新增的古籍类目查询页都实现了 KansekiLang 接口；登录/个人中心页是
// 纯账号页面，未引入转换表，frameLang() 对其返回 null 而静默跳过。列在此处是防御性的：
// 页面尚未加载 / 未实现接口时都会安全跳过。
function langCapableFrames() {
  return ['query', 'kanseki', 'login', 'account']
    .map(v => document.getElementById(FRAMES[v]))
    .filter(Boolean);
}

// 当前字形：优先取内嵌查询页的真实状态（它才是真正在渲染字形的那一个），
// 该页尚未加载 / 未实现接口时退回 localStorage 偏好
function currentFrameLang() {
  const api = frameLang(document.getElementById(FRAMES.query));
  if (api) {
    try {
      const cur = api.get();
      if (cur === 's' || cur === 't') return cur;
    } catch (_) { /* 落到下面读偏好 */ }
  }
  return currentLangPref();
}

// 按当前字形刷新按钮外观
function syncLangBtn() {
  const tx = $('#langToggleTx');
  const btn = $('#langToggleBtn');
  if (!tx || !btn) return;
  // 显示「将要切到的字形」：当前繁体 → 按钮显示「简」
  const next = currentFrameLang() === 't' ? 's' : 't';
  tx.textContent = next === 's' ? '简' : '繁';
  const label = next === 's' ? '切换为简体字' : '切换为繁体字';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// 把指定字形应用到所有支持切换的 iframe
function applyLangToFrames(lang) {
  langCapableFrames().forEach(f => {
    const api = frameLang(f);
    if (api) { try { api.set(lang); } catch (_) { /* 跨域等场景忽略 */ } }
  });
}

function toggleAppLang() {
  // 以内嵌查询页的实际状态为准；该页未就绪时退回 localStorage 偏好
  const qf = document.getElementById(FRAMES.query);
  const api = frameLang(qf);
  let next;
  if (api) {
    try { next = api.toggle(); } catch (_) { next = null; }
  }
  if (next !== 's' && next !== 't') {
    next = currentLangPref() === 't' ? 's' : 't';
    applyLangToFrames(next);
  }
  // 广播给其它页面（含尚未加载的 iframe：它们启动时会自读 localStorage）
  try { localStorage.setItem(LANG_KEY, next); } catch (_) { /* 忽略 */ }
  syncLangBtn();
  showToast(next === 's' ? '已切换为简体字' : '已切换为繁体字', 'ok');
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
  // ⚠️ 启动前几秒的点击由 index.html 里的早期脚本暂存（见那里的说明）。
  //    正式监听挂好后必须做两件事，顺序不能反：
  //      ① detach()  —— 解除早期监听，否则之后的点击会被暂存器再记一份
  //      ② takeAll() —— 取出启动期间的待办点击，补发一次
  //    倒过来做会把补发的点击又暂存进去，形成自激。补发用 el.click()，
  //    走的就是刚绑好的正式监听，行为与真实点击完全一致。
  try {
    const early = window.__kansekiEarlyClicks;
    if (early && typeof early.takeAll === 'function') {
      if (typeof early.detach === 'function') early.detach();
      const pending = early.takeAll();
      if (pending.length) {
        // 延迟一拍补发：此刻后面的窗口菜单、简繁按钮监听尚未绑定完，
        // 立即补发会导致「简繁按钮的点击无人响应」（同一次竞态的另一面）
        setTimeout(() => {
          pending.forEach(id => { const el = document.getElementById(id); if (el) el.click(); });
        }, 0);
      }
    }
  } catch (_) { /* 早期接管是增强项，失败不影响正常交互 */ }

  // 无边框窗口八向缩放：热区 mousedown → start_resize_dragging
  // 参数名须为 value，取值为 PascalCase 方向名（见本节顶部说明）
  //
  // ⚠️ 该命令不宜重试：原生拖拽循环一旦启动，再发一次会重设拖拽锚点，
  //    表现为窗口「跳一下」。故只在窗口尚未最大化（可缩放）时单发一次。
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
  // 账号项路由随登录态变化（未登录→登录页，已登录→个人中心）
  refreshAccountNav();
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

  // V9.2：「设置」→ 打开独立设置窗口（个人中心 / 同步设置 / API 管理）
  $('#sideSettingsBtn')?.addEventListener('click', async () => {
    closeUserMenu();
    try {
      await tauriInvoke('open_settings_window', {});
    } catch (e) {
      showToast('打开设置窗口失败：' + ((e && e.message) || e), 'err');
    }
  });

  // V9.2：设置窗口保存同步凭据 / 请求同步后，经 storage 事件通知本窗口
  window.addEventListener('storage', async (e) => {
    if (e.key !== 'kanseki_sync_reload') return;
    let wantSync = false;
    try { wantSync = !!(JSON.parse(e.newValue || '{}').sync); } catch (_) { /* 忽略 */ }
    try {
      if (store) {
        const u = await store.getMeta('webdav_username');
        const p = await store.getMeta('webdav_password');
        const user = (u && u.value) || '';
        const pass = (p && p.value) || '';
        if ($('#syncUser')) $('#syncUser').value = user;
        if ($('#syncPass')) $('#syncPass').value = pass;
        if (provider && user && pass) provider.setCredentials(user, pass);
        if (wantSync && engine) engine.sync('manual');
        showToast(wantSync ? '已按设置窗口的请求开始同步' : '同步凭据已更新', 'ok');
      }
    } catch (err) {
      showToast('重新载入同步凭据失败：' + ((err && err.message) || err), 'err');
    }
  });

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

  // ---------- 一键简繁切换（V0.8.2） ----------
  syncLangBtn();
  $('#langToggleBtn')?.addEventListener('click', toggleAppLang);
  // 查询页就绪后：同步按钮文字 + 订阅其字形变化。
  // 页内用户下拉里也有「简/繁」按钮，用户从那里切换时，
  // 标题栏按钮文字必须跟着变——同文档内的 localStorage 变更不触发
  // storage 事件，故由 index.html 的 KansekiLang.onChange 主动回调。
  whenFrameReady(document.getElementById(FRAMES.query), () => {
    const frame = document.getElementById(FRAMES.query);
    const api = frameLang(frame);
    if (api) {
      try {
        const cur = api.get();
        if (cur === 's' || cur === 't') {
          try { localStorage.setItem(LANG_KEY, cur); } catch (_) { /* 忽略 */ }
        }
      } catch (_) { /* 忽略 */ }
      // 只订阅一次（whenFrameReady 可能因多次进入查询页而重复触发）
      if (!frame.__kansekiLangHooked && typeof api.onChange === 'function') {
        frame.__kansekiLangHooked = true;
        try {
          api.onChange((lang) => {
            try { localStorage.setItem(LANG_KEY, lang); } catch (_) { /* 忽略 */ }
            syncLangBtn();
          });
        } catch (_) { /* 忽略 */ }
      }
    }
    syncLangBtn();
  });

  // 侧边栏「打开网页版」→ GitHub 项目页（V9.3 按用户要求改指向仓库页，
  // 而不是直接开线上站；项目页里能看到源码、更新日志与线上站入口）
  $('#openWebBtn')?.addEventListener('click', () => {
    const url = 'https://github.com/AnkoMaryken/kanseki-catalog';
    if (isTauri) {
      tauriInvoke('open_external', { url }).catch(() => { try { window.open(url, '_blank'); } catch (_) { } });
    } else {
      window.open(url, '_blank');
    }
  });

  // ---------- V9.3：右下角导出通知栏 ----------
  // 内嵌页面（古籍类目查询）导出后通过 postMessage 通知外壳，由外壳显示可操作的
  // 右下角横条 —— 用户能直接「打开文件 / 打开所在文件夹」，不再不知道文件下哪了。
  let noticeTimer = null;
  let lastExportPath = '';
  function hideNotice() {
    const bar = $('#noticeBar');
    if (bar) bar.hidden = true;
    clearTimeout(noticeTimer);
  }
  function showNotice(info) {
    const bar = $('#noticeBar');
    if (!bar) return;
    lastExportPath = info.path || '';
    $('#nbTitle').textContent = (info.kind ? info.kind + ' 导出完成' : '导出完成');
    const where = lastExportPath || '（浏览器默认下载目录）';
    $('#nbText').textContent = info.name ? (info.name + '\n' + where) : where;
    // 无路径（网页版）时无法用系统程序打开，隐藏这两个按钮，避免点了没反应
    const canOpen = !!lastExportPath && isTauri;
    if ($('#nbOpen')) $('#nbOpen').hidden = !canOpen;
    if ($('#nbReveal')) $('#nbReveal').hidden = !canOpen;
    bar.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, 20000);
  }
  window.addEventListener('message', (e) => {
    const d = e && e.data;
    if (!d || d.type !== 'kanseki-export') return;
    showNotice(d);
  });
  $('#nbClose')?.addEventListener('click', hideNotice);
  $('#nbOpen')?.addEventListener('click', async () => {
    if (!lastExportPath) return;
    const ok = await tauriInvoke('open_path', { path: lastExportPath }).then(() => true).catch(() => false);
    if (!ok) showToast('打开文件失败，可能已被移动或删除', 'err');
  });
  $('#nbReveal')?.addEventListener('click', async () => {
    if (!lastExportPath) return;
    const ok = await tauriInvoke('reveal_path', { path: lastExportPath }).then(() => true).catch(() => false);
    if (!ok) showToast('打开文件夹失败', 'err');
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

  // ---------- 就绪信号（V0.8.2） ----------
  // 外壳全部绑定完成、首屏已就绪。自动化探测脚本在点击标题栏之前必须等它，
  // 否则会踩在「DOM 已可见但监听尚未绑定」的空窗里（实测该空窗长达约 3s，
  // 见 index.html 中早期脚本与 app/scripts/diag_boot.cjs 的时间线）。
  // 这不只是测试问题：真实用户在这 3 秒内点击标题栏同样没有反应，
  // 该缺陷已由 index.html 里的早期接住脚本 + 这里的补发一同解决。
  window.__kansekiAppReady = true;
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
