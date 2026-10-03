// ============================================================
// run_quick.js — **日常迭代用**的快速网页测试（几十秒量级）
// ------------------------------------------------------------
// 背景（用户要求）：每次改一点东西都跑 34 个套件太慢，
// 而其中大量是 v1.x–v4.x 时期的历史套件，与当前改动无关。
// 故分两档：
//   · 本文件（快跑）：只跑**当前在维护的功能**，改完立刻能验证
//   · run_all.js（全量）：发布打包前跑一次，作为完整安全网
//
// 用法： node tests/run_quick.js
// ============================================================
const { execSync } = require('child_process');
const path = require('path');
const NODE = process.env.KANSEKI_NODE || 'C:/Users/华为/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
process.env.NODE_PATH = 'C:/Users/华为/.workbuddy/binaries/node/workspace/node_modules';

// 只覆盖「当前在动的功能」：三大工具 + 账号/主题/导航
const tests = [
  'test_v931.js',        // 设置分区 / Token 用量 / 检索历史
  'test_v93_ai.js',      // 古籍类目查询 · AI 复检（网页版）
  'test_v90_kanseki.js', // 古籍类目查询本体
  'test_user_state.js',  // 账号 / 登录态 / 头像
  'test_theme_sync.js',  // 主题同步
  'test_browser14_nav.js', // 顶部导航
];

let fail = 0;
const t0 = Date.now();
for (const t of tests) {
  const s = Date.now();
  try {
    const out = execSync(`"${NODE}" "${path.join(__dirname, t)}"`, { encoding: 'utf-8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = out.split('\n').filter(l => l.includes('FAIL') || l.includes('====') || l.includes('JS 错误') || l.includes('JS错误') || l.includes('TOTAL'));
    const bad = out.includes('FAIL |') || out.includes('  FAIL  ');
    console.log((bad ? 'FAIL ' : 'ok   ') + t.padEnd(26) + ((Date.now() - s) / 1000).toFixed(1) + 's');
    if (bad) { console.log(lines.join('\n')); fail++; }
  } catch (e) {
    const out = e.stdout || '';
    const allPassed = out.split('\n').some(l => /\d+\s*通过\s*[,，]\s*0\s*(?:失败|FAIL)/i.test(l)) ||
                      out.split('\n').some(l => /TOTAL: \d+\s+PASS: \d+\s+FAIL: 0/.test(l));
    console.log((allPassed ? 'ok   ' : 'FAIL ') + t.padEnd(26) + ((Date.now() - s) / 1000).toFixed(1) + 's' +
      (allPassed ? '  [进程未退出但断言全绿]' : ''));
    if (!allPassed) { console.log((out || e.message).slice(-400)); fail++; }
  }
}
console.log('\n===== 快跑汇总：' + tests.length + ' 套件，失败 ' + fail + '，耗时 ' +
  ((Date.now() - t0) / 1000).toFixed(1) + 's =====');
console.log('（发布打包前请再跑一次全量：node tests/run_all.js）');
process.exit(fail ? 1 : 0);
