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
  const overlay = el('recordFormOverlay');
  if (!overlay) return;
  state.bound = true;

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
}

/** 进入视图时调用：读库 + 消费检索面板带来的带入数据 */
export async function refreshRecordsView() {
  await loadRecords();
  consumePendingRecord();
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
  const rows = visibleRecords();
  const total = state.records.length;

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
    return;
  }
  if (emptyBox) emptyBox.hidden = true;
  if (showCard) listBox.innerHTML = rows.map(rowHtml).join('');
  if (showTable && tableBox) tableBox.innerHTML = tableHtml(rows);
  if (showText && textBox) textBox.innerHTML = textHtml(rows);
}

/** 预览方式：card | table | text */
function setView(v) {
  if (!['card', 'table', 'text'].includes(v)) return;
  state.view = v;
  $$('.rec-vs').forEach((b) => b.classList.toggle('on', b.dataset.recView === v));
  try { localStorage.setItem('kanseki_records_view', v); } catch (_) { /* 忽略 */ }
  renderList();
}

/** 表格预览：与「编目表格」模板同 14 列（序號 + 13 业务字段） */
function tableHtml(rows) {
  const { headers, rows: body } = recordsToTableRows(rows);
  const head = headers.map((h) => `<th>${escHtml(h)}</th>`).join('');
  const trs = body.map((r) => '<tr>' + r.map((c) => {
    const empty = c === '' || c == null;
    return `<td class="${empty ? 'rec-cell-empty' : ''}">${escHtml(empty ? '' : c)}</td>`;
  }).join('') + '</tr>').join('');
  return `<table class="rec-table"><thead><tr>${head}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** 文字预览：按文字著录格式成文（可直接复制/打印） */
function textHtml(rows) {
  return rows.map((r) => `<div class="rec-text-item">${escHtml(recordToText(r))}</div>`).join('');
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
  return `<div class="rec-item" data-id="${escHtml(r.id)}">
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
};
if (typeof window !== 'undefined') window.__recordsInternals = __recordsInternals;
