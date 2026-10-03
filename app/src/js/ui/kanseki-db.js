// ================================================
// js/ui/kanseki-db.js — 全国漢籍データベース 检索视图（桌面版）
// ================================================
// 功能：在应用内检索「全國漢籍データベース」（日本所藏中文古籍數據庫，
//       京都大学人文科学研究所运营），查看记录详情，并跳转原站页面。
//
// 为什么只在桌面版可用（与 websearch.rs 同一结论）：
//   该站不返回 CORS 头，且只有 http://（无 https）。网页版受同源策略与
//   混合内容限制，浏览器无法直接取数；桌面版经 Rust 桥（kanseki_db.rs）无此限制。
//   非 Tauri 环境（浏览器调试/网页版）会显示明确说明，而不是静默失败。
//
// 检索行为的实测结论（界面上的提示文案依据，勿随意删）：
//   · 检索词至少填一个；只选机构不填词，服务器只回表单页、不执行检索
//   · 繁简/异体字自动归一（陶潛 = 陶潜；搜神記 = 捜神記），不必重复检索
//   · 人名异称**不**归一：陶潛 954 条，陶淵明 只有 8 条 → 查某人需各称名分别检索
//   · 命中过多时服务器约 190 秒掐断连接 → 返回部分结果并明确标注「不完整」
// ================================================
import { parseResultPage, parseRecordPage, recordToPairs } from '../core/kanseki-parse.js';

const HOST = 'http://kanji.zinbun.kyoto-u.ac.jp/kanseki';

// 所藏机构（代码取自原站详细检索页的 <OPTION VALUE>）
const INSTITUTIONS = [
  ['一橋大', 'FA002010'], ['三康', 'FASANKO'], ['中央大', 'FA005675'], ['九大', 'FA003454'],
  ['九大 旧六本松', 'FA015282'], ['二松學舎', 'FA006215'], ['京大人文研 本館', 'FA002735'],
  ['京大人文研 東方', 'FA019705'], ['京大文', 'FA002633'], ['京大法', 'FA002655'],
  ['京大附図', 'FA002611'], ['京府大', 'FA003931'], ['京産大', 'FA012218'],
  ['伊那市立 高遠町', 'FATAKATO'], ['佐賀県図', 'FASAGAKEN'], ['佐野市郷博', 'FASANO'],
  ['八戸市立', 'FAHACHINOHE'], ['公文書館 内閣文庫', 'FANAIKAKU'],
  ['前田育徳会 尊経閣', 'FASONKEIKAKU'], ['加賀市立 中央', 'FAKAGA'],
  ['千葉県立 中央', 'FA010802'], ['名大', 'FA002407'], ['国会', 'FAKOKKAI'],
  ['国士舘', 'FA005278'], ['堺市立 中央', 'FASAKAI'], ['大垣市立', 'FAOGAKI'],
  ['大阪府立 中之島', 'FA012750'], ['奈良大', 'FA008469'], ['実践女子', 'FA005303'],
  ['宮内庁書陵部', 'FAKUNAICHO'], ['宮城県図', 'FA010744'], ['宮教大', 'FA001517'],
  ['山口大', 'FA003283'], ['山梨県図', 'FAYAMANASHI'], ['岡大資生研', 'FA003192'],
  ['岡山大', 'FA003170'], ['岡山県図', 'FAOKAYAMAKEN'], ['島根県図', 'FA012728'],
  ['市立米沢', 'FAYONEZAWA'], ['広島大', 'FA012284'], ['広島市立 中央', 'FAHIROSHIMA'],
  ['愛媛大', 'FA003374'], ['愛知大 豊橋', 'FA007182'], ['愛院大', 'FA007218'],
  ['慶應大 三田', 'FA005198'], ['文教大 越谷', 'FA004821'], ['新潟大', 'FA002087'],
  ['新潟県図', 'FANIIGATAKEN'], ['新発田市立', 'FASHIBATA'], ['東京都立 中央', 'FATORITSU'],
  ['東北大', 'FA001379'], ['東北福大', 'FA004504'], ['東大東文研', 'FA011962'],
  ['東大総', 'FA001787'], ['東洋文庫', 'FATOYO'], ['椙山女 中央', 'FA007284'],
  ['横浜ユーラシア', 'FAEURASIA'], ['民博', 'FA009224'], ['法務図', 'FAHOMU'],
  ['法政大 多摩', 'FA006565'], ['滋賀大 教育', 'FA002586'], ['熊本大', 'FA003545'],
  ['神外大', 'FA004049'], ['神戸大', 'FA002994'], ['神戸市立 中央', 'FA015180'],
  ['福井大', 'FA002236'], ['立命館', 'FA007739'], ['群馬大', 'FA001710'],
  ['茨城大', 'FA001648'], ['茶女大', 'FA001980'], ['蓬左文庫', 'FAHOUSA'],
  ['足利學校', 'FAASHIKAGA'], ['酒田市立', 'FASAKATA'], ['金城学院大', 'FA007273'],
  ['長崎大 経済', 'FA003523'], ['関大', 'FA007965'], ['阪大総', 'FA002848'],
  ['静嘉堂', 'FASEIKADO'], ['飯田市立 中央', 'FAIIDA'], ['館林市立', 'FATATEBEYASHI'],
  ['高知大', 'FA003410'], ['鹿大', 'FA003647'], ['龍野歴史文化', 'FATATSUNO'],
];

// ---------------------------------------------------------------- 环境与传输
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function tauriInvoke(cmd, args) {
  if (!isTauri) throw new Error('非 Tauri 环境');
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

/** 取回原站页面 HTML（走 Rust 桥，规避 CORS 与混合内容限制） */
async function fetchKanseki(url, timeoutSecs) {
  if (!isTauri) {
    throw new Error('网页版无法直接访问该站点（该站不提供 CORS 头，且仅有 http 服务）。请在 Windows 桌面版中使用本功能。');
  }
  const resp = await tauriInvoke('kanseki_fetch', { url, timeoutSecs });
  return resp; // { status, body, bytes, truncated, url }
}

function buildSearchUrl(f, institutions) {
  const p = new URLSearchParams();
  // ti 必须出现：即使为空也要带上，否则服务器不进入详细检索
  p.set('ti', f.ti || '');
  if (f.au) p.set('au', f.au);
  if (f.yr) p.set('yr', f.yr);
  if (f.pb) p.set('pb', f.pb);
  if (f.ko) p.set('ko', f.ko);
  if (f.fr) p.set('fr', f.fr);
  const extra = (institutions || []).map((c) => '&or=' + encodeURIComponent(c)).join('');
  return HOST + '?' + p.toString() + extra;
}

// ---------------------------------------------------------------- 状态
const state = {
  total: 0,
  entries: [],
  selected: null,
  lastUrl: '',
  truncated: false,
  busy: false,
  searched: false,   // 是否已执行过一次检索（影响空结果的提示语）
  lastQuery: null,   // 本次检索所用条件的快照 { f, ors }（供摘要回显）
  timer: null,
};

let inited = false;

// ---------------------------------------------------------------- 渲染
function $(sel) {
  return document.querySelector(sel);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(html, kind) {
  const el = $('#kdbStatus');
  if (!el) return;
  el.className = 'kdb-status' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
}

// ------------------------------------------------- V9.4.1 高级筛选可折叠 / 视图切换
// 背景（用户反馈）：只把「结果 / 详情」两栏合并还不够 —— 筛选栏本身要能折叠，
// 整个页面应以**显示搜索结果**为主。故改为：
//   · 常驻一行主检索条（書名 + 检索 + 筛选开关 + 清空）；
//   · 其余条件收进可折叠的高级筛选区，**默认收起**；检索成功后自动收起；
//   · 收起时显示一行条件摘要，避免「不知道这批结果是怎么查出来的」；
//   · 开关带条件计数徽标，收起状态也能一眼看出有几项筛选在生效；
//   · 结果区用 flex 占满剩余高度，成为页面主体。

/** 读取当前表单条件 */
function currentFields() {
  return {
    ti: ($('#kdbTi') || {}).value || '',
    au: ($('#kdbAu') || {}).value || '',
    yr: ($('#kdbYr') || {}).value || '',
    pb: ($('#kdbPb') || {}).value || '',
    ko: ($('#kdbKo') || {}).value || '',
    fr: ($('#kdbFr') || {}).value || '',
  };
}

function selectedOrLabels() {
  const s = $('#kdbOr');
  return s ? Array.from(s.selectedOptions).map((o) => o.textContent.trim()) : [];
}

/** 高级筛选的条件（含机构）；書名是常驻主检索词，不计入 */
function advFields() {
  const f = currentFields();
  return { au: f.au, yr: f.yr, pb: f.pb, ko: f.ko, fr: f.fr };
}

/** 生效中的高级筛选项数（用于徽标） */
function advFilterCount() {
  const f = advFields();
  let n = Object.keys(f).filter((k) => f[k]).length;
  if (selectedOrLabels().length) n += 1;
  return n;
}

/** 一行条件摘要：优先回显**本次检索所用条件**的快照。
    该站检索要跑 1–3 分钟，若期间改动表单，用当前值会让摘要与结果对不上。 */
function summaryText(fieldsOverride, orsOverride) {
  const q = state.lastQuery;
  const f = fieldsOverride || (q ? q.f : currentFields());
  const ors = orsOverride || (q ? q.ors : selectedOrLabels());
  const parts = [];
  const push = (label, v) => { if (v) parts.push('<b>' + label + '</b>' + esc(v)); };
  push('書名', f.ti);
  push('著者名', f.au);
  push('刊年', f.yr);
  push('出版者', f.pb);
  push('子目', f.ko);
  push('keyword', f.fr);
  if (ors.length) {
    const show = ors.slice(0, 3).join('、');
    parts.push('<b>机构</b>' + esc(show) + (ors.length > 3 ? ' 等 ' + ors.length + ' 家' : ''));
  }
  return parts.join('　·　');
}

/** 刷新「收起时的一行摘要」与筛选条件计数徽标 */
function refreshSummary() {
  const n = advFilterCount();
  const badge = $('#kdbFilterCount');
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  const line = $('#kdbSummary');
  if (!line) return;
  // 只在「高级筛选收起」时显示摘要（展开时条件本身看得见，不必重复一行）
  if (isAdvOpen()) { line.hidden = true; return; }
  const txt = summaryText();
  if (!txt) { line.hidden = true; return; }
  line.innerHTML = txt;
  line.hidden = false;
}

/** 展开/收起高级筛选区 */
function setAdvOpen(open) {
  const adv = $('#kdbAdv');
  const btn = $('#kdbToggle');
  if (!adv) return;
  adv.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', String(!!open));
  refreshSummary();
}

function isAdvOpen() {
  const adv = $('#kdbAdv');
  return !!adv && !adv.hidden;
}

/** 兼容旧调用名（探针可能仍在用） */
const setFormCollapsed = (collapsed) => setAdvOpen(!collapsed);
const isFormCollapsed = () => !isAdvOpen();

/** 在「结果」与「详情」之间切换（两者共用同一块全宽区域） */
function showView(which) {
  const sp = $('#kdbSplit');
  if (!sp) return;
  const detail = which === 'detail';
  sp.classList.toggle('view-detail', detail);
  sp.classList.toggle('view-results', !detail);
  if (detail) {
    const box = $('#kdbDetail');
    if (box) box.scrollTop = 0;
  }
}

function stopTimer() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

function startTimer(label) {
  stopTimer();
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    const el = $('#kdbElapsed');
    if (el) el.textContent = s + ' 秒';
  };
  setStatus(esc(label) + ' <span class="kdb-dim">已用 <b id="kdbElapsed">0 秒</b></span>', 'busy');
  state.timer = setInterval(tick, 1000);
}

function renderResults() {
  const box = $('#kdbResults');
  if (!box) return;
  if (!state.entries.length) {
    box.innerHTML = '<p class="kdb-empty">' +
      (state.searched ? '没有命中记录。可放宽或调整条件后重试。'
        : '填写上方条件后点击「检索」。结果会在这块全宽区域里列出。') +
      '</p>';
    return;
  }
  const rows = state.entries.map((e, i) => {
    const active = state.selected === i ? ' active' : '';
    return '<button type="button" class="kdb-row' + active + '" data-idx="' + i + '">' +
      '<span class="kdb-row-title">' + esc(e.title || '（无题名）') + '</span>' +
      (e.authorBib ? '<span class="kdb-row-author">' + esc(e.authorBib) + '</span>' : '') +
      (e.series ? '<span class="kdb-row-series">丛书：' + esc(e.series) + '</span>' : '') +
      '<span class="kdb-row-foot"><span class="kdb-inst">' + esc(e.institution || '—') + '</span>' +
      (e.hasImage ? '<span class="kdb-badge">书影</span>' : '') +
      '<span class="kdb-dim">' + esc(e.recordPath.split('/').slice(1, 2).join('')) + '</span></span>' +
      '</button>';
  }).join('');
  box.innerHTML = '<div class="kdb-rows">' + rows + '</div>';

  box.querySelectorAll('.kdb-row').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(parseInt(btn.dataset.idx, 10)));
  });
}

/** 详情顶部「← 返回结果」按钮（每次重绘都要重新绑定） */
function wireDetailBar() {
  const back = $('#kdbBack');
  if (back) back.addEventListener('click', () => showView('results'));
}

function renderDetail(rec, truncatedNote, posText) {
  const box = $('#kdbDetail');
  if (!box) return;
  if (!rec) { box.innerHTML = '<p class="kdb-empty">在上方结果里点一条记录即可查看详情</p>'; return; }
  if (rec.error === 'no-record') {
    box.innerHTML = '<div class="kdb-detail-bar">' +
      '<button type="button" class="kdb-back" id="kdbBack">← 返回结果</button></div>' +
      '<p class="kdb-empty">该记录在原站不存在（レコードがありません）</p>';
    wireDetailBar();
    return;
  }

  const pairs = recordToPairs(rec);
  const kv = pairs.map((p) =>
    '<div class="kdb-kv"><b>' + esc(p.label) + '</b><span>' + esc(p.value) + '</span></div>').join('');

  const kids = rec.childrenList || [];
  const kidsHtml = kids.length
    ? '<div class="kdb-kids"><div class="kdb-kids-head">子目 ' + kids.length + ' 条' +
      (kids.length > 200 ? '（仅列前 200 条）' : '') + '</div>' +
      '<ol class="kdb-kids-list">' +
      kids.slice(0, 200).map((k) =>
        '<li>' + (k.group ? '<span class="kdb-dim">' + esc(k.group) + '</span> ' : '') +
        esc(k.title) + (k.author ? '<span class="kdb-dim"> · ' + esc(k.author) + '</span>' : '') + '</li>').join('') +
      '</ol></div>'
    : '';

  box.innerHTML =
    '<div class="kdb-detail-bar">' +
    '<button type="button" class="kdb-back" id="kdbBack">← 返回结果</button>' +
    (posText ? '<span class="kdb-detail-pos">' + esc(posText) + '</span>' : '') +
    '</div>' +
    (truncatedNote ? '<p class="kdb-warn">' + esc(truncatedNote) + '</p>' : '') +
    '<div class="kdb-detail-head"><h3>' + esc((rec.ti || []).join(' ; ') || '（无题名）') + '</h3>' +
    '<p class="kdb-dim">' + esc((rec.or || []).join(' ; ')) + '</p></div>' +
    '<div class="kdb-kvs">' + kv + '</div>' +
    kidsHtml +
    '<div class="kdb-detail-actions">' +
    '<button type="button" class="av-btn" id="kdbCopy">复制字段</button>' +
    '<button type="button" class="av-btn" id="kdbOpen">在浏览器打开原记录页</button>' +
    '</div>';

  wireDetailBar();

  const copyBtn = $('#kdbCopy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = pairs.map((p) => p.label + '：' + p.value).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        window.__kansekiToast && window.__kansekiToast('已复制 ' + pairs.length + ' 个字段');
      } catch (e) {
        window.__kansekiToast && window.__kansekiToast('复制失败：' + e.message, 'err');
      }
    });
  }
  const openBtn = $('#kdbOpen');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      if (!rec.url) return;
      if (isTauri) tauriInvoke('open_external', { url: rec.url }).catch(() => {});
      else window.open(rec.url, '_blank');
    });
  }
}

// ---------------------------------------------------------------- 行为
async function doSearch() {
  if (state.busy) return;
  const f = {
    ti: ($('#kdbTi') || {}).value || '',
    au: ($('#kdbAu') || {}).value || '',
    yr: ($('#kdbYr') || {}).value || '',
    pb: ($('#kdbPb') || {}).value || '',
    ko: ($('#kdbKo') || {}).value || '',
    fr: ($('#kdbFr') || {}).value || '',
  };
  const orSel = $('#kdbOr');
  const ors = orSel ? Array.from(orSel.selectedOptions).map((o) => o.value) : [];

  if (!f.ti && !f.au && !f.yr && !f.pb && !f.ko && !f.fr) {
    setStatus('请至少填写一个检索条件（只选机构不会执行检索）。', 'err');
    return;
  }

  const url = buildSearchUrl(f, ors);
  const timeout = parseInt(($('#kdbTimeout') || {}).value || '200', 10);
  // 记录本次条件快照：摘要回显用它，保证「摘要 = 产生这批结果的条件」
  state.lastQuery = { f: Object.assign({}, f), ors: selectedOrLabels() };
  state.busy = true;
  state.selected = null;
  $('#kdbResults').innerHTML = '';
  renderDetail(null);
  startTimer('正在检索…（该站为老旧 CGI，命中较多时可能需 1–3 分钟）');

  try {
    const resp = await fetchKanseki(url, timeout);
    stopTimer();
    state.lastUrl = url;

    const parsed = parseResultPage(resp.body);
    if (parsed.isForm) {
      setStatus('服务器返回的是检索表单页，说明检索式未被接受。请至少填写一个检索词。', 'err');
      state.entries = [];
      renderResults();
      return;
    }
    state.total = parsed.total;
    state.entries = parsed.entries;
    state.truncated = !!resp.truncated;
    state.searched = true;
    renderResults();
    // 检索完成后收起高级筛选，把竖向空间让给结果（页面以结果为主）
    setAdvOpen(false);
    showView('results');

    const bits = [];
    bits.push('命中 <b>' + state.total + '</b> 条');
    if (state.entries.length < state.total) bits.push('本页返回 ' + state.entries.length + ' 条');
    if (state.truncated) {
      bits.push('<span class="kdb-badge warn">服务器中断，结果不完整</span>');
    }
    setStatus(bits.join(' · '), state.truncated ? 'warn' : 'ok');
    if (state.truncated) {
      setStatus(bits.join(' · ') +
        '　<span class="kdb-dim">该站命中过多时会在约 190 秒掐断连接。请增加检索词（如叠加刊年、出版者或选择机构）后缩小范围再查。</span>',
        'warn');
    }
    if (!state.entries.length && !state.truncated) setStatus('命中 0 条。', 'ok');
  } catch (e) {
    stopTimer();
    state.entries = [];
    renderResults();
    setStatus(esc(e && e.message ? e.message : String(e)), 'err');
  } finally {
    state.busy = false;
  }
}

async function openDetail(idx) {
  const e = state.entries[idx];
  if (!e) return;
  state.selected = idx;
  renderResults();
  renderDetail(null);
  showView('detail');
  const posText = '第 ' + (idx + 1) + ' / ' + state.entries.length + ' 条' +
    (state.total > state.entries.length ? '（本页返回 ' + state.entries.length + ' / 共命中 ' + state.total + '）' : '');
  $('#kdbDetail').innerHTML = '<div class="kdb-detail-bar">' +
    '<button type="button" class="kdb-back" id="kdbBack">← 返回结果</button>' +
    '<span class="kdb-detail-pos">' + esc(posText) + '</span></div>' +
    '<p class="kdb-empty">正在读取记录详情…</p>';
  wireDetailBar();
  try {
    const resp = await fetchKanseki(e.url, 60);
    const rec = parseRecordPage(resp.body, { path: e.recordPath, url: e.url });
    renderDetail(rec, resp.truncated ? '该记录页内容被服务器截断，字段可能不全。' : '', posText);
  } catch (err) {
    $('#kdbDetail').innerHTML = '<div class="kdb-detail-bar">' +
      '<button type="button" class="kdb-back" id="kdbBack">← 返回结果</button></div>' +
      '<p class="kdb-warn">' + esc(err.message) + '</p>';
    wireDetailBar();
  }
}

function resetForm() {
  ['kdbTi', 'kdbAu', 'kdbYr', 'kdbPb', 'kdbKo', 'kdbFr'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const orSel = $('#kdbOr');
  if (orSel) Array.from(orSel.options).forEach((o) => { o.selected = false; });
  state.entries = [];
  state.total = 0;
  state.selected = null;
  state.searched = false;
  state.lastQuery = null;
  renderResults();
  renderDetail(null);
  showView('results');
  setAdvOpen(false);         // 清空后收起高级筛选，保持「结果为主」的版面
  refreshSummary();
  setStatus('', '');
  const ti = $('#kdbTi');
  if (ti) ti.focus();
}

// ---------------------------------------------------------------- 初始化
export function initKansekiDbView() {
  if (inited) return;
  inited = true;

  const orSel = $('#kdbOr');
  if (orSel && !orSel.options.length) {
    orSel.innerHTML = INSTITUTIONS
      .map(([label, code]) => '<option value="' + code + '">' + esc(label) + '</option>')
      .join('');
  }

  $('#kdbForm') && $('#kdbForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    doSearch();
  });
  $('#kdbReset') && $('#kdbReset').addEventListener('click', resetForm);
  $('#kdbOrClear') && $('#kdbOrClear').addEventListener('click', () => {
    const s = $('#kdbOr');
    if (s) Array.from(s.options).forEach((o) => { o.selected = false; });
    refreshSummary();
  });
  // 「筛选 ↓」开关：展开/收起高级筛选区
  $('#kdbToggle') && $('#kdbToggle').addEventListener('click', () => {
    setAdvOpen(!isAdvOpen());
  });
  // 高级条件的改动实时反映到计数徽标与摘要行
  ['kdbAu', 'kdbYr', 'kdbPb', 'kdbKo', 'kdbFr'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', refreshSummary);
  });
  if (orSel) orSel.addEventListener('change', refreshSummary);

  setAdvOpen(false);   // 默认收起：页面以结果为主
  showView('results');
  renderResults();
  renderDetail(null);
  refreshSummary();

  if (!isTauri) {
    setStatus('当前为浏览器环境：网页版无法直接访问该站点（不提供 CORS 头、且仅有 http 服务），' +
      '请在 Windows 桌面版中使用本功能。', 'err');
  } else {
    setStatus('<span class="kdb-dim">填写条件后点击「检索」。提示：繁简与异体字已由服务器自动归一，' +
      '但人名异称不归一（如「陶潛」与「陶淵明」结果不同），查询某人时请分别检索其各种称名。</span>', '');
  }
}

/** 供外部（如编目记录页）按著者/书名一键跳转检索 */
export function searchFromOutside({ ti, au } = {}) {
  if (ti != null) { const el = $('#kdbTi'); if (el) el.value = ti; }
  if (au != null) { const el = $('#kdbAu'); if (el) el.value = au; }
  doSearch();
}

export const __test__ = {
  buildSearchUrl, INSTITUTIONS,
  setAdvOpen, isAdvOpen, setFormCollapsed, isFormCollapsed,
  showView, summaryText, currentFields, advFilterCount, refreshSummary,
};
// 供自动化测试取用（浏览器/真机探针都能直接调，不必真的联网检索）
if (typeof window !== 'undefined') window.__kdbTest__ = __test__;
