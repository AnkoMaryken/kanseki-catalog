// 一键运行全部浏览器测试
const { execSync } = require('child_process');
const path = require('path');
const NODE = 'C:/Users/华为/.workbuddy/binaries/node/versions/22.22.2/node.exe';
process.env.NODE_PATH = 'C:/Users/华为/.workbuddy/binaries/node/workspace/node_modules';
const tests = ['test_browser3.js','test_browser4.js','test_browser5.js','test_browser6.js','test_browser7.js','test_browser8.js','test_browser9.js','test_browser10.js','test_browser11.js','test_browser12_history.js','test_browser13_calc.js'];
let fail = 0;
for (const t of tests) {
  console.log('\n########## ' + t + ' ##########');
  try {
    const out = execSync(`"${NODE}" "${path.join(__dirname, t)}"`, { encoding: 'utf-8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = out.split('\n').filter(l => l.includes('FAIL') || l.includes('TOTAL') || l.includes('JS错误'));
    console.log(lines.join('\n') || out.slice(-300));
    if (out.includes('FAIL |')) fail++;
  } catch (e) {
    console.log('运行失败:', (e.stdout || '').slice(-300));
    fail++;
  }
}
console.log('\n===== 汇总: 失败测试文件数 =', fail, '=====');
