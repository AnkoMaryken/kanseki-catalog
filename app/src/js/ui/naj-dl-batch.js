// ================================================
// js/ui/naj-dl-batch.js — 「批量下载」（V9.9）
// ================================================
// 用户要求：
//   · 可以**提前批量提交**（例如粘贴一批索书号/ID），先**读取这些书的信息**供核对，
//     核对无误后再排队下载；**下完第一本自动开始第二本**；
//   · 下载失败时右下角弹窗 + 提示音，并可选择 **略过 / 重试 / 暂停 / 取消**；
//   · 全程可**开始 / 暂停 / 继续 / 取消**，进度自动保存（可关软件后续跑）。
//
// 与单本下载共用同一套完整性规则（executeTask：清单冻结 → 逐册页数校验 → 打包门禁），
// 因此批量下也不会出现「下了第 13 本、漏了第 2 本」。
// ================================================
import {
  RUN, invoke, esc, toast, onEngine, runBook, resolveBookPlan, taskDir, saveTask,
  pickFolder, defaultOutRoot, lastOutDir, rememberOutDir, dlAvailable,
  effectiveTemplates, saveTemplates, pumpResumeQueue, drainInsertedQueue,
  pauseRecord, cancelRecord, forgetRunTask, requeueInserted,
} from './naj-dl.js';
import { buildSearchUrl, parseSearchPage } from '../core/naj-parse.js';
import {
  DEFAULT_TEMPLATES, TEMPLATE_PRESETS, parseBatchInput, matchReferenceCandidates, referenceOfItem,
  NAME_TOKENS, applyTemplate, truncateForNas,
} from '../core/naj-dl.js';

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const B = {
  open: false,
  batch: null,
  running: false,
};

function notify(p) {
  if (window.__najDlNotify) window.__najDlNotify(p);
}
function beep(kind) {
  window.__najDlBeep?.(kind);
}

// ---------------------------------------------------------------- 输入解析（parseBatchInput 在 core/naj-dl.js，便于单测）

/**
 * 索书号（請求番号）→ 记录。
 *
 * ⚠️ 实测教训（用户反馈「批量导入索书号导不进来」）：
 *   ① 原站「参照コード」检索（ks0=kw_id）对 子046-0012 / 子０４６－００１２ **都返回 0 件**，
 *      所以不能只靠它；
 *   ② 改用 ks0=kw_all（全部字段）能命中——原站对全角/半角不敏感；
 *   ③ 但命中里会混进**只是「件名番号」相同**的无关记录
 *      （查 子046-0012 时混进「絳帖平」，其請求番号是 子０９６－０００１），
 *      因此必须逐条核对「請求番号」本身，相符才算数；
 *   ④ 相符的可能有多条（簿冊 + 各子册），优先取 /file/ 那一级（它带全部子册）。
 */
async function resolveByReference(code) {
  const search = async (scope, rows) => {
    const url = buildSearchUrl({ keyword: code, scope, rows, page: 1 });
    const resp = await invoke('naj_fetch', { url, timeoutSecs: 60 });
    if (!resp || resp.status >= 400) return [];
    const parsed = parseSearchPage(String(resp.body || ''));
    return parsed.items || [];
  };

  let items = await search('kw_id', 20);          // ① 精确检索（多数时候 0 件）
  if (!items.length) items = await search('kw_all', 50);  // ② 全字段检索
  if (!items.length) throw new Error('未检索到该索书号（可改用 ID 或完整链接）');

  const { exact } = matchReferenceCandidates(items, code);   // ③ 核对請求番号
  const toCand = (it) => ({ id: it.id, title: it.title, url: it.url, code: referenceOfItem(it) || it.refCode || '' });

  if (exact.length === 1) return { one: toCand(exact[0]) };
  if (exact.length > 1) return { candidates: exact.slice(0, 10).map(toCand) };
  if (items.length === 1) return { one: toCand(items[0]) };   // 宽松兜底：唯一命中
  return { candidates: items.slice(0, 10).map(toCand) };      // ④ 多条待用户选择
}

// ---------------------------------------------------------------- 面板

function ensurePanel() {
  if (el('dlbOverlay')) return;
  const d = document.createElement('div');
  d.className = 'dl-overlay';
  d.id = 'dlbOverlay';
  d.hidden = true;
  d.innerHTML = `
    <div class="dl-modal dlb-modal" role="dialog" aria-modal="true">
      <div class="dl-head">
        <h3>批量下载</h3>
        <button class="dl-x" type="button" data-dlb-close title="关闭">×</button>
      </div>
      <div class="dl-body">
        <div class="dlb-grid">
          <div class="dlb-left">
            <label class="dl-field"><span>批量输入（每行一条：# 开头为注释）</span>
              <textarea id="dlbInput" class="dlb-textarea" spellcheck="false"
                placeholder="591091&#10;https://www.digital.archives.go.jp/file/1081945&#10;別０３８－０００１-0002"></textarea></label>
            <div class="dlb-run-hint" id="dlbRunHint" hidden></div>
            <div class="dlb-list-head">
              <b>书目清单</b>
              <span id="dlbCount" class="dl-dim"></span>
              <span class="dlb-list-act">
                <button class="av-btn" type="button" id="dlbCheckAll">全选</button>
                <button class="av-btn" type="button" id="dlbCheckNone">全不选</button>
                <button class="av-btn" type="button" id="dlbClear">清空清单</button>
              </span>
            </div>
            <div class="dlb-list" id="dlbList">
              <div class="dlc-empty">还没有条目。粘贴一批 ID / 链接 / 索书号后点「读取书目信息」。</div>
            </div>
          </div>
          <div class="dlb-side">
            <label class="dl-field"><span>输入类型</span>
              <select id="dlbMode">
                <option value="auto">自动识别（ID / 链接 / 索书号）</option>
                <option value="id">只按 ID·链接</option>
                <option value="ref">只按索书号检索</option>
              </select></label>
            <label class="dl-field"><span>下载位置</span>
              <span class="dl-pathrow">
                <input id="dlbOut" type="text" spellcheck="false">
                <button class="av-btn dl-browse" type="button" id="dlbBrowse">浏览…</button>
              </span></label>
            <div class="dlb-tpl">
              <div class="dl-tpl-head"><span>命名方式</span>
                <select id="dlbPreset" class="dl-preset"></select></div>
              <div class="dlb-tpl-row">
                <label class="dl-field"><span>目录名</span>
                  <span class="dlb-tpl-input"><input id="dlbTplFolder" type="text" spellcheck="false"><button class="dlb-tok-btn" type="button" data-dlb-tok="dlbTplFolder" title="插入字段">▾</button></span></label>
                <label class="dl-field"><span>每册文件名</span>
                  <span class="dlb-tpl-input"><input id="dlbTplFile" type="text" spellcheck="false"><button class="dlb-tok-btn" type="button" data-dlb-tok="dlbTplFile" title="插入字段">▾</button></span></label>
                <label class="dl-field"><span>压缩包名</span>
                  <span class="dlb-tpl-input"><input id="dlbTplZip" type="text" spellcheck="false"><button class="dlb-tok-btn" type="button" data-dlb-tok="dlbTplZip" title="插入字段">▾</button></span></label>
              </div>
              <div class="dlb-tok-menu" id="dlbTokMenu" hidden role="menu" aria-label="可用字段"></div>
              <div class="dlb-preview" id="dlbTplPreview"></div>
            </div>
            <div class="dl-grid2">
              <label class="dl-field"><span>并发册数</span>
                <select id="dlbConc"><option value="1">1（推荐）</option><option value="2">2</option></select></label>
              <label class="dl-field"><span>每册间隔(ms)</span>
                <input id="dlbDelay" type="number" min="0" step="100" value="1200"></label>
            </div>
            <label class="dl-check"><input type="checkbox" id="dlbZip" checked> 每本完成后打包为 ZIP</label>
          </div>
        </div>
      </div>
      <div class="dl-foot">
        <button class="av-btn" type="button" data-dlb-close>关闭</button>
        <button class="av-btn" type="button" id="dlbRestore" hidden>恢复上次队列</button>
        <button class="av-btn" type="button" id="dlbRead">读取书目信息</button>
        <button class="av-btn av-btn-primary" type="button" id="dlbStart">加入队列并开始</button>
      </div>
    </div>`;
  document.body.appendChild(d);

  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-dlb-close]')) closePanel();
  });
  el('dlbBrowse').addEventListener('click', async () => {
    const p = await pickFolder(el('dlbOut').value);
    if (p) { el('dlbOut').value = p; rememberOutDir(p); }
  });
  el('dlbRead').addEventListener('click', readAll);
  el('dlbStart').addEventListener('click', () => startBatch());
  el('dlbCheckAll').addEventListener('click', () => { toggleAll(true); });
  el('dlbCheckNone').addEventListener('click', () => { toggleAll(false); });
  el('dlbClear').addEventListener('click', () => clearBatchList());
  el('dlbList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-dlb-check]');
    if (cb && B.batch) {
      const i = Number(cb.dataset.dlbCheck);
      if (B.batch.items[i]) B.batch.items[i].checked = cb.checked;
      renderList();
      return;
    }
    const sel = e.target.closest('select[data-dlb-cand]');
    if (sel && B.batch) pickCandidate(Number(sel.dataset.dlbCand), Number(sel.value));
  });
  el('dlbPreset').addEventListener('change', () => {
    const p = TEMPLATE_PRESETS.find((x) => x.id === el('dlbPreset').value);
    if (!p) return;
    el('dlbTplFolder').value = p.tpl.folder;
    el('dlbTplFile').value = p.tpl.file;
    el('dlbTplZip').value = p.tpl.zip;
    renderTplPreview();
  });
  // 三套模板各自一个「▾」下拉：点开选字段/分隔符，插入到对应输入框
  d.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dlb-tok]');
    if (btn) { e.stopPropagation(); toggleTokMenu(btn.dataset.dlbTok, btn); return; }
    const item = e.target.closest('[data-dlb-tok-ins]');
    if (item) {
      e.preventDefault();
      e.stopPropagation();
      insertTok(item.dataset.dlbTokIns);
      return;
    }
    if (!e.target.closest('#dlbTokMenu')) closeTokMenu();
  });
  for (const id of ['dlbTplFolder', 'dlbTplFile', 'dlbTplZip']) {
    el(id).addEventListener('input', renderTplPreview);
    // ⚠️ 不在 focus 时改 tokTarget：否则「刚点过输入框 → 再点 ▾」会被判成"同一个按钮又点了一次"而收起菜单
  }
  document.addEventListener('click', () => closeTokMenu());
  // 预设下拉
  el('dlbPreset').innerHTML = '<option value="__custom">自定义</option>'
    + TEMPLATE_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
}

// ---------------------------------------------------------------- 命名字段下拉

let tokTarget = 'dlbTplFile';

function toggleTokMenu(targetId, btn) {
  const menu = el('dlbTokMenu');
  if (!menu) return;
  if (!menu.hidden && tokTarget === targetId) { closeTokMenu(); return; }
  tokTarget = targetId;
  const sep = ['_', '-', '.', ' '];
  menu.innerHTML =
    '<div class="dlb-tok-sec">字段</div><div class="dlb-tok-grid">'
    + NAME_TOKENS.map((t) => `<button type="button" class="dlb-tok" data-dlb-tok-ins="{${esc(t.key)}}" title="${esc(t.desc)}">{${esc(t.key)}}</button>`).join('')
    + '</div><div class="dlb-tok-sec">分隔与补零</div><div class="dlb-tok-grid">'
    + sep.map((s) => `<button type="button" class="dlb-tok" data-dlb-tok-ins="${esc(s)}" title="插入分隔符">${s === ' ' ? '空格' : esc(s)}</button>`).join('')
    + '<button type="button" class="dlb-tok" data-dlb-tok-ins="{册次:03}" title="册次补零到 3 位">{册次:03}</button>'
    + '<button type="button" class="dlb-tok" data-dlb-tok-ins="{册次:02}" title="册次补零到 2 位">{册次:02}</button>'
    + '</div>';
  menu.hidden = false;
  // V1.3（task-17）：把菜单移入被点的「字段 + ▾」容器，CSS 使其贴在该按钮正下方弹出
  // （不再是整个预览区下方的一个公共浮层）
  if (btn) {
    const wrap = btn.closest('.dlb-tpl-input') || btn.parentElement;
    if (wrap && menu.parentElement !== wrap) wrap.appendChild(menu);
    const input = el(targetId);
    if (input) input.focus({ preventScroll: true });
  }
}

function closeTokMenu() {
  const menu = el('dlbTokMenu');
  if (menu && !menu.hidden) menu.hidden = true;
}

function insertTok(tok) {
  const input = el(tokTarget);
  if (!input) return;
  const pos = input.selectionStart == null ? input.value.length : input.selectionStart;
  const end = input.selectionEnd == null ? pos : input.selectionEnd;
  input.value = input.value.slice(0, pos) + tok + input.value.slice(end);
  input.focus();
  input.selectionStart = input.selectionEnd = pos + tok.length;
  renderTplPreview();
}

/** 三套模板的即时预览（用当前批量的第一条作样例） */
function renderTplPreview() {
  const box = el('dlbTplPreview');
  if (!box) return;
  const it = (B.batch && B.batch.items || []).find((x) => x.title) || {};
  const common = {
    书名: it.title || '（书名）',
    分类: '',
    主册ID: it.id || '（主册ID）',
    日期: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    总册数: it.volumes || 1,
  };
  const folder = applyTemplate(el('dlbTplFolder').value, common);
  const zip = applyTemplate(el('dlbTplZip').value, common);
  const fctx = { ...common, 册次: 1, 册名: it.title || '（册名）', 册ID: it.id || '（册ID）' };
  let file = truncateForNas(applyTemplate(el('dlbTplFile').value, fctx));
  if (file.toLowerCase().endsWith('.pdf')) file = file.slice(0, -4);
  box.innerHTML = `<div class="dlb-preview-head">预览（以清单第一条为例）</div>` +
    `<div class="dl-preview-tree">` +
    `<div class="dl-ind1">${esc(folder)}/</div>` +
    `<div class="dl-ind2">${esc(file)}.pdf</div>` +
    `<div class="dl-ind1">${esc(folder)}/${esc(zip)}.zip</div>` +
    `</div>`;
}

function fillPresets() {
  const sel = el('dlbPreset');
  if (!sel) return;
  sel.innerHTML = '<option value="__custom">自定义</option>'
    + TEMPLATE_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
}

export async function openBatchPanel() {
  if (!dlAvailable()) { toast('批量下载仅在 Windows 桌面版可用', 'err'); return; }
  ensurePanel();
  fillPresets();
  if (!B.batch && RUN.batch) B.batch = RUN.batch;    // 引擎里已有队列时直接接管显示
  B.open = true;
  el('dlbOverlay').hidden = false;
  el('dlbOut').value = lastOutDir() || await defaultOutRoot();
  if (!el('dlbTplFile').value) {
    const t = effectiveTemplates();
    el('dlbTplFolder').value = t.folder;
    el('dlbTplFile').value = t.file;
    el('dlbTplZip').value = t.zip;
  }
  if (B.batch) renderList();
  renderTplPreview();
  renderBatchRunState();
  // 有历史队列时给「恢复」入口（正在下载时不需要：队列就在内存里）
  if (!RUN.running) try {
    const dir = (el('dlbOut').value || '').replace(/[\\/]+$/, '');
    const txt = dir ? await invoke('naj_dl_read_text', { path: `${dir}/_批量队列.json` }) : null;
    if (txt) {
      const old = JSON.parse(txt);
      const rest = (old.items || []).filter((i) => i.status !== 'done').length;
      if (rest) {
        const btn = el('dlbRestore');
        btn.hidden = false;
        btn.textContent = `恢复上次队列（剩 ${rest} 本）`;
        btn.onclick = () => { B.batch = old; renderList(); renderBatchRunState(); toast('已恢复上次队列，可继续下载', 'ok'); };
      }
    }
  } catch (_) { /* 无历史即忽略 */ }
}

function closePanel() {
  B.open = false;
  el('dlbOverlay').hidden = true;
}

// ---------------------------------------------------------------- 读取书目信息

function newBatch() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    outDir: '',
    options: null,
    items: [],
    cursor: -1,
  };
}

function currentOptions() {
  const templates = {
    folder: el('dlbTplFolder').value || DEFAULT_TEMPLATES.folder,
    file: el('dlbTplFile').value || DEFAULT_TEMPLATES.file,
    zip: el('dlbTplZip').value || DEFAULT_TEMPLATES.zip,
  };
  saveTemplates(templates);   // 三套模板都记住，下次沿用
  return {
    kind: 'imagePdf',
    concurrency: Number(el('dlbConc').value || 1),
    delayMs: Number(el('dlbDelay').value || 1200),
    outDir: (el('dlbOut').value || '').replace(/[\\/]+$/, ''),
    templates,
    makeZip: !!el('dlbZip').checked,
  };
}

async function readAll() {
  const lines = parseBatchInput(el('dlbInput').value);
  if (!lines.length) { toast('请先粘贴要下载的条目（每行一条）', 'err'); return; }
  const opts = currentOptions();
  if (!opts.outDir) { toast('请先选择下载位置', 'err'); return; }
  const mode = el('dlbMode').value;

  // V2.1（用户第 3 条）：下载进行中/已有清单时，再次读取 = **追加到队尾**，不打断当前下载；
  // 想从头开始可先点「清空清单」。追加的条目会实时出现在清单与下载中心里。
  const appending = !!(B.batch && B.batch.items.length);
  if (!appending) {
    B.batch = newBatch();
    B.batch.outDir = opts.outDir;
    B.batch.options = opts;
  } else if (!RUN.running) {
    // 没在下载时可以更新输出位置/参数；下载中不改（已开始的任务沿用原参数）
    B.batch.outDir = opts.outDir;
    B.batch.options = opts;
  }
  const base = B.batch.items.length;
  const added = lines.map((l, i) => ({
    no: base + i + 1, input: l.raw, mode: mode === 'auto' ? l.mode : mode, id: l.id, title: '',
    levels: 0, volumes: 0, status: 'pending', error: '', checked: true,
  }));
  B.batch.items.push(...added);
  renderList();

  for (const it of added) {
    it.status = 'resolving';
    renderList();
    try {
      await applyResolved(it);
    } catch (e) {
      it.status = 'failed';
      it.error = (e && e.message) ? e.message : String(e);
    }
    renderList();
    await sleep(120);
  }
  toast(appending
    ? `已追加 ${added.length} 条到队列（共 ${B.batch.items.length} 条），当前下载不受影响`
    : '书目信息已读取，请核对后开始下载', 'ok');
}

/** 清空清单（下载进行中不允许，避免把正在跑的队列拆掉） */
function clearBatchList() {
  if (RUN.running) { toast('下载进行中：不能清空清单（可先暂停/取消，或等本批结束）', 'warn'); return; }
  B.batch = null;
  renderList();
  toast('清单已清空', 'ok');
}

/** 面板里提示「下载进行中，可继续追加」 */
function renderBatchRunState() {
  const hint = el('dlbRunHint');
  const startBtn = el('dlbStart');
  const running = !!RUN.running;
  if (hint) {
    hint.hidden = !running;
    hint.textContent = running ? '下载进行中：再次「读取书目信息」会把新书目追加到队尾，不打断当前下载。' : '';
  }
  if (startBtn) startBtn.textContent = running ? '追加到队列' : '加入队列并开始';
  if (el('dlbClear')) el('dlbClear').disabled = running;
}

/** 解析一条（索书号或 ID）→ 书名、册数；索书号命中多条时给出候选供选择 */
async function applyResolved(it) {
  let rec = { id: it.id, title: '', url: '' };
  if (it.mode === 'ref' || !it.id) {
    const r = await resolveByReference(it.input);
    if (r.candidates && r.candidates.length) {
      it.candidates = r.candidates;
      it.candIdx = 0;
      rec = r.candidates[0];
    } else {
      it.candidates = null;
      rec = r.one;
    }
  } else {
    it.candidates = null;
  }
  const plan = await resolveBookPlan({ id: rec.id, title: rec.title, url: rec.url });
  it.id = rec.id;
  it.title = plan.bookTitle || rec.title || rec.id;
  it.volumes = plan.volumes.length;
  it.status = it.candidates ? 'choose' : 'ready';
  it.error = '';
}

/** 用户在候选里换了一条 */
async function pickCandidate(idx, candIdx) {
  const it = B.batch && B.batch.items[idx];
  if (!it || !it.candidates || !it.candidates[candIdx]) return;
  it.candIdx = candIdx;
  const rec = it.candidates[candIdx];
  it.status = 'resolving';
  renderList();
  try {
    const plan = await resolveBookPlan({ id: rec.id, title: rec.title, url: rec.url });
    it.id = rec.id;
    it.title = plan.bookTitle || rec.title || rec.id;
    it.volumes = plan.volumes.length;
    it.status = 'choose';
    it.error = '';
  } catch (e) {
    it.status = 'failed';
    it.error = (e && e.message) ? e.message : String(e);
  }
  renderList();
}

function toggleAll(v) {
  if (!B.batch) return;
  for (const it of B.batch.items) it.checked = v;
  renderList();
}

function renderList() {
  const box = el('dlbList');
  if (!box) return;
  if (!B.batch || !B.batch.items.length) {
    box.innerHTML = '<div class="dlc-empty">还没有条目。粘贴一批 ID / 链接 / 索书号后点「读取书目信息」。</div>';
    el('dlbCount').textContent = '';
    return;
  }
  const map = {
    pending: ['待读取', 'dl-b-idle'],
    resolving: ['读取中', 'dl-b-run'],
    ready: ['已核对', 'dl-b-idle'],
    choose: ['待选候选', 'dl-b-warn'],
    downloading: ['下载中', 'dl-b-run'],
    paused: ['已暂停', 'dl-b-warn'],
    done: ['完成', 'dl-b-ok'],
    skipped: ['已略过', 'dl-b-warn'],
    failed: ['失败', 'dl-b-err'],
  };
  box.innerHTML = B.batch.items.map((it, i) => {
    const [tx, cls] = map[it.status] || ['—', 'dl-b-idle'];
    const on = i === B.batch.cursor;
    const pri = it.priority ? '<span class="dlb-pri" title="已设为下一本优先下载">优先</span>' : '';
    const titleCell = (it.candidates && it.candidates.length)
      ? `<select class="dlb-cand" data-dlb-cand="${i}" title="该索书号命中多条，请选择正确的一条">
           ${it.candidates.map((c, j) => `<option value="${j}" ${j === (it.candIdx || 0) ? 'selected' : ''}>${esc((c.code ? c.code + ' ' : '') + (c.title || c.id))}</option>`).join('')}
         </select>`
      : `<span class="dlb-title" title="${esc(it.title || it.input)}">${esc(it.title || it.input)}</span>`;
    return `<div class="dlb-item ${on ? 'on' : ''}">
      <label class="dlb-check"><input type="checkbox" data-dlb-check="${i}" ${it.checked ? 'checked' : ''}></label>
      <span class="dlb-no">${String(i + 1).padStart(2, '0')}</span>
      ${pri}${titleCell}
      <span class="dlb-vols dl-dim">${it.volumes ? `${it.volumes} 册` : ''}</span>
      <span class="dlb-input dl-dim" title="${esc(it.input)}">${esc(it.input)}</span>
      <span class="dl-badge ${cls}">${esc(tx)}</span>
      ${it.error ? `<span class="dl-err" title="${esc(it.error)}">${esc(it.error.slice(0, 48))}</span>` : ''}
    </div>`;
  }).join('');
  const ready = B.batch.items.filter((i) => i.status === 'ready').length;
  const done = B.batch.items.filter((i) => i.status === 'done').length;
  const paused = B.batch.items.filter((i) => i.status === 'paused').length;
  const left = B.batch.items.filter((i) => i.checked && !['done', 'skipped'].includes(i.status)).length;
  el('dlbCount').textContent = `共 ${B.batch.items.length} 条 · 已核对 ${ready} · 待下载 ${left} · 完成 ${done}${paused ? ` · 暂停 ${paused}` : ''}`;
}

// ---------------------------------------------------------------- 队列执行

let decisionWaiter = null;

function waitDecision() {
  return new Promise((resolve) => {
    RUN.decided = null;
    decisionWaiter = setInterval(() => {
      if (RUN.decided) {
        clearInterval(decisionWaiter);
        decisionWaiter = null;
        const d = RUN.decided;
        RUN.decided = null;
        resolve(d);
      }
    }, 200);
  });
}

async function saveBatch(batch) {
  try {
    const dir = (batch.outDir || '').replace(/[\\/]+$/, '');
    if (!dir) return;
    await invoke('naj_dl_mkdir', { path: dir });
    // 运行期字段（优先抢占状态、已处理集合）不进队列文件
    const { preempted, preemptPriorityItem, _processed, ...rest } = batch;
    const slim = {
      ...rest,
      options: batch.options,
      items: batch.items.map((i) => ({ ...i })),
    };
    await invoke('naj_dl_write_text', { path: `${dir}/_批量队列.json`, text: JSON.stringify(slim, null, 2) });
  } catch (_) { /* 存盘失败不影响下载 */ }
}

async function waitWhilePausedOrCancelled() {
  while (RUN.paused && !RUN.cancelled) await sleep(250);
  return !RUN.cancelled;
}

// ---------------------------------------------------------------- 队列调度（动态追加 / 优先 / 插入单本）
const BATCH_TERMINAL = new Set(['done', 'skipped']);

/** 这一条现在能不能开始下载（下载中追加的条目要等它读完书目信息） */
function selectableItem(it) {
  if (!it || !it.checked) return false;
  if (BATCH_TERMINAL.has(it.status) || it.status === 'paused') return false;
  if (it.status === 'resolving') return false;
  if (it.status === 'pending' && !it.id) return false;
  return true;
}

/** 取下一条要下载的书：优先队列 → 清单顺序；下载中新追加的条目也会被动态扫到 */
function nextBatchItem(processed) {
  const batch = B.batch;
  if (!batch) return null;
  if (Array.isArray(batch.priority) && batch.priority.length) {
    while (batch.priority.length) {
      const cand = batch.priority.shift();
      if (!cand) continue;
      cand.priority = false;
      if (processed.has(cand)) continue;
      if (!selectableItem(cand)) continue;
      return cand;
    }
  }
  for (const it of batch.items) {
    if (processed.has(it)) continue;
    if (!selectableItem(it)) continue;
    return it;
  }
  return null;
}

/** 下载中心：把某一本设为「下一本优先下载」（批量进行中可用）
 *  V2.2：**即时抢占** —— 若批量正在下载另一本，先把它按本暂停（当前册下完即停、状态「已暂停」），
 *  马上开始优先这本；优先这本处理完（完成/失败/暂停/取消）后自动恢复被抢占的那一本（回到队首）。 */
export function prioritizeBatchItem(item) {
  const batch = B.batch || RUN.batch;      // 兼容：面板未打开时 RUN.batch 就是当前队列
  if (!item || !batch) return false;
  if (item.status === 'paused') return 'paused';      // 暂停的书交给引擎恢复队列（放回队尾）
  if (!selectableItem(item)) return false;
  batch.priority = Array.isArray(batch.priority) ? batch.priority : [];
  if (!batch.priority.includes(item)) batch.priority.push(item);
  item.priority = true;
  // ② 即时抢占：暂停当前正在下载的那一本，记下来等优先这本处理完再自动恢复
  const cur = RUN.currentRec;
  let preempted = false;
  if (RUN.running && cur && cur.task && cur.task !== (item.rec && item.rec.task) && cur !== item.rec) {
    // 当前这本可能刚开跑、batch item 还没来得及挂 rec → 按 book.id 找到对应的队列条目
    const curBookId = cur.task.book && cur.task.book.id;
    const curItem = (batch.items || []).find((x) => x.rec === cur)
      || (batch.items || []).find((x) => curBookId != null && String(x.id) === String(curBookId))
      || null;
    if (!batch.preempted || batch.preempted.rec !== cur) {
      batch.preempted = { item: curItem, rec: cur };
      batch.preemptPriorityItem = item;
      try { pauseRecord(cur); } catch (_) { /* 忽略 */ }
      preempted = true;
      toast(`已暂停当前这本（${cur.title || '当前任务'}），优先开始：${item.title || item.input}`, 'warn');
    }
  }
  if (!preempted) toast(`已设为下一本优先下载：${item.title || item.input}`, 'ok');
  renderList();
  return 'queued';
}

/** 优先这本处理完后，把被抢占的那一本恢复：待下载书放回队首；插入单本放回插入队列最前 */
function resumePreemptedBatch(processed) {
  const batch = B.batch;
  if (!batch || !batch.preempted) return false;
  const set = processed || batch._processed;
  const pre = batch.preempted;
  batch.preempted = null;
  batch.preemptPriorityItem = null;
  if (pre.item) {
    if (set && set.delete) set.delete(pre.item);
    pre.item.status = 'ready';
    pre.item.priority = true;
    pre.item._resumeRec = pre.rec || null;    // 批量循环据此复用原记录（不产生重复行）
    batch.priority = Array.isArray(batch.priority) ? batch.priority : [];
    if (!batch.priority.includes(pre.item)) batch.priority.unshift(pre.item);
    if (pre.rec && pre.rec.task) {
      pre.rec.task._paused = false;
      pre.rec.status = 'queued';       // 显示「队列中」，等批量循环复用原任务继续
    }
    renderList();
    return true;
  }
  if (pre.rec && pre.rec.task) {
    pre.rec.task._paused = false;
    try { requeueInserted(pre.rec); } catch (_) { /* 忽略 */ }
    return true;
  }
  return false;
}

/** 每本「取消当前」：从批量队列删除这一本（未开始/下载中/已暂停都可删），并从下载中心列表移出 */
export function removeBatchItem(item) {
  const batch = B.batch || RUN.batch;
  if (!item) return false;
  if (batch) {
    const i = (batch.items || []).indexOf(item);
    if (i >= 0) batch.items.splice(i, 1);
    if (Array.isArray(batch.priority)) {
      const j = batch.priority.indexOf(item);
      if (j >= 0) batch.priority.splice(j, 1);
    }
    if (batch.preempted && batch.preempted.item === item) batch.preempted = null;
    if (batch.preemptPriorityItem === item) {
      batch.preemptPriorityItem = null;
      // 被取消的恰好是「优先这本」→ 立刻恢复之前被抢占的那一本
      if (batch.preempted) resumePreemptedBatch();
    }
  }
  if (item.rec) {
    try { cancelRecord(item.rec); } catch (_) { /* 忽略 */ }
    try { forgetRunTask(item.rec); } catch (_) { /* 忽略 */ }
  }
  renderList();
  if (batch) { try { saveBatch(batch); } catch (_) { /* 忽略 */ } }
  return true;
}

/** 从下载中心启动队列（引擎空闲时） */
export function startBatchIfIdle() {
  if (RUN.running) return false;
  if (!B.batch && RUN.batch) B.batch = RUN.batch;
  startBatch(true);
  return true;
}

async function startBatch(fromView) {
  if (!B.batch || !B.batch.items.length) { toast('请先「读取书目信息」', 'err'); return; }
  if (RUN.running) {
    // V2.1：下载进行中再次点「加入队列」= 只是追加（清单已实时追加，不重置队列）
    if (RUN.batch === B.batch) {
      toast('已追加到队列：当前下载不受影响，新条目会依次下载', 'ok');
      closePanel();
    } else {
      toast('已有其它下载任务在进行，请先在「下载中心」查看/暂停', 'warn');
    }
    return;
  }
  // 从下载中心「开始队列」进入时沿用队列已保存的参数；从面板进入时以面板当前值为准
  const opts = (fromView && B.batch.options && B.batch.outDir) ? B.batch.options : currentOptions();
  if (!opts.outDir) { toast('请先选择下载位置', 'err'); return; }
  B.batch.options = opts;
  B.batch.outDir = opts.outDir;
  const todo = B.batch.items.filter((i) => i.checked && i.status !== 'done' && i.status !== 'skipped');
  if (!todo.length) { toast('没有勾选任何待下载条目', 'err'); return; }

  RUN.mode = 'batch';
  RUN.batch = B.batch;
  RUN.running = true;
  RUN.paused = false;
  RUN.cancelled = false;
  // 收起批量面板：下载过程中的进度与「失败决策」都在下载中心抽屉里，
  // 面板若留在最上层会挡住抽屉底部的暂停/取消按钮（实测踩过）。
  closePanel();
  window.__najDlOpenDrawer?.();
  notify({ kind: 'warn', title: '批量下载已开始', text: `共 ${todo.length} 本，将逐本下载`, dir: opts.outDir, sticky: false });

  let doneCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let pausedCount = 0;

  // V2.1：动态队列（下载中可多次追加 / 设为优先 / 插入单本），不再用固定 for 下标
  const processed = new Set();
  B.batch._processed = processed;      // 供「优先抢占自动恢复」在循环外也能定位已处理项
  while (!RUN.cancelled) {
    if (!(await waitWhilePausedOrCancelled())) break;
    // V2.2 第 4 条：插入的单本默认排到**队尾** —— 这里不再穿插，等整批跑完后统一执行（见循环后 drain）
    const it = nextBatchItem(processed);
    if (!it) break;
    processed.add(it);
    B.batch.cursor = B.batch.items.indexOf(it);
    renderList();
    await saveBatch(B.batch);

    let attempt = 0;
    // V2.2：被「优先下载」抢占后自动恢复的那一本，复用原任务/原下载记录（不产生重复记录、不重下已完成册）
    const reuse = (it._resumeRec && it._resumeRec.task) ? { task: it._resumeRec.task, rec: it._resumeRec } : null;
    if (reuse) delete it._resumeRec;
    for (;;) {
      it.status = 'downloading';
      renderList();
      let res;
      try {
        res = await runBook({ id: it.id, title: it.title, url: it.url }, {
          kind: opts.kind,
          concurrency: opts.concurrency,
          delayMs: opts.delayMs,
          outDir: opts.outDir,
          templates: opts.templates,
        }, reuse);
      } catch (e) {
        res = { ok: false, error: (e && e.message) ? e.message : String(e), audit: { problems: [String(e)] } };
      }
      if (res && res.taskCancelled) {
        // V2.2 第 3 条「取消当前」：这一本已在取消时移出队列/记录；这里兜底再清一次，继续下一本
        if (res.rec) { try { forgetRunTask(res.rec); } catch (_) { /* 忽略 */ } }
        const k = B.batch.items.indexOf(it);
        if (k >= 0) B.batch.items.splice(k, 1);
        if (B.batch.preempted && B.batch.preempted.item === it) B.batch.preempted = null;
        if (B.batch.preemptPriorityItem === it) { B.batch.preemptPriorityItem = null; resumePreemptedBatch(processed); }
        renderList();
        await saveBatch(B.batch);
        break;
      }
      if (res && res.paused) {
        // V2.0 按本暂停：这一本在当前册下完后停下 → 记 paused，队列直接继续下一本
        // （恢复由「下载中心」负责：引擎空闲时重新入队，续传 + 审计 + 打包规则不变）
        it.status = 'paused';
        it.error = '';
        if (res.rec) it.rec = res.rec;
        pausedCount++;
        renderList();
        await saveBatch(B.batch);
        notify({
          kind: 'warn',
          title: '已暂停这一本',
          text: `${it.title}：已暂停，队列继续下载其它书；可在「下载中心」点「继续」恢复`,
          dir: res.dir || opts.outDir,
        });
        break;
      }
      if (res && res.rec) it.rec = res.rec;
      if (res.ok) {
        it.status = 'done';
        it.stats = res.audit ? res.audit.stats : null;
        doneCount++;
        renderList();
        notify({
          kind: 'ok',
          title: '这一本下载完成',
          text: `${it.title}：${res.audit ? res.audit.stats.done : '?'} 册 / ${res.audit ? res.audit.stats.pages : '?'} 页`,
          dir: res.dir || opts.outDir,
        });
        break;
      }

      // 失败：右下角弹窗 + 提示音，并等用户决定
      it.status = 'failed';
      it.error = res.error || '下载未完成';
      failedCount++;
      renderList();
      B.batch.awaitingDecision = it;
      notify({
        kind: 'error',
        title: '这一本下载失败',
        text: `${it.title}：${it.error}`,
        dir: res.dir || opts.outDir,
      });
      window.__najDlOpenDrawer?.();
      const d = await waitDecision();
      B.batch.awaitingDecision = null;
      renderList();

      if (d === 'retry') { attempt++; it.status = 'downloading'; continue; }
      if (d === 'skip') { it.status = 'skipped'; skippedCount++; break; }
      if (d === 'pause') {
        it.status = 'pending';
        RUN.paused = true;
        await waitWhilePausedOrCancelled();
        if (RUN.cancelled) break;
        continue; // 继续时重试这一本
      }
      RUN.cancelled = true;
      break;
    }
    await saveBatch(B.batch);
    renderList();
    // V2.2 第 2 条：优先这本处理完（完成/失败/暂停/取消）→ 自动恢复被抢占的那一本（放回队首）
    if (B.batch.preemptPriorityItem === it) resumePreemptedBatch(processed);
    else if (B.batch.preempted && B.batch.preemptPriorityItem && (B.batch.items || []).indexOf(B.batch.preemptPriorityItem) < 0) {
      resumePreemptedBatch(processed);
    }
    if (RUN.cancelled) break;
    await sleep(Math.max(0, Number(opts.delayMs) || 0));
  }

  // 队列跑完（或取消）后，若还有「插入的单本」没跑，接着跑完（取消时 drain 内部会立刻退出）
  try { await drainInsertedQueue(); } catch (_) { /* 忽略 */ }

  RUN.running = false;
  RUN.batch = B.batch;
  B.batch.cursor = -1;
  renderList();
  await saveBatch(B.batch);
  const pausedLeft = B.batch.items.filter((i) => i.status === 'paused').length;
  const skippedTotal = B.batch.items.filter((i) => i.status === 'skipped').length;
  const failedTotal = B.batch.items.filter((i) => i.status === 'failed').length;
  // 全部成功：清掉队列文件，输出目录里只留各书的 PDF/压缩包（用户要求「只留 PDF」）
  const allOk = B.batch.items.every((i) => i.status === 'done' || i.status === 'skipped');
  if (allOk && !RUN.cancelled) {
    try { await invoke('naj_dl_remove', { path: `${(opts.outDir || '').replace(/[\\/]+$/, '')}/_批量队列.json` }); } catch (_) { /* 忽略 */ }
  }
  const summary = `完成 ${doneCount} · 暂停 ${pausedLeft} · 略过 ${skippedTotal} · 失败 ${failedTotal}`;
  notify({
    kind: RUN.cancelled ? 'warn' : (failedTotal ? 'error' : (pausedLeft ? 'warn' : 'ok')),
    title: RUN.cancelled ? '批量下载已取消' : (pausedLeft ? '批量下载暂告一段落' : '批量下载结束'),
    text: `共 ${B.batch.items.length} 本：${summary}${pausedLeft ? '（暂停的书可在「下载中心」继续）' : ''}（队列与逐本进度已存盘，可随时恢复续跑）`,
    dir: opts.outDir,
    sticky: !!(failedTotal || pausedLeft),
  });
  // 批量结束后立刻尝试启动「排队恢复」的书（若用户已经在下载中心点了继续）
  try { pumpResumeQueue(); } catch (_) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 初始化

/** 在「国立公文书馆」检索条里插入「批量下载」入口 */
export function initBatchUi() {
  // 显示件数：选中 20/50/100/200 后立即按新件数重查一次（原逻辑只改标签，用户觉得“没生效”）。
  // 这段不依赖桌面版，网页版也要生效，所以放在 dlAvailable 判断之前。
  const rowsSel = el('najRows');
  if (rowsSel && rowsSel.dataset.rowsBound !== '1') {
    rowsSel.dataset.rowsBound = '1';
    rowsSel.addEventListener('change', () => {
      const kw = (el('najKw')?.value || '').trim();
      if (kw) el('najSearchBtn')?.click();
    });
  }
  if (!dlAvailable()) return;
  const form = el('najForm');
  if (!form || el('najBatchBtn')) return;
  const btn = document.createElement('button');
  btn.className = 'av-btn';
  btn.id = 'najBatchBtn';
  btn.type = 'button';
  btn.textContent = '批量下载';
  btn.title = '一次提交多本（ID / 链接 / 索书号），先核对书目再排队下载';
  const anchor = el('najReset');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
  else form.appendChild(btn);
  btn.addEventListener('click', () => openBatchPanel());

  // 引擎事件：队列条目状态变化时刷新面板与抽屉
  onEngine((kind) => {
    if (!B.open) return;
    if (kind === 'bookStart' || kind === 'bookEnd' || kind === 'progress') renderList();
  });
}

export function batchState() {
  return B.batch;
}

// 供自动化测试构造批量面板（浏览器/非 Tauri 环境无法从入口打开批量下载）
if (typeof window !== 'undefined') {
  window.__najBatchTest = {
    ensurePanel, renderTplPreview, toggleTokMenu,
    nextBatchItem, resumePreemptedBatch, prioritizeBatchItem, removeBatchItem, saveBatch,
  };
}
