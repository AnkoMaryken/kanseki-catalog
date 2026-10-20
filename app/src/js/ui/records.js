// ================================================
// js/ui/records.js — 编目记录视图（V9.5 正式版）
// ================================================
// 字段模型：core/catalog-record-schema.js（源自【27】編目表格模板.xlsx，14 列）
// 存储：IndexedDB kanseki-app.catalog_records（schema v1 已预建，无迁移成本）
//   · 写入走 KansekiStore.putRecordValue + pushChange，交给 sync-engine 同步
//   · 删除为**软删除（墓碑）**，与 quick_links 同策略，保证多端合并能传播删除
// 导出：CSV（带表头，桌面版走 system::save_export —— 自动加 BOM，Excel 不乱码）
//
// 与检索面板的联动：日本藏本检索／国立公文书馆面板可写
// window.__kansekiPendingRecord 后跳到本视图，本模块只带入**有把握**的字段，
// 其余留空由编目者按实物著录（绝不臆造卷数、版式、函册等）。
// ================================================
import {
  REQUIRED_FIELDS, OPTIONAL_FIELDS, ALL_FIELDS, FIELD_DEFS,
  createEmptyRecord, validateRecord, sortRecords, searchRecords,
  makeNewRecord, markDeleted, touchUpdated,
} from '../core/catalog-record-schema.js';
import { toDisplay } from '../core/conv.js';
// V9.7：表格导入（xlsx/csv）+ 表格/文字两种呈现与导出（纯逻辑模块，见 record-io.js）
import {
  parseTableFile, mapRowsToRecords, recordToText, recordsToText,
  recordsToTableRows, recordsToCsv, csvCell, TABLE_COLUMNS,
} from './record-io.js';

const STORE_RECORDS = 'catalog_records';

// ================================================================
// V1.3（task-20）编目记录「暂时封禁使用」
// ----------------------------------------------------------------
// · 功能暂停期间：整页只显示「暂停使用」提示 + 只读记录条数，
//   不渲染操作工具栏、不绑定编辑/批量删除等事件，**已有数据不删除**。
// · 解锁开关（供以后恢复）：
//     - 常量 RECORDS_FEATURE_ENABLED = true 即恢复全部功能；
//     - localStorage 键 kanseki_records_locked 保留（默认锁定）；
//     - 封禁期间用户不可自助解锁（UI 无开关；外部把键改成 '0' 也会被复位）。
// · 开发/自动化测试可在页面脚本前设 window.__kansekiRecordsUnlock = true，
//   仅用于自测与以后恢复时的临时验证，普通界面不暴露。
// ================================================================
const RECORDS_LOCKED_KEY = 'kanseki_records_locked';
const RECORDS_LOCKED_DEFAULT = true;
const RECORDS_FEATURE_ENABLED = false;   // ← 以后恢复功能：改为 true

function recordsLocked() {
  if (RECORDS_FEATURE_ENABLED) return false;
  if (typeof window !== 'undefined' && window.__kansekiRecordsUnlock === true) return false;
  const view = el('view-records');
  const attr = view && view.getAttribute('data-records-locked');
  if (attr === '0' || attr === 'false') return false;
  let v = null;
  try { v = localStorage.getItem(RECORDS_LOCKED_KEY); } catch (_) { /* 忽略 */ }
  // 封禁期间：默认锁定；外部写入 '0' 不生效并立即复位，防止用户自助解锁
  if (v === '0' || v === 'false') {
    try { localStorage.setItem(RECORDS_LOCKED_KEY, String(RECORDS_LOCKED_DEFAULT)); } catch (_) { /* 忽略 */ }
  } else if (v == null) {
    try { localStorage.setItem(RECORDS_LOCKED_KEY, String(RECORDS_LOCKED_DEFAULT)); } catch (_) { /* 忽略 */ }
  }
  return RECORDS_LOCKED_DEFAULT;
}

export function isRecordsLocked() {
  return recordsLocked();
}

let deps = {
  getStore: () => null,
  isTauri: false,
  invoke: null,
};

const state = {
  records: [],
  keyword: '',
  sort: 'desc',
  editing: null,     // 正在编辑的记录（null = 新增）
  rendered: false,   // 表单字段是否已生成
  bound: false,
  loading: false,
  view: 'card',      // 预览方式：card（卡片）| table（表格预览，同编目表格模板）| text（文字预览，按著录格式成文）
  selected: new Set(), // V1.3：批量删除勾选集合（记录 id）
  locked: false,     // V1.3：本页实例是否处于「暂停使用」状态
  bulkBar: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const el = (id) => document.getElementById(id);

function toast(msg, type) {
  if (window.__kansekiToast) window.__kansekiToast(msg, type);
}

// ---------------------------------------------------------------- 初始化
export function initRecordsView(options = {}) {
  deps = Object.assign({}, deps, options || {});
  if (state.bound) return;
  state.bound = true;
  injectRecordsStyles();

  // V1.3：封禁态——整页替换为提示 + 只读统计；不绑定任何编辑/删除事件
  if (recordsLocked()) {
    state.locked = true;
    renderLockedView();
    return;
  }

  const overlay = el('recordFormOverlay');
  if (!overlay) return;

  // 解锁态：确保 Lead 预置的暂停提示块处于收起状态
  hideLockedView();
  el('addRecordBtn')?.addEventListener('click', () => openForm(null));
  el('recordFormClose')?.addEventListener('click', closeForm);
  el('recordFormCancel')?.addEventListener('click', closeForm);
  el('recordFormSubmit')?.addEventListener('click', saveForm);
  el('recordFormDelete')?.addEventListener('click', () => {
    if (state.editing) requestDelete(state.editing.id);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeForm(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeForm();
  });

  // 实时必填提示
  overlay.addEventListener('input', (e) => {
    const fieldEl = e.target.closest('.av-field');
    if (!fieldEl) return;
    const f = fieldEl.dataset.field;
    const def = FIELD_DEFS[f];
    if (!def || !def.required) return;
    const errEl = fieldEl.querySelector('.field-error');
    const empty = !e.target.value.trim();
    errEl.textContent = empty ? '此项为必填' : '';
    errEl.hidden = !empty;
  });

  el('recordsSearch')?.addEventListener('input', (e) => {
    state.keyword = e.target.value;
    renderList();
  });
  el('recordsSort')?.addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderList();
  });

  // V9.7：预览方式切换（卡片 / 表格 / 文字）
  $$('.rec-vs').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.recView));
  });

  // V9.7：导入表格（Excel/CSV）与两种导出
  el('recordsImportBtn')?.addEventListener('click', () => el('recordsImportFile')?.click());
  el('recordsImportFile')?.addEventListener('change', onImportFile);
  el('recordsExportTableBtn')?.addEventListener('click', () => exportAs('table'));
  el('recordsExportTextBtn')?.addEventListener('click', () => exportAs('text'));

  // 记住上次选择的预览方式（卡片/表格/文字）
  try {
    const saved = localStorage.getItem('kanseki_records_view');
    if (['card', 'table', 'text'].includes(saved)) {
      state.view = saved;
      $$('.rec-vs').forEach((b) => b.classList.toggle('on', b.dataset.recView === saved));
    }
  } catch (_) { /* 忽略 */ }

  el('recordsList')?.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-rec-edit]');
    if (edit) {
      const rec = state.records.find((r) => r.id === edit.dataset.recEdit);
      if (rec) openForm(rec);
      return;
    }
    const del = e.target.closest('[data-rec-del]');
    if (del) requestDelete(del.dataset.recDel);
  });

  // V1.3：批量删除（行复选 / 全选 / 已选 N 条 / 批量删除）
  ensureBulkBar();
  bindBatchSelection();
}

/** 进入视图时调用：读库 + 消费检索面板带来的带入数据 */
export async function refreshRecordsView() {
  // V1.3：封禁态只刷新只读条数，不读表单、不消费带入数据
  if (state.locked || recordsLocked()) {
    state.locked = true;
    renderLockedView();
    await refreshLockedCount();
    return;
  }
  hideLockedView();
  await loadRecords();
  consumePendingRecord();
}

// ---------------------------------------------------------------- V1.3 封禁态 UI
/** 注入本模块专用样式（不改 index.html / 不改公共 CSS） */
function injectRecordsStyles() {
  if (el('recordsNative3Style')) return;
  const style = document.createElement('style');
  style.id = 'recordsNative3Style';
  style.textContent = `
/* —— 暂停使用 ——
   优先使用 index.html 里 Lead 预置的 #recordsLocked 提示块；锁定时隐藏
   .rec-wrap 里除提示块以外的全部内容；解锁时把提示块收起。 */
#view-records.is-records-locked .rec-wrap{padding-top:26px}
#view-records.is-records-locked .rec-wrap > *:not(#recordsLocked){display:none !important}
#view-records.is-records-locked #recordsLocked{display:block !important;max-width:860px;margin:0 auto 14px}
#view-records.rec-locked-fallback .rec-wrap{display:none !important}
.rec-lock-wrap{flex:1 1 auto;display:flex;align-items:flex-start;justify-content:center;padding:44px 24px 60px;width:100%;box-sizing:border-box}
.rec-lock-card{max-width:520px;width:100%;text-align:center;padding:34px 30px 30px}
.rec-lock-badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--text-muted);background:var(--bg);border-radius:999px;padding:3px 10px;margin-bottom:14px}
.rec-lock-title{font-size:16px;font-weight:700;color:var(--text);margin:0 0 8px;line-height:1.45}
.rec-lock-desc{font-size:13px;line-height:1.8;color:var(--text-sec);margin:0 0 16px}
.rec-lock-count{font-size:12.5px;color:var(--text-muted);border-top:1px solid var(--divider);padding-top:14px}
.rec-lock-count b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
/* —— 批量删除 —— */
.rec-bulkbar{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;flex-basis:100%;margin:2px 0 0;padding:8px 0 0;border-top:1px solid var(--divider)}
.rec-bulkbar[hidden]{display:none !important}
.rec-bulk-all{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--text-sec);cursor:pointer;white-space:nowrap}
.rec-bulk-count{font-size:12px;color:var(--text-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.rec-bulk-count b{color:var(--text);font-weight:600}
.rec-bulkbar .av-btn{height:30px;padding:0 12px;font-size:12px}
.rec-check{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;padding-top:2px;cursor:pointer}
.rec-check input[type="checkbox"],.rec-bulk-all input[type="checkbox"],.rec-table input[type="checkbox"]{width:14px;height:14px;accent-color:var(--accent);cursor:pointer;margin:0}
.rec-check-th{width:30px !important;text-align:center !important;padding-left:6px !important;padding-right:6px !important}
.rec-check-td{width:30px;text-align:center;padding-left:6px !important;padding-right:6px !important}
.rec-text-item .rec-check{float:left;margin-right:8px}
.rec-text-item{overflow:hidden}
`;
  document.head.appendChild(style);
}

const LOCKED_HTML = `
  <div class="av-card rec-locked">
    <h3 class="rec-locked-title">编目记录功能暂停使用</h3>
    <p class="rec-locked-sub">已有编目数据仍保存在本机，不会丢失；恢复使用时会自动读回。</p>
    <p class="rec-locked-count">本机现有记录：<b id="recordsLockedCount">—</b> 条</p>
  </div>`;

/** 取/建锁定时显示的提示块；有 Lead 预置的 #recordsLocked 就直接用 */
function ensureLockedBlock() {
  const view = el('view-records');
  if (!view) return null;
  let box = el('recordsLocked');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'recordsLocked';
  const holder = document.createElement('div');
  holder.className = 'rec-lock-wrap';
  holder.setAttribute('role', 'status');
  holder.innerHTML = LOCKED_HTML;
  box.appendChild(holder);
  view.appendChild(box);
  view.classList.add('rec-locked-fallback');
  box.dataset.fallback = '1';
  return box;
}

/** 封禁态：隐藏原操作区，显示提示 + 只读条数（不删除任何数据） */
function renderLockedView() {
  const view = el('view-records');
  if (!view) return;
  view.classList.add('is-records-locked');
  const box = ensureLockedBlock();
  if (box) {
    box.hidden = false;
    box.style.display = '';
  }
  // Lead 预置块若没有条目数元素，按同一版式补一个
  if (!el('recordsLockedCount')) {
    const p = document.createElement('p');
    p.className = 'rec-locked-count';
    p.innerHTML = '本机现有记录：<b id="recordsLockedCount">—</b> 条';
    (box && (box.querySelector('.av-card') || box))?.appendChild(p);
  }
  // 录入弹层不允许出现在封禁态
  const overlay = el('recordFormOverlay');
  if (overlay) overlay.hidden = true;
  document.body.style.overflow = '';
  state.records = [];
  state.selected.clear();
  if (state.bulkBar) state.bulkBar.hidden = true;
  if (typeof window !== 'undefined') window.__recordsLocked = true;
}

/** 解锁态：把暂停使用提示块收起（Lead 预置块在解锁后不应出现） */
function hideLockedView() {
  const view = el('view-records');
  if (view) view.classList.remove('is-records-locked', 'rec-locked-fallback');
  const box = el('recordsLocked');
  if (box) { box.hidden = true; box.style.display = 'none'; }
}

/** 封禁态只读条数（数据照旧读出来数一数，不做任何写操作） */
async function refreshLockedCount(attempt = 0) {
  const store = deps.getStore && deps.getStore();
  const cnt = el('recordsLockedCount');
  if (!store) {
    if (cnt) cnt.textContent = '—';
    if (attempt < 6) setTimeout(() => { refreshLockedCount(attempt + 1); }, 500);
    return;
  }
  try {
    const all = await store.getAllRecords();
    const total = (all || []).filter((r) => r && !r.deletedAt).length;
    if (cnt) cnt.textContent = String(total);
    if (typeof window !== 'undefined') window.__recordsLockedCount = total;
  } catch (e) {
    if (cnt) cnt.textContent = '—';
  }
}

// ---------------------------------------------------------------- V1.3 批量删除
function ensureBulkBar() {
  if (state.bulkBar && document.body.contains(state.bulkBar)) return state.bulkBar;
  let bar = el('recordsBulkBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'rec-bulkbar';
    bar.id = 'recordsBulkBar';
    bar.hidden = true;
    bar.innerHTML = `
      <label class="rec-bulk-all"><input type="checkbox" id="recordsSelectAll"> 全选</label>
      <span class="rec-bulk-count" id="recordsSelCount">已选 <b>0</b> 条</span>
      <button class="av-btn rec-danger" id="recordsBulkDelete" type="button" disabled>批量删除</button>`;
    const toolbar = document.querySelector('#view-records .rec-toolbar');
    if (toolbar) toolbar.appendChild(bar);
    else {
      const card = document.querySelector('#view-records .rec-listcard');
      if (card && card.parentNode) card.parentNode.insertBefore(bar, card);
      else el('view-records')?.appendChild(bar);
    }
  }
  state.bulkBar = bar;
  return bar;
}

function bindBatchSelection() {
  const view = el('view-records');
  if (!view) return;
  // 卡片 / 表格 / 文字三种视图的复选框（事件委托）
  view.addEventListener('change', (e) => {
    const all = e.target.closest('[data-rec-all]');
    if (all) { selectAllVisible(all.checked); return; }
    const cb = e.target.closest('[data-rec-check]');
    if (!cb) return;
    if (cb.checked) state.selected.add(cb.dataset.recCheck);
    else state.selected.delete(cb.dataset.recCheck);
    updateBulkBar();
  });
  el('recordsSelectAll')?.addEventListener('change', (e) => selectAllVisible(e.target.checked));
  el('recordsBulkDelete')?.addEventListener('click', batchDeleteSelected);
}

/** 全选 / 全不选（只作用于当前可见列表） */
function selectAllVisible(checked) {
  for (const r of visibleRecords()) {
    if (checked) state.selected.add(r.id);
    else state.selected.delete(r.id);
  }
  document.querySelectorAll('#view-records [data-rec-check]').forEach((cb) => {
    cb.checked = !!checked && state.selected.has(cb.dataset.recCheck);
  });
  updateBulkBar();
}

function updateBulkBar() {
  const bar = state.bulkBar || el('recordsBulkBar');
  if (!bar) return;
  const total = state.records.length;
  bar.hidden = total === 0;
  const n = state.selected.size;
  const cnt = el('recordsSelCount');
  if (cnt) cnt.innerHTML = `已选 <b>${n}</b> 条`;
  const del = el('recordsBulkDelete');
  if (del) del.disabled = n === 0;
  const vis = visibleRecords();
  const selVis = vis.filter((r) => state.selected.has(r.id)).length;
  const allChecked = vis.length > 0 && selVis === vis.length;
  const partial = selVis > 0 && selVis < vis.length;
  const master = el('recordsSelectAll');
  if (master) { master.checked = allChecked; master.indeterminate = partial; }
  const thAll = document.querySelector('#view-records [data-rec-all]');
  if (thAll) { thAll.checked = allChecked; thAll.indeterminate = partial; }
}

/** 批量删除（软删除墓碑；二次确认；删除后刷新列表/计数并提示） */
async function batchDeleteSelected() {
  const ids = Array.from(state.selected);
  if (!ids.length) { toast('请先勾选要删除的记录', 'err'); return; }
  if (!window.confirm(`确定删除选中的 ${ids.length} 条编目记录？\n（软删除，会随同步传播到其它设备；本机数据删除后不可恢复）`)) return;
  const store = deps.getStore && deps.getStore();
  if (!store) { toast('存储未就绪，暂时无法删除', 'err'); return; }
  let done = 0;
  try {
    for (const id of ids) {
      const rec = state.records.find((r) => r.id === id);
      if (!rec) continue;
      const tomb = markDeleted(rec, store.deviceId);
      await store.putRecordValue(tomb);
      await store.pushChange(STORE_RECORDS, tomb.id);
      done++;
    }
    state.selected.clear();
    await loadRecords();
    toast(`已删除 ${done} 条编目记录`, 'ok');
  } catch (e) {
    state.selected.clear();
    await loadRecords();
    toast('批量删除失败：' + ((e && e.message) || e), 'err');
  }
}

// ---------------------------------------------------------------- 读库
async function loadRecords() {
  const store = deps.getStore && deps.getStore();
  if (!store) {
    // 存储尚未就绪：显示空态但明确说明，不假装「没有记录」
    state.records = [];
    renderList();
    const box = el('recordsEmpty');
    if (box) box.hidden = false;
    el('recordsCount').textContent = '存储未就绪';
    return;
  }
  state.loading = true;
  try {
    const all = await store.getAllRecords();
    state.records = (all || []).filter((r) => r && !r.deletedAt);
  } catch (e) {
    toast('读取编目记录失败：' + ((e && e.message) || e), 'err');
    state.records = [];
  } finally {
    state.loading = false;
  }
  renderList();
}

function nextSeq() {
  let max = 0;
  for (const r of state.records) {
    const n = Number(r.seq) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

// ---------------------------------------------------------------- 列表渲染
function visibleRecords() {
  const filtered = searchRecords(state.records, state.keyword);
  if (state.sort === 'seq') {
    return [...filtered].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  }
  return sortRecords(filtered, state.sort);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderList() {
  const listBox = el('recordsList');
  const tableBox = el('recordsTableWrap');
  const textBox = el('recordsTextWrap');
  const emptyBox = el('recordsEmpty');
  if (!listBox) return;
  if (state.locked) return;   // 封禁态整页由提示块接管，不渲染列表
  const rows = visibleRecords();
  const total = state.records.length;

  // 勾选集合只保留仍存在的记录（删除/同步后自动收敛）
  if (state.selected.size) {
    const ids = new Set(state.records.map((r) => r.id));
    for (const id of Array.from(state.selected)) if (!ids.has(id)) state.selected.delete(id);
  }

  const countEl = el('recordsCount');
  if (countEl) countEl.textContent = total ? `共 ${total} 条${state.keyword ? ` · 命中 ${rows.length} 条` : ''}` : '';

  // 三个容器按当前预览方式只显示一个
  const showCard = state.view === 'card';
  const showTable = state.view === 'table';
  const showText = state.view === 'text';
  if (tableBox) tableBox.hidden = !(showTable && rows.length > 0);
  if (textBox) textBox.hidden = !(showText && rows.length > 0);
  listBox.hidden = !(showCard && rows.length > 0);

  if (!rows.length) {
    listBox.innerHTML = '';
    if (tableBox) tableBox.innerHTML = '';
    if (textBox) textBox.innerHTML = '';
    if (emptyBox) {
      emptyBox.hidden = false;
      // 有记录但搜索无命中时，文案要说清是「搜索无结果」而非「没有记录」
      const h3 = emptyBox.querySelector('h3');
      const sub = emptyBox.querySelector('.av-empty-sub');
      if (total && state.keyword) {
        if (h3) h3.textContent = '没有匹配的记录';
        if (sub) sub.textContent = `「${state.keyword}」未命中任何记录（共 ${total} 条）。可搜索書名／索書號／著者／類目。`;
      } else {
        if (h3) h3.textContent = '还没有编目记录';
        if (sub) sub.textContent = '点右上角「＋ 新增编目」按模板著录，或「导入表格」把 Excel/CSV 编目表一次性导入。';
      }
    }
    updateBulkBar();
    return;
  }
  if (emptyBox) emptyBox.hidden = true;
  if (showCard) listBox.innerHTML = rows.map(rowHtml).join('');
  if (showTable && tableBox) tableBox.innerHTML = tableHtml(rows);
  if (showText && textBox) textBox.innerHTML = textHtml(rows);
  updateBulkBar();
}

/** 预览方式：card | table | text */
function setView(v) {
  if (!['card', 'table', 'text'].includes(v)) return;
  state.view = v;
  $$('.rec-vs').forEach((b) => b.classList.toggle('on', b.dataset.recView === v));
  try { localStorage.setItem('kanseki_records_view', v); } catch (_) { /* 忽略 */ }
  renderList();
}

/** 表格预览：与「编目表格」模板同 14 列（序號 + 13 业务字段）；V1.3 增加行复选列 */
function tableHtml(rows) {
  const { headers, rows: body } = recordsToTableRows(rows);
  const head = '<th class="rec-check-th"><input type="checkbox" data-rec-all title="全选当前列表" aria-label="全选当前列表"></th>'
    + headers.map((h) => `<th>${escHtml(h)}</th>`).join('');
  const trs = body.map((r, i) => {
    const rec = rows[i] || {};
    const checked = state.selected.has(rec.id) ? ' checked' : '';
    const tds = r.map((c) => {
      const empty = c === '' || c == null;
      return `<td class="${empty ? 'rec-cell-empty' : ''}">${escHtml(empty ? '' : c)}</td>`;
    }).join('');
    return `<tr data-rec-id="${escHtml(rec.id)}">`
      + `<td class="rec-check-td"><label class="rec-check"><input type="checkbox" data-rec-check="${escHtml(rec.id)}"${checked} aria-label="选择该记录"></label></td>`
      + tds + '</tr>';
  }).join('');
  return `<table class="rec-table"><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** 文字预览：按文字著录格式成文（可直接复制/打印）；V1.3 增加行复选 */
function textHtml(rows) {
  return rows.map((r) => {
    const checked = state.selected.has(r.id) ? ' checked' : '';
    return `<div class="rec-text-item" data-rec-id="${escHtml(r.id)}">`
      + `<label class="rec-check"><input type="checkbox" data-rec-check="${escHtml(r.id)}"${checked} aria-label="选择该记录"></label>`
      + escHtml(recordToText(r)) + '</div>';
  }).join('');
}

function rowHtml(r) {
  const title = escHtml(r.title || '（未填書名）');
  const meta = [
    r.volume ? `卷數：${escHtml(r.volume)}` : '',
    r.author ? escHtml(r.author) : '',
    r.version ? `版本：${escHtml(r.version)}` : '',
  ].filter(Boolean).join(' · ');
  const badges = [
    r.category ? `<span class="rec-badge">${escHtml(r.category)}</span>` : '',
    r.shelf ? `<span class="rec-badge">索書號 ${escHtml(r.shelf)}</span>` : '',
    r.catalogers ? `<span class="rec-badge">編目 ${escHtml(r.catalogers)}</span>` : '',
  ].filter(Boolean).join('');
  const ts = r.updatedAt ? new Date(r.updatedAt).toLocaleString('zh-CN') : '';
  const checked = state.selected.has(r.id) ? ' checked' : '';
  return `<div class="rec-item" data-id="${escHtml(r.id)}">
      <label class="rec-check" title="选择该记录"><input type="checkbox" data-rec-check="${escHtml(r.id)}"${checked} aria-label="选择该记录"></label>
      <div class="rec-item-main">
        <div class="rec-item-title">
          <span class="rec-seq">#${escHtml(r.seq == null ? '—' : String(r.seq))}</span>
          ${title}
        </div>
        ${meta ? `<div class="rec-item-meta">${meta}</div>` : ''}
        <div class="rec-item-badges">${badges}</div>
      </div>
      <div class="rec-item-side">
        <span class="rec-item-time">${escHtml(ts)}</span>
        <div class="rec-item-actions">
          <button class="av-btn rec-mini" data-rec-edit="${escHtml(r.id)}" type="button">编辑</button>
          <button class="av-btn rec-mini rec-danger" data-rec-del="${escHtml(r.id)}" type="button">删除</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 表单
function ensureForm() {
  if (state.rendered) return;
  state.rendered = true;
  const reqBox = el('requiredFields');
  const optBox = el('optionalFields');
  if (reqBox) reqBox.innerHTML = REQUIRED_FIELDS.map(fieldHtml).join('');
  if (optBox) optBox.innerHTML = OPTIONAL_FIELDS.map(fieldHtml).join('');
}

function fieldHtml(f) {
  const def = FIELD_DEFS[f];
  const isTextarea = def.type === 'textarea';
  const tag = isTextarea ? 'textarea' : 'input';
  const extra = isTextarea ? ' rows="3"' : ' type="text"';
  return `
    <div class="av-field" data-field="${f}">
      <label for="rec-${f}">${toDisplay(def.label)}${def.required ? ' <span class="req-star">*</span>' : ''}</label>
      <${tag} id="rec-${f}" ${extra} placeholder="${toDisplay(def.hint)}" ${def.required ? 'required' : ''}></${tag}>
      <div class="field-error" hidden></div>
    </div>`;
}

function openForm(record, prefill) {
  ensureForm();
  const overlay = el('recordFormOverlay');
  if (!overlay) return;
  state.editing = record || null;
  const rec = record || createEmptyRecord();

  // 先清空再填，避免上一条的残留值
  for (const f of ALL_FIELDS) {
    const input = el('rec-' + f);
    if (input) input.value = rec[f] == null ? '' : String(rec[f]);
    const fieldEl = document.querySelector(`.av-field[data-field="${f}"]`);
    const errEl = fieldEl && fieldEl.querySelector('.field-error');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  }

  if (prefill) {
    for (const [k, v] of Object.entries(prefill)) {
      if (k.startsWith('__') || !v) continue;
      const input = el('rec-' + k);
      if (input && !input.value) input.value = String(v);
    }
  }

  const titleEl = el('recordFormTitle');
  if (titleEl) titleEl.textContent = record ? '編輯編目記錄' : '新增編目記錄';
  const metaEl = el('recordFormMeta');
  if (metaEl) {
    metaEl.textContent = record
      ? `序号 #${record.seq == null ? '—' : record.seq}　最后修改：${record.updatedAt ? new Date(record.updatedAt).toLocaleString('zh-CN') : '—'}　（带 * 为必填，留空也可先保存）`
      : (prefill && prefill.__source === 'naj'
        ? '已从国立公文书馆检索结果带入可确定的字段（書名／著者／索書號／類目／年代，附録含引用例），其余请按实物著录。带 * 为必填，留空也可先保存。'
        : '字段布局与校验按「【27】編目表格模板.xlsx」预置；带 * 为必填，但**留空也能先保存**，便于边编边补。');
  }
  // 只有已存在的记录才能删
  const delBtn = el('recordFormDelete');
  if (delBtn) delBtn.hidden = !record;

  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  el('rec-' + (REQUIRED_FIELDS[0] || 'title'))?.focus();
}

function closeForm() {
  const overlay = el('recordFormOverlay');
  if (overlay) overlay.hidden = true;
  document.body.style.overflow = '';
  state.editing = null;
}

/** 只取业务字段（不含 id/seq/createdAt 等同步元数据，避免覆盖既有值） */
function collectForm() {
  const out = {};
  for (const f of ALL_FIELDS) {
    const input = el('rec-' + f);
    if (input) out[f] = input.value;
  }
  return out;
}

async function saveForm() {
  const store = deps.getStore && deps.getStore();
  if (!store) { toast('存储未就绪，暂时无法保存', 'err'); return; }
  const data = collectForm();
  // V9.7（用户要求）：必填项**不再拦截保存** —— 编目常是先存草稿、边编边补。
  // 这里仅把缺项在表单上标红并计数，随后照常保存；提示语里写明还缺几项。
  const res = validateRecord(data);
  let missing = 0;
  if (!res.valid) {
    missing = Object.keys(res.errors).length;
    for (const f of Object.keys(res.errors)) {
      const fieldEl = document.querySelector(`.av-field[data-field="${f}"]`);
      const errEl = fieldEl && fieldEl.querySelector('.field-error');
      if (errEl) { errEl.textContent = res.errors[f]; errEl.hidden = false; }
    }
  }

  try {
    const isNew = !state.editing;
    let row;
    if (state.editing) {
      row = touchUpdated(state.editing, data, store.deviceId);
    } else {
      row = makeNewRecord(data, store.deviceId);
      row.seq = nextSeq();
    }
    await store.putRecordValue(row);
    await store.pushChange(STORE_RECORDS, row.id);
    await loadRecords();
    closeForm();
    const tail = missing ? `（还有 ${missing} 项带 * 的必填未填，可稍后补全）` : '';
    toast((isNew ? '已新增编目记录' : '已保存修改') + tail, missing ? '' : 'ok');
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || e), 'err');
  }
}

async function requestDelete(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  const label = rec.title || '（未填書名）';
  if (!window.confirm(`确定删除「${label}」？\n（软删除，会随同步传播到其它设备）`)) return;
  const store = deps.getStore && deps.getStore();
  if (!store) { toast('存储未就绪', 'err'); return; }
  try {
    const tomb = markDeleted(rec, store.deviceId);
    await store.putRecordValue(tomb);
    await store.pushChange(STORE_RECORDS, tomb.id);
    state.selected.delete(id);
    await loadRecords();
    closeForm();
    toast('已删除', 'ok');
  } catch (e) {
    toast('删除失败：' + ((e && e.message) || e), 'err');
  }
}

// ---------------------------------------------------------------- 导入表格（Excel / CSV）
// V9.7（用户要求）：支持一键导入 Excel 等表格文档；表头按模板自动对应字段，
// 识别不了则按模板列序回退；导入的每条都补齐元数据（id/seq/时间戳/deviceId）后落库。
async function onImportFile(e) {
  const input = e.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  const store = deps.getStore && deps.getStore();
  if (!store) { toast('存储未就绪，暂时无法导入', 'err'); input.value = ''; return; }

  toast('正在解析「' + file.name + '」…');
  try {
    const table = await parseTableFile(file);
    if (!table || !table.rows || !table.rows.length) {
      toast('该文件没有可导入的数据行（只看到表头？）', 'err');
      input.value = '';
      return;
    }
    const mapped = mapRowsToRecords(table.headers, table.rows);
    const records = mapped.records || [];
    if (!records.length) {
      toast('未解析出任何记录，请检查表格是否为空', 'err');
      input.value = '';
      return;
    }
    // 逐条落库（补元数据与序號）
    let seq = nextSeq();
    const now = Date.now();
    for (const data of records) {
      const row = makeNewRecord(data, store.deviceId);
      row.seq = seq++;
      // 同一批导入：createdAt 递增，保证「按录入顺序」排序稳定
      row.createdAt = now + (seq - 1);
      row.updatedAt = row.createdAt;
      await store.putRecordValue(row);
      await store.pushChange(STORE_RECORDS, row.id);
    }
    await loadRecords();
    const how = mapped.matchedBy === 'position' ? '按模板列序' : '按表头';
    const un = (mapped.unmappedHeaders || []).length;
    toast(`已导入 ${records.length} 条（${how}对应字段）` + (un ? `；${un} 个表头未识别` : ''), 'ok');
  } catch (err) {
    toast('导入失败：' + ((err && err.message) || err), 'err');
  } finally {
    input.value = '';   // 允许重复导入同一个文件
  }
}

// ---------------------------------------------------------------- 导出（表格 CSV / 文字 TXT）
async function exportAs(kind) {
  const rows = visibleRecords();
  if (!rows.length) { toast('没有可导出的记录', 'err'); return; }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const isCsv = kind === 'table';
  const name = `汉籍编目记录_${stamp}.${isCsv ? 'csv' : 'txt'}`;
  const content = isCsv ? recordsToCsv(rows) : recordsToText(rows);
  const kindLabel = isCsv ? '表格（CSV）' : '文字（TXT）';

  if (deps.isTauri && deps.invoke) {
    try {
      const path = await deps.invoke('save_export', { name, content });
      toast(`已导出${kindLabel}：` + path, 'ok');
      if (window.__kansekiShowNotice) window.__kansekiShowNotice({ kind: isCsv ? 'CSV' : 'TXT', name, path });
      return;
    } catch (e) {
      toast('导出失败：' + ((e && e.message) || e), 'err');
      return;
    }
  }
  // 浏览器调试：走下载（CSV 需带 BOM，Excel 打开才不乱码）
  try {
    const blob = new Blob([isCsv ? '\ufeff' + content : content],
      { type: isCsv ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已导出 ' + name, 'ok');
  } catch (e) {
    toast('导出失败：' + ((e && e.message) || e), 'err');
  }
}

// ---------------------------------------------------------------- 检索面板带入
function consumePendingRecord() {
  const pending = window.__kansekiPendingRecord;
  if (!pending) return;
  delete window.__kansekiPendingRecord;
  openForm(null, pending);
}

// 供测试与其它模块调用（浏览器端 e2e 测试会用到；与外壳既有的
// window.__kansekiToast / __kansekiAppReady 同属「测试可观测点」）
export const __recordsInternals = {
  visibleRecords, recordsToCsv, recordsToTableRows, recordToText, recordsToText, setView, csvCell,
  isRecordsLocked, batchDeleteSelected, selectAllVisible, updateBulkBar,
  RECORDS_LOCKED_KEY, RECORDS_LOCKED_DEFAULT, RECORDS_FEATURE_ENABLED, recordsLocked,
};
if (typeof window !== 'undefined') window.__recordsInternals = __recordsInternals;
if (typeof window !== 'undefined') {
  window.__recordsLocked = recordsLocked();
  window.__recordsLockedKey = RECORDS_LOCKED_KEY;
}
