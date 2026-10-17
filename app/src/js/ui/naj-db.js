// ================================================
// js/ui/naj-db.js — 国立公文書館デジタルアーカイブ 检索视图（桌面版）
// ================================================
// 数据源：https://www.digital.archives.go.jp（国立公文書館デジタルアーカイブ / 日本国立公文书馆）
//
// 为什么只在桌面版可用（实测结论）：
//   检索页 /search 与单条记录 /{item,file,fonds}/<ID>.json **不返回 CORS 头**，
//   浏览器 fetch 会被同源策略拒绝；桌面版经 Rust 桥（naj_db.rs）无此限制。
//   非 Tauri 环境显示明确说明，而不是静默失败。
//
// 检索习惯（照搬原站「詳細検索」，参数名取自原站 search-cond.js/archive-finder.js 并逐条实测）：
//   · kw0 关键词（必须配 ks0，只给 kw0 会 400）；ks0 = kw_all/kw_title/kw_creator/kw_item/kw_id
//   · type 资料种别：da22=簿册／da23=件名・細目／da21=资料群（可多选）
//   · img_type 图像等：01=图像／11=影音／02=电子公文；limit 利用限制：01 公开/02 需审查/03 部分公开/04 不公开
//   · stack 保存场所：01 本馆/02 分馆/03 电子公文等系统/04 外部书库
//   · date_y_from/date_y_to 作成年（公历，实测有效）；inst 移交元机关；ware 旧藏（文库）
//   · fond 资料群 ID（实测会真实收窄命中，如 内閣文庫 2214 → 漢書 2107）
//   · rows 表示件数、page 页码（1 起）
//   ⚠️ reference_from/to 原站对格式敏感，实测填资料群或请求番号均返回 0 件，界面已注明
//
// 界面（用户要求）：
//   · 全部条件标签用中文；机关名/文库名等专名沿用原站著录
//   · 可筛「簿册」「件名·细目」
//   · 「内閣文庫 汉籍分类」单列一区：内閣文庫 → 漢書 → 經/史/子/集/叢書/新書 一键限定
//   · 每条检索结果信息**末尾**给出可点击原链接（打开原网页查看图像）
// ================================================
import {
  SCOPES, TYPES, IMG_TYPES, LIMITS, STACKS, ROWS_OPTIONS,
  INSTITUTIONS, OLD_HOLDINGS, NAIKAKU_BUNKO,
  parseSearchPage, parseRecordJson, buildSearchUrl, buildRecordUrl,
  itemToPairs, recordToPairs, citationOf, citationOfItem, classifySearch,
} from '../core/naj-parse.js';
// V9.8：整册 PDF 下载（原生主通道 + IIIF 兜底 + 零缺册门禁）
import { openBookDownload, dlAvailable, dlButtonHtml } from './naj-dl.js';
// V9.9：下载中心（标题栏按钮 + 抽屉 + 完成/失败提醒）与批量下载面板
import { initDownloadCenter } from './naj-dl-center.js';
import { initBatchUi } from './naj-dl-batch.js';

// ---------------------------------------------------------------- 环境与传输
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function tauriInvoke(cmd, args) {
  if (!isTauri) throw new Error('非 Tauri 环境');
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

/** 取回原站页面（走 Rust 桥：规避 CORS，并自带重试/部分结果保全） */
async function najFetch(url, timeoutSecs) {
  if (!isTauri) {
    throw new Error('网页版无法直接访问该站点（该站不提供 CORS 头）。请在 Windows 桌面版中使用本功能。');
  }
  return tauriInvoke('naj_fetch', { url, timeoutSecs: timeoutSecs || 45 });
}

/** 打开原网页（桌面版交给系统浏览器，避免在应用内框住整个站点） */
export async function openExternal(url) {
  if (isTauri) {
    try {
      await tauriInvoke('open_external', { url });
      return;
    } catch (_) { /* 落到 window.open */ }
  }
  try { window.open(url, '_blank'); } catch (_) { /* 忽略 */ }
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function toast(msg, type) {
  if (window.__kansekiToast) window.__kansekiToast(msg, type);
}

// ---------------------------------------------------------------- 状态
const state = {
  keyword: '',
  scope: 'kw_all',
  rows: 20,
  page: 1,
  total: null,
  from: null,
  to: null,
  items: [],
  selected: null,
  lastUrl: '',
  truncated: false,
  attempts: 1,
  elapsed: 0,
  busy: false,
  searched: false,
  bound: false,
  fond: '',          // 当前限定的资料群（内閣文庫分类）
  fondLabel: '',
};

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 表单构建
function fillSelect(sel, items) {
  if (!sel) return;
  sel.innerHTML = items
    .map((it) => `<option value="${escHtml(it.value)}">${escHtml(it.label)}</option>`)
    .join('');
}

function fillChecks(box, items, name) {
  if (!box) return;
  box.innerHTML = items.map((it) => (
    `<label class="naj-check"><input type="checkbox" name="${name}" value="${escHtml(it.value)}">`
    + `<span>${escHtml(it.label)}</span></label>`
  )).join('');
}

function checkedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
}

/** 组装「内閣文庫 汉籍分类」按钮（含原站分类页入口，空关键词时也能去浏览） */
function renderNaikaku() {
  const box = el('najNaikakuChips');
  if (!box) return;
  const items = [
    { id: NAIKAKU_BUNKO.id, label: '内閣文庫（全部）', jp: NAIKAKU_BUNKO.title, pageUrl: NAIKAKU_BUNKO.pageUrl },
    ...NAIKAKU_BUNKO.groups,
  ];
  box.innerHTML = items.map((g) => (
    `<span class="naj-chip-wrap">`
    + `<button type="button" class="naj-chip" data-naj-fond="${escHtml(g.id)}"`
    + ` data-naj-fond-label="${escHtml(g.label)}" title="原站名称：${escHtml(g.jp)}｜点此把检索限定在该资料群">`
    + `${escHtml(g.label)}</button>`
    + `<a class="naj-chip-page" data-naj-out href="${escHtml(g.pageUrl)}"`
    + ` title="到原站浏览「${escHtml(g.jp)}」分类页（不需要关键词）">↗</a></span>`
  )).join('');
  syncNaikakuActive();
}

function syncNaikakuActive() {
  const box = el('najNaikakuChips');
  if (box) {
    box.querySelectorAll('.naj-chip').forEach((b) => {
      b.classList.toggle('on', !!state.fond && b.dataset.najFond === state.fond);
    });
  }
  const info = el('najNaikakuActive');
  if (!info) return;
  if (!state.fond) { info.setAttribute('hidden', ''); return; }
  info.removeAttribute('hidden');
  info.innerHTML = `已限定分类：<b>${escHtml(state.fondLabel || state.fond)}</b>`
    + `<button type="button" class="kdb-link" id="najFondClear">取消限定</button>`;
  el('najFondClear')?.addEventListener('click', () => {
    state.fond = ''; state.fondLabel = '';
    syncNaikakuActive();
    updateFilterBadge();
  });
}

function setFond(id, label) {
  if (state.fond === id) { state.fond = ''; state.fondLabel = ''; }
  else { state.fond = id; state.fondLabel = label; }
  syncNaikakuActive();
  updateFilterBadge();
  // 已有关键词时立即按新分类重检，并收起浮层以便看结果；
  // 无关键词则只记下分类（原站检索必须有关键词），浮层保持打开供继续挑选
  if (state.fond && (el('najKw')?.value || '').trim()) {
    closePops();
    runSearch(1);
  } else if (state.fond) {
    toast('已选定分类，请输入关键词后点「检索」', 'ok');
  }
}

// ---------------------------------------------------------------- 内閣文庫 漢籍 分類瀏覽（V10.5.1）
// 用户要求：能在软件里按原站 fonds 层级**逐层浏览**（内閣文庫 › 漢籍 › 經部… › 簿册一覧），
//           而不是只给一个统计数字；并且要能导出 CSV；这一块不要占太大地方。
//
// 做法：一条紧凑工具栏 + 一行分类 chips。点某部 → 清空关键词、只留「資料種別=簿册(da22)」，
//       用既有检索链路把该部簿册列到下方结果区（顺序与原站分类页一致）。
// 簿册数口径：資料種別 da22 的命中数，与原站分类页「該当件数」一致（經部 1886）。

const NAIKAKU_WABUN_FOND = '3682585';   // 和書部（日文典籍，非漢籍）
const NAIKAKU_HANJI_FOND = '3602612';   // 漢籍（上级资料群，作面包屑，不单列 chip）
const NAJ_FOND_CACHE_KEY = 'najFondCountsV1';
let fondCounts = null;                  // { at, rows:[{id,label,jp,count,pageUrl}] }
let browse = null;                      // 当前浏览的分类 { id, label, jp }
let browseCsvBusy = false;

/** 待浏览的「部」：经／史／子／集／叢書／新書（与原站分类页同序） */
function fondList() {
  return (NAIKAKU_BUNKO.groups || [])
    .filter((g) => g.id !== NAIKAKU_WABUN_FOND && g.id !== NAIKAKU_HANJI_FOND)
    .map((g) => ({ id: g.id, label: g.label, jp: g.jp, pageUrl: g.pageUrl }));
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function loadFondCounts() {
  try {
    const o = JSON.parse(localStorage.getItem(NAJ_FOND_CACHE_KEY) || 'null');
    return (o && Array.isArray(o.rows) && o.rows.length) ? o : null;
  } catch (_) { return null; }
}

function countOfFond(id) {
  const r = ((fondCounts && fondCounts.rows) || []).find((x) => x.id === id);
  return r && Number.isFinite(Number(r.count)) ? Number(r.count) : null;
}

function renderFondChips() {
  const box = el('najBrowseChips');
  if (!box) return;
  box.innerHTML = fondList().map((g) => {
    const n = countOfFond(g.id);
    const on = browse && browse.id === g.id;
    return `<button type="button" class="naj-fond-chip${on ? ' on' : ''}"`
      + ` data-fond="${escHtml(g.id)}" data-label="${escHtml(g.label)}"`
      + ` title="原站分类：${escHtml(g.jp)}（点此在下方列出该部簿册；再点一次取消）">`
      + `<span class="naj-fond-name">${escHtml(g.label)}</span>`
      + `<b class="naj-fond-n">${n == null ? '—' : n.toLocaleString('zh-CN')}</b></button>`;
  }).join('');
}

function renderBrowsePath() {
  const p = el('najBrowsePath');
  if (p) p.textContent = browse ? `内閣文庫 › 漢籍 › ${browse.label} › 簿册` : '内閣文庫 › 漢籍';
  const csvBtn = el('najBrowseCsv');
  if (csvBtn) csvBtn.disabled = !browse || browseCsvBusy;
}

/** 统计各部簿册数（首次自动跑一次，结果缓存本机；点「刷新件数」可重算） */
async function refreshFondCounts() {
  if (!isTauri) return;
  const list = fondList();
  if (!list.length) return;
  const prog = el('najBrowseProg');
  const btn = el('najBrowseRefresh');
  if (btn) btn.disabled = true;
  const rows = list.map((g) => ({ ...g, count: null }));
  for (let i = 0; i < rows.length; i++) {
    if (prog) prog.textContent = `统计件数 ${i + 1}/${rows.length}…`;
    try {
      const url = buildSearchUrl({ keyword: '', scope: 'kw_all', types: ['da22'], fond: rows[i].id, rows: 20, page: 1 });
      const resp = await najFetch(url, 50);
      const parsed = parseSearchPage(String(resp.body || ''));
      rows[i].count = parsed.total == null ? null : parsed.total;
    } catch (_) { rows[i].count = null; }
    fondCounts = { at: new Date().toISOString(), rows };
    renderFondChips();
    await new Promise((r) => setTimeout(r, 260));
  }
  fondCounts = { at: new Date().toISOString(), rows };
  try { localStorage.setItem(NAJ_FOND_CACHE_KEY, JSON.stringify(fondCounts)); } catch (_) { /* 存不下无妨 */ }
  renderFondChips();
  if (prog) prog.textContent = '';
  if (btn) btn.disabled = false;
}

/** 点分类 → 在下方结果区按原站分类页顺序列出该部簿册；再点一次取消限定 */
function browseFond(id, label) {
  const g = fondList().find((x) => x.id === id) || { id, label, jp: label };
  if (browse && browse.id === id) {
    browse = null;
    state.fond = ''; state.fondLabel = '';
    document.querySelectorAll('input[name="naj-type"]').forEach((cb) => { cb.checked = false; });
    syncNaikakuActive();
    updateFilterBadge();
    renderFondChips();
    renderBrowsePath();
    toast('已取消分类限定', 'ok');
    return;
  }
  browse = { id, label: g.label, jp: g.jp };
  state.fond = id; state.fondLabel = g.label;
  syncNaikakuActive();
  if (el('najKw')) el('najKw').value = '';
  // 只留「簿册」，避免把件名·细目混进来（原站分类页列的也是簿册）
  document.querySelectorAll('input[name="naj-type"]').forEach((cb) => { cb.checked = cb.value === 'da22'; });
  updateFilterBadge();
  renderFondChips();
  renderBrowsePath();
  runSearch(1);
}

/** 把当前浏览分类的簿册导出为 CSV（分页抓全，带上限保护） */
async function exportBrowseCsv() {
  if (!browse || browseCsvBusy) return;
  if (!isTauri) { toast('仅桌面版可用', 'warn'); return; }
  const prog = el('najBrowseProg');
  const csvBtn = el('najBrowseCsv');
  browseCsvBusy = true;
  if (csvBtn) csvBtn.disabled = true;

  const ROWS = 200, MAX_PAGES = 12;    // 上限 2400 条
  const items = [];
  let total = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (prog) prog.textContent = `导出中 第 ${page} 页…`;
    try {
      const url = buildSearchUrl({ keyword: '', scope: 'kw_all', types: ['da22'], fond: browse.id, rows: ROWS, page });
      const resp = await najFetch(url, 60);
      const parsed = parseSearchPage(String(resp.body || ''));
      if (total == null) total = parsed.total;
      items.push(...(parsed.items || []));
      if (!parsed.items || parsed.items.length < ROWS) break;
      if (total != null && items.length >= total) break;
    } catch (e) {
      toast('导出中断：' + (e.message || e), 'err');
      break;
    }
    await new Promise((r) => setTimeout(r, 260));
  }
  if (prog) prog.textContent = '';
  browseCsvBusy = false;
  if (!items.length) {
    if (csvBtn) csvBtn.disabled = false;
    toast('没有取到簿册数据', 'warn');
    return;
  }

  // 列：固定列 + 各条目出现过的字段名（按首次出现顺序） + 原站链接
  const fixed = ['番号', '資料種別', '簿冊名', '層級'];
  const dyn = [];
  for (const it of items) for (const f of (it.fields || [])) if (f.label && dyn.indexOf(f.label) < 0) dyn.push(f.label);
  const lines = [[...fixed, ...dyn, '原站鏈接'].map(csvCell).join(',')];
  items.forEach((it, i) => {
    const byLabel = {};
    for (const f of (it.fields || [])) if (f.label && byLabel[f.label] == null) byLabel[f.label] = f.value || '';
    const row = [
      it.no || String(i + 1),
      it.kind || '',
      it.title || '',
      (it.hierarchy || []).map((h) => h.title).join(' › '),
      ...dyn.map((k) => (byLabel[k] == null ? '' : byLabel[k])),
      it.url || '',
    ];
    lines.push(row.map(csvCell).join(','));
  });

  try {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safeLabel = String(browse.label).replace(/[\\/:*?"<>|]/g, '');
    const path = await tauriInvoke('save_export', {
      name: `内閣文庫漢籍_${safeLabel}_簿册_${day}.csv`,
      content: lines.join('\r\n'),
    });
    const capped = total != null && items.length < total;
    toast(`已导出 ${items.length} 条${capped ? `（该部共 ${total} 条，已按上限截取）` : ''}：${path}`, 'ok');
    try { await tauriInvoke('reveal_path', { path }); } catch (_) { /* 打不开目录无妨 */ }
  } catch (e) {
    toast('导出失败：' + (e.message || e), 'err');
  }
  if (csvBtn) csvBtn.disabled = false;
}

function bindFondBrowse() {
  if (!el('najBrowse')) return;
  el('najBrowseChips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fond]');
    if (chip) browseFond(chip.dataset.fond, chip.dataset.label);
  });
  el('najBrowseRefresh')?.addEventListener('click', () => { refreshFondCounts(); });
  el('najBrowseCsv')?.addEventListener('click', () => { exportBrowseCsv(); });
  fondCounts = loadFondCounts();
  renderFondChips();
  renderBrowsePath();
  // 首次进页面若还没有缓存，自动统计一次（约 8–12 秒）；有缓存直接回显
  if (!fondCounts && isTauri) refreshFondCounts();
}

// ---------------------------------------------------------------- 详细检索条件
function readyear(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{1,4}$/.test(s) ? s : '';
}

function readConditions() {
  return {
    types: checkedValues('naj-type'),
    imgTypes: checkedValues('naj-imgtype'),
    limits: checkedValues('naj-limit'),
    stacks: checkedValues('naj-stack'),
    yearFrom: readyear(el('najYearFrom')?.value),
    yearTo: readyear(el('najYearTo')?.value),
    inst: el('najInst')?.value || '',
    ware: el('najWare')?.value || '',
    refFrom: (el('najRefFrom')?.value || '').trim(),
    refTo: (el('najRefTo')?.value || '').trim(),
    fond: state.fond,
  };
}

const LABELS = {
  types: Object.fromEntries(TYPES.map((t) => [t.value, t.label])),
  imgTypes: Object.fromEntries(IMG_TYPES.map((t) => [t.value, t.label])),
  limits: Object.fromEntries(LIMITS.map((t) => [t.value, t.label])),
  stacks: Object.fromEntries(STACKS.map((t) => [t.value, t.label])),
};

function activeCount(c) {
  let n = 0;
  for (const k of ['types', 'imgTypes', 'limits', 'stacks']) n += (c[k] || []).length;
  for (const k of ['yearFrom', 'yearTo', 'refFrom', 'refTo']) if (c[k]) n++;
  if (c.inst) n++;
  if (c.ware) n++;
  if (c.fond) n++;   // 内閣文庫分类也算一项详细条件（它现在就在详细检索面板里）
  return n;
}

/** 中文条件摘要（状态行回显，让用户知道这次到底筛了什么） */
function conditionSummary(c) {
  const out = [];
  if (c.types.length) out.push('资料种别：' + c.types.map((v) => LABELS.types[v] || v).join('／'));
  if (c.imgTypes.length) out.push('图像等：' + c.imgTypes.map((v) => LABELS.imgTypes[v] || v).join('／'));
  if (c.limits.length) out.push('利用限制：' + c.limits.map((v) => LABELS.limits[v] || v).join('／'));
  if (c.stacks.length) out.push('保存场所：' + c.stacks.map((v) => LABELS.stacks[v] || v).join('／'));
  if (c.yearFrom || c.yearTo) out.push(`作成年：${c.yearFrom || '不限'}–${c.yearTo || '不限'}`);
  if (c.inst) {
    const it = INSTITUTIONS.find(([v]) => v === c.inst);
    out.push('移交元机关：' + (it ? it[1] : c.inst));
  }
  if (c.ware) {
    const it = OLD_HOLDINGS.find(([v]) => v === c.ware);
    out.push('旧藏：' + (it ? it[1] : c.ware));
  }
  if (c.refFrom || c.refTo) out.push(`参照代码：${c.refFrom || ''}–${c.refTo || ''}`);
  if (c.fond) out.push('分类：' + (state.fondLabel || c.fond));
  return out;
}

function updateFilterBadge() {
  const n = activeCount(readConditions());
  const badge = el('najFilterCount');
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

/** 详细检索浮层（内含条件与内閣文庫分类）开合 */
function togglePop(which, force) {
  const panel = el('najAdv');
  const btn = el('najToggle');
  if (!panel) return;
  const openNow = !panel.hasAttribute('hidden');
  const next = (force === undefined) ? !openNow : !!force;
  if (next) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
  btn?.setAttribute('aria-expanded', String(next));
}

function closePops() { togglePop(null, false); toggleRowsMenu(false); }

function anyPopOpen() {
  const e = el('najAdv');
  const menu = el('najRowsMenu');
  return !!((e && !e.hasAttribute('hidden')) || (menu && !menu.hasAttribute('hidden')));
}

/** 显示件数下拉（V10.0：从检索行里挪到状态栏，按钮点击弹浮层） */
function toggleRowsMenu(force) {
  const menu = el('najRowsMenu');
  const btn = el('najRowsBtn');
  if (!menu) return;
  const next = (force === undefined) ? menu.hasAttribute('hidden') : !!force;
  if (next) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
  btn?.setAttribute('aria-expanded', String(next));
}

function buildRowsMenu() {
  const menu = el('najRowsMenu');
  const sel = el('najRows');
  if (!menu || !sel) return;
  menu.innerHTML = ROWS_OPTIONS
    .map((v) => `<button type="button" class="naj-rows-item" data-naj-rows="${v}">${v} 件</button>`)
    .join('');
  const sync = () => {
    const cur = String(sel.value || '20');
    if (el('najRowsLabel')) el('najRowsLabel').textContent = cur;
    menu.querySelectorAll('[data-naj-rows]').forEach((b) => {
      b.classList.toggle('on', b.dataset.najRows === cur);
    });
  };
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-naj-rows]');
    if (!b) return;
    e.stopPropagation();
    sel.value = b.dataset.najRows;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
    toggleRowsMenu(false);
  });
  sel.addEventListener('change', sync);
  sync();
}

function clearAdvanced() {
  document.querySelectorAll('#najForm input[type="checkbox"]').forEach((i) => { i.checked = false; });
  for (const id of ['najYearFrom', 'najYearTo', 'najRefFrom', 'najRefTo']) {
    const e = el(id); if (e) e.value = '';
  }
  if (el('najInst')) el('najInst').value = '';
  if (el('najWare')) el('najWare').value = '';
  state.fond = ''; state.fondLabel = '';
  syncNaikakuActive();
  updateFilterBadge();
}

// ---------------------------------------------------------------- 初始化
export function initNajDbView() {
  const form = el('najForm');
  if (!form) return;

  // V9.9：下载中心（标题栏按钮 + 抽屉）与「批量下载」入口，随本视图一并初始化（幂等）
  try { initDownloadCenter(); } catch (_) { /* 非桌面版或初始化失败不应影响检索 */ }
  try { initBatchUi(); } catch (_) { /* 同上 */ }

  // 下拉、复选框、分类按钮（标签全部中文）
  fillSelect(el('najScope'), SCOPES);
  fillSelect(el('najRows'), ROWS_OPTIONS.map((v) => ({ value: String(v), label: `${v} 件` })));
  buildRowsMenu();
  fillSelect(el('najInst'), [{ value: '', label: '（不限）' }, ...INSTITUTIONS.map(([v, l]) => ({ value: v, label: l }))]);
  fillSelect(el('najWare'), [{ value: '', label: '（不限）' }, ...OLD_HOLDINGS.map(([v, l]) => ({ value: v, label: l }))]);
  fillChecks(el('najTypes'), TYPES, 'naj-type');
  fillChecks(el('najImgTypes'), IMG_TYPES, 'naj-imgtype');
  fillChecks(el('najLimits'), LIMITS, 'naj-limit');
  fillChecks(el('najStacks'), STACKS, 'naj-stack');
  renderNaikaku();
  bindFondBrowse();   // V10.5.1：内閣文庫漢籍 分類瀏覽（含件数缓存回显）

  if (!state.bound) {
    state.bound = true;
    form.addEventListener('submit', (e) => { e.preventDefault(); closePops(); runSearch(1); });
    el('najReset')?.addEventListener('click', resetForm);
    // 详细检索浮层（内閣文庫分类就在其中）：点浮层外或 Esc 关闭
    el('najToggle')?.addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
    // 显示件数下拉（状态栏里、分页左侧）
    el('najRowsBtn')?.addEventListener('click', (e) => { e.stopPropagation(); toggleRowsMenu(); });
    document.addEventListener('click', (e) => {
      if (!anyPopOpen()) return;
      if (e.target.closest && e.target.closest('#najAdv, #najToggle, #najRowsWrap')) return;
      closePops();
    });
    el('najAdvClear')?.addEventListener('click', () => { clearAdvanced(); });
    // 勾选/填值后实时更新「详细检索」角标
    form.addEventListener('change', updateFilterBadge);
    form.addEventListener('input', updateFilterBadge);
    // 内閣文庫分类按钮（在详细检索浮层内）
    el('najNaikakuChips')?.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-naj-out]');
      if (link) { e.preventDefault(); openExternal(link.getAttribute('href')); return; }
      const chip = e.target.closest('.naj-chip');
      if (chip) setFond(chip.dataset.najFond, chip.dataset.najFondLabel);
    });
    el('najPrev')?.addEventListener('click', () => { if (state.page > 1) runSearch(state.page - 1); });
    el('najNext')?.addEventListener('click', () => {
      if (state.total != null && state.to != null && state.to < state.total) runSearch(state.page + 1);
    });
    el('najStatus')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-naj-retry]')) runSearch(state.page);
    });
    el('najResults')?.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-naj-out]');
      if (link) { e.preventDefault(); openExternal(link.getAttribute('href')); return; }
      if (e.target.closest('[data-naj-retry]')) { runSearch(state.page); return; }
      // V9.8：结果行右侧「下载」→ 整册 PDF（含全部子册）
      const dl = e.target.closest('[data-naj-dl]');
      if (dl) {
        e.preventDefault();
        e.stopPropagation();
        const it = state.items[Number(dl.dataset.najDl)];
        if (it) openBookDownload({ id: it.id, title: it.title, url: it.url, categoryPath: hierarchyToCategory(it) });
        return;
      }
      const row = e.target.closest('.kdb-row');
      if (row && row.dataset.idx != null) openDetail(Number(row.dataset.idx));
    });
    el('najDetail')?.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-naj-out]');
      if (link) { e.preventDefault(); openExternal(link.getAttribute('href')); return; }
      if (e.target.closest('[data-naj-back]')) { showResults(); return; }
      if (e.target.closest('[data-naj-dlbook]')) {
        const it = state.selected;
        if (it) openBookDownload({ id: it.id, title: it.title, url: it.url, categoryPath: hierarchyToCategory(it) });
        return;
      }
      const copy = e.target.closest('[data-naj-copy]');
      if (copy) { copyText(copy.dataset.najCopy || ''); return; }
      if (e.target.closest('[data-naj-torecord]')) { toCatalogRecord(); return; }
      const hier = e.target.closest('[data-naj-goto]');
      if (hier) { e.preventDefault(); loadByUrl(hier.dataset.najGoto, hier.dataset.najTitle || ''); }
    });
    // Esc 收起任一浮层（仅在本视图激活时）
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && anyPopOpen()
          && document.getElementById('view-najdb')?.classList.contains('active')) {
        closePops();
      }
    });
  }

  // 浏览器（网页版）明确说明不可用，而不是让用户点了没反应
  if (!isTauri) {
    el('najResults').innerHTML =
      `<p class="kdb-warn">此功能仅在 Windows 桌面版可用：国立公文書館デジタルアーカイブ不返回 CORS 头，
       浏览器/网页版无法直接取数（与「汉籍检索（日本）」同一限制）。<br>
       桌面版经内置网络桥直连原站，可直接检索并查看记录与图像链接。</p>`;
    el('najSearchBtn')?.setAttribute('disabled', '');
  }
  renderStatus();
}

function resetForm() {
  if (el('najKw')) el('najKw').value = '';
  if (el('najScope')) el('najScope').value = 'kw_all';
  if (el('najRows')) el('najRows').value = '20';
  clearAdvanced();
  closePops();
  state.searched = false;
  state.items = [];
  state.total = null;
  state.keyword = '';
  el('najResults').innerHTML = '<p class="kdb-empty">输入关键词后点「检索」，或在「内閣文庫 汉籍分类」中先选分类。<br>可检索書名、作成者、件名・細目与参照コード；详细检索可进一步按资料种别、利用限制、年代等筛选。</p>';
  el('najPager')?.setAttribute('hidden', '');
  renderStatus();
}

// ---------------------------------------------------------------- 检索
async function runSearch(page) {
  const kw = (el('najKw')?.value || '').trim();
  const cond = readConditions();
  // V10.5.1：原站「分类页」本身是「空关键词 + 資料群(fond) 限定」，这种 URL 实测能正常返回簿册列表；
  // 因此浏览分类时必须放行空关键词，否则点分类只会弹一句「请输入关键词」，结果区永远空着。
  const browsingFond = !kw && (cond.fond || (browse && browse.id));
  if (!kw && !browsingFond) {
    toast('请输入关键词（原站检索必须有检索词；也可点上方分类直接浏览该部簿册）', 'err');
    el('najKw')?.focus();
    return;
  }
  if (state.busy) return;

  state.keyword = kw;
  state.scope = el('najScope')?.value || 'kw_all';
  state.rows = Number(el('najRows')?.value || 20);
  state.page = page || 1;
  state.busy = true;
  state.searched = true;

  const url = buildSearchUrl({
    keyword: state.keyword, scope: state.scope, rows: state.rows, page: state.page,
    types: cond.types, imgTypes: cond.imgTypes, limits: cond.limits, stacks: cond.stacks,
    yearFrom: cond.yearFrom, yearTo: cond.yearTo,
    inst: cond.inst, ware: cond.ware,
    referenceFrom: cond.refFrom, referenceTo: cond.refTo,
    fond: cond.fond,
  });
  state.lastUrl = url;
  // 诊断/测试可观测点（与外壳既有的 window.__kanseki* 钩子同类）
  if (typeof window !== 'undefined') window.__najLastUrl = url;
  renderStatus('检索中…');
  el('najResults').innerHTML = '<p class="kdb-empty">正在请求国立公文書館デジタルアーカイブ…（该站连接偶发重置，已自动重试）</p>';

  const t0 = Date.now();
  try {
    const resp = await najFetch(url, 45);
    state.elapsed = Date.now() - t0;
    state.attempts = resp.attempts || 1;
    state.truncated = !!resp.truncated;
    // ⚠️ 必须先看状态码：4xx/5xx 的 body 也可能是可解析的 HTML，
    // 若径直解析，会把「服务端故障」显示成「没有命中」
    if (resp.status >= 400) {
      state.items = []; state.total = null;
      el('najResults').innerHTML =
        `<p class="kdb-warn">原站返回 HTTP ${escHtml(String(resp.status))}，本次检索未成功。</p>
         <p class="kdb-empty"><button class="av-btn" data-naj-retry type="button">重试</button></p>`;
      renderStatus('检索失败（HTTP ' + resp.status + '）', 'err');
      return;
    }
    const parsed = parseSearchPage(resp.body);
    const kind = classifySearch(parsed);
    if (kind === 'form') {
      state.items = []; state.total = null;
      el('najResults').innerHTML = '<p class="kdb-warn">原站未执行检索（只回了检索表单）。请确认关键词非空后重试。</p>';
      renderStatus('未执行检索', 'warn');
      return;
    }
    state.total = parsed.total;
    state.from = parsed.from;
    state.to = parsed.to;
    state.items = parsed.items;
    state.condSummary = conditionSummary(cond);
    renderResults(parsed, kind);
    renderStatus();
  } catch (e) {
    state.items = [];
    const msg = (e && e.message) ? e.message : String(e);
    el('najResults').innerHTML =
      `<p class="kdb-warn">检索失败：${escHtml(msg)}</p>
       <p class="kdb-empty"><button class="av-btn" data-naj-retry type="button">重试</button></p>`;
    renderStatus('检索失败', 'err');
  } finally {
    state.busy = false;
  }
}

function renderStatus(text, cls) {
  const box = el('najStatus');
  if (!box) return;
  if (text) { box.className = 'kdb-status ' + (cls || 'busy'); box.textContent = text; }
  else if (!state.searched) { box.className = 'kdb-status'; box.textContent = ''; }
  else if (state.total == null) { box.className = 'kdb-status warn'; box.textContent = '未取得命中数'; }
  else {
    const parts = [`命中 ${state.total} 件`];
    if (state.from != null && state.to != null) parts.push(`显示 ${state.from}–${state.to}`);
    parts.push(`用时 ${(state.elapsed / 1000).toFixed(1)}s`);
    if (state.attempts > 1) parts.push(`重试 ${state.attempts - 1} 次`);
    box.className = 'kdb-status' + (state.truncated ? ' warn' : ' ok');
    box.textContent = parts.join(' · ') + (state.truncated ? '（响应不完整）' : '');
  }
  renderCondSummary();
  renderPager();
}

/** 状态行右侧：本次检索的中文条件摘要 */
function renderCondSummary() {
  const box = el('najCondSummary');
  if (!box) return;
  const items = state.condSummary || [];
  if (!items.length) { box.setAttribute('hidden', ''); box.textContent = ''; return; }
  box.removeAttribute('hidden');
  box.innerHTML = items.map((t) => escHtml(t)).join('　·　');
}

function renderPager() {
  const pager = el('najPager');
  if (!pager) return;
  const has = state.searched && state.total != null && state.items.length > 0;
  if (!has) { pager.setAttribute('hidden', ''); return; }
  pager.removeAttribute('hidden');
  // rows 兜底为 ≥1，避免任何异常取值导致页数算成 Infinity
  const rows = Math.max(1, Number(state.rows) || 20);
  const pages = Math.max(1, Math.ceil(state.total / rows));
  el('najPageInfo').textContent = `第 ${state.page} / ${pages} 页`;
  el('najPrev').disabled = state.page <= 1;
  el('najNext').disabled = state.page >= pages;
}

// ---------------------------------------------------------------- 结果渲染

/** 从检索条目的階層链取分类路径（去掉顶层「内閣文庫」与末段=记录自身） */
function hierarchyToCategory(it) {
  const titles = (it && it.hierarchy ? it.hierarchy : [])
    .map((h) => h && h.title)
    .filter((t) => t && t !== '内閣文庫');
  if (titles.length && it && titles[titles.length - 1] === it.title) titles.pop();
  return titles;
}

/** 结果条目 → 下载所需的最小记录（无 ID 则返回 null，绝不臆造） */
function recordForDownload(it) {
  if (!it) return null;
  const id = it.id || (it.url ? (String(it.url).match(/(\d{3,})\s*$/) || [])[1] : '');
  if (!id) return null;
  return { id: String(id), title: it.title || '', url: it.url || '', categoryPath: hierarchyToCategory(it) };
}

function renderResults(parsed, kind) {
  const box = el('najResults');
  if (!box) return;
  if (kind === 'unparsed') {
    // 命中数已取到、条目却一条也解析不出：只可能是原站改版或响应异常，
    // 必须说清「不是没有命中」，并给重试入口（绝不伪装成空结果）
    box.innerHTML = `<p class="kdb-warn">已取到命中 ${escHtml(String(parsed.total))} 件的检索结果页，
      但未能从中解析出条目 —— 可能是原站页面结构改版，或本次响应不完整。</p>
      <p class="kdb-empty"><button class="av-btn" data-naj-retry type="button">重试</button>
      　若反复出现，请用「打开原网页」到原站检索。</p>`;
    return;
  }
  if (kind === 'empty' || state.items.length === 0) {
    box.innerHTML = `<p class="kdb-empty">没有命中（原站：該当する資料が見つかりませんでした）。<br>
      可放宽条件：换检索范围（如「全部」）、取消「资料种别／利用限制／年代／分类」限制，或改用原站著录的日文/繁体字形（例如 論語 而非 论语）。</p>`;
    return;
  }
  box.innerHTML = '<div class="kdb-rows">' + state.items.map((it, i) => resultRowHtml(it, i)).join('') + '</div>';
}

function resultRowHtml(it, i) {
  const pairs = itemToPairs(it);
  const kind = it.kind ? `<span class="kdb-badge">${escHtml(it.kind)}</span>` : '';
  const tree = it.hierarchy && it.hierarchy.length
    ? `<div class="naj-tree">${it.hierarchy.map((h) =>
        `<a data-naj-out href="${escHtml(h.url)}" title="打开资料群页面">${escHtml(h.title)}</a>`).join('<span class="naj-tree-sep"> ＞ </span>')}</div>`
    : '';
  const kvs = pairs.filter(p => p.label !== 'No.' && p.label !== '資料種別' && p.label !== '階層')
    .map(p => `<div class="naj-kv"><b>${escHtml(p.label)}</b><span>${escHtml(p.value)}</span></div>`).join('');
  // ⚠️ 用户要求：原链接放在**信息末尾**，可点击打开原网页查看图像
  const src = it.url
    ? `<div class="naj-src">
         <span class="naj-src-label">原链接</span>
         <a class="naj-link" data-naj-out href="${escHtml(it.url)}" title="在浏览器中打开原网页（可查看图像）">${escHtml(it.url)}</a>
       </div>`
    : '';
  return `<div class="kdb-row naj-row" data-idx="${i}">
      <div class="naj-row-head">
        <span class="naj-no">${escHtml(it.no || String(i + 1))}</span>
        ${kind}
        <span class="kdb-row-title naj-row-title">${escHtml(it.title || '（原站该条无标题）')}</span>
        ${recordForDownload(it) ? dlButtonHtml(i, it.title) : ''}
      </div>
      ${tree}
      <div class="naj-kvs">${kvs}</div>
      ${src}
    </div>`;
}

// ---------------------------------------------------------------- 详情
/**
 * 取单条记录的 JSON-LD（含一次重试）。
 * 实测该站会偶发返回 HTML（内容协商/连接重置），故解析失败时重试一次再退化，
 * 绝不把 HTML 当数据硬解析。
 */
async function fetchRecordJson(pageUrl) {
  let err = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await najFetch(buildRecordUrl(pageUrl), 45);
      const body = String(resp.body || '');
      if (!body.trimStart().startsWith('{')) {
        err = '原站返回的不是 JSON-LD（可能是 HTML 页面或响应被截断）';
      } else {
        const rec = parseRecordJson(body);
        if (rec) return { rec, resp };
        err = 'JSON-LD 结构无法识别';
      }
    } catch (e) {
      err = (e && e.message) ? e.message : String(e);
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 700));
  }
  return { rec: null, resp: null, err };
}

async function openDetail(idx) {
  const it = state.items[idx];
  if (!it || !it.url) return;
  state.selected = it;
  el('najSplit')?.classList.remove('view-results');
  el('najSplit')?.classList.add('view-detail');
  el('najDetail').innerHTML = '<p class="kdb-empty">正在读取记录（JSON-LD）…</p>';
  const { rec, resp, err } = await fetchRecordJson(it.url);
  if (!rec) { renderDetailFallback(it, resp, err); return; }
  renderDetail(rec, it, resp);
}

async function loadByUrl(url, title) {
  const fake = { url, title, fields: [], hierarchy: [], kind: '', no: '' };
  state.selected = fake;
  el('najSplit')?.classList.remove('view-results');
  el('najSplit')?.classList.add('view-detail');
  el('najDetail').innerHTML = '<p class="kdb-empty">正在读取记录…</p>';
  const { rec, resp, err } = await fetchRecordJson(url);
  if (rec) renderDetail(rec, fake, resp);
  else renderDetailFallback(fake, resp, err);
}

function renderDetail(rec, item, resp) {
  const pairs = recordToPairs(rec);
  const kvs = pairs.map((p) => {
    const isUrl = /^https?:\/\//.test(p.value);
    const val = isUrl
      ? `<a class="naj-link" data-naj-out href="${escHtml(p.value)}">${escHtml(p.value)}</a>`
      : escHtml(p.value);
    return `<div class="kdb-kv"><b>${escHtml(p.label)}</b><span>${val}</span></div>`;
  }).join('');
  const cite = citationOf(rec);
  const thumb = rec.thumbnail
    ? `<img class="naj-thumb" src="${escHtml(rec.thumbnail)}" alt="" loading="lazy">` : '';
  const extra = resp && resp.truncated ? '<p class="kdb-warn">响应不完整（服务器中断），下方字段可能缺失。</p>' : '';
  const hier = rec.parentPageUrl
    ? `<p class="naj-hier">上位資料：<a class="naj-link" data-naj-goto data-naj-title="" href="${escHtml(rec.parentPageUrl)}">${escHtml(rec.parentPageUrl)}</a></p>`
    : '';
  el('najDetail').innerHTML = `
    <div class="kdb-detail-bar">
      <button class="kdb-back" data-naj-back type="button">← 返回结果</button>
      <span class="kdb-detail-pos">${escHtml(rec.levelName || '')}${rec.identifier ? ' · ' + escHtml(rec.identifier) : ''}</span>
    </div>
    <div class="kdb-detail-head">
      <h3>${escHtml(rec.title || item.title || '（无标题）')}</h3>
      <p>${escHtml(rec.creator || '')}</p>
    </div>
    ${extra}
    <div class="naj-detail-body">
      <div class="kdb-kvs naj-kvs-detail">${kvs}</div>
      ${thumb ? `<div class="naj-thumb-box">${thumb}</div>` : ''}
    </div>
    ${hier}
    <div class="naj-cite">
      <div class="naj-cite-head">引用例（原站建议注明出典；目録元数据为 CC0）</div>
      <div class="naj-cite-text">${escHtml(cite)}</div>
    </div>
    <div class="kdb-detail-actions">
      <a class="av-btn av-btn-primary" data-naj-out href="${escHtml(rec.pageUrl)}" style="text-decoration:none">打开原网页（查看图像）</a>
      ${recordForDownload(item) ? '<button class="av-btn" data-naj-dlbook="1" type="button">下载整册 PDF</button>' : ''}
      <button class="av-btn" data-naj-copy="${escHtml(cite)}" type="button">复制引用例</button>
      <button class="av-btn" data-naj-torecord="1" type="button">参考此记录新建编目记录</button>
    </div>
    <!-- 用户要求：记录信息末尾给出原链接 -->
    <div class="naj-src naj-src-foot">
      <span class="naj-src-label">原链接</span>
      <a class="naj-link" data-naj-out href="${escHtml(rec.pageUrl)}" title="在浏览器中打开原网页（可查看图像）">${escHtml(rec.pageUrl)}</a>
    </div>`;
}

function renderDetailFallback(item, resp, errMsg) {
  // 退化路径：JSON-LD 没拿到时，用检索结果页已有字段 + 我们确知的 URI
  // （该站记录页本身就显示这个 URI，写明它不属臆造）
  const pairs = [
    ...(item.url ? [{ label: 'URI', value: item.url }] : []),
    ...itemToPairs(item),
  ];
  const kvs = pairs.map((p) =>
    `<div class="kdb-kv"><b>${escHtml(p.label)}</b><span>${escHtml(p.value)}</span></div>`).join('');
  const cite = citationOfItem(item);
  const reason = errMsg || (resp && resp.truncated ? '响应被服务器中断' : '响应为空');
  el('najDetail').innerHTML = `
    <div class="kdb-detail-bar">
      <button class="kdb-back" data-naj-back type="button">← 返回结果</button>
      <span class="kdb-detail-pos">${escHtml(item.kind || '')}</span>
    </div>
    <div class="kdb-detail-head"><h3>${escHtml(item.title || '（无标题）')}</h3></div>
    <p class="kdb-warn">未能读取机器可读记录（${escHtml(reason)}；已自动重试一次），以下为检索结果页已有字段。</p>
    <div class="kdb-kvs">${kvs}</div>
    <div class="naj-cite">
      <div class="naj-cite-head">引用例</div>
      <div class="naj-cite-text">${escHtml(cite)}</div>
    </div>
    <div class="kdb-detail-actions">
      <a class="av-btn av-btn-primary" data-naj-out href="${escHtml(item.url || '')}" style="text-decoration:none">打开原网页（查看图像）</a>
      ${recordForDownload(item) ? '<button class="av-btn" data-naj-dlbook="1" type="button">下载整册 PDF</button>' : ''}
      <button class="av-btn" data-naj-copy="${escHtml(cite)}" type="button">复制引用例</button>
      <button class="av-btn" data-naj-torecord="1" type="button">参考此记录新建编目记录</button>
    </div>
    <div class="naj-src naj-src-foot">
      <span class="naj-src-label">原链接</span>
      <a class="naj-link" data-naj-out href="${escHtml(item.url || '')}">${escHtml(item.url || '')}</a>
    </div>`;
}

function showResults() {
  el('najSplit')?.classList.remove('view-detail');
  el('najSplit')?.classList.add('view-results');
}

// ---------------------------------------------------------------- 复制 / 转编目记录
async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制引用例', 'ok');
  } catch (_) {
    toast('复制失败（剪贴板不可用）', 'err');
  }
}

/** 把当前记录作为参考填进「编目记录」：只映射有把握的字段，其余留空 */
function toCatalogRecord() {
  const rec = state.selected;
  if (!rec) return;
  const specOf = (name) => {
    const s = (rec.specs || []).find((x) => x.label === name);
    return s ? s.value : '';
  };
  const prefill = {
    title: rec.title || '',
    author: rec.creator || '',
    shelf: rec.identifier || '',
    category: specOf('階層情報') || specOf('資料種別') || '',
    version: rec.dateText || '',
    appendix: citationOf(rec),
    __source: 'naj',
  };
  window.__kansekiPendingRecord = prefill;
  location.hash = '#/records';
  toast('已带入可确定的字段，其余请按实物著录', 'ok');
}
