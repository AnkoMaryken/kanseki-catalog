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
import { cpSync, mkdirSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
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
