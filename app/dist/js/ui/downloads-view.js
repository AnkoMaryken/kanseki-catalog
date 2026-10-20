// ================================================
// js/ui/downloads-view.js — 下载中心（V2.0：按本暂停/继续 + 每本具体进度）
// ================================================
// 用户第 13 条：
//   ① 每个任务（每本书）可单独「暂停 / 继续」，暂停一本时其它书继续；
//      状态区分：队列中 / 下载中 / 已暂停 / 已完成 / 失败；
//   ② 每本显示具体进度：百分比、已下载/总册数、已落盘页数、当前文件/册、
//      速度与剩余时间（桌面版有引擎实测数据时）、失败原因；
//   ③ 不再显示顶部说明文字；
//   ④ 「打开文件夹」打开**当前这本书**的下载目录（reveal_path；网页版提示不可用）；
//   ⑤ 与批量引擎兼容：批量里暂停一本 → 队列继续下一本；恢复时重新入队，
//      零缺册审计与打包仍由 executeTask / finalizeTask 原流程保证。
// 数据：全部来自 naj-dl.js 的 RUN / listRunTasks()（真实下载状态），不另存一份。
// ================================================
import {
  RUN, listRunTasks, pauseRun, resumeRun, cancelRun, taskDir, onEngine, invoke, esc, toast,
  dlAvailable, pauseRecord, resumeRecord, cancelQueuedResume, pumpResumeQueue,
} from './naj-dl.js';

const el = (id) => document.getElementById(id);
let inited = false;
let timer = null;

// 引擎实时进度（Rust 侧 naj_dl_progress；网页版拿不到 → 只显示逐册状态）
let live = {
  active: false, speed_bps: 0, bytes_done: 0, bytes_total: 0,
  pages_done: 0, pages_total: 0, elapsed_ms: 0, label: '', kind: '',
};

const STATE = {
  running: ['下载中', 'run'],
  queued: ['队列中', 'queued'],
  paused: ['已暂停', 'paused'],
  done: ['已完成', 'ok'],
  failed: ['失败', 'err'],
  cancelled: ['已取消', 'cancel'],
};

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtMB(n) { return `${(Number(n || 0) / 1048576).toFixed(1)} MB`; }
function fmtSpeed(bps) {
  const v = Number(bps || 0);
  if (v <= 0) return '';
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
function fmtPct(rec) {
  const total = Number(rec.total) || 0;
  const done = Number(rec.done) || 0;
  if (!total) return rec.status === 'done' ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}
function dirOf(rec) {
  if (!rec) return '';
  if (rec.dir) return rec.dir;
  try { return rec.task ? taskDir(rec.task) : ''; } catch (_) { return ''; }
}
function activeVolume(rec) {
  const vols = (rec && rec.task && rec.task.volumes) || [];
  return vols.find((v) => v.status === 'running') || vols.find((v) => v.status === 'partial') || null;
}
/** 当前册文案：尽量不重复「第 N 册」（原站册名有时已含册序号） */
function volLabel(v) {
  if (!v) return '';
  const raw = String(v.title || v.fileName || '').trim();
  const noText = `第 ${v.no} 册`;
  const hasNo = /^第\s*\d+\s*册/.test(raw) || raw.indexOf(noText) === 0;
  const label = !raw ? noText : (hasNo ? raw : `${noText} · ${raw}`);
  return v.pages ? `${label}（${v.pages} 页）` : label;
}
function isCurrent(rec) {
  return !!(RUN.current && rec && RUN.current.task && rec.task && RUN.current.task === rec.task);
}
function fmtEta() {
  const speed = Number(live.speed_bps) || 0;
  const total = Number(live.bytes_total) || 0;
  const done = Number(live.bytes_done) || 0;
  if (speed <= 0 || total <= 0) return '';
  return fmtDur(((total - done) / speed) * 1000);
}

// ---------------------------------------------------------------- 状态 / 进度文案

function statusOf(rec) {
  return STATE[rec.status] || [rec.status === 'idle' ? '队列中' : '—', 'idle'];
}

function currentText(rec) {
  const v = activeVolume(rec);
  if (rec.status === 'running') {
    if (v) return volLabel(v);
    return '准备下一册…';
  }
  if (rec.status === 'queued') return '等待当前任务结束后继续';
  if (rec.status === 'paused') {
    return v ? `停在第 ${v.no} 册 · ${esc(v.title || v.fileName || '')}` : '已暂停（可随时继续）';
  }
  if (rec.status === 'done') {
    const zip = rec.task && rec.task.zip;
    return zip && zip.path ? `已打包：${esc(String(zip.name || 'ZIP'))}` : '全部册已下载';
  }
  if (rec.status === 'failed') return '已停止，可「重试」续传未完成册';
  if (rec.status === 'cancelled') return '已取消（已完成的册保留）';
  return '';
}

/** 第二行：速度 / 剩余时间 / 已落盘体积 / 失败原因 */
function detailText(rec) {
  const bits = [];
  const doneBytes = ((rec.task && rec.task.volumes) || [])
    .reduce((s, v) => s + (v.files || []).reduce((a, f) => a + (Number(f.bytes) || 0), 0), 0);
  if (doneBytes > 0) bits.push(`已落盘 ${fmtMB(doneBytes)}`);
  if (rec.status === 'running' && isCurrent(rec) && live.active) {
    const sp = fmtSpeed(live.speed_bps);
    if (sp) bits.push(sp);
    const eta = fmtEta();
    if (eta) bits.push(`剩余约 ${eta}`);
    if (live.bytes_total > 0 && live.bytes_done > 0) {
      bits.push(`${Math.round((live.bytes_done / live.bytes_total) * 100)}% 当前册`);
    }
  }
  return bits.join(' · ');
}

function rowsHtml(tasks) {
  return tasks.map((rec) => {
    const [tx, cls] = statusOf(rec);
    const pct = fmtPct(rec);
    const kind = rec.kind === 'batch' ? '批量' : '单本';
    const started = fmtTime(rec.startedAt);
    const dur = rec.endedAt && rec.startedAt ? ` · 用时 ${fmtDur(rec.endedAt - rec.startedAt)}` : '';
    const err = rec.error ? `<div class="dlv-err" title="${esc(String(rec.error))}">${esc(String(rec.error).slice(0, 120))}</div>` : '';
    const dir = dirOf(rec);
    const ops = [];
    if (rec.status === 'running') ops.push(`<button type="button" class="dlv-op" data-act="pause" data-id="${rec.id}" title="只暂停这一本；其它书继续">暂停</button>`);
    if (rec.status === 'paused') {
      ops.push(`<button type="button" class="dlv-op primary" data-act="resume" data-id="${rec.id}">继续</button>`);
      ops.push(`<button type="button" class="dlv-op" data-act="cancel" data-id="${rec.id}">取消</button>`);
    }
    if (rec.status === 'queued') ops.push(`<button type="button" class="dlv-op" data-act="cancelqueued" data-id="${rec.id}" title="取消排队（保持暂停）">取消排队</button>`);
    if (rec.status === 'failed' || rec.status === 'cancelled') {
      ops.push(`<button type="button" class="dlv-op primary" data-act="resume" data-id="${rec.id}" title="续传未完成册；完成后照常审计、打包">重试</button>`);
    }
    if (dir) ops.push(`<button type="button" class="dlv-op" data-act="reveal" data-dir="${esc(dir)}" title="${esc(dir)}">打开文件夹</button>`);

    const prog = rec.total
      ? `${rec.done || 0}/${rec.total} 册 · ${rec.pages || 0} 页`
      : (rec.status === 'done' ? '已完成' : '—');
    return `<tr class="dlv-row dlv-row-${esc(rec.status || '')}">
      <td><span class="dlv-badge ${cls}">${esc(tx)}</span></td>
      <td>
        <div class="dlv-title" title="${esc(rec.title || '')}">${esc(rec.title || '（未命名）')}</div>
        <div class="dlv-sub">${kind} · ${started}${dur}</div>
        ${err}
      </td>
      <td>
        <div class="dlv-progline"><b class="dlv-pct">${pct}%</b><span class="dlv-bar"><i style="width:${pct}%"></i></span></div>
        <div class="dlv-sub">${prog}</div>
      </td>
      <td>
        <div class="dlv-cur">${currentText(rec)}</div>
        <div class="dlv-sub">${detailText(rec)}</div>
      </td>
      <td class="dlv-ops">${ops.join('') || '<span class="dlv-sub">—</span>'}</td>
    </tr>`;
  }).join('');
}

/** 批量队列里「还没轮到」的书：也给出 队列中 状态，避免用户以为丢了 */
function queuedBatchHtml(tasks) {
  const batch = RUN.batch;
  if (!batch || !batch.items || !batch.items.length) return '';
  const startedRecs = new Set(tasks.filter((t) => t.kind === 'batch').map((t) => (t.task && t.task.book && t.task.book.id) || ''));
  const rows = batch.items
    .filter((it) => it.checked && ['pending', 'ready', 'resolving', 'idle'].includes(it.status))
    .filter((it) => !startedRecs.has(it.id))
    .slice(0, 14)
    .map((it) => `<tr class="dlv-row dlv-row-queued">
      <td><span class="dlv-badge queued">队列中</span></td>
      <td>
        <div class="dlv-title">${esc(it.title || it.input || '（待核对）')}</div>
        <div class="dlv-sub">批量队列 · 等待前面的书完成</div>
      </td>
      <td><div class="dlv-progline"><b class="dlv-pct">0%</b><span class="dlv-bar"><i style="width:0%"></i></span></div><div class="dlv-sub">—</div></td>
      <td><div class="dlv-cur">排队中</div><div class="dlv-sub">开始后可单独暂停/继续</div></td>
      <td class="dlv-ops"><span class="dlv-sub">—</span></td>
    </tr>`);
  return rows.join('');
}

// ---------------------------------------------------------------- 打开文件夹

function revealDir(dir) {
  if (!dir) return;
  if (!dlAvailable()) {
    toast('网页版无法打开文件夹；请在桌面版中使用「打开文件夹」', 'warn');
    return;
  }
  invoke('reveal_path', { path: dir }).catch((e) => toast(`打开文件夹失败：${(e && e.message) || e}`, 'err'));
}

/** 当前这本书：优先正在下载的，其次暂停/排队，最后最近一条 */
function currentRec(tasks) {
  return tasks.find((t) => t.status === 'running')
    || tasks.find((t) => t.status === 'paused')
    || tasks.find((t) => t.status === 'queued')
    || tasks[0]
    || null;
}

function cancelRec(rec) {
  if (!rec) return;
  cancelQueuedResume(rec);
  if (rec.task) rec.task._paused = true;
  rec.status = 'cancelled';
  rec.endedAt = rec.endedAt || Date.now();
  render();
}

// ---------------------------------------------------------------- 渲染

function render() {
  const root = el('dlvRoot');
  if (!root) return;
  const tasks = (listRunTasks() || []).slice(0, 40);
  // 把批量队列条目的状态与下载记录里的状态同步（恢复/重试后条目会重新跑）
  if (RUN.batch && RUN.batch.items) {
    for (const it of RUN.batch.items) {
      if (!it.rec) continue;
      const rec = it.rec;
      const map = { running: 'downloading', queued: 'pending', paused: 'paused', done: 'done', failed: 'failed', cancelled: 'skipped' };
      if (map[rec.status]) it.status = map[rec.status];
    }
  }
  const count = (s) => tasks.filter((t) => t.status === s).length;
  const queuedExtra = (RUN.batch && RUN.batch.items ? RUN.batch.items.filter((it) => it.checked && ['pending', 'ready', 'resolving'].includes(it.status)).length : 0);
  const running = count('running');
  const queued = count('queued') + queuedExtra;
  const paused = count('paused');
  const done = count('done');
  const failed = count('failed');
  const cur = currentRec(tasks);
  const curDir = dirOf(cur);

  root.innerHTML = `
    <div class="dlv-head">
      <div><h1>下载中心</h1></div>
      <div class="dlv-actions">
        <button type="button" class="av-btn" id="dlvPause" ${RUN.running ? '' : 'disabled'}>${RUN.paused ? '继续全部' : '暂停全部'}</button>
        <button type="button" class="av-btn" id="dlvCancel" ${RUN.running ? '' : 'disabled'}>取消当前</button>
        <button type="button" class="av-btn" id="dlvReveal" ${curDir ? '' : 'disabled'} title="${esc(curDir || '当前没有可定位的任务')}">打开当前书文件夹</button>
      </div>
    </div>

    <div class="dlv-stats">
      <div class="dlv-stat"><b>${running}</b><span>下载中</span></div>
      <div class="dlv-stat"><b>${queued}</b><span>队列中</span></div>
      <div class="dlv-stat"><b>${paused}</b><span>已暂停</span></div>
      <div class="dlv-stat"><b>${done}</b><span>已完成</span></div>
      <div class="dlv-stat"><b>${failed}</b><span>失败</span></div>
    </div>

    <div class="dlv-card">
      <div class="dlv-card-h"><b>任务列表</b><span>${tasks.length ? `最近 ${tasks.length} 本 · 每本可单独暂停/继续` : ''}</span></div>
      ${tasks.length || queuedExtra ? `<table class="dlv-tbl dlv-tbl2">
        <thead><tr><th>状态</th><th>书名</th><th>进度</th><th>当前 / 速度</th><th>操作</th></tr></thead>
        <tbody>${rowsHtml(tasks)}${queuedBatchHtml(tasks)}</tbody>
      </table>` : `<div class="dlv-empty">
        <b>还没有下载任务</b>
        在「日本国立公文书馆」检索结果里点条目右侧的「下载」，<br>
        或用「批量下载」一次提交多本；下载进度会实时显示在这里。
      </div>`}
    </div>`;

  el('dlvPause')?.addEventListener('click', () => {
    if (RUN.paused) resumeRun(); else pauseRun();
    render();
  });
  el('dlvCancel')?.addEventListener('click', () => { cancelRun(); render(); });
  el('dlvReveal')?.addEventListener('click', () => {
    const dir = (RUN.current && RUN.current.dir) || dirOf(currentRec(listRunTasks() || []));
    revealDir(dir);
  });
}

// 事件委托：渲染后不用重复绑定
function bindOnce(root) {
  if (root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'reveal') { revealDir(b.getAttribute('data-dir') || ''); return; }
    const id = Number(b.getAttribute('data-id'));
    const rec = (listRunTasks() || []).find((t) => t.id === id);
    if (!rec) return;
    if (act === 'pause') {
      pauseRecord(rec);
      toast('已暂停这一本；其它书继续下载', 'warn');
      render();
    } else if (act === 'resume') {
      const r = resumeRecord(rec);
      if (r === 'queued') toast('已加入队列：当前任务结束后继续这一本', 'ok');
      else if (r === 'started') toast('已继续下载这一本', 'ok');
      render();
    } else if (act === 'cancelqueued') {
      cancelQueuedResume(rec);
      toast('已取消排队（仍保持暂停）', 'warn');
      render();
    } else if (act === 'cancel') {
      cancelRec(rec);
      toast('已取消这一本', 'warn');
    }
  });
}

export function refreshDownloadsView() {
  render();
}

export function initDownloadsView() {
  const root = el('dlvRoot');
  if (!root) return;
  bindOnce(root);
  if (!inited) {
    inited = true;
    try {
      onEngine(() => { if (el('view-downloads')?.classList.contains('active')) render(); });
    } catch (_) { /* 忽略 */ }
  }
  render();
  if (!timer) {
    timer = setInterval(async () => {
      if (!el('view-downloads')?.classList.contains('active')) return;
      if (dlAvailable()) {
        try {
          const p = await invoke('naj_dl_progress');
          if (p && typeof p === 'object') live = p;
        } catch (_) { /* 网页版/未开始：保持默认 */ }
      }
      try { pumpResumeQueue(); } catch (_) { /* 忽略 */ }
      render();
    }, 1000);
  }
}
