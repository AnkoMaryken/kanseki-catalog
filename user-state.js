/* ================================================
 * user-state.js — 全站用户状态与头像管理 (V7.0)
 * -------------------------------------------------
 * 统一管理:
 *   - 登录态: localStorage 'kanseki_user' (email/id/name)
 *   - 个人资料: localStorage 'kanseki_profile' (avatar 头像数据)
 *   - 头像: 支持图片 base64 / 颜色+字符 / 默认首字母
 *   - 表头渲染: 已登录显示头像+昵称下拉, 未登录显示「登录」
 *
 * 依赖: 无 (纯原生 JS, 单文件零依赖)
 * 用法: 各页面 <script src="user-state.js"></script> 后调用
 *   UserState.isLoggedIn()
 *   UserState.getUser()
 *   UserState.getProfile()
 *   UserState.avatarHTML(size)
 *   UserState.renderHeaderAvatar(container)
 *   UserState.logout()
 *   UserState.getAvatarData() / UserState.setAvatarData(data)
 * ================================================ */
(function () {
  'use strict';

  var USER_KEY = 'kanseki_user';
  var PROFILE_KEY = 'kanseki_profile';

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  // 获取登录用户
  function getUser() { return read(USER_KEY); }
  function isLoggedIn() {
    var u = getUser();
    return !!(u && u.email);
  }
  // 显示名: profile.name > user.name > 邮箱前缀
  function getDisplayName() {
    var p = getProfile();
    if (p && p.name) return p.name;
    var u = getUser();
    if (u && u.name) return u.name;
    if (u && u.email) return u.email.split('@')[0];
    return '';
  }
  // 邮箱
  function getEmail() {
    var u = getUser();
    return u ? (u.email || '') : '';
  }

  // 个人资料 (头像等)
  function getProfile() { return read(PROFILE_KEY) || {}; }
  function setProfile(patch) {
    var p = Object.assign(getProfile(), patch || {});
    write(PROFILE_KEY, p);
    return p;
  }
  function getAvatarData() {
    var p = getProfile();
    return p.avatar || null; // { type: 'img', data: base64 } | { type: 'color', bg, char, fg }
  }
  function setAvatarData(av) {
    var p = getProfile();
    p.avatar = av;
    write(PROFILE_KEY, p);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 默认头像字符: 自定义字符 > 显示名首字 > '?'
  function avatarChar(av) {
    if (av && av.type === 'color' && av.char) return av.char;
    var name = getDisplayName();
    return (name && name.trim()) ? name.trim()[0] : '?';
  }

  // 生成头像 DOM 字符串
  function avatarHTML(size) {
    size = size || 28;
    var av = getAvatarData();
    var ch = avatarChar(av);
    var base = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;';
    var font = 'font-size:' + Math.round(size * 0.5) + 'px;font-weight:600;line-height:1;';
    if (av && av.type === 'img' && av.data) {
      return '<span class="user-avatar" style="' + base + 'background:#e8e8ec;"><img src="' + esc(av.data) + '" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></span>';
    }
    if (av && av.type === 'color' && av.bg) {
      return '<span class="user-avatar" style="' + base + font + 'background:' + esc(av.bg) + ';color:' + esc(av.fg || '#fff') + ';">' + esc(ch) + '</span>';
    }
    // 默认: 按邮箱哈希取色
    var colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#0ea5e9', '#f43f5e'];
    var idx = 0;
    var em = getEmail() || getDisplayName() || '?';
    for (var i = 0; i < em.length; i++) idx = (idx + em.charCodeAt(i)) % colors.length;
    var bg = colors[idx];
    return '<span class="user-avatar" style="' + base + font + 'background:' + bg + ';color:#fff;">' + esc(ch) + '</span>';
  }

  // 渲染表头用户区: 已登录 → 头像+昵称下拉; 未登录 → 登录链接
  // 参数: container = .user-dropdown 元素
  function renderHeaderAvatar(container) {
    if (!container) return;
    var btn = container.querySelector('.user-btn');
    if (!btn) return;
    var logged = isLoggedIn();

    var labelEl = container.querySelector('.user-btn-label');
    if (!labelEl) {
      // 兼容旧结构: user-btn 内是 <a class="user-login-link">登录</a><svg ...>
      var oldLink = container.querySelector('.user-login-link');
      if (oldLink) {
        var wrap = document.createElement('span');
        wrap.className = 'user-btn-label';
        oldLink.parentNode.replaceChild(wrap, oldLink);
        labelEl = wrap;
      }
    }

    var menu = container.querySelector('.user-menu');
    // 记录原始菜单结构: single = 单个「登录 / 注册」链接 (index), dual = 「登录」「注册」两个链接 (其余四页)
    if (menu && !menu.dataset.us) {
      menu.dataset.us = menu.querySelector('.user-menu-login') ? 'single' : 'dual';
    }

    if (!logged) {
      // 未登录: 显示「登录」链接
      if (labelEl) {
        labelEl.innerHTML = '<a href="login.html" class="user-login-link">登录</a>';
      }
      // 菜单恢复为登录/注册 (若之前渲染过已登录菜单)
      if (menu && menu.dataset.us) {
        var lw = menu.querySelector('.user-menu-logged');
        if (lw) {
          lw.parentNode.removeChild(lw);
          if (menu.dataset.us === 'single') {
            var a1 = document.createElement('a');
            a1.href = 'login.html';
            a1.setAttribute('role', 'menuitem');
            a1.className = 'user-menu-login';
            a1.textContent = '登录 / 注册';
            menu.appendChild(a1);
          } else {
            var a2 = document.createElement('a');
            a2.href = 'login.html';
            a2.setAttribute('role', 'menuitem');
            a2.textContent = '登录';
            menu.appendChild(a2);
            var a3 = document.createElement('a');
            a3.href = 'signup.html';
            a3.setAttribute('role', 'menuitem');
            a3.textContent = '注册';
            menu.appendChild(a3);
          }
        }
      }
      return;
    }

    // 已登录: 头像 + 昵称
    var name = getDisplayName() || '用户';
    if (labelEl) {
      labelEl.innerHTML = avatarHTML(26) + '<span class="user-btn-name" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.85rem;margin-left:6px;">' + esc(name) + '</span>';
    }

    // 菜单: 已登录 → 个人中心/退出 (移除登录/注册链接, 保留显示字形等区块)
    if (menu && menu.dataset.us) {
      if (!menu.querySelector('.user-menu-logged')) {
        var loginLinks = menu.querySelectorAll('a[href="login.html"], a[href="signup.html"]');
        for (var i = 0; i < loginLinks.length; i++) {
          loginLinks[i].parentNode.removeChild(loginLinks[i]);
        }
        // 仅当菜单中还有其他区块 (如 index 的字形切换区) 时加分隔线
        var onlyChild = menu.children.length === 0;
        var div = document.createElement('div');
        div.className = 'user-menu-logged' + (onlyChild ? '' : ' user-menu-logged-divider');
        div.innerHTML =
          '<a href="profile.html" role="menuitem" class="user-menu-item user-menu-profile">个人中心</a>' +
          '<a href="#" role="menuitem" class="user-menu-item user-menu-logout" id="userMenuLogout">退出登录</a>';
        menu.appendChild(div);
        var lo = div.querySelector('#userMenuLogout');
        if (lo) {
          lo.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            UserState.logout();
          });
        }
      }
    }
  }

  // 注入公共样式 (自包含, 各页无需手写 CSS)
  var STYLE_ID = 'user-state-style';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.user-btn-label{display:inline-flex;align-items:center;justify-content:center;}' +
      '.user-btn-name{display:inline-block;}' +
      '.user-menu-logged{display:flex;flex-direction:column;padding:0;}' +
      '.user-menu-logged-divider{border-top:1px solid var(--color-border,#e5e5e5);margin-top:.25rem;padding-top:.25rem;}' +
      '.user-menu-logged .user-menu-item{display:flex;align-items:center;gap:8px;padding:.5rem .75rem;border-radius:var(--radius-sm,8px);color:var(--color-text-secondary,#525252);font-size:.85rem;text-decoration:none;transition:all .15s;white-space:nowrap;}' +
      '.user-menu-logged .user-menu-item:hover{background:var(--color-surface-hover,#f5f5f5);color:var(--color-text,#0a0a0a);}' +
      '.user-menu-logged .user-menu-profile{color:var(--color-text,#0a0a0a);}' +
      '.user-menu-logged .user-menu-logout{color:#dc2626;}' +
      '.user-menu-logged .user-menu-logout:hover{background:rgba(220,38,38,.08);color:#dc2626;}' +
      '.user-menu-logged .user-menu-item + .user-menu-item{border-top:1px solid var(--color-border,#e5e5e5);}' +
      '.user-avatar{user-select:none;-webkit-user-select:none;}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // 各页面初始化: 渲染表头用户区 (已登录/未登录)
  function initHeader() {
    injectStyles();
    var ud = document.querySelector('.user-dropdown');
    if (ud) renderHeaderAvatar(ud);
  }

  // 退出登录 (清本地状态, 演示模式下直接登出; 真实模式由 SupabaseAuth 处理)
  function logout() {
    try { localStorage.removeItem(USER_KEY); } catch (e) {}
    // 保留 profile (头像等个人资料), 仅清登录态
    if (window.SupabaseAuth && window.SupabaseAuth.signOut) {
      window.SupabaseAuth.signOut().then(function () {
        location.href = 'index.html';
      }).catch(function () {
        location.href = 'index.html';
      });
      return;
    }
    location.href = 'index.html';
  }

  window.UserState = {
    isLoggedIn: isLoggedIn,
    getUser: getUser,
    getDisplayName: getDisplayName,
    getEmail: getEmail,
    getProfile: getProfile,
    setProfile: setProfile,
    getAvatarData: getAvatarData,
    setAvatarData: setAvatarData,
    avatarHTML: avatarHTML,
    renderHeaderAvatar: renderHeaderAvatar,
    initHeader: initHeader,
    logout: logout,
    USER_KEY: USER_KEY,
    PROFILE_KEY: PROFILE_KEY
  };
})();

// 页面加载后自动渲染表头 (无需各页手写调用)
(function () {
  if (typeof window === 'undefined') return;
  function boot() { UserState.initHeader(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
