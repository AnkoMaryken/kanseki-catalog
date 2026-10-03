// ============================================================
// run_quick.cjs — **日常迭代用**的桌面版快速测试（秒级，不联网）
// ------------------------------------------------------------
// 分两档（与网页版一致）：
//   · 本文件（快跑）：单元测试 + 侧栏结构。改完立刻能验证。
//   · 完整：单元 + 各 browser 套件 + 两个真机探针 + 发布物校验，
//           发布打包前再跑。
//
// 用法： node tests/run_quick.cjs
// 说明：kansekidb_live.test.cjs 真连京都大学原站、耗时 1–3 分钟，
//       属"发布前"档，不放这里。
// ============================================================
const { execSync } = require('child_process');
const path = require('path');
const NODE = process.env.KANSEKI_NODE || 'C:/Users/华为/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
process.env.NODE_PATH = 'C:/Users/华为/.workbuddy/binaries/node/workspace/node_modules';

let fail = 0;
const t0 = Date.now();
function run(label, cmd) {
  const s = Date.now();
  try {
    const out = execSync(cmd, { cwd: path.join(__dirname, '..'), encoding: 'utf-8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    const bad = /FAIL \||  FAIL  |# fail [1-9]/.test(out);
    console.log((bad ? 'FAIL ' : 'ok   ') + label.padEnd(26) + ((Date.now() - s) / 1000).toFixed(1) + 's');
    if (bad) { console.log(out.slice(-600)); fail++; }
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    const bad = /FAIL \||# fail [1-9]/.test(out);
    console.log((bad ? 'FAIL ' : 'ok   ') + label.padEnd(26) + ((Date.now() - s) / 1000).toFixed(1) + 's');
    if (bad) { console.log(out.slice(-600)); fail++; }
  }
}

// 单元测试（含 kanseki-parse 等纯逻辑）—— 秒级
run('单元测试', `"${NODE}" --test "tests/unit/*.test.js"`);
// 侧栏结构（导航项/视图数量、入口文字、视图切换）—— 需 8766 服务
run('侧栏结构 sidebar_merge', `"${NODE}" tests/browser/sidebar_merge.test.cjs`);

console.log('\n===== 桌面快跑汇总：失败 ' + fail + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's =====');
console.log('（发布打包前请再跑：活体测试 + 真机探针 + verify_portable/verify_installer）');
process.exit(fail ? 1 : 0);
