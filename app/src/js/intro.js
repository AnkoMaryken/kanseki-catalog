/* V1.9：开场动画（logo × Ankoleopas × 全球汉籍合璧工程）+ 全功能新手引导
 * · 默认每次启动显示；设置中可关闭（kanseki_intro_enabled）
 * · 动画未完全出现时按钮即可点击（随时可进）
 * · 引导覆盖侧栏全部功能，设置/登录聚焦在侧栏底部登录栏
 */
(function () {
  'use strict';

  var K_ENABLED = 'kanseki_intro_enabled';
  var K_ONBOARD = 'kanseki_onboarded';
  var $ = function (s) { return document.querySelector(s); };

  var introEl = null;
  var onboardEl = null;
  var obIndex = 0;

  var OB_STEPS = [
    { sel: '[data-view="wb"]', title: '工作台', text: '打开软件先到这里：上方卡片可快速进入各功能，右下角「最近更新」会自动检查新版本，问问 AI 的答案在页面浮窗里查看（支持 Markdown）。' },
    { sel: '[data-view="query"]', title: '纪年查询', text: '输入年号或年份查对应纪年；精确年份结果年号后有复制按钮，格式为「年号（公历年）」。' },
    { sel: '[data-view="kanseki"]', title: '古籍类目', text: '按书名、著者或分类查古籍类目；支持批量查询，并可就单条或整批做 AI 复检。' },
    { sel: '[data-view="kansekidb"]', title: '日本所藏汉籍检索', text: '检索日本各藏书机构的汉籍目录，可查看原站详细著录信息。' },
    { sel: '[data-view="najdb"]', title: '日本国立公文书馆', text: '检索公文书馆数字档案，支持批量下载整册影像，下载中可暂停、优先、取消单本。' },
    { sel: '[data-view="records"]', title: '编目记录', text: '记录你的编目条目（当前暂停使用，数据会保留在本机）。' },
    { sel: '[data-view="catalog"][data-tab="0"]', title: '细则查阅', text: '查阅 2023.09 / 2025.10 两版编目细则，可按章节树跳转。' },
    { sel: '[data-view="catalog"][data-tab="1"]', title: '分类表', text: '按部、类、属查看分类体系与代表古籍。' },
    { sel: '[data-view="catalog"][data-tab="2"]', title: '工作手册', text: '工作手册 PDF 已内嵌，可直接翻阅。' },
    { sel: '[data-view="seal"]', title: '小篆检字（测试功能）', text: '按字直查《说文》小篆字形，也可按部首检字；缺字会红色提示。' },
    { sel: '[data-view="jump"]', title: '快速跳转', text: '常用古籍网站入口，点击后由系统默认浏览器打开。' },
    { sel: '[data-view="guide"]', title: '使用介绍', text: '完整的功能与操作说明，遇到问题先看这里。' },
    { sel: '[data-view="changelog"]', title: '更新日志', text: '查看每个版本的新增与修正。' },
    { sel: '#sideUserBtn', title: '登录 / 设置与更多', text: '侧栏底部这里是登录入口；点开后菜单里有「设置」——AI 配置、同步、快捷键、开场动画开关、关于与重播都在设置的浮窗里。' }
  ];

  function readEnabled() {
    try { return localStorage.getItem(K_ENABLED) !== '0'; } catch (e) { return true; }
  }
  function set(key, v) { try { localStorage.setItem(key, v ? '1' : '0'); } catch (e) { } }

  // 版本号：等 app.js 写入 window.__APP_VERSION（最多 3 秒）
  function watchVersion() {
    var el = $('#introVersion');
    if (!el) return;
    var tries = 0;
    (function tick() {
      var v = '';
      try { v = window.__APP_VERSION || ''; } catch (e) { }
      if (!v) { try { v = document.documentElement.dataset.appVersion || ''; } catch (e) { } }
      if (v) { el.textContent = 'v' + String(v).replace(/^v/i, ''); return; }
      if (tries++ > 30) return;
      setTimeout(tick, 100);
    })();
  }

  // ---------------- 开场 ----------------
  function showIntro() {
    if (!introEl) return;
    introEl.hidden = false;
    introEl.classList.remove('is-out');
    document.documentElement.classList.add('intro-lock');
    try { document.documentElement.removeAttribute('data-intro-default'); } catch (e) { }
    watchVersion();
  }

  function hideIntro(thenGuide) {
    if (!introEl) return;
    introEl.classList.add('is-out');
    document.documentElement.classList.remove('intro-lock');
    setTimeout(function () {
      introEl.hidden = true;
      introEl.classList.remove('is-out');
      if (thenGuide) showOnboard();
    }, 380);
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
    document.querySelectorAll('.onboard-target').forEach(function (el) { el.classList.remove('onboard-target'); });
    var hole = $('#onboardHole');
    if (hole) hole.classList.remove('on');
  }

  function renderObStep() {
    var step = OB_STEPS[obIndex];
    if (!step) return;
    var target = $(step.sel);
    var hole = $('#onboardHole');
    var card = $('#onboardCard');
    if ($('#obTitle')) $('#obTitle').textContent = step.title;
    if ($('#obText')) $('#obText').textContent = step.text;
    if ($('#obStepNum')) $('#obStepNum').textContent = (obIndex + 1) + ' / ' + OB_STEPS.length;
    if ($('#obPrev')) $('#obPrev').disabled = obIndex === 0;
    if ($('#obNext')) $('#obNext').textContent = obIndex === OB_STEPS.length - 1 ? '开始使用' : '下一步';

    document.querySelectorAll('.onboard-target').forEach(function (el) { el.classList.remove('onboard-target'); });
    if (target && hole) {
      try { target.scrollIntoView({ block: 'nearest' }); } catch (e) { }
      target.classList.add('onboard-target');
      var r = target.getBoundingClientRect();
      var pad = 6;
      hole.style.left = Math.max(6, r.left - pad) + 'px';
      hole.style.top = Math.max(6, r.top - pad) + 'px';
      hole.style.width = Math.min(window.innerWidth - 12, r.width + pad * 2) + 'px';
      hole.style.height = Math.min(window.innerHeight - 12, r.height + pad * 2) + 'px';
      hole.classList.add('on');
      if (card) {
        var cw = 330;
        var left = r.right + 18;
        if (left + cw > window.innerWidth - 16) left = Math.max(16, r.left - cw - 18);
        var top = Math.min(Math.max(16, r.top - 10), window.innerHeight - 250);
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

    var enter = $('#introEnter');
    if (enter) enter.addEventListener('click', function () { hideIntro(false); });
    var guide = $('#introGuide');
    if (guide) guide.addEventListener('click', function () { hideIntro(true); });

    if ($('#obNext')) $('#obNext').addEventListener('click', function () {
      if (obIndex >= OB_STEPS.length - 1) return hideOnboard();
      obIndex++; renderObStep();
    });
    if ($('#obPrev')) $('#obPrev').addEventListener('click', function () { if (obIndex > 0) { obIndex--; renderObStep(); } });
    if ($('#obSkip')) $('#obSkip').addEventListener('click', hideOnboard);
    window.addEventListener('resize', function () { if (onboardEl && !onboardEl.hidden) renderObStep(); });

    var force = /[?&]intro=1/.test(location.search) || /(^|&)intro=1/.test(location.hash);
    if (force || readEnabled()) showIntro();

    window.__kansekiIntro = {
      show: function () { showIntro(); },
      onboard: showOnboard,
      enabled: readEnabled
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
