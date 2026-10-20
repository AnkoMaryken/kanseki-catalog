// ================================================
// scripts/build.mjs — 静态构建（零依赖拷贝）
// 产出 app/dist/ 供 Tauri 消费（frontendDist）
// ================================================
// 目录映射：
//   src/index.html         -> dist/index.html（SPA 唯一入口）
//   src/css/*              -> dist/css/*
//   src/js/**/*.mjs|*.js   -> dist/js/**/*（ES 模块，浏览器直接加载）
//   src/assets/*           -> dist/assets/*（PDF、图标等）
//   ../（仓库根）HTML/JS    -> dist/pages/*（静态站，构建时实时拷贝）
//   ../docs/manual.pdf     -> dist/docs/ 与 dist/pages/docs/（工作手册）
// ================================================
import { mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const SRC = join(APP_ROOT, 'src');
const DIST = join(APP_ROOT, 'dist');
const ROOT = resolve(APP_ROOT, '..'); // 仓库根（docs/manual.pdf 所在）

// 拷贝目录（可排除顶层子项，如已废弃的 src/pages）
// 注意：不能用 cpSync —— 目标文件已存在时（如重复构建、Tauri 触发构建）
// cpSync 会先 unlink 再写，在 WorkBuddy 的 fs shim 下会抛
// `Error: , The operation completed successfully`（errno 0）导致构建中断。
// 改用 readFileSync + writeFileSync 直接覆盖，无 unlink 步骤。
function copyDir(src, dest, excludeTop = new Set()) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (excludeTop.has(entry.name)) continue;
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

function copyFileIfExists(src, dest) {
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    // 同上：read+write 而非 cpSync，避免覆盖时报 unlink shim 错误
    writeFileSync(dest, readFileSync(src));
  }
}

// ================================================
// 静态站页面同步（V0.6.2）
// -------------------------------------------------
// 历史坑：src/pages/ 曾是 v6.0 时期的一次性快照，落后根目录 7 个版本，
// 导致桌面版跑旧内容（缺 V8.0 周边政权 / V8.2 移动端 / V8.3 卡片网格，
// 且缺 overlay.js / mobile-nav.js / user-state.js 三个脚本）。
// 现改为构建时从仓库根实时拷贝，副本不再维护，永不过期。
// 注意：源文件零改动，APP 专属差异全部由下方 injectEmbedCss 在 dist 阶段注入。
// ================================================
const PAGES_DIR = join(DIST, 'pages');

// 静态站页面（iframe 承载）
const SITE_PAGES = ['index.html', 'catalog.html', 'kanseki.html', 'embed.html', 'guide.html', 'changelog.html', 'settings.html', 'seal.html'];
// 账号体系页面（页内登录/注册链接指向，缺失会 404）
const ACCOUNT_PAGES = ['login.html', 'signup.html', 'terms.html', 'privacy.html', 'profile.html'];
// 页面依赖的脚本（根目录同名）
const SITE_SCRIPTS = [
  'seal-font-coverage.js',  // 小篆字库覆盖表（缺字检测）
  'seal-ids-data.js',  // 小篆检字：部件检字索引
  'user-state.js',      // V7.0 用户态（页面菜单）
  'overlay.js',         // 遮罩层
  'mobile-nav.js',      // 移动端抽屉
  'conv_tables.js',     // 简繁转换表
  'pinyin_data.js',     // 拼音数据
  'knowledge.js',       // 知识数据
  'era_data.js',        // V10.4 纪年数据（中国朝代/日本时代/周边政权），index.html 依赖
  'catalog_data.js',    // 编目数据
  'classify_data.js',   // V10.4 标准分类表（六部 66 类，含介绍与代表古籍）
  'kanseki_data.js',    // V9.0 古籍类目数据（9.6MB，仅 kanseki.html 使用）
  'kanseki_conv.js',    // V9.0 古籍类目专用 繁→简 表
  'ai-config.js',       // V9.2 DeepSeek 配置与调用（kanseki.html / settings.html / profile.html 共用）
  'supabase-config.js', // 认证配置（账号页依赖）
];

function syncSiteFiles(stats) {
  mkdirSync(PAGES_DIR, { recursive: true });
  const missing = [];
  for (const rel of [...SITE_PAGES, ...ACCOUNT_PAGES, ...SITE_SCRIPTS]) {
    const s = join(ROOT, rel);
    if (!existsSync(s)) { missing.push(rel); continue; }
    // 用 read+write 而非 cpSync：目标可能已存在（同名脚本/PDF），
    // Windows 下 cpSync 覆盖会触发 unlink shim 报错。
    writeFileSync(join(PAGES_DIR, rel), readFileSync(s));
    stats.push(rel);
  }
  // 工作手册：catalog.html 以 docs/manual.pdf 相对路径引用
  copyFileIfExists(join(ROOT, 'docs', 'manual.pdf'), join(PAGES_DIR, 'docs', 'manual.pdf'));
  // V9.5：iframe 页面位于 /pages/ 下，页内的 `assets/logo.png` 相对引用会解析成
  // /pages/assets/logo.png。故把前端 assets 同步一份到 pages/assets，
  // 否则每个内嵌页面的 logo 都会 404（实测 dist 内 index.html 首屏即报）。
  copyDir(join(SRC, 'assets'), join(PAGES_DIR, 'assets'));
  // V1.7 小篆检字字体（根 assets/fonts → pages/assets/fonts，供内嵌页相对引用）
  try { copyDir(join(ROOT, 'assets', 'fonts'), join(PAGES_DIR, 'assets', 'fonts')); } catch (e) { }
  try { copyDir(join(ROOT, 'assets', 'fonts'), join(DIST, 'assets', 'fonts')); } catch (e) { }
  return missing;
}

// ================================================
// APP 化改造（V0.6）：注入嵌入样式
// -------------------------------------------------
// APP 外壳已把「顶部导航」与「编目规范侧栏」搬到 APP 左侧栏，
// 因此 iframe 内页面需隐藏自带的 header / docs-sidebar，避免重复。
// 注意：只在 dist 阶段注入，仓库根目录的源文件始终保持「网页版」原样。
// ================================================
const EMBED_CSS_MARK = '/* kanseki-app-embed */';

// 各页注入规则：
//   hideHeaderNav  — 隐藏 .header-nav（导航已移至 APP 侧栏）
//   hideBrand      — 隐藏 .header-brand（APP 侧栏已有品牌区）
//   hideHeaderAll  — 隐藏整个 .app-header
//   hideDocsAside  — 隐藏 catalog 自带 .docs-sidebar（已合并进 APP 侧栏）
//   gridTwoCol     — catalog 三栏 grid 改两栏（配合 hideDocsAside）
const EMBED_RULES = {
  'index.html': { hideHeaderNav: true, hideBrand: true },
  'catalog.html': {
    hideHeaderAll: true, hideDocsAside: true, gridTwoCol: true,
    // V1.0：页面已改为「浮出章节树 + 单栏正文」，网页版的返回链接/面包屑在 APP 内是多余的
    hideSelectors: ['.back-link', '.phead-kicker', '.docs-toc', '#tocCol'],
  },
  'kanseki.html': {
    hideHeaderAll: true,
    // V9.1：按用户要求，APP 内不显示页内的「导出 CSV / 简繁 / 切换主题」——
    // 简繁与主题在外壳中已有入口（标题栏「繁」按钮、侧栏「切换主题」），页内重复。
    // 网页版不受影响（此段只在 dist 注入）。
    hideSelectors: ['#ksExport', '.ks-lang', '#themeToggleSide'],
  },
  'embed.html': { hideHeaderAll: true, fixedOffset: true },
  'guide.html': {
    hideHeaderAll: true,
    hideSelectors: ['.back-link', '.phead-kicker'],
  },
  'changelog.html': { hideHeaderAll: true },
  'seal.html': { hideHeaderAll: true },
};

function embedStyleFor(rule) {
  const css = [];
  // 导航/品牌隐藏（index）
  if (rule.hideHeaderNav) css.push('.app-header .header-nav{display:none !important}');
  if (rule.hideBrand) css.push('.app-header .header-brand{display:none !important}');
  // 整块 header 隐藏（catalog/embed/guide/changelog）
  if (rule.hideHeaderAll) css.push('.app-header{display:none !important}');
  // sticky 偏移校正：header 消失后顶栏吸附回 0
  if (rule.hideHeaderNav || rule.hideHeaderAll) {
    css.push('.filter-bar{top:0 !important}');
    css.push('.doc-toolbar,.cat-toolbar{top:0 !important}');
  }
  // catalog 自带侧栏隐藏 + 布局重排
  if (rule.hideDocsAside) {
    css.push('.docs-sidebar{display:none !important}');
  }
  if (rule.gridTwoCol) {
    css.push('.docs-layout{grid-template-columns:minmax(0,1fr) !important;max-width:1400px;padding-top:.9rem}');
    css.push('@media(max-width:1150px){.docs-layout{grid-template-columns:minmax(0,1fr) !important}}');
  }
  // V1.3 内容列归一：让所有内嵌页的标题落在与原生视图一致的水平/垂直位置
  css.push('body{padding-left:0!important;padding-right:0!important}');
  css.push('main,body>.wrap,body>.page-wrap,body>.container,.wrap-inner{max-width:none!important;margin-left:0!important;margin-right:0!important;padding-left:18px!important;padding-right:18px!important;padding-top:0!important}');
  css.push('.page-head,.phead{padding-left:0!important;padding-right:0!important;margin-left:0!important;margin-right:0!important;padding-top:8px!important;margin-top:6px!important}');
  // V1.3 标题统一（含位置略低）：所有内嵌页共用同一套标题字阶与上边距
  css.push('.page-head,.phead{padding-top:10px!important}');
  css.push('.page-head h1,.page-head h2,.phead h1,.phead h2,.ph-text h1,.ph-text h2,.phead-text h2,.phead-text h1{font-size:20px!important;font-weight:700!important;line-height:1.35!important;letter-spacing:-.01em!important;margin:0!important}');
  // V2：内嵌页大标题统一（基准 = 日本所藏汉籍检索页：20px / 700 / 1.35）
  css.push('.page-head h1,.page-head h2,.phead h1,.phead h2,.ph-text h1,.ph-text h2,.phead .pt h1{font-size:20px!important;font-weight:700!important;line-height:1.35!important;letter-spacing:-.01em!important;margin:0!important}');
  // V1.1：网页版站点导航条在 APP 内不显示（侧栏已有同名入口）
  css.push('.web-nav-strip{display:none !important}');
  // 视口高度校正：页面内若干 calc(100vh - Npx) 是按「顶栏(约 60px) + 页脚/内边距」估的，
  // 嵌入 APP 后顶栏已被隐藏，需把这部分高度还给内容区，否则底部会留下大片空白。
  if (rule.hideHeaderAll) {
    css.push('.doc-body{max-height:calc(100vh - 132px) !important}');
    css.push('.cat-scroll{max-height:calc(100vh - 132px) !important}');
    css.push('.pdf-frame{height:calc(100vh - 116px) !important}');
    css.push('.docs-toc{max-height:calc(100vh - 24px) !important;top:12px !important}');
    css.push('.docs-layout{padding-bottom:1rem !important}');
  } else if (rule.hideHeaderNav) {
    // index：仅隐藏导航条，header 仍在（含搜索框），高度链不受影响，无需校正
    void 0;
  }
  // 浮动控件的固定偏移校正：原为避开顶栏而设（top:76px/122px），顶栏隐藏后需上移
  if (rule.fixedOffset) {
    css.push('.jump-bar{top:16px !important}');
    css.push('.jump-hint{top:62px !important}');
  }
  // 移动端：APP 侧栏已承担导航，隐藏页内汉堡按钮与抽屉
  css.push('.m-hamburger{display:none !important}');
  css.push('.drawer,.drawer-overlay{display:none !important}');
  // 通用：按选择器隐藏页内控件（V9.1）
  // 用途：某些页内控件在 APP 中与外壳功能重复，或按用户要求不应出现在软件里。
  // 例：kanseki.html 的「导出 CSV」「简/繁」「切换主题」——APP 标题栏已有一键简繁、
  //     侧栏已有「切换主题」，页内这三枚属重复入口。
  // ⚠️ 只在 dist 阶段注入：仓库根的网页版源文件保持原样，网页版的这些功能不受影响。
  if (Array.isArray(rule.hideSelectors)) {
    for (const sel of rule.hideSelectors) {
      if (typeof sel === 'string' && sel.trim()) css.push(`${sel.trim()}{display:none !important}`);
    }
  }
  if (!css.length) return '';
  return `<style id="kanseki-app-embed">${EMBED_CSS_MARK}\n${css.join('\n')}\n</style>`;
}

// 在 </head> 前注入嵌入样式（无 </head> 则追加到 </body> 前）
function injectEmbedCss(htmlPath, rule, stats) {
  if (!rule) return;
  const style = embedStyleFor(rule);
  if (!style) return;
  let html = readFileSync(htmlPath, 'utf8');
  if (html.includes(EMBED_CSS_MARK)) return; // 幂等
  if (html.includes('</head>')) {
    html = html.replace('</head>', style + '\n</head>');
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', style + '\n</body>');
  } else {
    html += style;
  }
  writeFileSync(htmlPath, html, 'utf8');
  stats.push(htmlPath.replace(DIST + '\\', '').replace(DIST + '/', ''));
}

// 清空目录内容（不用 rmSync 整个目录——沙箱 shim 会把 rmSync 劫持为 trash，
// 在部分环境会失败；改为逐项删除文件/空目录）
function emptyDir(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      emptyDir(p);
      try { rmSync(p, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    } else {
      try { rmSync(p, { force: true }); } catch (_) { /* 忽略 */ }
    }
  }
}

console.log('[build] 清理 dist...');
emptyDir(DIST);
mkdirSync(DIST, { recursive: true });

console.log('[build] 拷贝 src -> dist...');
copyDir(SRC, DIST, new Set(['pages'])); // pages 由下方从仓库根同步，不用 src 里的历史副本

// 静态站页面从仓库根实时同步（忽略 src/pages 里的历史副本，保证与网页版一致）
console.log('[build] 同步静态站页面（仓库根 -> dist/pages）...');
const synced = [];
const missing = syncSiteFiles(synced);
console.log(`[build] 已同步 ${synced.length} 个文件：${synced.join(', ')}`);
if (missing.length) {
  console.warn(`[build] ⚠ 缺失 ${missing.length} 个源文件（未同步）：${missing.join(', ')}`);
}

// APP 化：给 iframe 承载的静态页注入嵌入样式
console.log('[build] 注入 APP 嵌入样式...');
const injected = [];
for (const [rel, rule] of Object.entries(EMBED_RULES)) {
  const p = join(DIST, 'pages', rel);
  if (existsSync(p)) injectEmbedCss(p, rule, injected);
}
console.log(`[build] 已注入 ${injected.length} 个页面：${injected.join(', ')}`);

// 网页版的 PWA 三件套（manifest / pwa.js / apple-touch-icon）只对浏览器有意义。
// 桌面版本身就是原生程序，内嵌页里保留这些标签只会请求不存在的文件（404 噪音），
// 因此在拷贝出的副本里统一剔除。
console.log('[build] 剔除 PWA 标签（桌面版内嵌页不适用）...');
const PWA_STRIP = [
  /[ \t]*<link rel="manifest"[^>]*>\r?\n?/g,
  /[ \t]*<meta name="theme-color"[^>]*>\r?\n?/g,
  /[ \t]*<link rel="apple-touch-icon"[^>]*>\r?\n?/g,
  /[ \t]*<meta name="mobile-web-app-capable"[^>]*>\r?\n?/g,
  /[ \t]*<meta name="apple-mobile-web-app-capable"[^>]*>\r?\n?/g,
  /[ \t]*<meta name="apple-mobile-web-app-title"[^>]*>\r?\n?/g,
  /[ \t]*<script defer src="pwa\.js"><\/script>\r?\n?/g
];
const pwaStripped = [];
for (const rel of [...SITE_PAGES, ...ACCOUNT_PAGES]) {
  const p = join(PAGES_DIR, rel);
  if (!existsSync(p)) continue;
  const before = readFileSync(p, 'utf8');
  let after = before;
  for (const re of PWA_STRIP) after = after.replace(re, '');
  if (after !== before) { writeFileSync(p, after, 'utf8'); pwaStripped.push(rel); }
}
console.log(`[build] 已剔除 ${pwaStripped.length} 个页面的 PWA 标签`);

console.log('[build] 拷贝 docs/manual.pdf...');
copyFileIfExists(join(ROOT, 'docs', 'manual.pdf'), join(DIST, 'docs', 'manual.pdf'));

// 移除源目录中的非发布文件（如 .dev 标记）
const devMarker = join(DIST, '.dev');
if (existsSync(devMarker)) { try { rmSync(devMarker); } catch (_) { /* 忽略 */ } }

// 输出统计
const total = (function walk(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += walk(p);
    else n += 1;
  }
  return n;
})(DIST);
console.log(`[build] 完成：dist/ 共 ${total} 个文件`);
