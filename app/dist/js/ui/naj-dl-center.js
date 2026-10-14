// ================================================
// js/ui/naj-dl-center.js — 「下载中心」（V9.9）
// ================================================
// 用户要求：
//   · 标题栏右上角、最小化旁边加一个按钮，点一下看当前下载详情（速度 / 进度）；
//   · 一边下载一边还能用软件其它功能 ⇒ 抽屉式面板（不遮挡、不阻塞，可随时收起）；
//   · 整包下载并打包完毕后，主界面上下弹出消息提醒；
//   · 失败时右下角弹窗 + 提示音。
//
// 实现要点：
//   · 抽屉与横幅都是 body 末尾注入的浮层，不参与视图布局，切视图不丢；
//   · 速度/进度由 Rust 侧 `naj_dl_progress` 提供（传输循环里实时累加），
//     这里每 800ms 轮询一次 —— 只依赖 `__TAURI_INTERNALS__.invoke`，零额外前端依赖；
//   · 提示音用 WebAudio 现场合成（不引入音频文件）。
// ================================================
import { RUN, invoke, taskDir, pauseRun, resumeRun, cancelRun, decide, dlAvailable, esc, onEngine } from './naj-dl.js';

const el = (id) => document.getElementById(id);
let pollTimer = null;
let soundReady = false;

// ---------------------------------------------------------------- 提示音

let audioCtx = null;
export function beep(kind = 'ok') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.01;
    const seq = kind === 'error' ? [784, 587, 392] : (kind === 'warn' ? [587, 587] : [659, 880]);
    seq.forEach((f, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const at = t0 + i * 0.17;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(at);
      o.stop(at + 0.18);
    });
    soundReady = true;
  } catch (_) { /* 音频不可用就算了，不影响下载 */ }
}

// ---------------------------------------------------------------- 顶部横幅 / 右下角通知

function ensureBanner() {
  if (el('dlcBanner')) return;
  const b = document.createElement('div');
  b.className = 'dlc-banner';
  b.id = 'dlcBanner';
  b.hidden = true;
  b.innerHTML = `
    <div class="dlc-banner-ic" id="dlcBannerIc">✔</div>
    <div class="dlc-banner-tx">
      <b id="dlcBannerTitle"></b>
      <span id="dlcBannerText"></span>
    </div>
    <div class="dlc-banner-act">
      <button class="av-btn" type="button" id="dlcBannerOpen" hidden>打开所在文件夹</button>
      <button class="av-btn" type="button" id="dlcBannerDetail" hidden>查看下载详情</button>
      <button class="dlc-x" type="button" id="dlcBannerClose" title="关闭">×</button>
    </div>`;
  document.body.appendChild(b);
  el('dlcBannerClose').addEventListener('click', () => { b.hidden = true; });
}

function showBanner({ kind, title, text, dir, sticky }) {
  ensureBanner();
  const b = el('dlcBanner');
  b.className = 'dlc-banner dlc-banner-' + (kind || 'ok');
  b.hidden = false;
  el('dlcBannerIc').textContent = kind === 'error' ? '!' : (kind === 'warn' ? '⏸' : '✔');
  el('dlcBannerTitle').textContent = title || '';
  el('dlcBannerText').textContent = text || '';
  const openBtn = el('dlcBannerOpen');
  openBtn.hidden = !dir;
  openBtn.onclick = async () => {
    if (!dir) return;
    try { await invoke('reveal_path', { path: dir }); } catch (e) { window.__kansekiToast?.(String(e.message || e), 'err'); }
  };
  const detail = el('dlcBannerDetail');
  detail.hidden = false;
  detail.onclick = () => openDrawer();
  clearTimeout(b._timer);
  if (!sticky) b._timer = setTimeout(() => { b.hidden = true; }, 9000);
}

function ensureAlerts() {
  if (el('dlcAlerts')) return;
  const a = document.createElement('div');
  a.className = 'dlc-alerts';
  a.id = 'dlcAlerts';
  document.body.appendChild(a);
}

/** 右下角常驻通知（失败时用；带按钮，需用户处理） */
function pushAlert({ title, text, actions }) {
  ensureAlerts();
  const box = el('dlcAlerts');
  const card = document.createElement('div');
  card.className = 'dlc-alert';
  card.innerHTML = `
    <div class="dlc-alert-head"><span class="dlc-alert-ic">!</span><b>${esc(title)}</b>
      <button class="dlc-x" type="button" title="关闭">×</button></div>
    <div class="dlc-alert-text">${esc(text)}</div>
    <div class="dlc-alert-act"></div>`;
  const actBox = card.querySelector('.dlc-alert-act');
  for (const a of (actions || [])) {
    const btn = document.createElement('button');
    btn.className = 'av-btn' + (a.primary ? ' av-btn-primary' : '');
    btn.type = 'button';
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      card.remove();
      try { a.onClick && a.onClick(); } catch (_) { /* 忽略 */ }
    });
    actBox.appendChild(btn);
  }
  card.querySelector('.dlc-x').addEventListener('click', () => card.remove());
  box.appendChild(card);
  // 最多留 4 条，避免堆满屏幕
  while (box.children.length > 4) box.removeChild(box.firstChild);
}

/** 统一入口：naj-dl.js 在任务收尾时调用 */
export function notify(payload) {
  const { kind, title, text, dir, task } = payload || {};
  showBanner({ kind, title, text, dir, sticky: kind === 'error' });
  window.__kansekiToast?.(`${title}：${text}`, kind === 'error' ? 'err' : 'ok');
  beep(kind === 'error' ? 'error' : 'ok');
  if (kind === 'error') {
    pushAlert({
      title,
      text,
      actions: [
        { label: '查看下载详情', primary: true, onClick: () => openDrawer() },
        dir ? { label: '打开文件夹', onClick: () => invoke('reveal_path', { path: dir }).catch(() => { }) } : null,
      ].filter(Boolean),
    });
  }
  updateBadge();
  if (!el('dlcDrawer')?.hidden) renderDrawer();
}

// ---------------------------------------------------------------- 抽屉

function ensureButton() {
  const right = document.querySelector('.app-titlebar .tb-right');
  if (!right || el('tbDl')) return;
  const btn = document.createElement('button');
  btn.className = 'tb-win tb-dlbtn';
  btn.id = 'tbDl';
  btn.type = 'button';
  btn.title = '下载中心（查看下载速度与进度）';
  btn.setAttribute('aria-label', '下载中心');
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>
    </svg>
    <span class="tb-dl-badge" id="tbDlBadge" hidden>0</span>`;
  right.insertBefore(btn, el('tbMin'));
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleDrawer(); });
}

function ensureDrawer() {
  if (el('dlcDrawer')) return;
  const d = document.createElement('aside');
  d.className = 'dlc-drawer';
  d.id = 'dlcDrawer';
  d.hidden = true;
  d.innerHTML = `
    <div class="dlc-head">
      <b>下载中心</b>
      <span class="dlc-head-sub" id="dlcState">空闲</span>
      <button class="dlc-x" type="button" id="dlcClose" title="收起">×</button>
    </div>
    <div class="dlc-body">
      <div class="dlc-sec" id="dlcNow">
        <div class="dlc-empty">当前没有下载任务。<br>
          在「国立公文书馆」检索结果里点条目右侧的「下载」，或用「批量下载」一次提交多本。</div>
      </div>
      <div class="dlc-sec" id="dlcQueueSec" hidden>
        <div class="dlc-sec-title">批量队列</div>
        <div id="dlcQueue" class="dlc-queue"></div>
      </div>
      <div class="dlc-sec" id="dlcDecideSec" hidden>
        <div class="dlc-sec-title">这一本下载失败，要怎么处理？</div>
        <div class="dlc-decide" id="dlcDecideText"></div>
        <div class="dlc-decide-btns">
          <button class="av-btn av-btn-primary" type="button" data-dlc-decide="retry">重试这一本</button>
          <button class="av-btn" type="button" data-dlc-decide="skip">略过，继续下一本</button>
          <button class="av-btn" type="button" data-dlc-decide="pause">暂停整批（保留进度）</button>
          <button class="av-btn" type="button" data-dlc-decide="cancel">取消整批</button>
        </div>
      </div>
    </div>
    <div class="dlc-foot">
      <button class="av-btn" type="button" id="dlcPause">暂停</button>
      <button class="av-btn" type="button" id="dlcCancel">取消</button>
      <button class="av-btn" type="button" id="dlcReveal">打开文件夹</button>
    </div>`;
  document.body.appendChild(d);
  el('dlcClose').addEventListener('click', () => { d.hidden = true; syncAlertsOffset(); updateBadge(); });
  el('dlcPause').addEventListener('click', () => {
    if (RUN.paused) resumeRun(); else pauseRun();
    renderDrawer();
  });
  el('dlcCancel').addEventListener('click', () => { cancelRun(); renderDrawer(); });
  el('dlcReveal').addEventListener('click', () => {
    const dir = RUN.current ? RUN.current.dir : (RUN.lastResult && RUN.lastResult.dir);
    if (dir) invoke('reveal_path', { path: dir }).catch(() => { });
  });
  d.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dlc-decide]');
    if (b) { decide(b.dataset.dlcDecide); renderDrawer(); }
  });
}

export function openDrawer() {
  ensureDrawer();
  el('dlcDrawer').hidden = false;
  syncAlertsOffset();
  renderDrawer();
}

export function toggleDrawer() {
  ensureDrawer();
  const d = el('dlcDrawer');
  d.hidden = !d.hidden;
  syncAlertsOffset();
  if (!d.hidden) renderDrawer();
  updateBadge();
}

/** 抽屉打开时，把右下角通知整体左移，避免压住抽屉底部的「暂停/取消」按钮（实测踩过） */
function syncAlertsOffset() {
  const box = el('dlcAlerts');
  if (!box) return;
  const open = !el('dlcDrawer')?.hidden;
  box.classList.toggle('with-drawer', !!open);
}

function fmtMB(n) { return `${(Number(n || 0) / 1048576).toFixed(1)} MB`; }
function fmtSpeed(bps) {
  const v = Number(bps || 0);
  if (v <= 0) return '—';
  if (v >= 1048576) return `${(v / 1048576).toFixed(2)} MB/s`;
  return `${(v / 1024).toFixed(0)} KB/s`;
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

let live = { speed_bps: 0, bytes_done: 0, bytes_total: 0, pages_done: 0, pages_total: 0, active: false, elapsed_ms: 0, kind: '', label: '' };

async function pollOnce() {
  if (!dlAvailable()) return;
  try {
    const p = await invoke('naj_dl_progress');
    if (p) live = p;
  } catch (_) { /* 忽略 */ }
  // 托盘菜单点了「下载中心」→ 打开抽屉
  try {
    if (await invoke('app_take_open_center')) openDrawer();
  } catch (_) { /* 忽略 */ }
  if (!el('dlcDrawer')?.hidden || RUN.running) renderDrawer();
  updateBadge();
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, 800);
}

export function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------- 渲染

function taskOfRun() {
  return RUN.current ? RUN.current.task : (RUN.lastResult ? RUN.lastResult.task : null);
}

function renderNow() {
  const box = el('dlcNow');
  if (!box) return;
  const task = taskOfRun();
  if (!task) {
    box.innerHTML = `<div class="dlc-empty">当前没有下载任务。<br>
      在「国立公文书馆」检索结果里点条目右侧的「下载」，或用「批量下载」一次提交多本。<br>
      <span class="dlc-dim">提示：点窗口关闭按钮不会退出程序，而是最小化到右下角托盘，下载继续；点托盘图标即可回到这里。</span></div>`;
    return;
  }
  const vols = task.volumes || [];
  const done = vols.filter((v) => v.status === 'done').length;
  const running = vols.find((v) => v.status === 'running');
  const pct = Math.round((done / Math.max(1, vols.length)) * 100);
  const bytesTotal = task.volumes.reduce((s, v) => s + (v.files || []).reduce((a, f) => a + (Number(f.bytes) || 0), 0), 0);
  const liveBar = live.active
    ? (live.bytes_total > 0
      ? Math.round((live.bytes_done / live.bytes_total) * 100)
      : (live.pages_total > 0 ? Math.round((live.pages_done / live.pages_total) * 100) : 0))
    : 0;
  box.innerHTML = `
    <div class="dlc-sec-title">当前任务</div>
    <div class="dlc-book">${esc(task.book.title || '')}</div>
    <div class="dlc-meta">${done}/${vols.length} 册完成 · 已落盘 ${fmtMB(bytesTotal)}
      ${task.zip && task.zip.path ? ' · 已打包' : ''}</div>
    <div class="dlc-bar"><div class="dlc-bar-in" style="width:${pct}%"></div></div>
    <div class="dlc-live">
      <div class="dlc-live-row">
        <span>${live.active ? esc(live.label || '') : (running ? esc(running.title || '') : '（等待中）')}</span>
        <b class="dlc-speed">${fmtSpeed(live.speed_bps)}</b>
      </div>
      <div class="dlc-live-row dlc-dim">
        <span>${live.active
      ? (live.bytes_total > 0
        ? `${fmtMB(live.bytes_done)} / ${fmtMB(live.bytes_total)}`
        : (live.pages_total > 0 ? `已取 ${live.pages_done}/${live.pages_total} 页` : fmtMB(live.bytes_done)))
      : '—'}</span>
        <span>${live.active ? `本次已用 ${fmtDur(live.elapsed_ms)}` : ''}</span>
      </div>
      <div class="dlc-bar dlc-bar-live"><div class="dlc-bar-in dlc-bar-in-live" style="width:${liveBar}%"></div></div>
      ${running ? `<div class="dlc-dim">本册：${esc(running.title || '')} ${running.pages ? `（共 ${running.pages} 页）` : ''}</div>` : ''}
    </div>
    <div class="dlc-actions">
      <button class="av-btn" type="button" data-dlc-open-task="1">查看逐册明细</button>
    </div>
    <div class="dlc-dim dlc-path" title="${esc(taskDir(task))}">${esc(taskDir(task))}</div>`;
  const openBtn = box.querySelector('[data-dlc-open-task]');
  if (openBtn) openBtn.addEventListener('click', () => window.__najDlShowTask?.(task));
}

function renderQueue() {
  const sec = el('dlcQueueSec');
  const box = el('dlcQueue');
  if (!sec || !box) return;
  const batch = RUN.batch;
  if (!batch || !batch.items || !batch.items.length) { sec.hidden = true; return; }
  sec.hidden = false;
  const label = {
    pending: ['待下载', 'dl-b-idle'],
    resolving: ['读取信息', 'dl-b-run'],
    ready: ['已核对', 'dl-b-idle'],
    downloading: ['下载中', 'dl-b-run'],
    done: ['完成', 'dl-b-ok'],
    skipped: ['已略过', 'dl-b-warn'],
    failed: ['失败', 'dl-b-err'],
  };
  box.innerHTML = batch.items.map((it, i) => {
    const [tx, cls] = label[it.status] || ['—', 'dl-b-idle'];
    return `<div class="dlc-qitem ${i === batch.cursor ? 'on' : ''}">
      <span class="dlc-qno">${String(i + 1).padStart(2, '0')}</span>
      <span class="dlc-qtitle" title="${esc(it.title || it.input)}">${esc(it.title || it.input)}</span>
      <span class="dl-badge ${cls}">${esc(tx)}</span>
    </div>`;
  }).join('');
}

function renderDecide() {
  const sec = el('dlcDecideSec');
  if (!sec) return;
  const pending = RUN.batch && RUN.batch.awaitingDecision;
  sec.hidden = !pending;
  if (pending) {
    el('dlcDecideText').textContent = `${pending.title || pending.input}：${pending.error || '下载未完成'}`;
  }
}

function renderDrawer() {
  if (!el('dlcDrawer')) return;
  const running = RUN.running;
  el('dlcState').textContent = RUN.cancelled ? '已取消' : (RUN.paused ? '已暂停' : (running ? '下载中' : '空闲'));
  const pauseBtn = el('dlcPause');
  pauseBtn.textContent = RUN.paused ? '继续' : '暂停';
  pauseBtn.disabled = !running;
  el('dlcCancel').disabled = !running;
  renderNow();
  renderQueue();
  renderDecide();
}

function updateBadge() {
  const btn = el('tbDl');
  if (!btn) return;
  const badge = el('tbDlBadge');
  const task = taskOfRun();
  let txt = '';
  if (RUN.running && task) {
    const done = task.volumes.filter((v) => v.status === 'done').length;
    txt = `${done}/${task.volumes.length}`;
  } else if (RUN.batch && RUN.batch.items) {
    const done = RUN.batch.items.filter((i) => i.status === 'done').length;
    if (RUN.batch.items.length) txt = `${done}/${RUN.batch.items.length}`;
  }
  if (txt) { badge.hidden = false; badge.textContent = txt; } else { badge.hidden = true; }
  btn.classList.toggle('busy', !!RUN.running);
}

// ---------------------------------------------------------------- 初始化

export function initDownloadCenter() {
  if (!dlAvailable()) return null;
  ensureButton();
  ensureDrawer();
  ensureBanner();
  ensureAlerts();
  startPolling();
  // 引擎状态一变就刷新抽屉与角标（逐册进度都是引擎在推）
  onEngine(() => { renderDrawer(); updateBadge(); });
  // 供其它模块（批量面板、单本面板）回调，避免循环 import
  window.__najDlBeep = beep;
  window.__najDlOpenDrawer = openDrawer;
  return { notify, openDrawer, toggleDrawer, beep, stopPolling };
}

// naj-dl.js 通过 window 钩子回调（避免循环 import）
window.__najDlNotify = notify;
