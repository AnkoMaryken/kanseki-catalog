/* V1.8：基础防护（减少调试/右键另存/选中拖拽等低成本提取）
 * 说明：离线软件无法做到绝对防提取，这里只做「提高门槛」：
 *   1) 屏蔽右键菜单（输入框/可编辑区保留，便于复制粘贴）
 *   2) 屏蔽 F12 / Ctrl+Shift+I/J/C / Ctrl+U 等开发者工具与查看源码快捷键
 *   3) 禁止图片、链接被拖拽另存
 *   4) 页面内注入构建标识，便于溯源分发版本
 * 不修改任何业务功能，不影响正常复制文本。
 */
(function () {
  'use strict';
  var BUILD_TAG = 'kanseki-catalog';
  try {
    window.__KANSEKI_BUILD__ = BUILD_TAG;
    window.__KANSEKI_PROTECTED__ = true;
  } catch (e) { }

  function editable(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('input,textarea,[contenteditable="true"],.allow-native-menu')) return true;
    return false;
  }

  // 1) 右键菜单
  document.addEventListener('contextmenu', function (e) {
    if (editable(e.target)) return;
    e.preventDefault();
  }, true);

  // 2) 开发者工具 / 查看源码快捷键
  document.addEventListener('keydown', function (e) {
    var k = String(e.key || '').toUpperCase();
    if (k === 'F12') { e.preventDefault(); e.stopPropagation(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (k === 'I' || k === 'J' || k === 'C')) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 'U') {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);

  // 3) 拖拽另存
  document.addEventListener('dragstart', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'IMG' || t.tagName === 'A')) e.preventDefault();
  }, true);

  // 4) 图片长按/拖拽兼容
  document.addEventListener('selectstart', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG') e.preventDefault();
  }, true);
})();
