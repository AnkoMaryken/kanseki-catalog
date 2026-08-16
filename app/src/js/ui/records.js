// ================================================
// js/ui/records.js — 编目记录占位视图（框架 + 表单预览）
// ================================================
// 占位期：列表空状态 + 表单弹层（14 字段布局与校验），不落库。
// 后期启用：接入 catalog-record-schema.js 的 CRUD + sync-engine（catalog_records store 已预留）。
// ================================================
import {
  REQUIRED_FIELDS, OPTIONAL_FIELDS, FIELD_DEFS, validateRecord, createEmptyRecord
} from '../core/catalog-record-schema.js';
import { toDisplay } from '../core/conv.js';

export function initRecordsView() {
  const overlay = document.getElementById('recordFormOverlay');
  const openBtn = document.getElementById('previewFormBtn');
  const addBtn = document.getElementById('addRecordBtn');
  const closeBtn = document.getElementById('recordFormClose');
  const cancelBtn = document.getElementById('recordFormCancel');
  const submitBtn = document.getElementById('recordFormSubmit');

  if (!overlay) return;

  // 渲染字段（首次打开时惰性生成）
  let rendered = false;
  function ensureForm() {
    if (rendered) return;
    rendered = true;
    const reqBox = document.getElementById('requiredFields');
    const optBox = document.getElementById('optionalFields');
    reqBox.innerHTML = REQUIRED_FIELDS.map(f => fieldHtml(f)).join('');
    optBox.innerHTML = OPTIONAL_FIELDS.map(f => fieldHtml(f)).join('');
  }

  function fieldHtml(f) {
    const def = FIELD_DEFS[f];
    const isTextarea = def.type === 'textarea';
    const tag = isTextarea ? 'textarea' : 'input';
    const extra = isTextarea ? ' rows="3"' : ' type="text"';
    return `
      <div class="form-field" data-field="${f}">
        <label for="rec-${f}">${toDisplay(def.label)}${def.required ? ' <span class="req-star">*</span>' : ''}</label>
        <${tag} id="rec-${f}" ${extra} placeholder="${toDisplay(def.hint)}" ${def.required ? 'required' : ''}></${tag}>
        <div class="field-error" hidden></div>
      </div>`;
  }

  function openForm() {
    ensureForm();
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeForm() {
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  openBtn?.addEventListener('click', openForm);
  addBtn?.addEventListener('click', openForm);
  closeBtn?.addEventListener('click', closeForm);
  cancelBtn?.addEventListener('click', closeForm);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeForm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeForm();
  });

  // 实时校验（输入时提示必填）
  overlay.addEventListener('input', (e) => {
    const fieldEl = e.target.closest('.form-field');
    if (!fieldEl) return;
    const f = fieldEl.dataset.field;
    const def = FIELD_DEFS[f];
    if (!def || !def.required) return;
    const val = e.target.value.trim();
    const errEl = fieldEl.querySelector('.field-error');
    if (!val) {
      errEl.textContent = '此项为必填';
      errEl.hidden = false;
    } else {
      errEl.hidden = true;
    }
  });

  // 提交（占位：不落库，提示预览）
  submitBtn?.addEventListener('click', () => {
    const rec = createEmptyRecord();
    for (const f of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
      const el = document.getElementById('rec-' + f);
      if (el) rec[f] = el.value;
    }
    const res = validateRecord(rec);
    if (!res.valid) {
      // 显示所有必填错误
      for (const f of Object.keys(res.errors)) {
        const fieldEl = document.querySelector(`.form-field[data-field="${f}"]`);
        const errEl = fieldEl?.querySelector('.field-error');
        if (errEl) {
          errEl.textContent = res.errors[f];
          errEl.hidden = false;
        }
      }
      return;
    }
    // 占位：校验通过但提示预览
    showPreviewToast();
  });

  function showPreviewToast() {
    // 复用全局 toast（在 app.js 挂载时注入）
    if (window.__kansekiToast) {
      window.__kansekiToast('表单校验通过（预览）。编目功能即将上线，数据不会保存', 'ok');
    } else {
      alert('表单校验通过（预览）。编目功能即将上线，数据不会保存');
    }
  }
}
