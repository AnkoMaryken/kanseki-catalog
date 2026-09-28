/* ============================================
 * mobile-nav.js — 移动端汉堡抽屉 UI 层 (V8.2)
 * 供 5 个带 .header-nav 的页面共用:
 *   index / guide / catalog / changelog / embed
 * 桌面端 (.header-nav > a.nav-link) 结构原样保留,
 * 汉堡按钮/抽屉仅在 ≤768px 由 CSS 显示。
 * ============================================ */
(function () {
  'use strict';

  function initMobileNav() {
    var btn = document.getElementById('mHamburger');
    var drawer = document.getElementById('mDrawer');
    var overlay = document.getElementById('mDrawerOverlay');
    if (!btn || !drawer) return;

    function open() {
      drawer.classList.add('open');
      if (overlay) overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
      btn.setAttribute('aria-expanded', 'true');
    }
    function close() {
      drawer.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
      document.body.style.overflow = '';
      btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      drawer.classList.contains('open') ? close() : open();
    });
    if (overlay) overlay.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) close();
    });
    // 抽屉内链接点击后自动关闭
    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) close();
    });
    // 调整到桌面尺寸时自动关闭
    window.addEventListener('resize', function () {
      if (window.innerWidth > 768 && drawer.classList.contains('open')) close();
    });
  }

  // DOM ready 后初始化
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  window.initMobileNav = initMobileNav;
  onReady(initMobileNav);
})();
