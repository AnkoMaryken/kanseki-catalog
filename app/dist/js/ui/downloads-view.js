// ================================================
// js/ui/downloads-view.js — 下载中心（V2.1：全队列 + 状态筛选 + 清空 + 选新书 + 插入单本）
// ================================================
// 用户第 3 条：
//   · 展示**所有队列条目**（批量里的每一本 + 单本任务 + 批量还没轮到的书）；
//   · 状态筛选：全部 / 下载中 / 队列中 / 已暂停 / 已完成 / 失败 / 取消；
//   · 「清空列表」只清已结束的记录（二次确认），不影响正在下载/排队/暂停的任务；
//   · 暂停某本后可从「选择新书开始」里挑一本优先下载，或把暂停的书放回队尾；
//   · 「打开文件夹」用 reveal_path 传**这本书**的任务目录（网页版提示不可用）。
// 数据：全部来自 naj-dl.js 的 RUN / listRunTasks()（真实下载状态），不另存一份。
// ================================================
import {
  RUN, listRunTasks, pauseRun, resumeRun, cancelRun, taskDir, onEngine, invoke, esc, toast,
  dlAvailable, pauseRecord, resumeRecord, cancelQueuedResume, pumpResumeQueue, pumpQueuedSingles,
  clearFinishedRunTasks, cancelRecord, forgetRunTask, isReading, READING_TIP,
} from './naj-dl.js';
import { prioritizeBatchItem, startBatchIfIdle, removeBatchItem } from './naj-dl-batch.js';

const el = (id) => document.getElementById(id);
let inited = false;
let timer = null;
let disarmedTimer = null;

// 视图局部状态（定时重渲染时保持）
const UI = { filter: 'all', pickerOpen: false, clearArmed: false };

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
const FILTERS = [
  ['all', '全部'], ['running', '下载中'], ['queued', '队列中'],
  ['paused', '已暂停'], ['done', '已完成'], ['failed', '失败'], ['cancelled', '取消'],
];

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

// ---------------------------------------------------------------- 统一行数据（记录 + 批量队列条目）

const ITEM_STATUS = {
  pending: 'queued', ready: 'queued', resolving: 'queued', choose: 'queued',
  downloading: 'running', paused: 'paused', done: 'done', failed: 'failed', skipped: 'cancelled',
};

/**
 * 下载中心要展示「所有队列条目」：
 *   ① RUN.tasks 里的每条下载记录（单本 + 批量里的每一本，含暂停/完成/失败）；
 *   ② 批量队列里**还没轮到、也还没建记录**的书 → 以「队列中」出现（不会显得丢单）；
 *   ③ V2.2：批量中插入的单本默认排到**队尾** → 未开始的插入记录排在批量队列条目之后。
 */
function collectRows() {
  const allRecs = (listRunTasks() || []).slice(0, 60);
  const tailRecs = allRecs.filter((r) => r._inserted && (r.status === 'queued' || r.status === 'paused'));
  const recs = allRecs.filter((r) => !tailRecs.includes(r));
  const rows = recs.map((rec) => ({ type: 'rec', rec, status: rec.status, title: rec.title || '（未命名）' }));
  const batch = RUN.batch;
  if (batch && Array.isArray(batch.items) && batch.items.length) {
    const linked = new Set();
    for (const rec of recs) {
      if (!rec.task) continue;
      for (const it of batch.items) {
        if (it.rec === rec || (rec.task.book && it.id && String(it.id) === String(rec.task.book.id) && it.status === 'paused')) linked.add(it);
      }
    }
    for (const it of batch.items) {
      if (linked.has(it)) continue;
      const status = ITEM_STATUS[it.status] || 'queued';
      rows.push({ type: 'item', item: it, status, title: it.title || it.input || '（待核对）' });
    }
  }
  // 队尾：批量中插入的单本（尚未开始）
  for (const rec of tailRecs) rows.push({ type: 'rec', rec, status: rec.status, title: rec.title || '（未命名）' });
  return rows;
}

// ---------------------------------------------------------------- 文案

function currentText(rec) {
  const v = activeVolume(rec);
  if (rec.status === 'running') {
    if (v) return volLabel(v);
    return '准备下一册…';
  }
  if (rec.status === 'queued') return '等待前面的任务结束后继续';
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
    if (live.bytes_total > 0 && live.bytes_done > 0) bits.push(`${Math.round((live.bytes_done / live.bytes_total) * 100)}% 当前册`);
  }
  return bits.join(' · ');
}

// ---------------------------------------------------------------- 打开文件夹 / 清空 / 选新书

function revealDir(dir) {
  if (!dir) return;
  if (!dlAvailable()) {
    toast('网页版无法打开文件夹；请在桌面版中使用「打开文件夹」', 'warn');
    return;
  }
  invoke('reveal_path', { path: dir }).catch((e) => toast(`打开文件夹失败：${(e && e.message) || e}`, 'err'));
}

function currentRec(tasks) {
  return tasks.find((t) => t.status === 'running')
    || tasks.find((t) => t.status === 'paused')
    || tasks.find((t) => t.status === 'queued')
    || tasks[0]
    || null;
}

function cancelRec(rec) {
  if (!rec) return;
  if (isReading()) { toast(READING_TIP, 'warn'); return; }   // 读取中禁止取消（程序化调用也绕不过）
  // V2.2 第 3 条「取消当前」：从下载队列删除这一本（未开始/下载中/已暂停都能删），并从列表移出
  const batch = RUN.batch;
  const it = (batch && Array.isArray(batch.items)) ? (batch.items.find((x) => x.rec === rec) || null) : null;
  if (it) removeBatchItem(it);              // 会取消任务 + 从批量清单删除 + 从下载中心记录移除
  else { cancelRecord(rec); forgetRunTask(rec); }
  toast(`已从下载队列移除：${rec.title || '这一本'}`, 'warn');
  render();
}

/** 已结束记录只从列表移除（不影响文件） */
function removeFromList(rec) {
  if (!rec) return;
  forgetRunTask(rec);
  toast('已从列表移除', 'ok');
  render();
}

/** 清空列表：只清已结束记录；第一次点变「再点一次确认」，3 秒后自动复原 */
function clearList() {
  if (!UI.clearArmed) {
    UI.clearArmed = true;
    render();
    if (disarmedTimer) clearTimeout(disarmedTimer);
    disarmedTimer = setTimeout(() => { UI.clearArmed = false; try { render(); } catch (_) { } }, 4000);
    return;
  }
  UI.clearArmed = false;
  if (disarmedTimer) { clearTimeout(disarmedTimer); disarmedTimer = null; }
  const n = clearFinishedRunTasks();
  toast(n ? `已清空 ${n} 条已结束记录` : '没有可清空的已结束记录', n ? 'ok' : 'warn');
  render();
}

/** 「选择新书开始」候选：暂停的书（放回队尾）+ 批量里还没开始的书（优先下载） */
function pickCandidates() {
  const out = [];
  for (const rec of (listRunTasks() || [])) {
    if (rec.status === 'paused') out.push({ kind: 'rec', rec, title: rec.title, status: '已暂停' });
  }
  const batch = RUN.batch;
  if (batch && Array.isArray(batch.items)) {
    for (const it of batch.items) {
      if (it.rec) continue;
      if (['pending', 'ready', 'resolving', 'choose'].includes(it.status)) {
        out.push({ kind: 'item', item: it, title: it.title || it.input, status: it.status === 'ready' ? '待下载' : '队列中' });
      }
    }
  }
  return out;
}

function pickNewBook() {
  UI.pickerOpen = !UI.pickerOpen;
  render();
}

function doPick(cand) {
  UI.pickerOpen = false;
  if (isReading()) { toast(READING_TIP, 'warn'); render(); return; }
  if (cand.kind === 'rec') {
    const r = resumeRecord(cand.rec);
    toast(r === 'queued' ? '已放回队尾：当前任务结束后继续这一本' : '已继续下载这一本', 'ok');
  } else if (cand.kind === 'item') {
    if (RUN.running) {
      prioritizeBatchItem(cand.item);         // 模块内部会提示「已抢占当前这本 / 已设为优先」
    } else {
      prioritizeBatchItem(cand.item);
      if (startBatchIfIdle()) toast('已开始队列下载', 'ok');
      else toast('队列暂时无法启动', 'warn');
    }
  }
  render();
}

// ---------------------------------------------------------------- 行渲染

function recOps(rec) {
  const ops = [];
  const dir = dirOf(rec);
  const reading = isReading();
  const dis = reading ? ' disabled' : '';
  const active = rec.status === 'running' || rec.status === 'paused' || rec.status === 'queued';
  if (rec.status === 'running') {
    ops.push(`<button type="button" class="dlv-op" data-act="pause" data-id="${rec.id}" title="只暂停这一本；队列立刻跳过它开始下一本"${dis}>暂停</button>`);
  } else if (rec.status === 'paused') {
    ops.push(`<button type="button" class="dlv-op primary" data-act="resume" data-id="${rec.id}" title="重新入队：当前任务结束后继续"${dis}>${RUN.running ? '放回队尾' : '继续'}</button>`);
  } else if (rec.status === 'failed' || rec.status === 'cancelled') {
    ops.push(`<button type="button" class="dlv-op primary" data-act="resume" data-id="${rec.id}" title="续传未完成册；完成后照常审计、打包"${dis}>重试</button>`);
  }
  if (active) ops.push(`<button type="button" class="dlv-op" data-act="cancelcurrent" data-id="${rec.id}" title="从下载队列删除这一本（当前册下完即停）"${dis}>取消当前</button>`);
  if (!active && (rec.status === 'done' || rec.status === 'failed' || rec.status === 'cancelled')) {
    ops.push(`<button type="button" class="dlv-op" data-act="remove" data-id="${rec.id}" title="只从列表移除，不影响已下载文件">从列表移除</button>`);
  }
  if (dir) ops.push(`<button type="button" class="dlv-op" data-act="reveal" data-dir="${esc(dir)}" title="${esc(dir)}">打开文件夹</button>`);
  return ops.join('');
}

function recRow(rec) {
  const [tx, cls] = STATE[rec.status] || ['—', 'idle'];
  const pct = fmtPct(rec);
  const kind = rec.kind === 'batch' ? '批量' : '单本';
  const started = fmtTime(rec.startedAt);
  const dur = rec.endedAt && rec.startedAt ? ` · 用时 ${fmtDur(rec.endedAt - rec.startedAt)}` : '';
  const err = rec.error ? `<div class="dlv-err" title="${esc(String(rec.error))}">${esc(String(rec.error).slice(0, 120))}</div>` : '';
  const prog = rec.total ? `${rec.done || 0}/${rec.total} 册 · ${rec.pages || 0} 页` : (rec.status === 'done' ? '已完成' : '—');
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
    <td class="dlv-ops">${recOps(rec) || '<span class="dlv-sub">—</span>'}</td>
  </tr>`;
}

function itemRow(row) {
  const it = row.item;
  const [tx, cls] = STATE[row.status] || ['队列中', 'queued'];
  const pri = it.priority ? '<span class="dlv-pri" title="已设为下一本优先下载">优先</span>' : '';
  const ops = [];
  const dis = isReading() ? ' disabled' : '';
  if (row.status === 'queued') {
    if (RUN.running) {
      ops.push(`<button type="button" class="dlv-op" data-act="priority" data-key="${esc(String(it.no || it.id))}" title="立即抢占：暂停当前这本，先下这一本"${dis}>优先下载</button>`);
    }
    ops.push(`<button type="button" class="dlv-op" data-act="cancelitem" data-key="${esc(String(it.no || it.id))}" title="从下载队列删除这一本"${dis}>取消当前</button>`);
  }
  return `<tr class="dlv-row dlv-row-${esc(row.status)}">
    <td><span class="dlv-badge ${cls}">${esc(tx)}</span></td>
    <td>
      <div class="dlv-title">${esc(row.title)}${pri}</div>
      <div class="dlv-sub">批量队列 · 还没轮到</div>
    </td>
    <td><div class="dlv-progline"><b class="dlv-pct">0%</b><span class="dlv-bar"><i style="width:0%"></i></span></div><div class="dlv-sub">—</div></td>
    <td><div class="dlv-cur">排队中，前面的书下完后自动开始</div><div class="dlv-sub">可点「优先下载」提前</div></td>
    <td class="dlv-ops">${ops.join('') || '<span class="dlv-sub">—</span>'}</td>
  </tr>`;
}

// ---------------------------------------------------------------- 渲染

function render() {
  const root = el('dlvRoot');
  if (!root) return;
  const rows = collectRows();
  // 把批量队列条目状态与下载记录同步（恢复/重试后条目会重新跑）
  if (RUN.batch && RUN.batch.items) {
    for (const it of RUN.batch.items) {
      if (!it.rec) continue;
      const map = { running: 'downloading', queued: 'pending', paused: 'paused', done: 'done', failed: 'failed', cancelled: 'skipped' };
      if (map[it.rec.status]) it.status = map[it.rec.status];
    }
  }
  const countOf = (s) => rows.filter((r) => r.status === s).length;
  const filtered = UI.filter === 'all' ? rows : rows.filter((r) => r.status === UI.filter);
  const tasks = (listRunTasks() || []);
  const cur = currentRec(tasks);
  const curDir = dirOf(cur);
  const pickList = pickCandidates();

  const filterHtml = FILTERS.map(([key, label]) => {
    const n = key === 'all' ? rows.length : rows.filter((r) => r.status === key).length;
    return `<button type="button" class="dlv-filter${UI.filter === key ? ' on' : ''}" data-filter="${key}" role="tab" aria-selected="${UI.filter === key}">${label}<span class="n">${n}</span></button>`;
  }).join('');

  const pickHtml = UI.pickerOpen ? `
    <div class="dlv-pickmenu" role="menu" aria-label="选择要开始的书">
      <div class="dlv-pickhead">选择新书开始 / 放回队尾</div>
      ${pickList.length ? pickList.slice(0, 20).map((c, i) => `<button type="button" class="dlv-pickitem" data-pick="${i}" role="menuitem">
        <span class="dlv-picktitle">${esc(c.title || '（未命名）')}</span>
        <span class="dlv-picksub">${esc(c.status)}${c.kind === 'rec' ? ' · 放回队尾' : (RUN.running ? ' · 优先下载' : ' · 立即开始')}</span>
      </button>`).join('') : '<div class="dlv-picksub" style="padding:10px 12px">没有可选择的待下载/暂停书目</div>'}
    </div>` : '';

  root.innerHTML = `
    <div class="dlv-head">
      <div><h1>下载中心</h1></div>
      <div class="dlv-actions">
        <button type="button" class="av-btn" id="dlvPause" ${RUN.running && !isReading() ? '' : 'disabled'}>${RUN.paused ? '继续全部' : '暂停全部'}</button>
        <button type="button" class="av-btn" id="dlvCancel" ${RUN.running && !isReading() ? '' : 'disabled'}>取消当前</button>
        <button type="button" class="av-btn" id="dlvReveal" ${curDir ? '' : 'disabled'} title="${esc(curDir || '当前没有可定位的任务')}">打开当前书文件夹</button>
      </div>
    </div>

    ${isReading() ? `<div class="dlv-reading-hint" id="dlvReadingHint" role="status" aria-live="polite">${esc(READING_TIP)}</div>` : ''}

    <div class="dlv-toolbar">
      <div class="dlv-filters" role="tablist" aria-label="按状态筛选">${filterHtml}</div>
      <div class="dlv-tools">
        <span class="dlv-pickwrap">
          <button type="button" class="av-btn" id="dlvPickBtn" aria-haspopup="true" aria-expanded="${UI.pickerOpen}" ${isReading() ? 'disabled title="正在读取书目信息，请稍候…"' : ''}>选择新书开始…</button>
          ${pickHtml}
        </span>
        <button type="button" class="av-btn${UI.clearArmed ? ' dlv-danger' : ''}" id="dlvClear">${UI.clearArmed ? '再点一次确认清空' : '清空列表'}</button>
      </div>
    </div>

    <div class="dlv-stats">
      <div class="dlv-stat"><b>${countOf('running')}</b><span>下载中</span></div>
      <div class="dlv-stat"><b>${countOf('queued')}</b><span>队列中</span></div>
      <div class="dlv-stat"><b>${countOf('paused')}</b><span>已暂停</span></div>
      <div class="dlv-stat"><b>${countOf('done')}</b><span>已完成</span></div>
      <div class="dlv-stat"><b>${countOf('failed')}</b><span>失败</span></div>
    </div>

    <div class="dlv-card">
      <div class="dlv-card-h"><b>任务列表</b><span>${rows.length ? `共 ${rows.length} 条 · 每本可单独暂停/继续` : ''}</span></div>
      ${filtered.length ? `<table class="dlv-tbl dlv-tbl2">
        <thead><tr><th>状态</th><th>书名</th><th>进度</th><th>当前 / 速度</th><th>操作</th></tr></thead>
        <tbody>${filtered.map((r) => (r.type === 'rec' ? recRow(r.rec) : itemRow(r))).join('')}</tbody>
      </table>` : `<div class="dlv-empty">
        <b>${rows.length ? '当前筛选下没有任务' : '还没有下载任务'}</b>
        ${rows.length ? '换个状态筛选看看。' : '在「日本国立公文书馆」检索结果里点条目右侧的「下载」，<br>或用「批量下载」一次提交多本；下载进度会实时显示在这里。'}
      </div>`}
    </div>`;

  // 动作
  el('dlvPause')?.addEventListener('click', () => {
    if (RUN.paused) resumeRun(); else pauseRun();
    render();
  });
  el('dlvCancel')?.addEventListener('click', () => { cancelRun(); render(); });
  el('dlvReveal')?.addEventListener('click', () => {
    const dir = (RUN.current && RUN.current.dir) || dirOf(currentRec(listRunTasks() || []));
    revealDir(dir);
  });
  el('dlvClear')?.addEventListener('click', clearList);
  el('dlvPickBtn')?.addEventListener('click', (e) => { e.stopPropagation(); pickNewBook(); });
  root.querySelectorAll('.dlv-filter').forEach((b) => {
    b.addEventListener('click', () => { UI.filter = b.getAttribute('data-filter') || 'all'; render(); });
  });
  root.querySelectorAll('[data-pick]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cand = pickList[Number(b.getAttribute('data-pick'))];
      if (cand) doPick(cand);
    });
  });
  // 点面板外关闭「选择新书」浮层
  if (UI.pickerOpen && !root._pickOutside) {
    root._pickOutside = (e) => { if (!e.target.closest('.dlv-pickwrap')) { UI.pickerOpen = false; render(); } };
    document.addEventListener('click', root._pickOutside, { once: true });
  }
}

// 事件委托：渲染后不用重复绑定（行内暂停/继续/优先/打开文件夹）
function bindOnce(root) {
  if (root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'reveal') { revealDir(b.getAttribute('data-dir') || ''); return; }
    if (act === 'priority') {
      const key = b.getAttribute('data-key');
      const batch = RUN.batch;
      const it = batch && (batch.items || []).find((x) => String(x.no || x.id) === key);
      if (it) {
        prioritizeBatchItem(it);              // 即时抢占；提示由 batch 模块统一给出
        render();
      }
      return;
    }
    if (act === 'cancelitem') {
      const key = b.getAttribute('data-key');
      const batch = RUN.batch;
      const it = batch && (batch.items || []).find((x) => String(x.no || x.id) === key);
      if (it) {
        removeBatchItem(it);
        toast(`已从下载队列移除：${it.title || it.input || '这一本'}`, 'warn');
        render();
      }
      return;
    }
    const id = Number(b.getAttribute('data-id'));
    const rec = (listRunTasks() || []).find((t) => t.id === id);
    if (!rec) return;
    if (act === 'pause') {
      pauseRecord(rec);
      toast('已暂停这一本；队列会立刻跳过它开始下一本', 'warn');
      render();
    } else if (act === 'resume') {
      const r = resumeRecord(rec);
      if (r === 'queued') toast('已放回队尾：当前任务结束后继续这一本', 'ok');
      else if (r === 'started') toast('已继续下载这一本', 'ok');
      render();
    } else if (act === 'cancelcurrent') {
      cancelRec(rec);
    } else if (act === 'remove') {
      removeFromList(rec);
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
      onEngine((kind) => { if (el('view-downloads')?.classList.contains('active')) render(); });
    } catch (_) { /* 忽略 */ }
  }
  render();
  if (!timer) {
    timer = setInterval(async () => {
      if (!el('view-downloads')?.classList.contains('active')) return;
      if (UI.pickerOpen) return;   // 浮层展开时不重渲染，避免菜单闪掉
      if (dlAvailable()) {
        try {
          const p = await invoke('naj_dl_progress');
          if (p && typeof p === 'object') live = p;
        } catch (_) { /* 网页版/未开始：保持默认 */ }
      }
      try { pumpResumeQueue(); } catch (_) { /* 忽略 */ }
      try { pumpQueuedSingles(); } catch (_) { /* 队列尾部的插入单本 */ }
      render();
    }, 1000);
  }
}
