// 一键运行全部浏览器测试 (串行 — 浏览器测试必须串行, 并行会卡死)
// V9.0 修复: NODE 路径曾硬编码为 versions/22.22.2 (该目录已不存在, 整套跑不起来),
//            现改为 22.22.2-3; 并补收此前遗漏的 4 个套件 (含最新的 v8.9 / v9.0)。
const { execSync } = require('child_process');
const path = require('path');
const NODE = process.env.KANSEKI_NODE || 'C:/Users/华为/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
process.env.NODE_PATH = 'C:/Users/华为/.workbuddy/binaries/node/workspace/node_modules';
const tests = [
  // B 系列主功能
  'test_browser.js','test_browser2.js',
  'test_browser3.js','test_browser4.js','test_browser5.js','test_browser6.js',
  'test_browser7.js','test_browser8.js','test_browser9.js','test_browser10.js',
  'test_browser11.js','test_browser12_history.js','test_browser13_calc.js',
  // 后续版本专项
  'test_browser14_nav.js','test_browser15_catalog_docs.js','test_browser16_embed.js',
  'test_browser17_precise.js','test_browser18_v80.js',
  'test_v71_crop_favicon.js','test_v72_crop_pixel.js','test_v81_persist.js',
  'test_user_state.js','test_admin_smoke.js','test_admin_hidden_entry.js',
  'test_admin_supabase_mode.js','test_theme_sync.js',
  // V8.2 移动端 + V8.3 功能
  'test_v82_mobile.js','test_v83_card_search.js',
  // V8.9 字形 + V9.0 古籍类目查询 + V9.1 AI 复检 (此前漏收)
  'test_v89_lang.js','test_v90_kanseki.js','test_v91_ai.js'
];
let fail = 0;
for (const t of tests) {
  console.log('\n########## ' + t + ' ##########');
  try {
    const out = execSync(`"${NODE}" "${path.join(__dirname, t)}"`, { encoding: 'utf-8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = out.split('\n').filter(l => l.includes('FAIL') || l.includes('====') || l.includes('JS 错误') || l.includes('JS错误') || l.includes('TOTAL'));
    console.log(lines.join('\n') || out.slice(-300));
    if (out.includes('FAIL |') || out.includes('  FAIL  ')) fail++;
  } catch (e) {
    const out = e.stdout || '';
    // 已知顽疾: Windows headless Chrome 偶发「断言全绿但进程不退出」→ spawn 超时
    // 判别: 若测试内部已打印「N 通过, 0 失败 / 结果: N 通过, 0 失败 / TOTAL: N PASS: N FAIL: 0」则视为通过
    const allPassed = out.split('\n').some(l => /\d+\s*通过\s*[,，]\s*0\s*(?:失败|FAIL)/i.test(l)) ||
                      out.split('\n').some(l => /TOTAL: \d+\s+PASS: \d+\s+FAIL: 0/.test(l));
    console.log(allPassed ? '  [spawn超时但断言全绿, 视为通过]' : '运行失败:', (out || '').slice(-400));
    if (!allPassed) {
      console.log('  原因:', e.message);
      fail++;
    }
  }
}
console.log('\n===== 汇总: 失败测试文件数 =', fail, '=====');
