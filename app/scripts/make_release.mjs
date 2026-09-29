/* ================================================
 * make_release.mjs — 生成可分发的发布包
 * -------------------------------------------------
 * 用途：把 Tauri 打包产物组装成「可以直接发给别人」的形式：
 *
 *   release/古代史及汉籍研究工具_v0.8.2/
 *     ├─ 古代史及汉籍研究工具_0.8.2_x64-setup.exe   安装版（推荐，带开始菜单）
 *     ├─ 古代史及汉籍研究工具_0.8.2_x64-portable.exe 免安装版（单文件，双击即用）
 *     ├─ 使用说明.txt                              给接收方的说明
 *     └─ SHA256SUMS.txt                            校验值（防传输损坏）
 *   release/古代史及汉籍研究工具_v0.8.2.zip         整体压缩包 ← 直接发这个
 *
 * 前置：先跑 `tauri build`（产出安装包）与一次 release 编译（产出 exe）。
 *
 * 用法：node scripts/make_release.mjs
 * ================================================ */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..');

const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;
const APP_NAME = '古代史及汉籍研究工具';

const NSIS_DIR = join(APP_ROOT, 'tauri', 'target', 'release', 'bundle', 'nsis');
const EXE = join(APP_ROOT, 'tauri', 'target', 'release', 'kanseki-app.exe');
const RELEASE_ROOT = join(REPO_ROOT, 'release');
const OUT_DIR = join(RELEASE_ROOT, `${APP_NAME}_v${VERSION}`);

function log(msg) { console.log('[release] ' + msg); }
function die(msg) { console.error('[release] ✗ ' + msg); process.exit(1); }

// ---------- 1. 校验前置产物 ----------
if (!existsSync(EXE)) die(`未找到程序文件：${EXE}\n  请先执行：cd app/tauri && ../node_modules/.bin/tauri build --no-bundle`);
if (!existsSync(NSIS_DIR)) die(`未找到安装包目录：${NSIS_DIR}\n  请先执行：cd app/tauri && ../node_modules/.bin/tauri build`);

// 安装包文件名由 Tauri 生成（含中文与版本号），这里按前缀匹配，避免写死
const setupName = readdirSync(NSIS_DIR).find(f => f.endsWith('-setup.exe'));
if (!setupName) die(`安装包目录内没有 -setup.exe：${NSIS_DIR}`);
const SETUP = join(NSIS_DIR, setupName);
log(`安装包: ${setupName}（${(statSync(SETUP).size / 1024 / 1024).toFixed(2)} MB）`);

// ---------- 2. 重建输出目录 ----------
// 只清理本脚本自己管理的 release 目录，不碰其它位置
if (existsSync(OUT_DIR)) { rmSync(OUT_DIR, { recursive: true, force: true }); log('已清理旧的发布目录'); }
mkdirSync(OUT_DIR, { recursive: true });

const setupOut = join(OUT_DIR, `${APP_NAME}_${VERSION}_x64-setup.exe`);
const portableOut = join(OUT_DIR, `${APP_NAME}_${VERSION}_x64-portable.exe`);
copyFileSync(SETUP, setupOut);
copyFileSync(EXE, portableOut);
log(`已复制安装版  → ${setupName}`);
log(`已复制免安装版 → ${APP_NAME}_${VERSION}_x64-portable.exe（${(statSync(portableOut).size / 1024 / 1024).toFixed(2)} MB）`);

// ---------- 3. 使用说明 ----------
const README = `${APP_NAME} v${VERSION}
========================================

感谢使用。本软件用于中日历史纪年对照查询与汉籍编目规范查阅，完全离线运行，
不需要联网，也不会收集任何个人信息。

----------------------------------------
一、怎么装（两种方式，任选其一）
----------------------------------------

【方式 A：安装版 —— 推荐】
  双击运行：
      ${APP_NAME}_${VERSION}_x64-setup.exe
  按提示完成安装即可。安装后会在开始菜单与桌面创建快捷方式，可以随时卸载。

【方式 B：免安装版 —— 不想装东西就选这个】
  双击运行：
      ${APP_NAME}_${VERSION}_x64-portable.exe
  直接就能用，不写注册表、不在系统里留痕。想放哪就放哪（U 盘也行），
  想删掉直接删文件即可。适合临时使用或放在移动盘里带着走。

  提示：首次打开如果 Windows 弹出「已保护你的电脑」提示，点「更多信息」
        →「仍要运行」即可。这是因为软件未购买数字签名证书，并非有病毒。

----------------------------------------
二、系统要求
----------------------------------------
  · Windows 10 / 11（64 位）
  · 需要「Microsoft Edge WebView2 运行时」。Windows 11 与较新的
    Windows 10 已自带；若提示缺失，安装版会自动联网安装它，
    也可以手动下载：https://developer.microsoft.com/microsoft-edge/webview2/

----------------------------------------
三、主要功能
----------------------------------------
  · 纪年查询：中国历代年号与日本年号对照，支持年份、干支、年号检索
  · 周边政权：朝鲜半岛、东北、云南、越南等地政权年号一并列出
  · 编目规范：古籍编目细则文献，含全文检索
  · 工作手册：完整 PDF，可在线查阅或导出
  · 简繁切换：标题栏左上角「简/繁」按钮一键切换，也可在页面内切换
  · 常用跳转：可自行添加常用网址，一键直达
  · 深浅色主题：侧栏底部可切换

----------------------------------------
四、数据是否会丢
----------------------------------------
  软件的数据保存在您自己的电脑上（本地存储），不上传云端，卸载软件会一并清除。
  查询与查阅功能不受影响；如需长期保存自定义设置，请勿随意清理浏览器/应用数据。

----------------------------------------
五、校验文件完整性（可选）
----------------------------------------
  若担心下载或传输过程中文件损坏，可核对 SHA256SUMS.txt 中的校验值。
  在文件所在目录打开命令提示符，执行：
      certutil -hashfile 文件名 SHA256
  将结果与 SHA256SUMS.txt 中对应的一行比对，一致即为完整。

----------------------------------------
六、反馈
----------------------------------------
  使用中如遇问题或有改进建议，欢迎反馈。

—— ${APP_NAME} · v${VERSION}
`;

const readmePath = join(OUT_DIR, '使用说明.txt');
// 用带 BOM 的 UTF-8，确保记事本等工具打开中文不乱码
writeFileSync(readmePath, '\ufeff' + README.replace(/\n/g, '\r\n'), 'utf-8');
log('已生成 使用说明.txt');

// ---------- 4. 校验值 ----------
function sha256(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }
const sums = [
  `${sha256(setupOut)}  ${APP_NAME}_${VERSION}_x64-setup.exe`,
  `${sha256(portableOut)}  ${APP_NAME}_${VERSION}_x64-portable.exe`,
];
writeFileSync(join(OUT_DIR, 'SHA256SUMS.txt'), '\ufeff' + sums.join('\r\n') + '\r\n', 'utf-8');
log('已生成 SHA256SUMS.txt');
sums.forEach(s => console.log('    ' + s));

// ---------- 5. 压缩为整体包 ----------
// 用 PowerShell 的 Compress-Archive（Windows 自带，无需额外依赖）。
// 先把目录名改成 ASCII 临时名再压缩 —— 部分解压工具对压缩包内的中文名
// 处理不一致，改为「压缩包名带中文、内部为英文目录」兼容性最好。
const ZIP = join(RELEASE_ROOT, `${APP_NAME}_v${VERSION}.zip`);
if (existsSync(ZIP)) rmSync(ZIP, { force: true });

const stagingName = `kanseki-v${VERSION}`;
const stagingDir = join(RELEASE_ROOT, stagingName);
if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
for (const f of readdirSync(OUT_DIR)) copyFileSync(join(OUT_DIR, f), join(stagingDir, f));

log('正在压缩…');
try {
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${ZIP}' -CompressionLevel Optimal -Force`,
  ], { stdio: 'inherit' });
} catch (e) {
  die('压缩失败：' + (e && e.message));
}
rmSync(stagingDir, { recursive: true, force: true });

log(`压缩包: ${APP_NAME}_v${VERSION}.zip（${(statSync(ZIP).size / 1024 / 1024).toFixed(2)} MB）`);

// ---------- 6. 汇总 ----------
console.log('\n' + '='.repeat(58));
console.log(` 发布包已就绪：v${VERSION}`);
console.log('='.repeat(58));
console.log(` 目录：${OUT_DIR}`);
for (const f of readdirSync(OUT_DIR)) {
  console.log(`   · ${f}  (${(statSync(join(OUT_DIR, f)).size / 1024 / 1024).toFixed(2)} MB)`);
}
console.log(`\n 直接发给别人的文件（一个压缩包搞定）：`);
console.log(`   ${ZIP}`);
console.log('\n 接收方解压后，双击「setup.exe」安装，或双击「portable.exe」免安装使用。');
