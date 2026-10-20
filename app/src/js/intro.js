/* V1.8：首次启动开场动画 + 新手引导
 * 配色：白底为主 + 青柠高亮（与软件主题一致）
 * 只显示一次（localStorage 标记），设置 → 关于可重播。
 */
(function () {
  'use strict';

  var K_INTRO = 'kanseki_intro_seen';
  var K_ONBOARD = 'kanseki_onboarded';
  var $ = function (s) { return document.querySelector(s); };

  function has(key) { try { return localStorage.getItem(key) === '1'; } catch (e) { return false; } }
  function set(key, v) { try { localStorage.setItem(key, v ? '1' : '0'); } catch (e) { } }

  var introEl = null;
  var onboardEl = null;
  var introTimers = [];
  var obIndex = 0;

  var OB_STEPS = [
    {
      sel: '.side-sec:first-of-type',
      title: '这里是主功能导航',
      text: '工作台、纪年查询、古籍类目等全部功能都在左侧。可以 Ctrl+B 收起侧栏，Ctrl+K 直接跳到纪年检索。'
    },
    {
      sel: '[data-view="wb"]',
      title: '工作台',
      text: '打开就是工作台：每日推荐每日一换，右下角会自动检查新版本，问问 AI 的答案在页面浮窗里查看（支持 Markdown）。'
    },
    {
      sel: '[data-view="query"]',
      title: '纪年查询',
      text: '输入年号或年份查对应纪年，精确年份结果年号后带复制按钮，格式为「年号（公历年）」。'
    },
    {
      sel: '[data-view="seal"]',
      title: '小篆检字（测试功能）',
      text: '按字直查《说文》小篆字形，也可按部首检字；缺字会红色提示。'
    },
    {
      sel: '#sideSettingsBtn',
      title: '设置与更多',
      text: '点左下角或右上角进入设置（浮窗）：AI 配置、同步、快捷键、关于与开场重播都在这里。'
    }
  ];

  function clearTimers() { introTimers.forEach(function (t) { clearTimeout(t); }); introTimers = []; }

  // ---------------- 开场动画 ----------------
  function showIntro() {
    if (!introEl) return;
    introEl.hidden = false;
    try { document.documentElement.removeAttribute('data-first-run'); } catch (e) { }
    introEl.classList.remove('is-out');
    document.documentElement.classList.add('intro-lock');
    var canvas = $('#introCanvas');
    if (canvas) drawParticles(canvas);
    clearTimers();
    var start = $('#introStart');
    if (start) { start.hidden = true; start.disabled = true; start.classList.remove('is-in'); }
    var cap = $('#introCaption');
    if (cap) cap.textContent = '正在整理案头…';
    introTimers.push(setTimeout(function () {
      if (cap) cap.textContent = '准备就绪';
      if (start) { start.hidden = false; start.disabled = false; requestAnimationFrame(function () { start.classList.add('is-in'); }); }
    }, 2000));
    introTimers.push(setTimeout(function () {
      var p = $('#introProgress i');
      if (p) p.style.width = '100%';
    }, 60));
  }

  function hideIntro(thenOnboard) {
    if (!introEl) return;
    introEl.classList.add('is-out');
    clearTimers();
    set(K_INTRO, true);
    setTimeout(function () {
      introEl.hidden = true;
      introEl.classList.remove('is-out');
      document.documentElement.classList.remove('intro-lock');
      if (thenOnboard && !has(K_ONBOARD)) showOnboard();
    }, 620);
  }

  // 轻柔的纸面颗粒/光点
  function drawParticles(canvas) {
    var ctx = canvas.getContext('2d');
    function resize() {
      var r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * (window.devicePixelRatio || 1)));
      canvas.height = Math.max(1, Math.round(r.height * (window.devicePixelRatio || 1)));
    }
    resize();
    var W = canvas.width, H = canvas.height;
    var dots = [];
    for (var i = 0; i < 46; i++) {
      dots.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: (Math.random() * 1.6 + 0.5) * (window.devicePixelRatio || 1),
        vy: -(Math.random() * 0.22 + 0.05),
        a: Math.random() * 0.35 + 0.06
      });
    }
    var raf = null;
    function tick() {
      if (!introEl || introEl.hidden) { if (raf) cancelAnimationFrame(raf); return; }
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        d.y += d.vy;
        if (d.y < -6) { d.y = H + 6; d.x = Math.random() * W; }
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(200, 241, 105, ' + d.a + ')';
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    }
    tick();
    window.addEventListener('resize', function () { if (introEl && !introEl.hidden) { resize(); W = canvas.width; H = canvas.height; } });
  }

  // ---------------- 新手引导 ----------------
  function showOnboard() {
    if (!onboardEl) return;
    obIndex = 0;
    onboardEl.hidden = false;
    document.documentElement.classList.add('intro-lock');
    renderObStep();
  }

  function hideOnboard() {
    if (!onboardEl) return;
    onboardEl.hidden = true;
    document.documentElement.classList.remove('intro-lock');
    set(K_ONBOARD, true);
    var hole = $('#onboardHole');
    if (hole) hole.className = 'onboard-hole';
    document.querySelectorAll('.onboard-target').forEach(function (el) { el.classList.remove('onboard-target'); });
  }

  function renderObStep() {
    var step = OB_STEPS[obIndex];
    if (!step) return;
    var target = $(step.sel);
    var hole = $('#onboardHole');
    var card = $('#onboardCard');
    var title = $('#obTitle');
    var text = $('#obText');
    var num = $('#obStepNum');
    var prev = $('#obPrev');
    var next = $('#obNext');
    if (title) title.textContent = step.title;
    if (text) text.textContent = step.text;
    if (num) num.textContent = (obIndex + 1) + ' / ' + OB_STEPS.length;
    if (prev) prev.disabled = obIndex === 0;
    if (next) next.textContent = obIndex === OB_STEPS.length - 1 ? '开始使用' : '下一步';

    document.querySelectorAll('.onboard-target').forEach(function (el) { el.classList.remove('onboard-target'); });
    if (target && hole) {
      target.classList.add('onboard-target');
      var r = target.getBoundingClientRect();
      var pad = 6;
      hole.style.left = Math.max(6, r.left - pad) + 'px';
      hole.style.top = Math.max(6, r.top - pad) + 'px';
      hole.style.width = Math.min(window.innerWidth - 12, r.width + pad * 2) + 'px';
      hole.style.height = Math.min(window.innerHeight - 12, r.height + pad * 2) + 'px';
      hole.classList.add('on');
      // 引导卡片放在高亮区右侧/下方
      if (card) {
        var cw = 320;
        var left = r.right + 18;
        if (left + cw > window.innerWidth - 16) left = Math.max(16, r.left - cw - 18);
        var top = Math.min(Math.max(16, r.top), window.innerHeight - 230);
        card.style.left = left + 'px';
        card.style.top = top + 'px';
        card.style.transform = 'none';
      }
    } else if (hole) {
      hole.classList.remove('on');
      if (card) { card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%,-50%)'; }
    }
  }

  // ---------------- 初始化 ----------------
  function init() {
    introEl = $('#introOverlay');
    onboardEl = $('#onboardLayer');
    var start = $('#introStart');
    if (start) start.addEventListener('click', function () { hideIntro(true); });
    var obNext = $('#obNext');
    if (obNext) obNext.addEventListener('click', function () {
      if (obIndex >= OB_STEPS.length - 1) return hideOnboard();
      obIndex++; renderObStep();
    });
    var obPrev = $('#obPrev');
    if (obPrev) obPrev.addEventListener('click', function () { if (obIndex > 0) { obIndex--; renderObStep(); } });
    var obSkip = $('#obSkip');
    if (obSkip) obSkip.addEventListener('click', hideOnboard);
    window.addEventListener('resize', function () { if (onboardEl && !onboardEl.hidden) renderObStep(); });

    var force = /(\?|&)intro=1/.test(location.search) || /(^|&)intro=1/.test(location.hash);
    if (force || !has(K_INTRO)) {
      showIntro();
      if (force) { set(K_INTRO, false); set(K_ONBOARD, false); }
    }
    var replay = document.getElementById('replayIntro');
    if (replay) replay.addEventListener('click', function () {
      set(K_INTRO, false); set(K_ONBOARD, false);
      showIntro();
    });
    window.__kansekiIntro = {
      show: function () { set(K_INTRO, false); set(K_ONBOARD, false); showIntro(); },
      onboard: showOnboard
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
