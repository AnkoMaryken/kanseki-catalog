/* ============================================
 * overlay.js — 数据层工具 (V8.2)
 * 职责: kanseki_overlay / kanseki_events / kanseki_catalog_overlay
 *       的 load/save/apply, storage 监听注册
 * 供 index.html 与 admin.html 共用
 * 约定: 录入数据一律存简体, 展示经 toDisplay()/toLang()
 * ============================================ */
(function () {
  'use strict';

  var KEYS = {
    OVERLAY: 'kanseki_overlay',           // {cn:[Op],jp:[Op],ot:[Op]}  Op={op:'add'|'edit'|'del',targetId,item?}
    EVENTS: 'kanseki_events',             // {"1644":[{id,year,title,desc,category,source,updatedAt}]}
    CATALOG_OVERLAY: 'kanseki_catalog_overlay', // {doc2023?,doc2025?,catalogTree?}
    VIEW_MODE: 'kanseki_view_mode'        // 'table' | 'card'
  };

  function safeParse(raw, fallback) {
    try {
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) { return fallback; }
  }

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  // ---------- 纪年覆盖层 ----------
  function emptyOverlay() { return { cn: [], jp: [], ot: [] }; }

  function loadOverlay() {
    var ov = safeParse(safeGet(KEYS.OVERLAY), null);
    if (!ov || typeof ov !== 'object') return emptyOverlay();
    ['cn', 'jp', 'ot'].forEach(function (k) {
      if (!Array.isArray(ov[k])) ov[k] = [];
    });
    return ov;
  }

  function saveOverlay(ov) {
    var clean = { cn: [], jp: [], ot: [] };
    if (ov) {
      ['cn', 'jp', 'ot'].forEach(function (k) {
        clean[k] = Array.isArray(ov[k]) ? ov[k] : [];
      });
    }
    return safeSet(KEYS.OVERLAY, JSON.stringify(clean));
  }

  // 依序应用 op 集, 返回合并后新数组 (不污染基线源数据)
  function applyOverlayToArray(baseArr, ops) {
    if (!Array.isArray(baseArr)) baseArr = [];
    var result = baseArr.map(function (item) {
      // 浅拷贝顶层 + eras 深拷贝, 避免污染基线
      var copy = {};
      for (var k in item) {
        if (Object.prototype.hasOwnProperty.call(item, k)) {
          copy[k] = (k === 'eras' && Array.isArray(item[k]))
            ? item[k].map(function (e) { return JSON.parse(JSON.stringify(e)); })
            : item[k];
        }
      }
      return copy;
    });
    if (!Array.isArray(ops)) return result;
    ops.forEach(function (op) {
      if (!op || !op.op) return;
      if (op.op === 'add') {
        if (op.item && op.item.id) result.push(JSON.parse(JSON.stringify(op.item)));
      } else if (op.op === 'edit') {
        var idx = -1;
        for (var i = 0; i < result.length; i++) {
          if (result[i].id === op.targetId) { idx = i; break; }
        }
        if (idx >= 0 && op.item) result[idx] = JSON.parse(JSON.stringify(op.item));
      } else if (op.op === 'del') {
        result = result.filter(function (x) { return x.id !== op.targetId; });
      }
    });
    return result;
  }

  // 对三个基线数组就地赋值合并结果
  // 用法: applyOverlayAll() — 自动从全局查找 (window 挂载的 let 变量);
  //       或 applyOverlayAll(cnArr, jpArr, otArr) — 显式传入数组引用 (IIFE 局部变量场景)
  function applyOverlayAll(cnArr, jpArr, otArr) {
    var ov = loadOverlay();
    if (cnArr !== undefined && Array.isArray(cnArr)) {
      var merged = applyOverlayToArray(cnArr, ov.cn);
      // 就地替换数组内容 (保持引用, 使调用方变量指向新数据)
      cnArr.length = 0;
      merged.forEach(function (x) { cnArr.push(x); });
      return;
    }
    var scope = (typeof window !== 'undefined') ? window : globalThis;
    if (Array.isArray(scope.CN_DYNASTIES)) scope.CN_DYNASTIES = applyOverlayToArray(scope.CN_DYNASTIES, ov.cn);
    if (Array.isArray(scope.JP_PERIODS)) scope.JP_PERIODS = applyOverlayToArray(scope.JP_PERIODS, ov.jp);
    if (Array.isArray(scope.OTHER_STATES)) scope.OTHER_STATES = applyOverlayToArray(scope.OTHER_STATES, ov.ot);
  }

  function resetOverlay() {
    safeRemove(KEYS.OVERLAY);
  }

  // ---------- 大事记 ----------
  function loadEvents() {
    var ev = safeParse(safeGet(KEYS.EVENTS), null);
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return {};
    return ev;
  }

  function saveEvents(evObj) {
    return safeSet(KEYS.EVENTS, JSON.stringify(evObj || {}));
  }

  function getEventsForYear(year) {
    var ev = loadEvents();
    var list = ev[String(year)];
    return Array.isArray(list) ? list : [];
  }

  function eventsHit(row, q) {
    if (!row || !q) return false;
    var list = getEventsForYear(row.year);
    if (!list.length) return false;
    var ql = String(q).toLowerCase();
    for (var i = 0; i < list.length; i++) {
      var it = list[i] || {};
      if ((it.title && String(it.title).toLowerCase().indexOf(ql) >= 0) ||
          (it.desc && String(it.desc).toLowerCase().indexOf(ql) >= 0) ||
          (it.source && String(it.source).toLowerCase().indexOf(ql) >= 0)) {
        return true;
      }
    }
    return false;
  }

  // ---------- 编目规范覆盖层 ----------
  function loadCatalogOverlay() {
    return safeParse(safeGet(KEYS.CATALOG_OVERLAY), null) || {};
  }
  function saveCatalogOverlay(obj) {
    return safeSet(KEYS.CATALOG_OVERLAY, JSON.stringify(obj || {}));
  }

  // ---------- storage 同步 (同源广播 → 防抖 reload) ----------
  function registerStorageSync() {
    if (typeof window === 'undefined') return;
    var timer = null;
    window.addEventListener('storage', function (e) {
      var key = e && e.key;
      if (!key) return;
      if (key === KEYS.OVERLAY || key === KEYS.EVENTS || key === KEYS.CATALOG_OVERLAY) {
        clearTimeout(timer);
        timer = setTimeout(function () {
          window.location.reload();
        }, 300);
      }
    });
  }

  // 导出全部用户改动 (overlay + events + catalogOverlay + quickLinks)
  function exportAllChanges() {
    var quick = [];
    try { quick = JSON.parse(localStorage.getItem('quickLinksCustom') || '[]'); } catch (e) { quick = []; }
    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      overlay: loadOverlay(),
      events: loadEvents(),
      catalogOverlay: loadCatalogOverlay(),
      quickLinks: Array.isArray(quick) ? quick : []
    };
  }

  // ---------- 导出 API ----------
  window.KansekiStore = {
    KEYS: KEYS,
    loadOverlay: loadOverlay,
    saveOverlay: saveOverlay,
    applyOverlayToArray: applyOverlayToArray,
    applyOverlayAll: applyOverlayAll,
    resetOverlay: resetOverlay,
    loadEvents: loadEvents,
    saveEvents: saveEvents,
    getEventsForYear: getEventsForYear,
    eventsHit: eventsHit,
    loadCatalogOverlay: loadCatalogOverlay,
    saveCatalogOverlay: saveCatalogOverlay,
    registerStorageSync: registerStorageSync,
    exportAllChanges: exportAllChanges
  };

  // 兼容旧调用名 (函数级全局, 便于 index/admin 内直接调用)
  window.loadOverlay = loadOverlay;
  window.saveOverlay = saveOverlay;
  window.applyOverlayToArray = applyOverlayToArray;
  window.applyOverlayAll = applyOverlayAll;
  window.resetOverlay = resetOverlay;
  window.loadEvents = loadEvents;
  window.saveEvents = saveEvents;
  window.getEventsForYear = getEventsForYear;
  window.eventsHit = eventsHit;
  window.loadCatalogOverlay = loadCatalogOverlay;
  window.saveCatalogOverlay = saveCatalogOverlay;
  window.registerStorageSync = registerStorageSync;
  window.exportAllChanges = exportAllChanges;
})();
