// ================================================
// js/ui/downloads-view.js — 下载中心（V1.1：视图形态，按设计稿 v3）
// ================================================
// 背景：V1.0 的下载中心是「标题栏按钮 + 右侧抽屉」。按用户要求改为
//       标题栏「查看下载情况」→ 直接进入本视图；侧栏不再放「下载中心」。
// 数据：全部来自 naj-dl.js 的 RUN / listRunTasks()（真实下载状态），不另存一份。
// ================================================
import { RUN, listRunTasks, pauseRun, resumeRun, cancelRun, taskDir, onEngine, invoke, esc } from './naj-dl.js';

const el = (id) => document.getElementById(id);
let inited = false;
let timer = null;

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusOf(t) {
  if (t.status === 'running') return ['下载中', 'run'];
  if (t.status === 'done') return ['已完成', 'ok'];
  if (t.status === 'failed') return ['失败', 'err'];
  if (t.status === 'cancelled') return ['已取消', ''];
  return ['—', ''];
}

function rowsHtml(tasks) {
  return tasks.map((t) => {
    const [tx, cls] = statusOf(t);
    const kind = t.kind === 'single' ? '单本' : '批量';
    const prog = t.total ? `${t.done}/${t.total} 册` : '—';
    const pages = t.pages ? `${t.pages} 页` : '';
    const err = t.error ? `<div class="dlv-dim" style="color:var(--danger)">${esc(String(t.error).slice(0, 40))}</div>` : '';
    const dir = t.dir || '';
    return `<tr>
      <td><span class="dlv-badge ${cls}">${esc(tx)}</span></td>
      <td><div class="dlv-title" title="${esc(t.title)}">${esc(t.title)}</div>${err}</td>
      <td class="dlv-dim">${kind}</td>
      <td class="dlv-prog">${prog}${pages ? ' · ' + pages : ''}</td>
      <td class="dlv-dim">${fmtTime(t.startedAt)}</td>
      <td>${dir ? `<button type="button" class="dlv-link" data-reveal="${esc(dir)}">打开文件夹</button>` : ''}</td>
    </tr>`;
  }).join('');
}

function render() {
  const root = el('dlvRoot');
  if (!root) return;
  const tasks = (listRunTasks() || []).slice(0, 60);
  const running = tasks.filter((t) => t.status === 'running').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const dir = RUN.current ? RUN.current.dir : (tasks[0] && tasks[0].dir) || '';

  root.innerHTML = `
    <div class="dlv-head">
      <div>
        <h1>下载中心</h1>
        <p>整册 PDF 下载进度与结果 · 数据仅存本机</p>
      </div>
      <div class="dlv-actions">
        <button type="button" class="av-btn" id="dlvPause">${RUN.paused ? '继续' : '暂停'}</button>
        <button type="button" class="av-btn" id="dlvCancel">取消</button>
        <button type="button" class="av-btn" id="dlvReveal">打开文件夹</button>
      </div>
    </div>

    <div class="dlv-stats">
      <div class="dlv-stat"><b>${running}</b><span>下载中</span></div>
      <div class="dlv-stat"><b>${done}</b><span>已完成</span></div>
      <div class="dlv-stat"><b>${failed}</b><span>失败</span></div>
    </div>

    <div class="dlv-card">
      <div class="dlv-card-h"><b>任务列表</b><span>最近 ${tasks.length} 条</span></div>
      ${tasks.length ? `<table class="dlv-tbl">
        <thead><tr><th>状态</th><th>书名</th><th>类型</th><th>进度</th><th>开始时间</th><th></th></tr></thead>
        <tbody>${rowsHtml(tasks)}</tbody>
      </table>` : `<div class="dlv-empty">
        <b>还没有下载任务</b>
        在「日本国立公文书馆」检索结果里点条目右侧的「下载」，<br>
        或用「批量下载」一次提交多本；下载进度会实时显示在这里。
      </div>`}
    </div>`;

  // 动作
  el('dlvPause')?.addEventListener('click', () => {
    if (RUN.paused) resumeRun(); else pauseRun();
    render();
  });
  el('dlvCancel')?.addEventListener('click', () => { cancelRun(); render(); });
  el('dlvReveal')?.addEventListener('click', () => {
    if (dir) invoke('reveal_path', { path: dir }).catch(() => { });
  });
  root.querySelectorAll('[data-reveal]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.getAttribute('data-reveal');
      if (p) invoke('reveal_path', { path: p }).catch(() => { });
    });
  });
}

export function refreshDownloadsView() {
  render();
}

export function initDownloadsView() {
  if (!el('dlvRoot')) return;
  if (!inited) {
    inited = true;
    try { onEngine(() => { if (el('view-downloads')?.classList.contains('active')) render(); }); } catch (_) { }
  }
  render();
  if (!timer) {
    timer = setInterval(() => {
      if (el('view-downloads')?.classList.contains('active')) render();
    }, 1200);
  }
}
