// ================================================
// scripts/build.mjs — 静态构建（零依赖拷贝）
// 产出 app/dist/ 供 Tauri 消费（frontendDist）
// ================================================
// 目录映射：
//   src/index.html         -> dist/index.html（SPA 唯一入口）
//   src/css/*              -> dist/css/*
//   src/js/**/*.mjs|*.js   -> dist/js/**/*（ES 模块，浏览器直接加载）
//   src/assets/*           -> dist/assets/*（PDF、图标等）
//   ../docs/manual.pdf     -> dist/docs/manual.pdf（工作手册）
// ================================================
import { cpSync, mkdirSync, rmSync, readdirSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const SRC = join(APP_ROOT, 'src');
const DIST = join(APP_ROOT, 'dist');
const ROOT = resolve(APP_ROOT, '..'); // 仓库根（docs/manual.pdf 所在）

function copyDir(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else cpSync(s, d);
  }
}

function copyFileIfExists(src, dest) {
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

// ================================================
// APP 化改造（V0.6）：注入嵌入样式
// -------------------------------------------------
// APP 外壳已把「顶部导航」与「编目规范侧栏」搬到 APP 左侧栏，
// 因此 iframe 内页面需隐藏自带的 header / docs-sidebar，避免重复。
// 注意：只改 dist 产物，src/pages/*.html 保持与静态站一致（便于再同步）。
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
  'catalog.html': { hideHeaderAll: true, hideDocsAside: true, gridTwoCol: true },
  'embed.html': { hideHeaderAll: true },
  'guide.html': { hideHeaderAll: true },
  'changelog.html': { hideHeaderAll: true },
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
    css.push('.docs-layout{grid-template-columns:minmax(0,1fr) 216px !important;max-width:1400px;padding-top:.9rem}');
    css.push('@media(max-width:1150px){.docs-layout{grid-template-columns:minmax(0,1fr) !important}}');
  }
  // 移动端：APP 侧栏已承担导航，隐藏页内汉堡按钮与抽屉
  css.push('.m-hamburger{display:none !important}');
  css.push('.drawer,.drawer-overlay{display:none !important}');
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
copyDir(SRC, DIST);

// APP 化：给 iframe 承载的静态页注入嵌入样式
console.log('[build] 注入 APP 嵌入样式...');
const injected = [];
for (const [rel, rule] of Object.entries(EMBED_RULES)) {
  const p = join(DIST, 'pages', rel);
  if (existsSync(p)) injectEmbedCss(p, rule, injected);
}
console.log(`[build] 已注入 ${injected.length} 个页面：${injected.join(', ')}`);

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
