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
    box.innerHTML = '<p class="kdb-empty">暂无结果</p>';
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

function renderDetail(rec, truncatedNote) {
  const box = $('#kdbDetail');
  if (!box) return;
  if (!rec) { box.innerHTML = '<p class="kdb-empty">从左侧选择一条记录查看详情</p>'; return; }
  if (rec.error === 'no-record') {
    box.innerHTML = '<p class="kdb-empty">该记录在原站不存在（レコードがありません）</p>';
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
    (truncatedNote ? '<p class="kdb-warn">' + esc(truncatedNote) + '</p>' : '') +
    '<div class="kdb-detail-head"><h3>' + esc((rec.ti || []).join(' ; ') || '（无题名）') + '</h3>' +
    '<p class="kdb-dim">' + esc((rec.or || []).join(' ; ')) + '</p></div>' +
    '<div class="kdb-kvs">' + kv + '</div>' +
    kidsHtml +
    '<div class="kdb-detail-actions">' +
    '<button type="button" class="av-btn" id="kdbCopy">复制字段</button>' +
    '<button type="button" class="av-btn" id="kdbOpen">在浏览器打开原记录页</button>' +
    '</div>';

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
    renderResults();

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
  $('#kdbDetail').innerHTML = '<p class="kdb-empty">正在读取记录详情…</p>';
  try {
    const resp = await fetchKanseki(e.url, 60);
    const rec = parseRecordPage(resp.body, { path: e.recordPath, url: e.url });
    renderDetail(rec, resp.truncated ? '该记录页内容被服务器截断，字段可能不全。' : '');
  } catch (err) {
    $('#kdbDetail').innerHTML = '<p class="kdb-warn">' + esc(err.message) + '</p>';
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
  renderResults();
  renderDetail(null);
  setStatus('', '');
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
  });

  renderResults();
  renderDetail(null);

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

export const __test__ = { buildSearchUrl, INSTITUTIONS };
