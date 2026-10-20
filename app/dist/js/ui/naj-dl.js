// ================================================
// js/ui/naj-dl.js — 国立公文书馆「整册 PDF 下载」界面与执行引擎（V9.9）
// ================================================
// 本文件有两层：
//   ① 执行引擎（runBook / executeTask / 暂停 / 取消 / 继续）—— 单本面板与批量队列共用；
//   ② 单本下载面板（点结果行「下载」弹出的那个）。
//
// 用户要求（V9.9 全部落实）：
//   · 结果行右侧一个「下载」按钮，下一本书的全部册为 PDF 并打包；
//   · 命名可自定义（三套模板 + 实时预览）；
//   · **绝不能出现「下了第 13 册、漏了第 2 册」**（清单冻结 → 逐册校验 → 打包门禁）；
//   · 自选下载位置（「浏览…」调系统文件夹选择框）；
//   · 支持暂停 / 继续 / 取消 / 保存进度（_任务.json 自动落盘）；
//   · 供「下载中心」（标题栏按钮）与「批量下载」读取实时状态。
// ================================================
import {
  parseVolumeListPage, parseViewerPage, parseManifest, parseViewerTitle,
  viewerUrl, manifestUrl, buildCidBody, chunk, BATCH_LIMIT, NATIVE_KINDS, NAJ_ORIGIN,
  createTask, auditTask, summarizeTask,
  DEFAULT_TEMPLATES, TEMPLATE_PRESETS, NAME_TOKENS, applyTemplate, truncateForNas,
  retryableVolumes, decidePlanSource, planErrorText,
} from '../core/naj-dl.js';
import { parseRecordJson } from '../core/naj-parse.js';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function invoke(cmd, args) {
  if (!isTauri) return Promise.reject(new Error('非桌面版环境'));
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

export function toast(msg, type) {
  if (window.__kansekiToast) window.__kansekiToast(msg, type);
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================
// ① 执行引擎
// ================================================================

/** 引擎全局状态（下载中心 / 批量面板都读它） */
export const RUN = {
  running: false,          // 是否有任务在跑
  paused: false,           // 用户点了暂停
  cancelled: false,        // 用户点了取消
  mode: '',                // 'single' | 'batch'
  batch: null,             // 批量队列对象（批量模式）
  current: null,           // { book, task, dir, startedAt }
  currentRec: null,        // 当前正在执行的「下载记录」（RUN.tasks 里的一条）
  lastResult: null,        // 最近一次完成结果
  decided: null,           // 批量失败待决：'retry'|'skip'|'pause'|'cancel'
  reading: false,          // V2.3：正在读取书目信息（批量面板 readAll / 册目录解析期间）
  tasks: [],               // V10.5：下载记录（单本与批量都入列，最新在前）
  listeners: new Set(),
};

// ---------------------------------------------------------------- V10.5 下载记录
// 背景：原先只有「批量」会把逐本状态写进下载中心列表；单本下载走 executeTask，
//       既不设 RUN.current 也不记录，导致下载中心显示「当前没有下载任务」、右上角也没有角标。
// 现在单本与批量都登记到 RUN.tasks，下载中心据此列出每一本的进度与结果。

const TASK_KEEP = 24;      // 记录上限，避免无限增长
let taskSeq = 0;

/** 供下载中心读取（避免循环 import） */
export function listRunTasks() { return RUN.tasks; }

function taskProgress(task) {
  const vols = (task && task.volumes) || [];
  return {
    total: vols.length,
    done: vols.filter((v) => v.status === 'done').length,
    pages: vols.reduce((s, v) => s + (Number(v.pageCount) || 0), 0),
  };
}

/** 登记一条下载记录（返回记录对象，后续用 updTask 更新） */
function regTask(kind, task) {
  const p = taskProgress(task);
  const rec = {
    id: ++taskSeq,
    kind,                                  // 'single' | 'batch'
    title: (task && task.book && task.book.title) || '（未命名）',
    status: 'running',
    startedAt: Date.now(),
    endedAt: 0,
    total: p.total,
    done: p.done,
    pages: p.pages,
    error: '',
    dir: task ? taskDir(task) : '',
    task,
  };
  RUN.tasks.unshift(rec);
  if (RUN.tasks.length > TASK_KEEP) RUN.tasks.length = TASK_KEEP;
  return rec;
}

function updTask(rec, patch) {
  if (!rec) return;
  if (patch) Object.assign(rec, patch);
  const p = taskProgress(rec.task);
  rec.total = p.total; rec.done = p.done; rec.pages = p.pages;
  if (rec.status !== 'running') rec.endedAt = rec.endedAt || Date.now();
}

/** 进度刷新：只在执行引擎自己 emit('progress') 时同步记录，避免额外轮询 */
function touchRunningTask() {
  const rec = RUN.tasks.find((t) => t.status === 'running');
  if (rec) updTask(rec);
}

export function onEngine(cb) {
  RUN.listeners.add(cb);
  return () => RUN.listeners.delete(cb);
}

function emit(kind, payload) {
  for (const cb of RUN.listeners) {
    try { cb(kind, payload); } catch (_) { /* 单个订阅者出错不影响引擎 */ }
  }
}

// ---------------------------------------------------------------- V2.3 书目读取中（reading）状态
// 用户第 2 条：批量面板读取书目/解析册目录期间，暂停 / 继续 / 取消一律不可用。
// 这里由引擎统一持有 reading 标记：面板开始读取时置 true、结束（成功或失败）时 finally 置 false；
// 所有暂停/继续/取消入口二次判断 reading → 直接 return（按钮 disabled 之外，程序化/键盘也绕不过）。
export const READING_TIP = '正在读取书目信息，暂停 / 继续 / 取消暂不可用，请稍候…';

export function isReading() { return !!RUN.reading; }

export function setReading(on) {
  const next = !!on;
  if (RUN.reading === next) return next;
  RUN.reading = next;
  emit('reading', { reading: next });
  return next;
}

/** 暂停/继续/取消类操作统一入口：读取中直接拒绝（并给提示） */
function blockedByReading() {
  if (!RUN.reading) return false;
  toast(READING_TIP, 'warn');
  return true;
}

export function taskDir(task) {
  return `${String(task.options.outDir).replace(/[\\/]+$/, '')}/${task.folderName}`;
}

export async function saveTask(task) {
  const dir = taskDir(task);
  await invoke('naj_dl_mkdir', { path: dir });
  await invoke('naj_dl_write_text', { path: `${dir}/_任务.json`, text: JSON.stringify(task, null, 2) });
}

/** 暂停时在这里等；取消时立刻返回 false */
async function waitWhilePaused() {
  while (RUN.paused && !RUN.cancelled) {
    await sleep(250);
  }
  return !RUN.cancelled;
}

export function pauseRun() {
  if (blockedByReading()) return false;
  RUN.paused = true;
  emit('pause');
  toast('已暂停：当前这一册下完后停下，进度已保存', 'warn');
}

export function resumeRun() {
  if (blockedByReading()) return false;
  RUN.paused = false;
  emit('resume');
  toast('已继续下载', 'ok');
}

export function cancelRun() {
  if (blockedByReading()) return false;
  RUN.cancelled = true;
  RUN.paused = false;
  RUN.decided = 'cancel';
  emit('cancel');
  toast('已取消剩余下载（已完成的册保留，可随时续传）', 'warn');
}

/** 供批量失败决策使用 */
export function decide(what) {
  RUN.decided = what;
  emit('decide', what);
}

// ---------------------------------------------------------------- V2.0 按任务（按这本书）暂停 / 恢复
// 用户第 13 条：下载中心里每一本可单独暂停/继续；暂停一本时其它书继续下载。
// 做法：内存里给任务对象打 `_paused` 标记（不写入 _任务.json，重启视为继续）：
//   · executeTask 在每册开始前检查 → 提前返回 { paused:true }，不进入 finalize（不审计、不打包）；
//   · runBook（批量中的一本）/ startRun（单本）/ runRecord（下载中心恢复）负责把记录标成 paused；
//   · 恢复时若引擎正忙 → 进入 RESUME_QUEUE（记录显示「队列中」），引擎空闲后 pumpResumeQueue 启动，
//     批量队列结束后也能接着跑（下载中心视图轮询调用 pump）。
// 这样批量队列只需在收到 paused 结果后跳过这一本继续下一本，零缺册审计与打包流程保持不变。
const RESUME_QUEUE = [];

export function isTaskPaused(task) { return !!(task && task._paused); }

export function pauseTask(task) {
  if (!task) return false;
  task._paused = true;
  emit('pauseTask', { task });
  return true;
}
export function resumeTask(task) {
  if (!task) return false;
  task._paused = false;
  emit('resumeTask', { task });
  return true;
}

/** 下载中心：暂停某一条记录（正在下载的那本会在当前这一册下完后停下） */
export function pauseRecord(rec) {
  if (blockedByReading()) return false;
  if (!rec || !rec.task) return false;
  pauseTask(rec.task);
  if (rec.status === 'running') {
    rec.status = 'paused';
    emit('progress', { task: rec.task, rec });
  }
  return true;
}

/** 下载中心：恢复一条暂停（或失败/cancelled）的记录；引擎忙则排队，返回 'queued' */
export function resumeRecord(rec) {
  if (blockedByReading()) return 'blocked';
  if (!rec || !rec.task) return 'noop';
  rec.task._paused = false;
  rec.task._cancelled = false;   // 取消过的记录点「重试/继续」要清掉取消标记
  // 正在跑的就是这一条：清掉暂停标记即可继续（当前这一册还没停）
  if (RUN.running && RUN.currentRec === rec) {
    rec.status = 'running';
    emit('progress', { task: rec.task, rec });
    return 'running';
  }
  if (RUN.running) {
    if (!RESUME_QUEUE.includes(rec)) RESUME_QUEUE.push(rec);
    rec.status = 'queued';
    rec.error = '';
    emit('progress', { task: rec.task, rec });
    return 'queued';
  }
  runRecord(rec);
  return 'started';
}

/** 取消「排队中」的恢复（回到已暂停，不启动） */
export function cancelQueuedResume(rec) {
  if (blockedByReading()) return false;
  const i = RESUME_QUEUE.indexOf(rec);
  if (i >= 0) RESUME_QUEUE.splice(i, 1);
  if (rec && rec.task) rec.task._paused = true;
  if (rec && rec.status === 'queued') rec.status = 'paused';
  return i >= 0;
}

// ---------------------------------------------------------------- V2.2 每本「取消当前」
// 用户第 1 条第 3 点：把这一本从下载队列删除（未开始/下载中/已暂停都要能删），并从列表移出。
// 做法：在 task 上打 `_cancelled`；executeTask 在当前这一册结束后提前返回（不审计、不打包），
//       各执行路径（runBook / runRecord / runInsertedRecord / startRun）把记录标成 cancelled。

export function isTaskCancelled(task) { return !!(task && task._cancelled); }
export function cancelTask(task) { if (!task) return false; task._cancelled = true; return true; }

/** 下载中心：取消这一本（正在下载 → 当前册下完即停；暂停/排队 → 立即移出队列） */
export function cancelRecord(rec) {
  if (blockedByReading()) return false;
  if (!rec) return false;
  const task = rec.task;
  if (task) { task._cancelled = true; task._paused = true; }
  cancelQueuedResume(rec);      // 从「恢复队列」移除
  removeInsertedTask(rec);      // 从「插入单本队列」移除
  if (rec.status !== 'running') {
    rec.status = 'cancelled';
    rec.endedAt = Date.now();
    rec.error = '';
  } else {
    rec._cancelPending = true;  // executeTask 返回后由执行路径落成 cancelled
  }
  emit('progress', { task: rec.task, rec });
  return true;
}

/** 从下载记录里删掉一条（「取消当前」后从列表消失） */
export function forgetRunTask(rec) {
  const i = RUN.tasks.indexOf(rec);
  if (i >= 0) RUN.tasks.splice(i, 1);
  emit('progress', { rec });
  return i >= 0;
}

/** 把被抢占的「插入单本」放回插入队列最前面（优先那本完成后恢复执行） */
export function requeueInserted(rec) {
  if (!rec || !rec.task) return false;
  rec.task._paused = false;
  rec.task._cancelled = false;
  if (!INSERT_QUEUE.includes(rec)) INSERT_QUEUE.unshift(rec);
  rec.status = 'queued';
  emit('progress', { task: rec.task, rec });
  return true;
}

/** 引擎空闲时启动下一条排队恢复的记录（下载中心定时调用；批量结束后也会立即调一次） */
export function pumpResumeQueue() {
  if (RUN.running) return false;
  const rec = RESUME_QUEUE.shift();
  if (!rec) return false;
  runRecord(rec);
  return true;
}

export function resumeQueueLength() { return RESUME_QUEUE.length; }

/** 启动一条已暂停/失败的下载记录（沿用原 task：已完成的册不会再下） */
async function runRecord(rec) {
  const task = rec.task;
  if (!task) return false;
  task._paused = false;
  task._cancelled = false;
  RUN.running = true;
  RUN.cancelled = false;
  RUN.paused = false;
  RUN.mode = rec.kind === 'batch' ? 'batch' : 'single';
  RUN.current = { book: task.book, task, dir: taskDir(task), startedAt: Date.now() };
  RUN.currentRec = rec;
  rec.status = 'running';
  rec.error = '';
  rec.endedAt = 0;
  if (!rec.startedAt) rec.startedAt = Date.now();
  emit('bookStart', { book: task.book, task });
  emit('progress', { task, rec });
  try {
    const res = await executeTask(task);
    RUN.current = null; RUN.currentRec = null; RUN.running = false;
    if (res && res.taskCancelled) {
      rec.status = 'cancelled';
      rec.endedAt = Date.now();
      rec.error = '';
    } else if (res && res.paused) {
      rec.status = 'paused';
    } else {
      rec.status = res && res.ok ? 'done' : 'failed';
      rec.error = res && res.ok ? '' : ((((res.audit || {}).problems) || []).slice(0, 3).join('；') || '下载未完成');
      if (res && res.ok) RUN.lastResult = { book: task.book, task, dir: taskDir(task), ok: true, error: '' };
    }
  } catch (e) {
    RUN.current = null; RUN.currentRec = null; RUN.running = false;
    rec.status = 'failed';
    rec.error = String((e && e.message) || e);
  }
  emit('bookEnd', {
    book: task.book, task, dir: taskDir(task),
    ok: rec.status === 'done', paused: rec.status === 'paused',
    cancelled: rec.status === 'cancelled', error: rec.error, rec,
  });
  emit('progress', { task, rec });
  // 队列里还有待恢复的就接着跑（放到下一 tick，避免递归过深）
  setTimeout(() => { try { pumpResumeQueue(); } catch (_) { } }, 0);
  return true;
}

// ---------------------------------------------------------------- V2.1 清空记录 / 批量中插入单本
// 用户第 3 条：
//   · 下载中心支持「清空下载列表」——只清已结束的记录，正在下载/排队/暂停的不动；
//   · 批量下载进行中插入单本下载——加入同一队列（下载中心可见），当前这本跑完后执行。
const INSERT_QUEUE = [];
let drainingInserted = false;

/** 清空已结束的下载记录（running/queued/paused 保留），返回清掉条数 */
export function clearFinishedRunTasks() {
  const keep = new Set(['running', 'queued', 'paused']);
  const before = RUN.tasks.length;
  const kept = RUN.tasks.filter((t) => keep.has(t.status));
  RUN.tasks.length = 0;
  for (const r of kept) RUN.tasks.push(r);
  emit('progress', { cleared: before - kept.length });
  return before - kept.length;
}

/** 下载中心：把一本单本下载任务插入当前队列（批量进行中调用；默认排到队尾，状态先显示「队列中」） */
export function insertSingleTask(task) {
  if (!task) return null;
  const rec = regTask('single', task);
  rec.status = 'queued';
  rec.error = '';
  rec._inserted = true;      // 视图据此把它排在批量队列条目之后（队尾）
  INSERT_QUEUE.push(rec);
  emit('progress', { task, rec });
  return rec;
}

export function insertedQueueLength() { return INSERT_QUEUE.length; }

/** 下载中心：取消一条「插入的单本」（回到已暂停，不执行） */
export function removeInsertedTask(rec) {
  const i = INSERT_QUEUE.indexOf(rec);
  if (i >= 0) INSERT_QUEUE.splice(i, 1);
  if (rec && rec.status === 'queued') rec.status = 'paused';
  emit('progress', { rec });
  return i >= 0;
}

/** 执行一条插入的单本任务（不改 RUN.running：批量循环仍持有引擎） */
async function runInsertedRecord(rec) {
  const task = rec.task;
  if (!task) return;
  task._paused = false;
  task._cancelled = false;
  RUN.current = { book: task.book, task, dir: taskDir(task), startedAt: Date.now() };
  RUN.currentRec = rec;
  rec.status = 'running';
  rec.error = '';
  rec.endedAt = 0;
  if (!rec.startedAt) rec.startedAt = Date.now();
  emit('bookStart', { book: task.book, task });
  emit('progress', { task, rec });
  try {
    const res = await executeTask(task);
    if (res && res.taskCancelled) {
      rec.status = 'cancelled';
      rec.endedAt = Date.now();
      rec.error = '';
    } else if (res && res.paused) {
      rec.status = 'paused';
    } else {
      rec.status = res && res.ok ? 'done' : 'failed';
      rec.error = res && res.ok ? '' : ((((res.audit || {}).problems) || []).slice(0, 3).join('；') || '下载未完成');
    }
  } catch (e) {
    rec.status = 'failed';
    rec.error = String((e && e.message) || e);
  }
  RUN.current = null; RUN.currentRec = null;
  emit('bookEnd', {
    book: task.book, task, dir: taskDir(task),
    ok: rec.status === 'done', paused: rec.status === 'paused',
    cancelled: rec.status === 'cancelled', error: rec.error, rec,
  });
  emit('progress', { task, rec });
}

/** 批量队列跑完后调用：把插入的单本（默认排在队尾）依次跑完（幂等并发保护） */
export async function drainInsertedQueue() {
  if (drainingInserted) return;
  drainingInserted = true;
  try {
    while (INSERT_QUEUE.length && !RUN.cancelled) {
      const rec = INSERT_QUEUE.shift();
      if (!rec || !rec.task) continue;
      await runInsertedRecord(rec);
      // 这一本被「优先下载」抢占（暂停）→ 把剩下的插入单本留给批量循环稍后处理
      if (rec.status === 'paused') break;
    }
  } finally {
    drainingInserted = false;
  }
}

/** 引擎空闲时启动队尾插入的单本（下载中心定时调用；批量结束时由批量循环 drain） */
export async function pumpQueuedSingles() {
  if (RUN.running || !INSERT_QUEUE.length) return false;
  const rec = INSERT_QUEUE.shift();
  if (!rec || !rec.task) return false;
  RUN.running = true;
  RUN.cancelled = false;
  RUN.paused = false;
  RUN.mode = 'single';
  try {
    await runInsertedRecord(rec);
  } finally {
    RUN.running = false;
    RUN.current = null;
    RUN.currentRec = null;
  }
  emit('progress', { rec });
  setTimeout(() => { try { pumpQueuedSingles(); } catch (_) { } }, 0);
  return true;
}

async function fetchText(url) {
  const resp = await invoke('naj_fetch', { url, timeoutSecs: 60 });
  if (!resp || resp.status >= 400) throw new Error(`原站返回 HTTP ${resp ? resp.status : '?'}`);
  return String(resp.body || '');
}

/**
 * 只有 ID 时补书名。三层兜底（实测该站 .json 端点会偶发改回 HTML，必须重试）：
 *   ① /item|file|fonds/<ID>.json 的 JSON-LD（每层重试 2 次）
 *   ② 查看器页 /img/<ID> 的 <title>「ビューア | 書名」
 * 批量下载里用户常只贴一串 ID 或索书号，没有书名就无法「核对书目」。
 */
async function fetchRecordTitle(id) {
  for (const level of ['item', 'file', 'fonds']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await invoke('naj_fetch', { url: `${NAJ_ORIGIN}/${level}/${id}.json`, timeoutSecs: 45 });
        if (resp && resp.status < 400) {
          const body = String(resp.body || '');
          if (body.trimStart().startsWith('{')) {
            const rec = parseRecordJson(body);
            if (rec && rec.title) return rec.title;
          }
        }
      } catch (_) { /* 换一次或换下一层 */ }
      await sleep(300);
    }
  }
  try {
    const html = await fetchText(viewerUrl(id));
    const t = parseViewerTitle(html);
    if (t) return t;
  } catch (_) { /* 实在取不到就用 ID 显示 */ }
  return '';
}

/**
 * 解析「这本书有哪些册」。目录页是唯一能列出子册的入口
 * （JSON-LD 无 dct:hasPart、IIIF 清单只有 1 canvas）。
 *
 * ⚠️ V10.2 修 bug：**断网/请求失败时不得静默回落成"单册"**。
 *    此前只要 /file/ 请求失败就按单册处理，于是一本 50 册的书只下了 1 册
 *    （用户反馈的「断网后重新下载，每本书只会下载其中一册」）。
 *    现在只有「原站明确没有子册（404，或 200 且确实 0 行）」才按单册；
 *    网络失败 / 响应被掐断 / 403 / 5xx 一律抛错——宁可不开始，也不下一半。
 */
export async function resolveBookPlan(record) {
  let res = null;
  let netErr = '';
  try {
    const r = await invoke('naj_fetch', {
      url: `${NAJ_ORIGIN}/file/${encodeURIComponent(record.id)}`, timeoutSecs: 60,
    });
    const parsed = parseVolumeListPage(String((r && r.body) || ''));
    res = {
      ok: true,
      status: r ? r.status : 0,
      truncated: !!(r && r.truncated),
      volumes: parsed.volumes.length,
      parsed,
    };
  } catch (e) {
    netErr = (e && e.message) ? e.message : String(e);
    res = { ok: false, error: netErr };
  }

  const source = decidePlanSource(res);
  if (source === 'error') throw new Error(planErrorText(netErr ? 'network' : 'site'));
  if (source === 'file-page') {
    const plan = res.parsed;
    plan.fromFilePage = true;
    return plan;
  }

  // 只有「原站明确说没有子册」才走单册：书名缺失时用 JSON-LD／查看器页补
  const title = record.title || await fetchRecordTitle(record.id);
  return {
    bookTitle: title || record.id,
    categoryPath: record.categoryPath || [],
    total: 1,
    fromFilePage: false,
    volumes: [{
      no: 1, id: record.id, title: title || record.id,
      url: record.url || `${NAJ_ORIGIN}/item/${record.id}`, hierarchy: [],
    }],
  };
}

/**
 * 读取已冻结的 `_任务.json`（若有）——用于「继续下载」，也用于批量里避免
 * 因重新解析失败而把多册书当成单册。目录名由模板 + 书名算出，故先用空册清单探出目录名。
 */
export async function loadFrozenTask(book, options) {
  try {
    const probe = createTask({
      book: { id: book.id, title: book.title || '', categoryPath: book.categoryPath || [], url: book.url || '' },
      options,
      volumes: [],
    });
    const txt = await invoke('naj_dl_read_text', { path: `${taskDir(probe)}/_任务.json` });
    if (!txt) return null;
    const t = JSON.parse(txt);
    if (!t || !Array.isArray(t.volumes) || !t.book || String(t.book.id) !== String(book.id)) return null;
    return t;
  } catch (_) {
    return null;
  }
}

/** 单册：原生 PDF 主通道（分批 + 逐批页数校验） */
async function runVolumeNative(task, v, dir, stem) {
  const html = await fetchText(viewerUrl(v.id));
  const viewer = parseViewerPage(html);
  if (!viewer.pages.length) {
    throw new Error('查看器页未给出可下载页（该册可能未公开图像，或原站页面结构已变更）');
  }
  v.pages = viewer.maxCount || viewer.pages.length;
  v.pageUrls = null;

  const limit = BATCH_LIMIT[task.options.kind] || 50;
  const batches = chunk(viewer.pages, limit);
  const collected = [];
  for (let b = 0; b < batches.length; b++) {
    if (!(await waitWhilePaused())) throw new Error('已取消');
    const batch = batches[b];
    const from = b * limit + 1;
    const to = b * limit + batch.length;
    const name = batches.length > 1 ? `${stem}_${from}-${to}` : stem;
    const res = await invoke('naj_dl_native_pdf', {
      req: {
        recordId: String(v.id),
        cids: batch.map((p) => p.cid),
        outDir: dir,
        fileStem: name,
        kind: task.options.kind,
        timeoutSecs: 900,
      },
    });
    const files = (res && res.files) || [];
    if (!files.length) throw new Error('原站未返回 PDF');
    // ⚠️ V10.3：结构不完整（缺 %%EOF，多半是传输被掐断）的 PDF 一律作废重来，
    // 否则会出现「页数数得对、文件却打不开／无法合并」的残缺 PDF 混进压缩包。
    const broken = files.find((f) => f.eof_ok === false);
    if (broken) {
      throw new Error(`第 ${from}-${to} 页这一批的 PDF 结构不完整（${broken.name || ''} 缺少文件尾部），已作废，将重试或走兜底`);
    }
    const sum = files.reduce((s, f) => s + (Number(f.pages_dct) || 0), 0);
    if (sum !== batch.length) {
      throw new Error(`第 ${from}-${to} 页这一批校验不符：期望 ${batch.length} 页，PDF 内实得 ${sum} 页`);
    }
    for (const f of files) {
      collected.push({
        path: f.path, name: f.name, bytes: f.bytes, sha256: f.sha256,
        pages: Number(f.pages_dct) || 0, channel: 'native',
      });
    }
  }

  // >1 个分卷（说明该册超过站方单批 50 页上限）→ 自动合并成一个 PDF（用户要求）
  if (collected.length > 1) {
    const expected = v.pages || collected.reduce((s, f) => s + f.pages, 0);
    try {
      const merged = await invoke('naj_dl_merge_pdfs', {
        req: {
          parts: collected.map((f) => f.path),
          outPath: `${dir}/${stem}.pdf`,
          title: v.title || task.book.title || '',
          author: '',
          sourceNote: `国立公文書館デジタルアーカイブ ${NAJ_ORIGIN}/item/${v.id}`,
          expectPages: expected,
        },
      });
      const ver = await invoke('naj_dl_verify_pdf', { path: merged.path, expectPages: expected });
      if (!ver.ok) throw new Error(`合并后页数校验不符（期望 ${expected}，实得 ${ver.pages_dct}）`);
      // 合并成功且校验通过，才删掉分卷，避免"合了但丢了分卷"
      for (const f of collected) {
        try { await invoke('naj_dl_remove', { path: f.path }); } catch (_) { /* 删不掉就留着 */ }
      }
      collected.length = 0;
      collected.push({
        path: merged.path, name: merged.name, bytes: merged.bytes, sha256: merged.sha256,
        pages: Number(merged.pages_dct) || 0, channel: 'native', merged: true,
      });
      v.note = `已把 ${batches.length} 个分卷合并为一个 PDF`;
    } catch (e) {
      // 合并失败不影响完整性：保留分卷，报告里写明原因，审计仍按各 part 页数求和
      v.note = `分卷未合并（${(e && e.message) ? e.message : e}），已保留 ${collected.length} 个分卷`;
    }
  }
  const totalPages = collected.reduce((s, f) => s + f.pages, 0);
  if (v.pages && totalPages !== Number(v.pages)) {
    throw new Error(`整册页数不符：期望 ${v.pages}，实得 ${totalPages}`);
  }
  v.files = collected;
  v.pageCount = totalPages;
  v.channel = 'native';
  v.status = 'done';
}

/** 单册：IIIF 逐页兜底（页数由 canvas 数确定，可精确校验） */
async function runVolumeIiif(task, v, dir, stem) {
  const mj = await fetchText(manifestUrl(v.id));
  const man = parseManifest(mj);
  if (!man || !man.canvases.length) throw new Error('IIIF 清单为空');
  const urls = man.canvases.map((c) => c.imageUrl).filter(Boolean);
  if (urls.length !== man.canvases.length) throw new Error('IIIF 清单中有 canvas 缺少图像地址');
  v.pages = man.pageCount;
  v.pageUrls = urls;

  const res = await invoke('naj_dl_iiif_volume', {
    req: {
      urls,
      outDir: dir,
      fileStem: stem,
      title: task.book.title || '',
      author: '',
      source_note: `国立公文書館デジタルアーカイブ ${NAJ_ORIGIN}/item/${v.id}`,
      concurrency: 2,
      delayMs: 400,
      timeoutSecs: 900,
    },
  });
  const failed = (res && res.failed) || [];
  if (!res || !res.file || failed.length) {
    throw new Error(`兜底下载失败：${failed.length ? `第 ${failed.slice(0, 12).join('、')} 页未取到` : '未生成文件'}`);
  }
  const f = res.file;
  const pages = Number(f.pages_dct) || 0;
  if (pages !== man.pageCount) {
    throw new Error(`兜底合成页数不符：期望 ${man.pageCount}，实得 ${pages}`);
  }
  v.files = [{ path: f.path, name: f.name, bytes: f.bytes, sha256: f.sha256, pages, channel: 'iiif' }];
  v.pageCount = pages;
  v.channel = 'iiif';
  v.status = 'done';
}

/** 跑一册（主通道失败自动降级兜底，册序号与文件名不变） */
async function runVolume(task, v, dir) {
  v.status = 'running';
  v.error = '';
  v.attempts = (v.attempts || 0) + 1;
  emit('volume', { task, volume: v });
  const stem = String(v.fileName || `第${v.no}册`).replace(/\.pdf$/i, '');

  let nativeErr = '';
  if (task.options.kind !== 'iiif-only') {
    try {
      await runVolumeNative(task, v, dir, stem);
      emit('volume', { task, volume: v });
      return;
    } catch (e) {
      nativeErr = (e && e.message) ? e.message : String(e);
      if (nativeErr === '已取消') { v.status = 'pending'; return; }
      v.files = [];
      v.pageCount = 0;
    }
  }
  try {
    await runVolumeIiif(task, v, dir, stem);
  } catch (e) {
    v.status = (v.files && v.files.length) ? 'partial' : 'failed';
    const msg = (e && e.message) ? e.message : String(e);
    v.error = nativeErr ? `原生通道：${nativeErr}；兜底通道：${msg}` : msg;
  }
  emit('volume', { task, volume: v });
}

/** 执行一个任务（逐册队列）；返回 { ok, audit, zip }；
 *  V2.0：若该任务被「按本暂停」（task._paused），当前这一册下完后提前返回 { paused:true }，
 *        不进入 finalize —— 已完成册与 _任务.json 都在，恢复时照常续传、审计、打包。
 *  V2.2：若该任务被「取消当前」（task._cancelled），同样在当前册结束后提前返回 { taskCancelled:true }，
 *        不审计、不打包（这一本会被移出下载队列）。 */
export async function executeTask(task) {
  const dir = taskDir(task);
  await invoke('naj_dl_mkdir', { path: dir });
  await saveTask(task);

  if (isTaskCancelled(task)) return { ok: false, cancelled: true, taskCancelled: true, task, dir };
  if (isTaskPaused(task)) return { ok: false, paused: true, task, dir };

  let cursor = 0;
  let paused = false;
  let taskCancelled = false;
  const conc = Math.max(1, Math.min(2, Number(task.options.concurrency) || 1));
  const worker = async () => {
    for (;;) {
      if (RUN.cancelled) return;
      if (isTaskCancelled(task)) { taskCancelled = true; return; }
      if (isTaskPaused(task)) { paused = true; return; }
      if (!(await waitWhilePaused())) return;
      const i = cursor++;
      if (i >= task.volumes.length) return;
      const v = task.volumes[i];
      if (v.status === 'done') continue;
      await runVolume(task, v, dir);
      await saveTask(task);
      touchRunningTask();                       // V10.5：同步「下载记录」里的进度
      emit('progress', { task });
      await sleep(Math.max(0, Number(task.options.delayMs) || 0));
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));

  if (taskCancelled || isTaskCancelled(task)) return { ok: false, cancelled: true, taskCancelled: true, task, dir };
  if (paused || isTaskPaused(task)) return { ok: false, paused: true, task, dir };
  return finalizeTask(task, dir);
}

/** 收尾：审计 → （过门禁才）打包 → 清理
 *  V10.2：不再写 `_报告.csv` / `_manifest.jsonl`（用户要求：打包后目录里只留 PDF）；
 *         任务完成后连 `_任务.json` 一并删除；未完成则保留，供续传。 */
export async function finalizeTask(task, dir, opts = {}) {
  const audit = auditTask(task);
  task.audit = { ok: audit.ok, problems: audit.problems, at: new Date().toISOString() };

  if (!audit.ok) {
    await saveTask(task);            // 未完成：保留任务文件，便于「只重试未完成册」
    return { ok: false, audit, dir, task };
  }

  if (opts.makeZip !== false) {
    const files = task.volumes.flatMap((v) => (v.files || []).map((f) => f.path));
    if (files.length) {
      const root = String(task.zipName || '打包').replace(/\.zip$/i, '');
      const z = await invoke('naj_dl_zip', { req: { files, outPath: `${dir}/${task.zipName}`, root } });
      task.zip = { path: z.path, name: z.name, bytes: z.bytes, sha256: z.sha256 };
    }
  }
  // 全部完成：目录里只留 PDF（与压缩包），任务文件删掉
  try { await invoke('naj_dl_remove', { path: `${dir}/_任务.json` }); } catch (_) { /* 已不存在也无妨 */ }
  return { ok: true, audit, dir, task };
}

/**
 * 跑「一本书」：解析册 → 建任务 → 执行。
 * 批量队列与单本面板都走这里，保证两条路径的完整性规则完全一致。
 * V2.2：可传入 reuse={task,rec} —— 「优先下载」抢占后自动恢复时复用原任务与下载记录，
 *       避免同一本书在下载中心出现两条记录（已完成册也不会重下）。
 * @returns {{ok:boolean, task:object, dir:string, error:string, audit:object}}
 */
export async function runBook(book, options, reuse) {
  let task;
  let rec;
  if (reuse && reuse.task) {
    task = reuse.task;
    task._paused = false;
    task._cancelled = false;
    rec = reuse.rec || regTask('batch', task);
    rec.status = 'running';
    rec.error = '';
    rec.endedAt = 0;
  } else {
    // 优先复用已冻结的任务（断点续传）：既省一次解析，也避免解析失败把多册书当单册
    task = await loadFrozenTask(book, options);
    if (task && retryableVolumes(task).length === 0) task = null;   // 已完成的不重复下
    if (!task) {
      const plan = await resolveBookPlan(book);
      task = createTask({
        book: {
          id: book.id,
          title: plan.bookTitle || book.title,
          categoryPath: plan.categoryPath || [],
          url: book.url || '',
        },
        options,
        volumes: plan.volumes,
      });
    }
    rec = regTask('batch', task);          // V10.5：批量里的每一本也进「下载记录」
  }
  RUN.current = { book, task, dir: taskDir(task), startedAt: Date.now() };
  RUN.currentRec = rec;
  emit('bookStart', { book, task });
  const res = await executeTask(task);
  const paused = !!(res && res.paused);
  const taskCancelled = !!(res && res.taskCancelled);
  const error = (paused || taskCancelled) ? '' : (res.ok ? '' : (((res.audit || {}).problems) || []).slice(0, 3).join('；'));
  RUN.current = null; RUN.currentRec = null;
  RUN.lastResult = { book, task, dir: res.dir, ok: !paused && !taskCancelled && res.ok, error, paused, cancelled: taskCancelled };
  updTask(rec, { status: taskCancelled ? 'cancelled' : (paused ? 'paused' : (res.ok ? 'done' : 'failed')), error });
  emit('bookEnd', { ...RUN.lastResult, rec });
  return { ...res, error, paused, taskCancelled, rec };
}

// ================================================================
// ② 单本下载面板
// ================================================================

const S = {
  open: false,
  record: null,
  plan: null,
  task: null,
  outRoot: '',
  kind: 'imagePdf',
  makeZip: true,
};

let outRootCache = '';

export async function defaultOutRoot() {
  if (outRootCache) return outRootCache;
  try { outRootCache = await invoke('naj_dl_default_root'); } catch (_) { outRootCache = ''; }
  return outRootCache;
}

/** 记住上次选择的输出目录（自选下载位置） */
export function rememberOutDir(p) {
  if (!p) return;
  outRootCache = p;
  try { localStorage.setItem('kanseki.najdl.outDir', p); } catch (_) { /* 忽略 */ }
}
export function lastOutDir() {
  try { return localStorage.getItem('kanseki.najdl.outDir') || ''; } catch (_) { return ''; }
}

// 命名模板：三套（目录 / 每册 / 压缩包）都要能自定义，且**记住上次用的**
const TPL_KEY = 'kanseki.najdl.templates';
export function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(TPL_KEY) || '{}') || {}; } catch (_) { return {}; }
}
export function saveTemplates(t) {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(t || {})); } catch (_) { /* 忽略 */ }
}
export function effectiveTemplates(override) {
  return { ...DEFAULT_TEMPLATES, ...loadTemplates(), ...(override || {}) };
}

/** 调系统「选择文件夹」对话框（Rust：SHBrowseForFolderW） */
export async function pickFolder(initial) {
  try {
    const p = await invoke('naj_dl_pick_folder', {
      title: '选择下载位置',
      initial: initial || '',
    });
    return p || '';
  } catch (e) {
    toast(`打开文件夹选择框失败：${e.message || e}`, 'err');
    return '';
  }
}

function ensureOverlay() {
  if (el('najDlOverlay')) return;
  const div = document.createElement('div');
  div.className = 'dl-overlay';
  div.id = 'najDlOverlay';
  div.hidden = true;
  div.innerHTML = `
    <div class="dl-modal" role="dialog" aria-modal="true" aria-labelledby="najDlHead">
      <div class="dl-head">
        <h3 id="najDlHead">下载整册 PDF</h3>
        <button class="dl-x" type="button" data-dl-close title="关闭">×</button>
      </div>
      <div class="dl-body">
        <div id="najDlPrepare">
          <div class="dl-est" id="najDlEstimate"><span class="dl-loading">正在解析目录页…</span></div>

          <div class="dl-grid2">
            <label class="dl-field"><span>下载位置（可自选）</span>
              <span class="dl-pathrow">
                <input id="najDlOut" type="text" spellcheck="false" autocomplete="off">
                <button class="av-btn dl-browse" type="button" id="najDlBrowse">浏览…</button>
              </span></label>
            <label class="dl-field"><span>下载方式</span>
              <select id="najDlKind"></select></label>
          </div>

          <div class="dl-tpl">
            <div class="dl-tpl-head">
              <span>命名方式</span>
              <select id="najDlPreset" class="dl-preset"></select>
            </div>
            <div class="dl-grid3">
              <label class="dl-field"><span>目录名</span><input id="najDlTplFolder" type="text" spellcheck="false"></label>
              <label class="dl-field"><span>每册文件名</span><input id="najDlTplFile" type="text" spellcheck="false"></label>
              <label class="dl-field"><span>压缩包名</span><input id="najDlTplZip" type="text" spellcheck="false"></label>
            </div>
            <div class="dl-tokens" id="najDlTokens"></div>
            <div class="dl-preview" id="najDlPreview"></div>
          </div>

          <div class="dl-grid3">
            <label class="dl-field"><span>并发册数</span>
              <select id="najDlConc">
                <option value="1">1（最稳，推荐）</option>
                <option value="2">2</option>
              </select></label>
            <label class="dl-field"><span>每册间隔（毫秒）</span>
              <input id="najDlDelay" type="number" min="0" step="100" value="1200"></label>
            <label class="dl-field dl-field-check"><span>&nbsp;</span>
              <label class="dl-check"><input type="checkbox" id="najDlZip" checked> 完成后打包为 ZIP</label></label>
          </div>

          <p class="dl-note">
            数据来源：<b>国立公文書館デジタルアーカイブ</b>（目録元数据 CC0；数字内容可自由复制改変再发布，请注明出典）。
            主通道为站方原生 PDF（robots 中 <code>/contentDownload/*</code> 为 Disallow，故本功能只由你逐次点选触发，
            默认并发 1 并强制册间间隔）。失败册会自动改用 IIIF 逐页重出，<b>册序号与文件名不变</b>。
            下载中可随时「暂停／取消」，进度写在输出目录的 <code>_任务.json</code> 里，重开可续传。
          </p>
        </div>

        <div id="najDlRun" hidden>
          <div class="dl-sum" id="najDlSum"></div>
          <div class="dl-bar"><div class="dl-bar-in" id="najDlBar"></div></div>
          <div class="dl-list" id="najDlList"></div>
          <div class="dl-problems" id="najDlProblems" hidden></div>
        </div>
      </div>
      <div class="dl-foot">
        <button class="av-btn" type="button" data-dl-close>关闭</button>
        <button class="av-btn" type="button" id="najDlResume" hidden>继续未完成任务</button>
        <button class="av-btn" type="button" id="najDlRetry" hidden>只重试未完成册</button>
        <button class="av-btn" type="button" id="najDlReveal" hidden>打开所在文件夹</button>
        <button class="av-btn av-btn-primary" type="button" id="najDlStart">开始下载</button>
      </div>
    </div>`;
  document.body.appendChild(div);

  div.addEventListener('click', (e) => {
    if (e.target === div || e.target.closest('[data-dl-close]')) closeOverlay();
    const token = e.target.closest('[data-dl-token]');
    if (token) insertToken(token.dataset.dlToken, token.dataset.dlTarget);
  });
  el('najDlStart')?.addEventListener('click', onStart);
  el('najDlResume')?.addEventListener('click', onResume);
  el('najDlRetry')?.addEventListener('click', onRetryFailed);
  el('najDlReveal')?.addEventListener('click', onReveal);
  el('najDlPreset')?.addEventListener('change', onPreset);
  el('najDlBrowse')?.addEventListener('click', async () => {
    const p = await pickFolder(el('najDlOut').value);
    if (p) { el('najDlOut').value = p; rememberOutDir(p); renderPreview(); }
  });
  for (const id of ['najDlTplFolder', 'najDlTplFile', 'najDlTplZip']) {
    el(id)?.addEventListener('input', renderPreview);
  }
  el('najDlOut')?.addEventListener('input', renderPreview);
  el('najDlKind')?.addEventListener('change', () => { S.kind = el('najDlKind').value; renderPreview(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.open) closeOverlay();
  });
}

function buildTokenChips() {
  const box = el('najDlTokens');
  if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  box.innerHTML = '<span class="dl-tokens-hint">点字段插入（作用于最后聚焦的输入框）：</span>'
    + NAME_TOKENS.map((t) => `<button type="button" class="dl-token" data-dl-token="{${esc(t.key)}}" title="${esc(t.desc)}">${esc(t.key)}</button>`).join('');
  box.addEventListener('focusin', (e) => {
    if (e.target.matches('input')) box.dataset.last = e.target.id;
  }, true);
}

function insertToken(tok, targetId) {
  const id = targetId || el('najDlTokens')?.dataset.last || 'najDlTplFile';
  const input = el(id);
  if (!input) return;
  const pos = input.selectionStart == null ? input.value.length : input.selectionStart;
  input.value = input.value.slice(0, pos) + tok + input.value.slice(input.selectionEnd == null ? pos : input.selectionEnd);
  input.focus();
  input.selectionStart = input.selectionEnd = pos + tok.length;
  renderPreview();
}

function fillKindOptions() {
  const sel = el('najDlKind');
  if (!sel) return;
  sel.innerHTML = NATIVE_KINDS.iiifcanvas
    .filter((k) => k.value === 'imagePdf')
    .map((k) => `<option value="${esc(k.value)}">${esc(k.label)}（站方原生，推荐）</option>`).join('')
    + '<option value="__iiif">IIIF 逐页合成（不经 /contentDownload）</option>';
}

export async function openBookDownload(record) {
  if (!isTauri) { toast('下载功能仅在 Windows 桌面版可用（网页版无法直连原站）', 'err'); return; }
  if (!record || !record.id) { toast('该条记录没有可用 ID', 'err'); return; }
  ensureOverlay();
  buildTokenChips();
  fillKindOptions();
  S.record = record;
  S.open = true;
  S.task = null;
  S.plan = null;
  el('najDlOverlay').hidden = false;
  el('najDlPrepare').hidden = false;
  el('najDlRun').hidden = true;
  el('najDlStart').hidden = false;
  el('najDlStart').disabled = true;
  el('najDlStart').textContent = RUN.running ? '加入下载队列（排到队尾）' : '开始下载';
  el('najDlResume').hidden = true;
  el('najDlRetry').hidden = true;
  el('najDlReveal').hidden = true;
  el('najDlProblems').hidden = true;
  el('najDlHead').textContent = `下载整册 PDF — ${record.title || record.id}`;
  el('najDlEstimate').innerHTML = '<span class="dl-loading">正在解析目录页（/file/）…</span>';
  el('najDlTplFolder').value = effectiveTemplates().folder;
  el('najDlTplFile').value = effectiveTemplates().file;
  el('najDlTplZip').value = effectiveTemplates().zip;
  fillPresets();
  el('najDlOut').value = lastOutDir() || await defaultOutRoot();

  try {
    const plan = await resolveBookPlan(record);
    S.plan = plan;
    renderEstimate();
    renderPreview();
    el('najDlStart').disabled = false;
    await checkResume();
  } catch (e) {
    // 解析失败（多半是断网）：明确报错并**禁用开始**，绝不按"单册"糊弄过去
    S.plan = null;
    el('najDlEstimate').innerHTML = `
      <div class="dl-est-main"><b>${esc(record.title || record.id)}</b>
        <span class="dl-est-cat">未能读取书目</span></div>
      <div class="dl-est-sub dl-est-err">${esc((e && e.message) ? e.message : String(e))}</div>`;
    el('najDlStart').disabled = true;
    toast('读取书目失败，未开始下载（请检查网络后重试）', 'err');
  }
}

function fillPresets() {
  const sel = el('najDlPreset');
  if (!sel || sel.dataset.built) return;
  sel.dataset.built = '1';
  sel.innerHTML = '<option value="__custom">自定义</option>'
    + TEMPLATE_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
}

function onPreset() {
  const p = TEMPLATE_PRESETS.find((x) => x.id === el('najDlPreset').value);
  if (!p) return;
  el('najDlTplFolder').value = p.tpl.folder;
  el('najDlTplFile').value = p.tpl.file;
  el('najDlTplZip').value = p.tpl.zip;
  renderPreview();
}

function renderEstimate() {
  const p = S.plan;
  if (!p) return;
  const n = p.volumes.length;
  const estPages = n * 40;
  el('najDlEstimate').innerHTML = `
    <div class="dl-est-main">
      <b>${esc(p.bookTitle || '')}</b>
      <span class="dl-est-badge">${n} 册${p.fromFilePage ? '' : '（未取到目录页，按单册处理）'}</span>
      ${p.categoryPath && p.categoryPath.length ? `<span class="dl-est-cat">${esc(p.categoryPath.join(' ＞ '))}</span>` : ''}
    </div>
    <div class="dl-est-sub">粗略预估：约 ${estPages} 页 · 约 ${(estPages * 0.7).toFixed(0)} MB ·
      约 ${Math.max(1, Math.round(n * 15 / 60))} 分钟（页数以逐册实际为准；主通道每册 1 次请求，&gt;50 页的册自动分批）</div>`;
}

function currentTemplates() {
  return {
    folder: el('najDlTplFolder').value || DEFAULT_TEMPLATES.folder,
    file: el('najDlTplFile').value || DEFAULT_TEMPLATES.file,
    zip: el('najDlTplZip').value || DEFAULT_TEMPLATES.zip,
  };
}

function renderPreview() {
  if (!S.plan) return;
  const common = {
    书名: S.plan.bookTitle || '',
    分类: (S.plan.categoryPath || []).join('-'),
    主册ID: S.record ? S.record.id : '',
    日期: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    总册数: S.plan.volumes.length,
  };
  const folder = applyTemplate(el('najDlTplFolder').value, common);
  const zip = applyTemplate(el('najDlTplZip').value, common);
  const root = (el('najDlOut').value || '').replace(/[\\/]+$/, '');
  const sample = [];
  const used = new Map();
  for (const v of S.plan.volumes.slice(0, 3)) {
    const ctx = { ...common, 册次: v.no, 册名: v.title, 册ID: v.id };
    let f = truncateForNas(applyTemplate(el('najDlTplFile').value, ctx));
    if (f.toLowerCase().endsWith('.pdf')) f = f.slice(0, -4);
    const k = f.toLowerCase();
    const dup = (used.get(k) || 0) + 1;
    used.set(k, dup);
    if (dup > 1) f = `${f}_${dup}`;
    sample.push(`${f}.pdf`);
  }
  const more = S.plan.volumes.length > 3 ? `…（共 ${S.plan.volumes.length} 个文件）` : '';
  el('najDlPreview').innerHTML = `
    <div class="dl-preview-head">预览</div>
    <div class="dl-preview-tree">
      <div>${esc(root)}/</div>
      <div class="dl-ind1">${esc(folder)}/</div>
      ${sample.map((f) => `<div class="dl-ind2">${esc(f)}</div>`).join('')}${more ? `<div class="dl-ind2 dl-dim">${esc(more)}</div>` : ''}
      <div class="dl-ind1">${esc(folder)}/${esc(zip)}.zip</div>
      <div class="dl-ind1 dl-dim">（下载中会临时写入 _任务.json，完成后自动删除——最终只留 PDF 与压缩包）</div>
    </div>`;
}

async function checkResume() {
  try {
    const probe = buildTaskFromPlan();
    const dir = taskDir(probe);
    const txt = await invoke('naj_dl_read_text', { path: `${dir}/_任务.json` });
    if (!txt) return;
    const old = JSON.parse(txt);
    if (!old || !old.volumes || !old.book || String(old.book.id) !== String(S.record.id)) return;
    const done = old.volumes.filter((v) => v.status === 'done').length;
    if (done >= old.volumes.length) return;
    const btn = el('najDlResume');
    btn.hidden = false;
    btn.textContent = `继续未完成任务（${done}/${old.volumes.length} 册已完成）`;
    btn.dataset.dir = dir;
  } catch (_) { /* 无历史任务即忽略 */ }
}

function onResume() {
  const dir = el('najDlResume').dataset.dir;
  if (!dir) return;
  invoke('naj_dl_read_text', { path: `${dir}/_任务.json` }).then((txt) => {
    if (!txt) { toast('任务文件已不存在', 'err'); return; }
    const task = JSON.parse(txt);
    S.task = task;
    startRun(task, { resume: true });
  }).catch((e) => toast(`读取任务失败：${e.message || e}`, 'err'));
}

function buildTaskFromPlan(overrides = {}) {
  return createTask({
    book: {
      id: S.record.id,
      title: S.plan.bookTitle || S.record.title,
      categoryPath: S.plan.categoryPath || [],
      url: S.record.url || '',
    },
    options: {
      kind: S.kind,
      concurrency: Number(el('najDlConc')?.value || 1),
      delayMs: Number(el('najDlDelay')?.value || 1200),
      outDir: (el('najDlOut').value || '').replace(/[\\/]+$/, ''),
      templates: currentTemplates(),
      ...overrides,
    },
    volumes: S.plan.volumes,
  });
}

async function onStart() {
  // V2.1（用户第 3 条）：批量下载进行中，单本下载请求**插入同一队列**，不打断批量；
  // 下载中心里会以「队列中 → 下载中」的状态出现，当前这本跑完后执行。
  if (RUN.running) {
    S.kind = el('najDlKind').value === '__iiif' ? 'iiif-only' : el('najDlKind').value;
    S.makeZip = !!el('najDlZip').checked;
    saveTemplates(currentTemplates());
    rememberOutDir(el('najDlOut').value.replace(/[\\/]+$/, ''));
    const task = buildTaskFromPlan();
    if (!task.options.outDir) { toast('请先选择下载位置', 'err'); return; }
    insertSingleTask(task);
    toast('已排到队尾：本批下载结束后开始这一本，可在「下载中心」查看', 'ok');
    closeOverlay();
    return;
  }
  S.kind = el('najDlKind').value === '__iiif' ? 'iiif-only' : el('najDlKind').value;
  S.makeZip = !!el('najDlZip').checked;
  saveTemplates(currentTemplates());   // 三套命名模板都记住，下次沿用
  rememberOutDir(el('najDlOut').value.replace(/[\\/]+$/, ''));
  const task = buildTaskFromPlan();
  if (!task.options.outDir) { toast('请先选择下载位置', 'err'); return; }
  S.task = task;
  startRun(task, { resume: false });
}

function startRun(task, { resume }) {
  RUN.running = true;
  RUN.paused = false;
  RUN.cancelled = false;
  RUN.mode = 'single';
  S.task = task;
  // V10.5：单本下载也进下载中心 —— 登记记录 + 设置当前任务 + 通知引擎订阅者，
  // 这样抽屉里的「当前任务/下载记录」和右上角角标都能看到本单的进度。
  const rec = regTask('single', task);
  RUN.current = { book: task.book, task, dir: taskDir(task), startedAt: Date.now() };
  RUN.currentRec = rec;
  emit('bookStart', { book: task.book, task });
  el('najDlPrepare').hidden = true;
  el('najDlRun').hidden = false;
  el('najDlStart').hidden = true;
  el('najDlResume').hidden = true;
  el('najDlProblems').hidden = true;
  renderTask();

  executeTask(task)
    .then((res) => {
      RUN.running = false;
      S.task = task;
      RUN.current = null; RUN.currentRec = null;
      // V2.2：这一本被「取消当前」——当前册下完即停，不审计、不打包，记录标取消
      if (res && res.taskCancelled) {
        rec.status = 'cancelled'; rec.error = ''; rec.endedAt = Date.now();
        RUN.lastResult = { book: task.book, task, dir: res.dir, ok: false, cancelled: true, error: '' };
        emit('bookEnd', { ...RUN.lastResult, rec });
        renderTask();
        toast('已取消这一本（已完成的册保留在文件夹里）', 'warn');
        el('najDlStart').hidden = false;
        el('najDlStart').textContent = '重新下载未完成册';
        el('najDlReveal').hidden = false;
        return;
      }
      // V2.0：按本暂停 —— 当前这一册下完后提前返回 paused，不审计、不打包；任务文件保留可续传
      if (res && res.paused) {
        rec.status = 'paused'; rec.error = ''; rec.endedAt = 0;
        RUN.lastResult = { book: task.book, task, dir: res.dir, ok: false, paused: true, error: '' };
        emit('bookEnd', { ...RUN.lastResult, rec });
        renderTask();
        toast('这一本已暂停，可在「下载中心」继续', 'warn');
        el('najDlStart').hidden = false;
        el('najDlStart').textContent = '继续下载未完成册';
        el('najDlReveal').hidden = false;
        return;
      }
      RUN.lastResult = {
        book: task.book, task, dir: res.dir, ok: res.ok,
        error: res.ok ? '' : ((res.audit && res.audit.problems) || []).slice(0, 3).join('；'),
      };
      updTask(rec, { status: res.ok ? 'done' : 'failed', error: RUN.lastResult.error });
      emit('bookEnd', { ...RUN.lastResult, rec });
      renderTask();
      if (!res.ok) {
        renderProblems(res.audit, '未通过完整性门禁，已拒绝打包（避免出现缺册却看似完整的压缩包）。可点「只重试未完成册」补齐后再打包。');
        window.__najDlNotify?.({
          kind: 'error',
          title: '下载未完成',
          text: `${task.book.title}：缺 ${res.audit.missing.length} 册，已拒绝打包`,
          dir: res.dir,
          task,
        });
      } else {
        el('najDlProblems').hidden = true;
        window.__najDlNotify?.({
          kind: 'ok',
          title: '下载完成',
          text: `${task.book.title}：${task.volumes.length} 册 / ${res.audit.stats.pages} 页${task.zip ? '，已打包' : ''}`,
          dir: res.dir,
          task,
        });
      }
      el('najDlStart').hidden = false;
      el('najDlStart').textContent = '重新下载未完成册';
      el('najDlRetry').hidden = retryableVolumes(task).length === 0;
      el('najDlReveal').hidden = false;
    })
    .catch((e) => {
      RUN.running = false;
      RUN.current = null; RUN.currentRec = null;
      const msg = String(e.message || e);
      RUN.lastResult = { book: task.book, task, dir: taskDir(task), ok: false, error: msg };
      updTask(rec, { status: 'failed', error: msg });
      emit('bookEnd', { ...RUN.lastResult, rec });
      toast(`任务异常终止：${msg}`, 'err');
    });
}

async function onRetryFailed() {
  if (RUN.running || !S.task) return;
  const list = retryableVolumes(S.task);
  if (!list.length) { toast('没有未完成的册', 'ok'); return; }
  for (const v of list) {
    v.status = 'pending'; v.files = []; v.pageCount = 0; v.pageUrls = null; v.error = '';
  }
  RUN.running = true;
  RUN.cancelled = false;
  RUN.paused = false;
  // V10.5：补齐同样登记进下载中心
  const rec = regTask('single', S.task);
  RUN.current = { book: S.task.book, task: S.task, dir: taskDir(S.task), startedAt: Date.now() };
  RUN.currentRec = rec;
  emit('bookStart', { book: S.task.book, task: S.task });
  renderTask();
  executeTask(S.task).then((res) => {
    RUN.running = false;
    RUN.current = null; RUN.currentRec = null;
    if (res && res.taskCancelled) {
      rec.status = 'cancelled'; rec.error = ''; rec.endedAt = Date.now();
      emit('bookEnd', { book: S.task.book, task: S.task, dir: res.dir, ok: false, cancelled: true, error: '', rec });
      renderTask();
      toast('已取消这一本', 'warn');
      return;
    }
    if (res && res.paused) {
      rec.status = 'paused'; rec.error = ''; rec.endedAt = 0;
      emit('bookEnd', { book: S.task.book, task: S.task, dir: res.dir, ok: false, paused: true, error: '', rec });
      renderTask();
      toast('这一本已暂停，可在「下载中心」继续', 'warn');
      return;
    }
    RUN.lastResult = {
      book: S.task.book, task: S.task, dir: res.dir, ok: res.ok,
      error: res.ok ? '' : ((res.audit && res.audit.problems) || []).slice(0, 3).join('；'),
    };
    updTask(rec, { status: res.ok ? 'done' : 'failed', error: RUN.lastResult.error });
    emit('bookEnd', { ...RUN.lastResult, rec });
    renderTask();
    if (!res.ok) renderProblems(res.audit, '仍有未完成册，已拒绝打包。');
    else window.__najDlNotify?.({ kind: 'ok', title: '补齐完成', text: `${S.task.book.title} 已全部完成`, dir: res.dir, task: S.task });
  }).catch((e) => {
    RUN.running = false;
    RUN.current = null; RUN.currentRec = null;
    const msg = String(e.message || e);
    updTask(rec, { status: 'failed', error: msg });
    emit('bookEnd', { book: S.task.book, task: S.task, dir: taskDir(S.task), ok: false, error: msg, rec });
    toast(String(msg), 'err');
  });
}

async function onReveal() {
  if (!S.task) return;
  try { await invoke('reveal_path', { path: taskDir(S.task) }); } catch (e) { toast(String(e.message || e), 'err'); }
}

// ---- 面板渲染

function statusBadge(v) {
  const map = {
    pending: ['待处理', 'dl-b-idle'],
    running: ['下载中', 'dl-b-run'],
    partial: ['半成品', 'dl-b-warn'],
    failed: ['失败', 'dl-b-err'],
    done: ['完成', 'dl-b-ok'],
  };
  const [text, cls] = map[v.status] || ['—', 'dl-b-idle'];
  const ch = v.channel === 'native' ? '原生' : (v.channel === 'iiif' ? '兜底' : '');
  return `<span class="dl-badge ${cls}">${esc(text)}</span>${ch ? `<span class="dl-badge dl-b-ch">${esc(ch)}</span>` : ''}`;
}

export function renderTaskInto(listEl, sumEl, barEl, task) {
  if (!task) return;
  if (sumEl) {
    const sum = summarizeTask(task);
    sumEl.innerHTML = `<b>${esc(task.book.title || '')}</b> · ${esc(sum.text)}
      <div class="dl-dim">输出：${esc(taskDir(task))}</div>`
      + (task.zip && task.zip.path ? `<div class="dl-dim">压缩包：${esc(task.zip.path)}</div>` : '');
  }
  if (barEl) {
    const doneCount = task.volumes.filter((v) => v.status === 'done').length;
    barEl.style.width = `${Math.round(doneCount / Math.max(1, task.volumes.length) * 100)}%`;
  }
  if (listEl) {
    listEl.innerHTML = task.volumes.map((v) => `
      <div class="dl-item dl-st-${esc(v.status)}" data-no="${v.no}">
        <span class="dl-no">${String(v.no).padStart(3, '0')}</span>
        <span class="dl-title" title="${esc(v.title)}">${esc(v.title)}</span>
        <span class="dl-pages">${v.pageCount ? `${v.pageCount} 页` : (v.pages ? `期望 ${v.pages} 页` : '')}</span>
        <span class="dl-file" title="${esc((v.files || []).map((f) => f.name).join(' / '))}">${esc((v.files || []).map((f) => f.name).join(' / ') || v.fileName || '')}</span>
        ${statusBadge(v)}
        ${v.error ? `<span class="dl-err" title="${esc(v.error)}">${esc(v.error.slice(0, 60))}</span>` : ''}
      </div>`).join('');
  }
}

function renderTask() {
  renderTaskInto(el('najDlList'), el('najDlSum'), el('najDlBar'), S.task);
}

function renderProblems(audit, head) {
  const box = el('najDlProblems');
  if (!box) return;
  box.hidden = false;
  const list = audit.problems.slice(0, 40).map((p) => `<li>${esc(p)}</li>`).join('');
  const more = audit.problems.length > 40 ? `<li class="dl-dim">…另有 ${audit.problems.length - 40} 条</li>` : '';
  box.innerHTML = `<div class="dl-problems-head">${esc(head).replace(/\*\*/g, '')}</div><ul>${list}${more}</ul>`;
}

function closeOverlay() {
  S.open = false;
  const ov = el('najDlOverlay');
  if (ov) ov.hidden = true;
}

// ---- 对外小工具

export function dlAvailable() { return isTauri; }

/** 只读打开某个任务的逐册明细（下载中心「查看逐册明细」用） */
export function showTaskDetail(task) {
  if (!task) return;
  ensureOverlay();
  buildTokenChips();
  fillKindOptions();
  S.open = true;
  S.task = task;
  S.plan = null;
  S.record = { id: task.book.id, title: task.book.title };
  el('najDlOverlay').hidden = false;
  el('najDlPrepare').hidden = true;
  el('najDlRun').hidden = false;
  el('najDlStart').hidden = true;
  el('najDlResume').hidden = true;
  el('najDlReveal').hidden = false;
  el('najDlHead').textContent = `下载详情 — ${task.book.title || ''}`;
  renderTask();
  const a = auditTask(task);
  if (!a.ok) renderProblems(a, '以下册尚未完成（不会打包；可回下载中心「只重试未完成册」）');
  else el('najDlProblems').hidden = true;
  el('najDlRetry').hidden = retryableVolumes(task).length === 0;
}

window.__najDlShowTask = showTaskDetail;

export function dlButtonHtml(idx, title) {
  if (!isTauri) return '';
  return `<button class="av-btn dl-row-btn" type="button" data-naj-dl="${idx}"
    title="下载「${esc(title || '')}」的全部册为 PDF（可自定义命名并打包）">下载</button>`;
}
