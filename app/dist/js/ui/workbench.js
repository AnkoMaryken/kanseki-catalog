// ================================================================
// js/ui/workbench.js — 工作台 v2（2026-10 重做）
// ================================================================
// 结构（参考 Permitly 风格：大留白 / 大圆角 / 黑色主卡 + 荧光绿）：
//   1. 页头：按本机时段的问候语（未登录显示「今天做些什么？」）
//   2. 快捷入口：5 张入口卡（编目记录数取本机 IndexedDB，不写死）
//   3. 黑色主卡：每日推荐（语料见 workbench-daily.js，≥730 条，可刷新）
//   4. 问问 AI：复用 ai-config.js（localStorage 配置）；无 Key 只给一行提示
//   5. 工作日历 / 待办：localStorage['kanseki_todo_v1']，按 YYYY-MM-DD 分组
//   6. 编目资料磁贴 + 最近更新（读 pages/changelog.html，不写死版本号）
//
// 样式全部在 css/wb2.css（#wbRoot 作用域），本文件不注入任何 <style>。
// ================================================================
import { openDB, idbCount, STORE_RECORDS } from '../core/sync/store-indexeddb.js';
import { WB_DAILY } from './workbench-daily.js';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function go(hash) {
  if (location.hash === hash) return;
  location.hash = hash;
}

// ---------------------------------------------------------------- 图标
const IC = {
  cal: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8v4M16 2.8v4"/></svg>',
  tree: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="6" height="5" rx="1.3"/><rect x="14.5" y="15.5" width="6" height="5" rx="1.3"/><path d="M6.5 8.5v6a2 2 0 0 0 2 2h6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M5 8l7-5 7 5"/><rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M9 20v-5h6v5"/></svg>',
  archive: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5h17M5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11"/><path d="M4.5 3.5h15v4h-15z"/><path d="M9.5 12h5"/></svg>',
  pen: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6M9 11h2"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.6 15.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>',
  chevL: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  chevR: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  arrowR: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-8-8-4z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.16.6.7 1 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2z"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  win: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/><path d="M8 5V3.2M12 5V3.2M16 5V3.2"/></svg>',
};

// ---------------------------------------------------------------- 常量
const USER_KEY = 'kanseki_user';
const PROFILE_KEY = 'kanseki_profile';
const LANG_KEY = 'kanseki_lang';
const TODO_KEY = 'kanseki_todo_v1';
const DAILY_TONE_KEY = 'kanseki_wb_daily_tone';
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

const AI_SYSTEM_PROMPT = [
  '你是「古代史及汉籍研究工具」里的古籍编目助手。',
  '服务对象是整理日本藏汉籍的编目人员。回答要求：',
  '1. 先给结论，再给依据；能指出依据出自《中国古籍总目》《编目细则》或版本学常识时请注明。',
  '2. 简洁，单次回答尽量控制在 300 字以内，可用短列表。',
  '3. 不确定或需要目验原书才能判断时，明确说「需核对原书/书影」，不要编造版本、卷数、藏地等信息。',
  '4. 不替用户虚构古籍原文；引用古籍时只引可核查的名句。',
].join('\n');

const AI_CHIPS = [
  '这条著录有什么问题？',
  '帮我判断类目',
  '版本项怎么著录？',
];

// ---------------------------------------------------------------- 状态
const state = {
  dailyBase: null,
  dailyOffset: 0,
  dailyTone: 'paper',    // 'ink' 深色主卡 | 'paper' 白色卡片（默认白，持久化）
  stats: { records: 0 },
  recent: [],
  version: {             // 最近更新：版本检查（本次会话缓存于 state + 当天缓存于 localStorage）
    current: '',
    status: 'idle',      // idle | checking | new | latest | error
    latest: '',
    assetUrl: '',
    pageUrl: '',
    checkedAt: 0,
    error: '',
  },
  calMonth: null,        // Date（当月 1 日）
  calSel: '',            // 'YYYY-MM-DD'
  ai: {
    loading: false,
    module: null,
    tried: false,
    hasKey: false,
    model: '',
    busy: false,
    answer: '',
    error: '',
    draft: '',
    history: [],         // [{role:'user'|'assistant', content}]
    notice: null,        // {q, a, dismissed}
  },
};

// ---------------------------------------------------------------- 用户 / 时段
function readLS(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}

function getUserName() {
  const p = readLS(PROFILE_KEY) || {};
  if (p.name) return String(p.name).trim();
  const u = readLS(USER_KEY);
  if (u && u.name) return String(u.name).trim();
  if (u && u.email) return String(u.email).split('@')[0];
  return '';
}

function isLoggedIn() {
  const u = readLS(USER_KEY);
  return !!(u && u.email);
}

function greetingInfo() {
  const h = new Date().getHours();
  const greet = h < 5 ? '凌晨好' : h < 12 ? '上午好' : h < 18 ? '下午好' : '晚上好';
  if (!isLoggedIn()) {
    return { prefix: '今天做些什么？', name: '', sub: '选一个入口开始，或先看看今天的推荐。' };
  }
  return {
    prefix: greet,
    name: getUserName(),
    sub: '今天想从哪一部书开始？',
  };
}

function todayCn() {
  const d = new Date();
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK_CN[d.getDay()]}`;
}

// ---------------------------------------------------------------- 每日推荐
function dayNumber() {
  const d = new Date();
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function ensureDailyBase() {
  const n = dayNumber();
  if (state.dailyBase !== n) {
    state.dailyBase = n;
    state.dailyOffset = 0;
  }
}

function currentDaily() {
  ensureDailyBase();
  const len = WB_DAILY.length || 1;
  const idx = ((state.dailyBase + state.dailyOffset) % len + len) % len;
  return WB_DAILY[idx] || { type: 'tip', title: '暂无语料', body: '', src: '' };
}

function dailyBodyHtml() {
  const item = currentDaily();
  if (item.type === 'quote') {
    return ''
      + `<blockquote class="wb2-quote">「${esc(item.text)}」</blockquote>`
      + `<div class="wb2-quote-src">—— ${esc(item.src)}</div>`
      + (item.note ? `<div class="wb2-hero-note">${esc(item.note)}</div>` : '');
  }
  return ''
    + `<div class="wb2-tip-title">${esc(item.title || '编目小识')}</div>`
    + `<p class="wb2-tip-body">${esc(item.body || '')}</p>`
    + `<div class="wb2-tip-src">${esc(item.src || '编目小识')}</div>`;
}

/* -------------------- 每日推荐：配色（深色 / 白色） -------------------- */
/* 用户要求：默认白色（paper）；仅当用户手动切到深色并持久化了 'ink' 时才用深色 */
function loadDailyTone() {
  try {
    return localStorage.getItem(DAILY_TONE_KEY) === 'ink' ? 'ink' : 'paper';
  } catch (_) { return 'paper'; }
}

function saveDailyTone(tone) {
  try { localStorage.setItem(DAILY_TONE_KEY, tone); } catch (_) { /* 忽略 */ }
}

function applyDailyTone() {
  const card = $('wb2Daily');
  if (!card) return;
  card.classList.toggle('is-paper', state.dailyTone === 'paper');
  const btn = card.querySelector('.wb2-tone');
  if (btn) {
    const toPaper = state.dailyTone !== 'paper';
    btn.innerHTML = (toPaper ? IC.sun : IC.moon) + '<span>' + (toPaper ? '白色' : '深色') + '</span>';
    btn.setAttribute('aria-label', toPaper ? '切换为白色卡片' : '切换为深色卡片');
    btn.setAttribute('title', toPaper ? '切换为白色卡片' : '切换为深色卡片');
  }
}

function toggleDailyTone() {
  state.dailyTone = state.dailyTone === 'paper' ? 'ink' : 'paper';
  saveDailyTone(state.dailyTone);
  applyDailyTone();
  const card = $('wb2Daily');
  if (card) {
    card.classList.remove('tone-swap');
    void card.offsetWidth; // 重启动画
    card.classList.add('tone-swap');
  }
}

function dailyHeroHtml() {
  const d = new Date();
  const date = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const toneLabel = state.dailyTone === 'paper' ? '深色' : '白色';
  const toneIcon = state.dailyTone === 'paper' ? IC.moon : IC.sun;
  const toneAria = state.dailyTone === 'paper' ? '切换为深色卡片' : '切换为白色卡片';
  return ''
    + '<div class="wb2-hero-head">'
    +   '<span class="wb2-hero-tag"><span class="dot"></span>每日推荐</span>'
    +   `<span class="wb2-hero-date">${esc(date)}</span>`
    +   `<button class="wb2-refresh" type="button" data-act="daily-refresh" title="换一条">${IC.refresh}换一条</button>`
    + '</div>'
    + `<div class="wb2-hero-body" id="wb2DailyBody">${dailyBodyHtml()}</div>`
    + `<button class="wb2-tone" type="button" data-act="daily-tone" title="${toneAria}" aria-label="${toneAria}">${toneIcon}<span>${toneLabel}</span></button>`;
}

function updateDaily() {
  const card = $('wb2Daily');
  if (!card) return;
  card.innerHTML = dailyHeroHtml();
  applyDailyTone();
  const body = $('wb2DailyBody');
  if (body) body.classList.add('swap');
}

// ---------------------------------------------------------------- 数据：本机记录数 / 最近更新
async function readStats() {
  const out = { records: 0 };
  try {
    const db = await openDB();
    out.records = await idbCount(db, STORE_RECORDS);
  } catch (_) { /* IndexedDB 不可用时保持 0 */ }
  return out;
}

async function readRecentVersions() {
  try {
    const resp = await fetch('pages/changelog.html', { cache: 'no-store' });
    if (!resp.ok) return [];
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [...doc.querySelectorAll('.cl-item[data-ver], .cl-entry')].slice(0, 3);
    return items.map((e) => {
      const ver = (e.getAttribute('data-ver') || ((e.querySelector('.cl-ver') || {}).textContent || '')).trim();
      const date = (e.getAttribute('data-date') || ((e.querySelector('.cl-date, .cl-dat') || {}).textContent || '')).trim();
      return { ver, date };
    }).filter((v) => v.ver);
  } catch (_) { return []; }
}

// ---------------------------------------------------------------- 版本检查（最近更新区块）
const UPDATE_CACHE_KEY = 'kanseki_update_check_v1';
const UPDATE_REPO = 'AnkoMaryken/kanseki-catalog';
const UPDATE_API_LATEST = 'https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest';
const UPDATE_API_TAGS = 'https://api.github.com/repos/' + UPDATE_REPO + '/tags';
const UPDATE_RELEASES_PAGE = 'https://github.com/' + UPDATE_REPO + '/releases/latest';

function normalizeVersion(v) { return String(v == null ? '' : v).trim().replace(/^v/i, ''); }

function compareVersion(a, b) {
  const pa = normalizeVersion(a).split(/[.+\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = normalizeVersion(b).split(/[.+\-]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function resolveCurrentVersion() {
  try {
    const av = window.__APP_VERSION;
    if (av) return normalizeVersion(av);
  } catch (_) { /* 忽略 */ }
  const first = state.recent && state.recent[0];
  if (first && first.ver) return normalizeVersion(first.ver);
  return '';
}

function todayStamp() { return dateKey(new Date()); }

function readUpdateCache() {
  try {
    const o = JSON.parse(localStorage.getItem(UPDATE_CACHE_KEY) || 'null');
    if (o && o.date === todayStamp()) return o;
  } catch (_) { /* 忽略 */ }
  return null;
}

function writeUpdateCache() {
  const v = state.version;
  try {
    localStorage.setItem(UPDATE_CACHE_KEY, JSON.stringify({
      date: todayStamp(), latest: v.latest, assetUrl: v.assetUrl, pageUrl: v.pageUrl, checkedAt: v.checkedAt,
    }));
  } catch (_) { /* 忽略 */ }
}

function clearUpdateCache() {
  try { localStorage.removeItem(UPDATE_CACHE_KEY); } catch (_) { /* 忽略 */ }
}

/* 查 GitHub 最新 release；无 release 时退到 tags。失败抛出，由 checkUpdate 统一转成 error 态 */
async function fetchLatestRelease() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 8000);
  try {
    const resp = await fetch(UPDATE_API_LATEST, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (resp.ok) {
      const data = await resp.json();
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const exe = assets.find((a) => /\.exe$/i.test(a.name || '')) || null;
      return {
        tag: data.tag_name || data.name || '',
        assetUrl: (exe && exe.browser_download_url) || '',
        pageUrl: data.html_url || UPDATE_RELEASES_PAGE,
      };
    }
    if (resp.status !== 404) throw new Error('GitHub API HTTP ' + resp.status);
  } finally {
    clearTimeout(timer);
  }
  const resp2 = await fetch(UPDATE_API_TAGS, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!resp2.ok) throw new Error('GitHub API HTTP ' + resp2.status);
  const tags = await resp2.json();
  if (!Array.isArray(tags) || !tags.length) throw new Error('no tags');
  return { tag: tags[0].name || '', assetUrl: '', pageUrl: UPDATE_RELEASES_PAGE };
}

function applyVersionResult(latest, assetUrl, pageUrl, checkedAt) {
  const v = state.version;
  v.latest = normalizeVersion(latest);
  v.assetUrl = assetUrl || '';
  v.pageUrl = pageUrl || UPDATE_RELEASES_PAGE;
  v.checkedAt = checkedAt || Date.now();
  v.current = resolveCurrentVersion();
  if (!v.latest || !v.current) v.status = 'latest';
  else v.status = compareVersion(v.latest, v.current) > 0 ? 'new' : 'latest';
}

async function checkUpdate(force) {
  if (state.version.status === 'checking') return;
  state.version.current = resolveCurrentVersion();
  if (!force) {
    const cached = readUpdateCache();
    if (cached && cached.latest) {
      applyVersionResult(cached.latest, cached.assetUrl, cached.pageUrl, cached.checkedAt || 0);
      updateUpdateUI();
      return;
    }
  }
  state.version.status = 'checking';
  state.version.error = '';
  updateUpdateUI();
  try {
    const rel = await fetchLatestRelease();
    if (!rel.tag) throw new Error('release tag 为空');
    applyVersionResult(rel.tag, rel.assetUrl, rel.pageUrl, Date.now());
    writeUpdateCache();
  } catch (e) {
    state.version.status = 'error';
    state.version.error = (e && e.message) || String(e);
    clearUpdateCache();
  }
  updateUpdateUI();
}

/* 打开更新地址：优先 Lead 提供的全局外部打开能力；预留后端下载 switch */
function openUpdateUrl() {
  const v = state.version;
  const url = v.assetUrl || v.pageUrl || UPDATE_RELEASES_PAGE;
  // switch：后端若提供下载安装接口，可在此改为调用（例如 window.__kansekiDownloadUpdate?.(v)）
  try {
    if (typeof window.__kansekiOpenExternal === 'function') {
      window.__kansekiOpenExternal(url);
      return;
    }
  } catch (_) { /* 落到备用 */ }
  // 备用：打开 release 页面
  try { window.open(v.pageUrl || UPDATE_RELEASES_PAGE, '_blank', 'noopener'); } catch (_) { /* 忽略 */ }
}

function formatCheckedAt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function updateBlockInnerHtml() {
  const v = state.version;
  let stateHtml = '';
  if (v.status === 'checking') {
    stateHtml = '<span class="wb2-update-txt"><span class="wb2-spin"></span>正在检查更新…</span>';
  } else if (v.status === 'new') {
    stateHtml = '<span class="wb2-update-txt new"><b>新版本 v' + esc(v.latest) + ' 待下载</b><span>当前 v' + esc(v.current || '—') + '</span></span>'
      + '<button class="wb2-update-btn" type="button" data-act="update-download" title="打开下载页面">直接覆盖更新</button>';
  } else if (v.status === 'error') {
    stateHtml = '<span class="wb2-update-txt err">检查更新失败（可重试）</span>';
  } else {
    stateHtml = '<span class="wb2-update-txt">已是最新版本'
      + (v.latest ? (' v' + esc(v.latest)) : (v.current ? (' v' + esc(v.current)) : '')) + '</span>';
  }
  const meta = v.checkedAt
    ? ((v.status === 'error' ? '上次成功检查 ' : '上次检查 ') + esc(formatCheckedAt(v.checkedAt)))
    : '';
  return '<div class="wb2-update-line">' + stateHtml
    + '<button class="wb2-update-check" type="button" data-act="update-check" title="立即检查更新">检查更新</button></div>'
    + '<div class="wb2-update-meta">' + meta + '</div>';
}

function updateUpdateUI() {
  const host = $('wb2UpdateBlock');
  if (host) host.innerHTML = updateBlockInnerHtml();
}

function recentRowsHtml() {
  const list = state.recent;
  if (!list.length) return '<div class="wb2-recent-empty">暂无更新记录</div>';
  return list.slice(0, 3).map((v) => `
    <div class="wb2-recent-row"><b>${esc(v.ver)}</b><span>${esc(v.date || '')}</span></div>`).join('');
}

function recentHtml() {
  return '<div id="wb2RecentRows">' + recentRowsHtml() + '</div>'
    + '<div class="wb2-update" id="wb2UpdateBlock">' + updateBlockInnerHtml() + '</div>';
}

// ---------------------------------------------------------------- 快捷入口 / 资料磁贴
function quickCards() {
  const records = state.stats.records || 0;
  return [
    ['#/query', IC.cal, '纪年查询', '公历年 → 朝代年号'],
    ['#/kanseki', IC.tree, '古籍类目', '书名 → 总目分类'],
    ['#/kansekidb', IC.search, '日本所藏汉籍检索', '全國漢籍データベース'],
    ['#/najdb', IC.archive, '日本国立公文书馆', '内閣文庫 · 可下载'],
    ['#/records', IC.pen, '编目记录', records ? `本机 ${records} 条` : '本机 · 尚未录入'],
  ].map(([hash, ic, t, s]) => `
    <button class="wb2-qcard" type="button" data-go="${hash}">
      <span class="qi">${ic}</span><b>${esc(t)}</b><span>${esc(s)}</span>
    </button>`).join('');
}

function tilesHtml() {
  return [
    ['#/catalog?tab=0', IC.doc, '细则查阅', '2023.09 / 2025.10'],
    ['#/catalog?tab=1', IC.grid, '分类表查询', '六部 66 类'],
    ['#/catalog?tab=2', IC.book, '工作手册', 'PDF 内嵌预览'],
    ['#/guide', IC.info, '使用介绍', '功能与操作'],
    ['#/changelog', IC.clock, '更新日志', '版本沿革'],
  ].map(([hash, ic, t, s]) => `
    <button class="wb2-tile" type="button" data-go="${hash}">
      <span class="ti">${ic}</span><b>${esc(t)}</b><span class="sub">${esc(s)}</span><span class="arw">${IC.arrowR}</span>
    </button>`).join('');
}

// ---------------------------------------------------------------- 问问 AI
function ensureAI() {
  if (state.ai.module) return Promise.resolve(state.ai.module);
  if (typeof window !== 'undefined' && window.KansekiAI) {
    state.ai.module = window.KansekiAI;
    return Promise.resolve(state.ai.module);
  }
  if (state.ai.loading) return state.ai.loading;
  state.ai.loading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'pages/ai-config.js';
    s.onload = () => {
      state.ai.module = window.KansekiAI || null;
      state.ai.tried = true;
      resolve(state.ai.module);
    };
    s.onerror = () => {
      state.ai.module = null;
      state.ai.tried = true;
      resolve(null);
    };
    document.head.appendChild(s);
  });
  return state.ai.loading;
}

function aiConfigInfo() {
  const mod = state.ai.module;
  if (!mod || typeof mod.getConfig !== 'function') return { ok: false, hasKey: false, model: '' };
  try {
    const cfg = mod.getConfig();
    return { ok: true, hasKey: !!cfg.hasKey, model: cfg.model || '' };
  } catch (_) {
    return { ok: false, hasKey: false, model: '' };
  }
}

function aiChipsHtml() {
  return AI_CHIPS.map((c) =>
    `<button class="wb2-chip" type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
}

function aiAnswerHtml() {
  if (state.ai.busy) {
    return `<div class="wb2-ai-answer"><span class="wb2-spin"></span>${esc('正在思考…')}</div>`;
  }
  if (state.ai.error) {
    return `<div class="wb2-ai-answer"><span class="err">${esc(state.ai.error)}</span></div>`;
  }
  if (state.ai.answer) {
    /* 用户要求：主栏不显示答案正文，只显示状态 + 查看入口（答案只在 #wb2AiModal 浮窗内） */
    return '<div class="wb2-ai-done">'
      +   `<span class="wb2-ai-done-ico">${IC.check}</span>`
      +   '<div class="wb2-ai-done-tx"><b>问题已回答</b><span>完整答案在浮窗中，可查看或继续追问</span></div>'
      +   '<button class="wb2-ai-open" type="button" data-act="ai-open-modal">查看答案</button>'
      + '</div>';
  }
  return '';
}

function aiCardHtml() {
  const cfg = aiConfigInfo();
  state.ai.hasKey = !!cfg.hasKey;
  state.ai.model = cfg.model || '';
  const head = ''
    + '<div class="wb2-ai-head">'
    +   `<span class="wb2-ai-ico">${IC.spark}</span>`
    +   '<div class="wb2-ai-title"><b>问问 AI</b><span>古籍编目助手 · DeepSeek</span></div>'
    +   (cfg.hasKey && cfg.model ? `<span class="wb2-ai-model">${esc(cfg.model)}</span>` : '')
    + '</div>';

  if (!cfg.ok) {
    return head
      + '<div class="wb2-ai-empty">'
      +   '<p class="wb2-ai-hint">AI 配置模块未加载，暂时无法提问。</p>'
      +   '<div class="wb2-ai-empty-row">'
      +     `<button class="wb2-ai-set" type="button" data-act="ai-settings">${IC.gear}去设置</button>`
      +     '<button class="wb2-chip" type="button" data-act="ai-reload">重新加载</button>'
      +   '</div>'
      + '</div>';
  }

  if (!cfg.hasKey) {
    return head
      + '<div class="wb2-ai-empty">'
      +   '<p class="wb2-ai-hint">还没有配置 <span class="kw">DeepSeek API Key</span>，配置后即可让 AI 帮你检查著录、判断类目。</p>'
      +   '<div class="wb2-ai-empty-row">'
      +     `<button class="wb2-ai-set" type="button" data-act="ai-settings">${IC.gear}去设置</button>`
      +   '</div>'
      + '</div>';
  }

  return head
    + '<div class="wb2-ai-field">'
    +   `<textarea id="wb2AiInput" rows="1" placeholder="问一个编目问题，Enter 发送…">${esc(state.ai.draft || '')}</textarea>`
    +   `<button class="wb2-ai-send" type="button" data-act="ai-send" title="发送">${IC.send}</button>`
    + '</div>'
    + `<div class="wb2-ai-chips">${aiChipsHtml()}</div>`
    + aiAnswerHtml();
}

async function updateAI(opts) {
  opts = opts || {};
  const card = $('wb2AiCard');
  if (!card) return;
  let mod = state.ai.module;
  if (!mod && !state.ai.tried) mod = await ensureAI();
  if (!card.isConnected) return; // 视图已切走
  card.innerHTML = aiCardHtml();
}

async function aiSettings() {
  try {
    if (state.ai.module && typeof state.ai.module.openSettings === 'function') {
      await state.ai.module.openSettings();
      return;
    }
  } catch (_) { /* 落到外壳按钮 */ }
  const btn = $('sideSettingsBtn') || $('navSettings');
  if (btn) { btn.click(); return; }
  try { location.hash = '#/settings'; } catch (_) {}
}

/* 统一的提问逻辑：主栏输入框与浮窗内输入框共用；问题完成后主栏只显示状态，答案进浮窗 */
async function askAI(rawQuestion) {
  if (state.ai.busy) return;
  const q = String(rawQuestion == null ? '' : rawQuestion).trim();
  if (!q) return;
  let mod = state.ai.module;
  if (!mod) mod = await ensureAI();
  if (!mod || typeof mod.chat !== 'function') {
    state.ai.error = 'AI 模块未加载，请先在设置中检查配置。';
    updateAI();
    renderAIOverlay();
    return;
  }
  state.ai.draft = '';
  state.ai.busy = true;
  state.ai.error = '';
  state.ai.answer = '';
  updateAI();
  renderAIOverlay();
  // 带上前几轮对话（最多 8 条）以便追问
  const ctxHistory = state.ai.history.slice(-8);
  const messages = [{ role: 'system', content: AI_SYSTEM_PROMPT }]
    .concat(ctxHistory)
    .concat([{ role: 'user', content: q }]);
  try {
    const r = await mod.chat(messages, { temperature: 0.3 });
    const answer = (r && r.content) || '（模型没有返回内容，请重试）';
    state.ai.answer = answer;
    state.ai.history.push({ role: 'user', content: q });
    state.ai.history.push({ role: 'assistant', content: answer });
    if (state.ai.history.length > 24) state.ai.history = state.ai.history.slice(-24);
    showAiNotice(q, answer);
  } catch (e) {
    state.ai.error = '请求失败：' + ((e && e.message) || e);
    state.ai.draft = q;
  }
  state.ai.busy = false;
  updateAI();
  renderAIOverlay();
}

function sendAI() {
  const ta = $('wb2AiInput');
  const q = ((ta && ta.value) || '').trim();
  if (!q) { if (ta) ta.focus(); return; }
  if (ta) ta.value = '';
  askAI(q);
}

function sendFromModal() {
  const ta = $('wb2AiModalInput');
  const q = ((ta && ta.value) || '').trim();
  if (!q) { if (ta) ta.focus(); return; }
  ta.value = '';
  askAI(q);
}

/* 轻量 Markdown 渲染（不引库）：标题 / 无序·有序列表 / 加粗 / 行内代码 / 代码块 / 链接 / 引用 / 分隔线 / 段落
   先整段 HTML 转义，再做结构替换；链接仅允许 http(s)，代码块内容不再做行内替换。 */
function inlineMd(text) {
  let s = String(text == null ? '' : text);
  const slots = [];
  const keep = (html) => { slots.push(html); return '\u0000' + (slots.length - 1) + '\u0000'; };
  // 行内代码优先占位，避免其中的 * 与链接被误处理
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep('<code>' + code + '</code>'));
  // 链接 [文字](http...)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) =>
    keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'));
  // 裸链接
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)\]]+)/g, (m, pre, url) =>
    pre + keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>'));
  // 加粗
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  // 斜体（单星号，避开已生成的 strong）
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 还原占位
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[Number(i)] || '');
  return s;
}

function renderMarkdown(src) {
  const escaped = esc(String(src == null ? '' : src));
  const lines = escaped.split(/\r?\n/);
  const out = [];
  let para = [];
  let listType = ''; // 'ul' | 'ol'
  let i = 0;

  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!listType) return;
    out.push('</' + listType + '>');
    listType = '';
  };
  const openList = (type) => {
    if (listType === type) return;
    flushList();
    listType = type;
    out.push('<' + type + '>');
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块 ```lang ... ```
    if (/^```/.test(trimmed)) {
      flushPara();
      flushList();
      const lang = trimmed.replace(/^```+/, '').trim();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i += 1; }
      i += 1; // 跳过结束 ```
      out.push('<pre class="wb2-md-pre"><code' + (lang ? ' data-lang="' + lang.replace(/"/g, '') + '"' : '') + '>'
        + code.join('\n') + '</code></pre>');
      continue;
    }

    // 标题 # ~ ####（输出 h3/h4/h5，避免与页面 h1/h2 混淆）
    let m = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (m) {
      flushPara();
      flushList();
      const level = Math.min(5, m[1].length + 2);
      out.push('<h' + level + '>' + inlineMd(m[2]) + '</h' + level + '>');
      i += 1;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // 引用（连续多行合并）
    if (/^&gt;\s?/.test(line)) {
      flushPara();
      flushList();
      const quote = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^&gt;\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + quote.map(inlineMd).join('<br>') + '</blockquote>');
      continue;
    }

    // 无序列表
    m = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      openList('ul');
      out.push('<li>' + inlineMd(m[1]) + '</li>');
      i += 1;
      continue;
    }

    // 有序列表
    m = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      openList('ol');
      out.push('<li>' + inlineMd(m[1]) + '</li>');
      i += 1;
      continue;
    }

    // 空行：段落/列表收尾
    if (!trimmed) {
      flushPara();
      flushList();
      i += 1;
      continue;
    }

    // 普通段落行
    flushList();
    para.push(line);
    i += 1;
  }
  flushPara();
  flushList();
  return out.join('');
}

/* 旧名别名（保持兼容） */
function mdLite(src) { return renderMarkdown(src); }

// ---------------------------------------------------------------- AI 回答通知 / 页内浮窗（答案只在浮窗内查看）
function previewText(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function showAiNotice(q, a) {
  state.ai.notice = { q: q, a: a, dismissed: false, at: Date.now() };
  mountNotice(true);
}

function noticeHtml() {
  const n = state.ai.notice;
  if (!n) return '';
  return ''
    + '<div class="wb2-notice-head">'
    +   `<span class="wb2-notice-ico">${IC.spark}</span>`
    +   '<div class="wb2-notice-tx"><b>问题已回答 · 点击查看</b><span>' + esc(previewText('你问：' + n.q, 46)) + '</span></div>'
    +   `<button class="wb2-notice-x" type="button" data-act="notice-close" title="关闭通知" aria-label="关闭通知">${IC.x}</button>`
    + '</div>'
    + '<div class="wb2-notice-foot">'
    +   '<span class="wb2-notice-hint">答案在页面内浮窗中</span>'
    +   `<button class="wb2-notice-btn" type="button" data-act="notice-open">${IC.spark}查看答案</button>`
    + '</div>';
}

function mountNotice(animate) {
  const root = $('wbRoot');
  if (!root) return;
  let el = $('wb2Notice');
  const n = state.ai.notice;
  if (!n || n.dismissed) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'wb2Notice';
    el.className = 'wb2-notice';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    root.appendChild(el);
  }
  el.innerHTML = noticeHtml();
  // 浮窗打开期间不显示右下角通知（关闭浮窗后恢复）
  el.style.display = isAIOverlayOpen() ? 'none' : '';
  if (animate) {
    el.classList.remove('in');
    void el.offsetWidth;
    el.classList.add('in');
  }
}

function dismissNotice() {
  if (!state.ai.notice) return;
  state.ai.notice.dismissed = true;
  mountNotice();
}

// —— 页内浮窗（#wb2AiModal）：显示历史问答（Markdown 渲染）并可继续提问 ——
function isAIOverlayOpen() {
  return !!document.getElementById('wb2AiModal');
}

function aiOverlayMsgHtml(m) {
  if (!m) return '';
  const role = m.role === 'user' ? 'user' : 'assistant';
  if (role === 'user') {
    return '<div class="wb2-aiwin-msg user"><div class="wb2-aiwin-bubble">' + esc(m.content) + '</div></div>';
  }
  return '<div class="wb2-aiwin-msg assistant"><div class="wb2-aiwin-bubble wb2-md">'
    + renderMarkdown(m.content) + '</div></div>';
}

function renderAIOverlay() {
  const list = document.getElementById('wb2AiModalList');
  if (!list) return;
  const cfg = aiConfigInfo();
  let html = '';
  if (!state.ai.history.length) {
    html = '<div class="wb2-aiwin-empty">还没有问答记录：在主栏提问后，答案会在这里显示并可继续追问。</div>';
  } else {
    state.ai.history.forEach((m) => { html += aiOverlayMsgHtml(m); });
  }
  if (state.ai.busy) {
    html += '<div class="wb2-aiwin-msg assistant loading"><div class="wb2-aiwin-bubble">'
      + '<span class="wb2-spin"></span>正在思考…</div></div>';
  }
  if (state.ai.error) {
    html += '<div class="wb2-aiwin-msg assistant err"><div class="wb2-aiwin-bubble">'
      + esc(state.ai.error) + '</div></div>';
  }
  list.innerHTML = html;
  list.scrollTop = list.scrollHeight;
  // 头部/底部状态
  const hint = document.getElementById('wb2AiModalHint');
  if (hint) hint.textContent = cfg.hasKey ? ('模型 ' + (cfg.model || '')) : '尚未配置 API Key';
  const input = document.getElementById('wb2AiModalInput');
  const send = document.getElementById('wb2AiModalSend');
  const lock = document.getElementById('wb2AiModalLock');
  const disabled = !cfg.hasKey || state.ai.busy;
  if (input) input.disabled = disabled;
  if (send) send.disabled = disabled;
  if (lock) lock.hidden = !!cfg.hasKey;
}


/* 页内浮窗（用户要求：不跳独立窗口；答案只在 #wb2AiModal 中查看与继续提问） */
let overlayKeyHandler = null;

function closeAIOverlay() {
  const m = document.getElementById('wb2AiModal');
  if (m) m.remove();
  if (overlayKeyHandler) {
    document.removeEventListener('keydown', overlayKeyHandler);
    overlayKeyHandler = null;
  }
  // 浮窗关闭后恢复右下角通知
  const noticeEl = document.getElementById('wb2Notice');
  if (noticeEl) noticeEl.style.display = '';
}

function openAIOverlay() {
  closeAIOverlay();
  const overlay = document.createElement('div');
  overlay.className = 'wb2-aiwin-overlay';
  overlay.id = 'wb2AiModal';
  overlay.innerHTML = [
    '<div class="wb2-aiwin-panel" role="dialog" aria-modal="true" aria-label="问问 AI">',
    '  <button class="wb2-aiwin-close" type="button" data-close title="关闭">×</button>',
    '  <header class="wb2-aiwin-head">',
    '    <span class="wb2-aiwin-ico">' + IC.spark + '</span>',
    '    <div class="wb2-aiwin-title"><b>问问 AI</b><span>古籍编目助手 · 可继续追问</span></div>',
    '    <span class="wb2-aiwin-hint" id="wb2AiModalHint"></span>',
    '  </header>',
    '  <div class="wb2-aiwin-list" id="wb2AiModalList"></div>',
    '  <div class="wb2-aiwin-foot">',
    '    <div class="wb2-aiwin-lock" id="wb2AiModalLock" hidden>',
    '      <span>尚未配置 DeepSeek API Key，配置后可继续提问</span>',
    '      <button class="wb2-aiwin-settings" type="button" data-act="ai-settings">去设置</button>',
    '    </div>',
    '    <div class="wb2-aiwin-input">',
    '      <textarea id="wb2AiModalInput" rows="2" placeholder="继续提问…（Enter 发送，Shift+Enter 换行）"></textarea>',
    '      <button id="wb2AiModalSend" class="wb2-aiwin-send" type="button">发送</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('\n');
  document.getElementById('wbRoot').appendChild(overlay);

  // 浮窗打开时隐藏右下角通知，避免遮挡浮窗输入区
  const noticeEl = document.getElementById('wb2Notice');
  if (noticeEl) noticeEl.style.display = 'none';

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('[data-close]')) closeAIOverlay();
  });
  overlayKeyHandler = (e) => { if (e.key === 'Escape') closeAIOverlay(); };
  document.addEventListener('keydown', overlayKeyHandler);

  const send = $('wb2AiModalSend');
  if (send) send.addEventListener('click', sendFromModal);
  const input = $('wb2AiModalInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromModal(); }
    });
  }
  renderAIOverlay();
  setTimeout(() => { if (input && !input.disabled) input.focus(); }, 60);
  return overlay;
}

/* 兼容旧名：原「新窗口查看」入口与新需求统一改为页内浮窗 */
function openAIWindow() {
  return openAIOverlay();
}

// ---------------------------------------------------------------- 工作日历 / 待办
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function loadTodos() {
  try {
    const o = JSON.parse(localStorage.getItem(TODO_KEY) || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (_) { return {}; }
}

function saveTodos(o) {
  try { localStorage.setItem(TODO_KEY, JSON.stringify(o)); } catch (_) { /* 配额满等忽略 */ }
}

function todosOf(data, key) {
  const list = data[key];
  return Array.isArray(list) ? list : [];
}

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 周一为 0
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function calMetrics(data) {
  const today = new Date();
  const todayKey = dateKey(today);
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 7);
  let todayCount = todosOf(data, todayKey).length;
  let weekDone = 0;
  Object.keys(data).forEach((key) => {
    const parts = key.split('-').map(Number);
    if (parts.length !== 3 || !parts[0]) return;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (d >= weekStart && d < weekEnd) {
      weekDone += todosOf(data, key).filter((x) => x && x.done).length;
    }
  });
  return { todayCount, weekDone };
}

function calGridHtml() {
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // 周一为第一列
  const days = new Date(y, m + 1, 0).getDate();
  const todayKey = dateKey(new Date());
  const todos = loadTodos();
  let html = ['一', '二', '三', '四', '五', '六', '日']
    .map((w) => `<div class="wb2-cal-wd">${w}</div>`).join('');
  for (let i = 0; i < offset; i++) html += '<div class="wb2-day blank"></div>';
  for (let d = 1; d <= days; d++) {
    const key = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const count = todosOf(todos, key).length;
    const cls = ['wb2-day'];
    if (key === todayKey) cls.push('today');
    if (key === state.calSel) cls.push('sel');
    let dots = '';
    if (count > 0) {
      dots = '<span class="dots">' + '<i></i>'.repeat(Math.min(count, 3)) + '</span>';
    }
    html += `<button class="${cls.join(' ')}" type="button" data-day="${key}"><span class="num">${d}</span>${dots}</button>`;
  }
  return html;
}

function todoHeadLabel() {
  if (!state.calSel) return '选择一个日期';
  const parts = state.calSel.split('-').map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  const todayKey = dateKey(new Date());
  const suffix = state.calSel === todayKey ? ' · 今天' : '';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEK_CN[d.getDay()]}${suffix}`;
}

function todoListHtml() {
  const data = loadTodos();
  const list = todosOf(data, state.calSel);
  if (!list.length) return '<div class="wb2-todo-empty">这一天还没有待办。加一条试试。</div>';
  return list.map((it) => `
    <div class="wb2-todo-item${it.done ? ' done' : ''}">
      <button class="wb2-check" type="button" data-todo="${esc(it.id)}" title="${it.done ? '标为未完成' : '标为完成'}">${IC.check}</button>
      <div class="wb2-todo-text">${esc(it.text)}</div>
      <button class="wb2-todo-del" type="button" data-del="${esc(it.id)}" title="删除">${IC.trash}</button>
    </div>`).join('');
}

function calendarInnerHtml() {
  const data = loadTodos();
  const mt = calMetrics(data);
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  const list = todosOf(data, state.calSel);
  const doneCount = list.filter((x) => x && x.done).length;
  return ''
    + '<div class="wb2-card-head">'
    +   '<h3>工作日历</h3>'
    +   `<span class="wb2-card-sub">今日待办 ${mt.todayCount} 项 · 本周完成 ${mt.weekDone} 项</span>`
    +   '<div class="wb2-head-right wb2-cal-nav">'
    +     `<button class="wb2-icon-btn" type="button" data-act="cal-prev" title="上个月">${IC.chevL}</button>`
    +     `<span class="wb2-cal-month">${y} 年 ${m + 1} 月</span>`
    +     `<button class="wb2-icon-btn" type="button" data-act="cal-next" title="下个月">${IC.chevR}</button>`
    +     '<button class="wb2-today-btn" type="button" data-act="cal-today">今天</button>'
    +   '</div>'
    + '</div>'
    + `<div class="wb2-cal-grid">${calGridHtml()}</div>`
    + '<div class="wb2-todo">'
    +   '<div class="wb2-todo-head">'
    +     `<b>${esc(todoHeadLabel())}</b>`
    +     `<span>${list.length ? `未完成 ${list.length - doneCount} / 共 ${list.length}` : '暂无待办'}</span>`
    +   '</div>'
    +   `<div class="wb2-todo-list" id="wb2TodoList">${todoListHtml()}</div>`
    +   '<div class="wb2-todo-add">'
    +     `<input class="wb2-todo-input" id="wb2TodoInput" type="text" maxlength="80" placeholder="添加待办，如：核对《论语》卷数…" autocomplete="off">`
    +     `<button class="wb2-todo-submit" type="button" data-act="todo-add">添加</button>`
    +   '</div>'
    + '</div>';
}

function updateCalendar() {
  const card = $('wb2CalCard');
  if (!card) return;
  const input = $('wb2TodoInput');
  const draft = input ? input.value : '';
  card.innerHTML = calendarInnerHtml();
  const next = $('wb2TodoInput');
  if (next && draft) next.value = draft;
}

function clampMonthSel() {
  const y = state.calMonth.getFullYear();
  const m = state.calMonth.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  let day = 1;
  if (state.calSel) {
    const parts = state.calSel.split('-').map(Number);
    if (parts[0] === y && parts[1] === m + 1) day = Math.min(parts[2], last);
    else day = Math.min(parts[2] || 1, last);
  }
  state.calSel = `${y}-${pad2(m + 1)}-${pad2(day)}`;
}

function calShift(dir) {
  if (!state.calMonth) state.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + dir, 1);
  clampMonthSel();
  updateCalendar();
}

function calToday() {
  const now = new Date();
  state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  state.calSel = dateKey(now);
  updateCalendar();
}

function addTodo() {
  const input = $('wb2TodoInput');
  const text = ((input && input.value) || '').trim();
  if (!text) { if (input) input.focus(); return; }
  const data = loadTodos();
  if (!state.calSel) state.calSel = dateKey(new Date());
  if (!Array.isArray(data[state.calSel])) data[state.calSel] = [];
  data[state.calSel].push({
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.slice(0, 80),
    done: false,
    at: Date.now(),
  });
  saveTodos(data);
  if (input) input.value = '';
  updateCalendar();
  const next = $('wb2TodoInput');
  if (next) next.focus();
}

function toggleTodo(id, data) {
  const list = todosOf(data, state.calSel);
  const it = list.find((x) => x && x.id === id);
  if (!it) return;
  it.done = !it.done;
  saveTodos(data);
  updateCalendar();
}

function deleteTodo(id, data) {
  const list = todosOf(data, state.calSel);
  const next = list.filter((x) => x && x.id !== id);
  if (next.length) data[state.calSel] = next;
  else delete data[state.calSel];
  saveTodos(data);
  updateCalendar();
}

// ---------------------------------------------------------------- 渲染 / 事件
function headHtml() {
  const g = greetingInfo();
  const nameHtml = g.name ? '，<span class="nm">' + esc(g.name) + '</span>' : '';
  return ''
    + '<div class="wb2-head-tx">'
    +   '<div class="wb2-kicker"><span class="dot"></span>工作台</div>'
    +   `<h1 class="wb2-greet">${esc(g.prefix)}${nameHtml}</h1>`
    +   `<p class="wb2-sub">${esc(g.sub)}</p>`
    + '</div>'
    + '<div class="wb2-head-side">'
    +   `<span class="wb2-date"><span class="dot"></span>${esc(todayCn())}</span>`
    + '</div>';
}

function renderAll() {
  const root = $('wbRoot');
  if (!root) return;
  const toneCls = state.dailyTone === 'paper' ? ' is-paper' : '';
  root.innerHTML = ''
    + '<div class="wb2-head">' + headHtml() + '</div>'
    + `<div class="wb2-quick">${quickCards()}</div>`
    + '<div class="wb2-hero-grid">'
    +   `<section class="wb2-hero wb2-reveal${toneCls}" id="wb2Daily">${dailyHeroHtml()}</section>`
    +   '<section class="wb2-card wb2-ai" id="wb2AiCard"><div class="wb2-ai-head"><span class="wb2-ai-ico">' + IC.spark + '</span><div class="wb2-ai-title"><b>问问 AI</b><span>古籍编目助手 · DeepSeek</span></div></div><div class="wb2-ai-empty"><p class="wb2-ai-hint">正在加载 AI 配置…</p></div></section>'
    + '</div>'
    + '<div class="wb2-lower-grid">'
    +   `<section class="wb2-card wb2-cal" id="wb2CalCard">${calendarInnerHtml()}</section>`
    +   '<div class="wb2-stack">'
    +     `<section class="wb2-card wb2-tiles"><div class="wb2-card-head"><h3>编目资料</h3></div>${tilesHtml()}</section>`
    +     `<section class="wb2-card wb2-recent" id="wb2RecentCard"><div class="wb2-card-head"><h3>最近更新</h3></div>${recentHtml()}</section>`
    +   '</div>'
    + '</div>';
  applyDailyTone();
  bindRootEvents(root);
  updateAI();
  mountNotice();
  if (isAIOverlayOpen()) renderAIOverlay();
}

function bindRootEvents(root) {
  if (root.__wb2Bound) return;
  root.__wb2Bound = true;

  root.addEventListener('click', (e) => {
    /* 通知卡片：点击直接打开页内浮窗查看答案 */
    if (e.target.closest('.wb2-notice') && !e.target.closest('[data-act]')) {
      openAIOverlay();
      return;
    }

    const goEl = e.target.closest('[data-go]');
    if (goEl) { go(goEl.getAttribute('data-go')); return; }

    const dayEl = e.target.closest('[data-day]');
    if (dayEl) {
      state.calSel = dayEl.getAttribute('data-day');
      updateCalendar();
      return;
    }

    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const ta = $('wb2AiInput');
      if (ta) { ta.value = chip.getAttribute('data-chip'); ta.focus(); }
      return;
    }

    const todoBtn = e.target.closest('[data-todo]');
    if (todoBtn) { toggleTodo(todoBtn.getAttribute('data-todo'), loadTodos()); return; }

    const delBtn = e.target.closest('[data-del]');
    if (delBtn) { deleteTodo(delBtn.getAttribute('data-del'), loadTodos()); return; }

    const act = e.target.closest('[data-act]');
    if (!act) return;
    const name = act.getAttribute('data-act');
    if (name === 'daily-refresh') {
      state.dailyOffset += 1;
      updateDaily();
    } else if (name === 'daily-tone') {
      toggleDailyTone();
    } else if (name === 'cal-prev') calShift(-1);
    else if (name === 'cal-next') calShift(1);
    else if (name === 'cal-today') calToday();
    else if (name === 'todo-add') addTodo();
    else if (name === 'ai-send') sendAI();
    else if (name === 'ai-settings') aiSettings();
    else if (name === 'ai-open-modal' || name === 'notice-open' || name === 'ai-window' || name === 'notice-window') openAIOverlay();
    else if (name === 'notice-close') dismissNotice();
    else if (name === 'update-check') checkUpdate(true);
    else if (name === 'update-download') openUpdateUrl();
    else if (name === 'ai-reload') {
      state.ai.tried = false;
      state.ai.module = null;
      state.ai.loading = false;
      updateAI();
    }
  });

  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'wb2AiInput' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAI();
    } else if (t.id === 'wb2TodoInput' && e.key === 'Enter') {
      e.preventDefault();
      addTodo();
    }
  });
}

/* 登录态 / AI Key 变化时轻量刷新 */
function bindGlobalOnce() {
  if (typeof window === 'undefined' || window.__wb2GlobalsBound) return;
  window.__wb2GlobalsBound = true;

  window.addEventListener('storage', (e) => {
    if (!e || !e.key) return;
    if (e.key === USER_KEY || e.key === PROFILE_KEY) {
      const head = document.querySelector('#wbRoot .wb2-head');
      if (head) head.innerHTML = headHtml();
      const q = document.querySelector('#wbRoot .wb2-quick');
      if (q) { q.innerHTML = quickCards(); }
    }
    if (/^kanseki_deepseek_/.test(e.key)) {
      state.ai.module = null;
      state.ai.tried = false;
      state.ai.loading = false;
      updateAI();
    }
  });

  window.addEventListener('focus', () => {
    if (!document.querySelector('#wbRoot .wb2-ai')) return;
    const cfg = aiConfigInfo();
    const hasKeyNow = !!cfg.hasKey;
    if (hasKeyNow !== state.ai.hasKey) {
      state.ai.hasKey = hasKeyNow;
      updateAI();
    }
  });
}

// ---------------------------------------------------------------- 入口
export async function initWorkbench() {
  const root = $('wbRoot');
  if (!root) return;

  // 每日推荐配色（持久化）与日历初始状态
  state.dailyTone = loadDailyTone();
  const now = new Date();
  if (!state.calMonth) state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  if (!state.calSel) state.calSel = dateKey(now);

  bindGlobalOnce();

  try {
    const [stats, recent] = await Promise.all([readStats(), readRecentVersions()]);
    state.stats = stats;
    state.recent = recent;
  } catch (_) { /* 读取失败时保留默认值 */ }

  state.version.current = resolveCurrentVersion();
  renderAll();
  /* 打开工作台时自动检查新版本：当天有缓存则直接用缓存，否则联网查询（失败静默为可重试态） */
  checkUpdate(false).catch(() => {});
}

/* 调试 / 自测钩子（不参与界面逻辑；便于自动化脚本模拟 AI 回答、浮窗与版本检查） */
try {
  window.__wb2Debug = {
    state: state,
    initWorkbench: initWorkbench,
    showAiNotice: showAiNotice,
    mountNotice: mountNotice,
    openAIWindow: openAIWindow,
    openAIOverlay: openAIOverlay,
    renderMarkdown: renderMarkdown,
    checkUpdate: checkUpdate,
    simulateAnswer: function (q, a) {
      state.ai.history.push({ role: 'user', content: q });
      state.ai.history.push({ role: 'assistant', content: a });
      state.ai.answer = a;
      state.ai.error = '';
      showAiNotice(q, a);
      updateAI();
      mountNotice(true);
      renderAIOverlay();
    },
  };
} catch (_) { /* 忽略 */ }
