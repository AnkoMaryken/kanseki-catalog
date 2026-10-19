// ================================================
// js/ui/workbench.js — 工作台（V3 正式版 1.0）
// ================================================
// 内容：
//   · 5 个快捷入口卡（纪年 / 古籍类目 / 汉籍检索 / 日本国立公文书馆 / 编目记录）
//   · 每日推荐（按「一年中的第几天」固定轮换，同一天所有人看到同一条）
//   · 今日概览（编目记录数 / 下载任务数 / 检索历史数——全部取本机真实数据）
//   · 最近更新（读 pages/changelog.html 的前三条，不写死版本号）
//   · 5 个资料磁贴（细则查阅 / 分类表 / 工作手册 / 使用介绍 / 更新日志）
//
// 说明：每日推荐的引文均给出可核查书名与篇目；「编目小识」为本工具自撰的
//       操作提示，不冒充古人原话，以免误引。
// ================================================
import { openDB, idbCount, STORE_RECORDS, STORE_HISTORY } from '../core/sync/store-indexeddb.js';
import { listRunTasks } from './naj-dl.js';

const el = (id) => document.getElementById(id);

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
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 2.8v4M16 2.8v4"/></svg>',
  tree: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="6" height="5" rx="1.3"/><rect x="14.5" y="15.5" width="6" height="5" rx="1.3"/><path d="M6.5 8.5v6a2 2 0 0 0 2 2h6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M5 8l7-5 7 5"/><rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M9 20v-5h6v5"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5h17M5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11"/><path d="M4.5 3.5h15v4h-15z"/><path d="M9.5 12h5"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h6M9 11h2"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
};

// ---------------------------------------------------------------- 每日推荐池
// type='quote' 为古籍引文（附出处）；type='tip' 为编目小识（本工具自撰，不署古人）。
const DAILY = [
  { type: 'quote', text: '學而不思則罔，思而不學則殆。', src: '《論語·為政》', note: '著錄一部書之前，先想清楚它屬於哪一類、據什麼定名；查得快不等於錄得對。' },
  { type: 'tip', title: '卷端題名優先', body: '書名著錄以正文卷端所題為準。若卷端題名不足以反映內容（如各卷題名不一），可酌取卷末、內封、牌記、目錄、序文、凡例、版心或題簽所題，並在附註項說明依據。', src: '編目細則 · 書名著錄' },
  { type: 'quote', text: '博學之，審問之，慎思之，明辨之，篤行之。', src: '《禮記·中庸》', note: '編目五步：查目錄、問版本、思體例、辨異同、然後落筆。' },
  { type: 'tip', title: '「日本藏本」不等於「日本刻本」', body: '內閣文庫、靜嘉堂等處所藏漢籍，多為中國刻本東傳或日本覆刻、活字本。著錄時須分清「藏地」與「版本」，不可因藏於日本便寫成和刻本。', src: '編目小識' },
  { type: 'quote', text: '舊書不厭百回讀，熟讀深思子自知。', src: '蘇軾《送安惇秀才失解西歸》', note: '同一部書隔一段時間再核一遍，常能發現第一次漏掉的牌記或避諱字。' },
  { type: 'tip', title: '牌記是版本的硬證據', body: '牌記（又稱木記）多位於卷末或書末，常載刻書年月、刻書者堂號。遇到「序跋可偽、牌記難移」的情況，先看牌記，再參諱字、行款、紙張。', src: '編目小識' },
  { type: 'quote', text: '紙上得來終覺淺，絕知此事要躬行。', src: '陸游《冬夜讀書示子聿》', note: '目錄數據可以參考，卷數、行款、版式仍需據書影或原書核對。' },
  { type: 'tip', title: '避諱字可作斷代旁證', body: '宋刻避宋諱、清刻避清諱。若見「玄」缺末筆、「弘」省筆，須留意其時代；但翻刻、覆刻亦沿舊諱，故避諱只能作旁證，不能單獨定版本。', src: '編目小識' },
  { type: 'quote', text: '盡信書，則不如無書。', src: '《孟子·盡心下》', note: '舊目錄的書名、卷數、作者常有沿誤；遇到前後矛盾，回到卷端與牌記。' },
  { type: 'tip', title: '叢書零種要單獨著錄', body: '叢書中的一種（零種）若單獨流傳，應按單行本著錄，並在附註中說明出自何叢書、第幾集；不要把叢書總名當作書名。', src: '編目小識' },
  { type: 'quote', text: '奇文共欣賞，疑義相與析。', src: '陶淵明《移居》', note: '疑難條目先記下證據鏈，再與他人核對；爭議點寫進附註，比硬下結論可靠。' },
  { type: 'tip', title: '紀年換算留心改元', body: '同一年號內改元時，一年可能跨兩個年號（如「萬曆四十八年」八月以後為泰昌元年）。查公曆對照時，注意年號起訖與農曆正月的界線。', src: '編目小識' },
  { type: 'quote', text: '工欲善其事，必先利其器。', src: '《論語·衛靈公》', note: '把常用的類目、紀年與檢索入口放在手邊，編目時少切換一次窗口，就少一次錄錯的機會。' },
  { type: 'tip', title: '「三態」判定要留依據', body: '與《中國古籍總目》類目比對時，完全相同／可對應／無對應三態都要能說明理由：完全相同指類目名稱與層級一致；可對應指上位類或鄰近類可涵蓋；無對應則須新增或歸入「其他」。', src: '編目小識' },
  { type: 'quote', text: '不積跬步，無以至千里。', src: '《荀子·勸學》', note: '每天錄幾條、核幾條，比一次趕工更不容易出錯。' },
];

function dayOfYear(d) {
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

// ---------------------------------------------------------------- 数据

async function readStats() {
  const out = { records: 0, history: 0, tasks: 0, running: 0 };
  try {
    const db = await openDB();
    out.records = await idbCount(db, STORE_RECORDS);
    out.history = await idbCount(db, STORE_HISTORY);
  } catch (_) { /* IndexedDB 不可用时保持 0 */ }
  try {
    const tasks = listRunTasks() || [];
    out.tasks = tasks.length;
    out.running = tasks.filter((t) => t.status === 'running').length;
  } catch (_) { /* 引擎未就绪 */ }
  return out;
}

async function readRecentVersions() {
  try {
    const resp = await fetch('pages/changelog.html', { cache: 'no-store' });
    if (!resp.ok) return [];
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('.cl-entry')].slice(0, 3).map((e) => ({
      ver: ((e.querySelector('.cl-ver') || {}).textContent || '').trim(),
      date: ((e.querySelector('.cl-date') || {}).textContent || '').trim(),
    })).filter((v) => v.ver);
  } catch (_) { return []; }
}

// ---------------------------------------------------------------- 渲染

function quickCards() {
  return [
    ['#/query', IC.cal, '纪年查询', '公历年 → 朝代年号'],
    ['#/kanseki', IC.tree, '古籍类目', '书名 → 总目分类'],
    ['#/kansekidb', IC.search, '汉籍检索（日本）', '全國漢籍データベース'],
    ['#/najdb', IC.archive, '日本国立公文书馆', '内閣文庫 · 可下载'],
    ['#/records', IC.pen, '编目记录', '仅本机 · 未上线'],
  ].map(([hash, ic, t, s]) => `
    <button class="wb-qcard" type="button" data-go="${hash}">
      <span class="qi">${ic}</span><b>${esc(t)}</b><span>${esc(s)}</span>
    </button>`).join('');
}

function tiles() {
  return [
    ['#/catalog?tab=0', IC.doc, '细则查阅', '2023.09 / 2025.10'],
    ['#/catalog?tab=1', IC.grid, '分类表查询', '六部 66 类'],
    ['#/catalog?tab=2', IC.book, '工作手册', 'PDF 内嵌预览'],
    ['#/guide', IC.info, '使用介绍', '功能与操作'],
    ['#/changelog', IC.clock, '更新日志', '版本沿革'],
  ].map(([hash, ic, t, s]) => `
    <button class="wb-tile" type="button" data-go="${hash}">
      <span class="ti">${ic}</span><b>${esc(t)}</b><span>${esc(s)}</span>
    </button>`).join('');
}

function dailyHtml() {
  const now = new Date();
  const item = DAILY[dayOfYear(now) % DAILY.length];
  const date = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  if (item.type === 'quote') {
    return `
      <div class="wb-card-h"><b>每日推荐</b><span>${date}</span></div>
      <blockquote class="wb-quote">「${esc(item.text)}」</blockquote>
      <div class="wb-quote-src">—— ${esc(item.src)}</div>
      <div class="wb-quote-note">${esc(item.note || '')}</div>`;
  }
  return `
    <div class="wb-card-h"><b>每日推荐</b><span>${date}</span></div>
    <div class="wb-story-title">${esc(item.title)}</div>
    <div class="wb-story-body">${esc(item.body)}</div>
    <div class="wb-quote-src" style="margin-top:12px">${esc(item.src)}</div>`;
}

export async function initWorkbench() {
  const root = el('wbRoot');
  if (!root) return;

  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const [stats, recent] = await Promise.all([readStats(), readRecentVersions()]);

  root.innerHTML = `
    <div class="wb-head">
      <div>
        <h1>工作台</h1>
        <p>今日推荐与常用入口 · 数据仅存本机</p>
      </div>
      <span class="wb-time">${hhmm}</span>
    </div>

    <div class="wb-quick">${quickCards()}</div>

    <div class="wb-split">
      <div class="wb-card" id="wbDaily">${dailyHtml()}</div>
      <div class="wb-card">
        <div class="wb-card-h"><b>今日概览</b><span>本机</span></div>
        <div class="wb-stats">
          <div class="wb-stat"><b>${stats.records}</b><span>编目记录</span></div>
          <div class="wb-stat"><b>${stats.running}</b><span>下载中</span></div>
          <div class="wb-stat"><b>${stats.history}</b><span>检索历史</span></div>
        </div>
        <div class="wb-card-h" style="margin-bottom:8px"><b style="font-size:13px">最近更新</b></div>
        <div class="wb-recent">
          ${(recent.length ? recent : [{ ver: '—', date: '' }]).map((v) => (
            `<div>${esc(v.ver)} <span class="ver">${esc(v.date)}</span></div>`
          )).join('')}
        </div>
      </div>
    </div>

    <div class="wb-card-h" style="padding:2px 2px 0"><b>编目资料</b></div>
    <div class="wb-tiles">${tiles()}</div>`;

  // 事件委托：快捷卡与磁贴都只带 data-go
  if (!root.__wbBound) {
    root.__wbBound = true;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-go]');
      if (b) go(b.dataset.go);
    });
  }
}
