/* ============================================================
   古代史及汉籍研究工具 · PWA 注册与「添加到主屏幕」引导
   ------------------------------------------------------------
   只在普通浏览器里生效：
     · 桌面版（Tauri 内嵌 WebView）跳过 —— 它本身就是原生程序
     · 被外层页面以 iframe 嵌入时跳过 —— 避免重复注册
     · 非 http/https 协议跳过
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 环境判断 ---------- */
  var isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  var inFrame = (function () { try { return window.self !== window.top; } catch (_) { return true; } })();
  var okProto = (location.protocol === 'https:' || location.protocol === 'http:');
  if (isTauri || inFrame || !okProto) return;
  if (!('serviceWorker' in navigator)) return;

  var SW_URL = 'sw.js';
  var LS_KEY = 'pwa_bar_dismissed';
  var LS_INSTALLED = 'pwa_installed';

  /* ---------- 注册 Service Worker ---------- */
  // 页面加载时就已有控制器 → 说明本次是「更新」而非「首次安装」。
  // 首次安装时 clients.claim() 也会触发 controllerchange，若此时刷新会导致
  // 页面刚打开就多加载一次（自动化测试里表现为「执行上下文被销毁」）。
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(SW_URL).then(function (reg) {
      // 发现新版本：主动让新 SW 接管，然后刷新一次以用上最新缓存
      reg.addEventListener('updatefound', function () {
        var sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', function () {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            sw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(function () { /* 注册失败不影响主功能 */ });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) return;   // 首次安装：不刷新
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });

  /* ---------- 已安装就不打扰 ---------- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }
  function isMobileLike() {
    return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
      window.innerWidth <= 820;
  }
  function dismissed() {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch (_) { return false; }
  }
  function installed() {
    try { return localStorage.getItem(LS_INSTALLED) === '1'; } catch (_) { return false; }
  }

  /* ---------- 横幅样式（自注入，不改动各页面 CSS） ---------- */
  var CSS = [
    '.pwa-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));',
    'width:min(420px,calc(100vw - 24px));display:flex;align-items:center;gap:12px;padding:12px 14px;z-index:9998;',
    'background:var(--color-bg,#fff);color:var(--color-text,#171717);border:1px solid var(--color-border,#e5e5e5);',
    'border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.16);font-size:13px;line-height:1.4;',
    'animation:pwaIn .22s cubic-bezier(.2,0,0,1)}',
    '@keyframes pwaIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}',
    '.pwa-ic{width:38px;height:38px;flex:0 0 38px;border-radius:10px;display:block}',
    '.pwa-tx{flex:1;min-width:0}',
    '.pwa-tx b{display:block;font-weight:600;font-size:13.5px;margin-bottom:2px}',
    '.pwa-tx span{display:block;color:var(--color-text-secondary,#737373);font-size:11.5px}',
    '.pwa-go{flex:0 0 auto;border:0;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:600;',
    'padding:8px 14px;border-radius:999px;background:var(--color-primary,#171717);color:var(--color-bg,#fff)}',
    '.pwa-go:active{transform:scale(.97)}',
    '.pwa-x{flex:0 0 28px;width:28px;height:28px;border:0;background:none;cursor:pointer;color:var(--color-text-muted,#a3a3a3);',
    'font-size:15px;line-height:1;border-radius:50%}',
    '.pwa-x:hover{background:var(--color-surface-hover,#f5f5f5)}'
  ].join('');

  var deferredPrompt = null;
  var bar = null;

  function injectCSS() {
    if (document.getElementById('pwa-style')) return;
    var st = document.createElement('style');
    st.id = 'pwa-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function removeBar() {
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    bar = null;
  }

  function showBar(opts) {
    if (bar) removeBar();
    injectCSS();

    bar = document.createElement('div');
    bar.className = 'pwa-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', '安装到主屏幕');
    bar.innerHTML =
      '<img class="pwa-ic" src="assets/icon-192.png" alt="">' +
      '<div class="pwa-tx"><b>' + opts.title + '</b><span>' + opts.desc + '</span></div>' +
      '<button class="pwa-go" type="button">' + opts.action + '</button>' +
      '<button class="pwa-x" type="button" aria-label="关闭">✕</button>';

    document.body.appendChild(bar);

    bar.querySelector('.pwa-x').addEventListener('click', function () {
      try { localStorage.setItem(LS_KEY, '1'); } catch (_) { }
      removeBar();
    });

    bar.querySelector('.pwa-go').addEventListener('click', function () {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(function (res) {
          if (res && res.outcome === 'accepted') {
            try { localStorage.setItem(LS_INSTALLED, '1'); } catch (_) { }
          }
          deferredPrompt = null;
          removeBar();
        }).catch(function () { removeBar(); });
      } else {
        try { localStorage.setItem(LS_KEY, '1'); } catch (_) { }
        removeBar();
      }
    });
  }

  /* ---------- Android / Chrome：有原生安装事件 ---------- */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (isStandalone() || dismissed() || installed() || !isMobileLike()) return;
    setTimeout(function () {
      showBar({
        title: '安装到主屏幕',
        desc: '像 App 一样打开，离线也能查',
        action: '安装'
      });
    }, 1200);
  });

  window.addEventListener('appinstalled', function () {
    try { localStorage.setItem(LS_INSTALLED, '1'); } catch (_) { }
    removeBar();
  });

  /* ---------- iOS Safari：没有 install 事件，只能给操作指引 ---------- */
  function isIOS() {
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ 伪装成 Mac
    return (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  window.addEventListener('load', function () {
    if (!isIOS()) return;
    if (isStandalone() || dismissed() || installed()) return;

    // 只在 Safari 里提示（Chrome/微信内置浏览器不支持添加到主屏幕）
    var ua = navigator.userAgent || '';
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|MicroMessenger|QQBrowser|UCBrowser/.test(ua);
    if (!isSafari) return;

    setTimeout(function () {
      showBar({
        title: '添加到主屏幕',
        desc: '点下方「分享」→「添加到主屏幕」',
        action: '知道了'
      });
    }, 1600);
  });
})();
