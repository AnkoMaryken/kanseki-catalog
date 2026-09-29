/* ================================================
 * diag_cold2.cjs — 打印图标改写的**调用栈**，锁定是谁在写状态
 * -------------------------------------------------
 * diag_cold 的三轮实测结果：
 *   第 1 轮 失败 —— 图标改写 2 次，均为「未最大化」(F,F)
 *   第 2 轮 成功 —— 图标改写 1 次，为「最大化」(T)
 *   第 3 轮 失败 —— 图标改写 2 次，均为「未最大化」(F,F)
 *
 * 澄清一个此前的误判：失败**不是**「点击后图标被改回去」（那种情况会先出现
 * 一次 T）。失败时根本没有 T —— 说明点击处理没走到「立即翻转图标」那一步，
 * 而同期另有两条路径把状态写成了「未最大化」。
 *
 * 本脚本做四件事，把「谁写的」查清楚：
 *   ① 采集页面报错（pageerror / console error）—— 若 init 中途抛错，
 *      标题栏按钮就不会被绑定，可解释「点了完全没反应」
 *   ② 用 CDP 读 #tbMax 上挂了几个 click 监听（0 个 = 从未绑定）
 *   ③ 自己在 document 上加捕获期监听，确认点击事件确实送达按钮
 *   ④ 打印每条改写的调用栈（app.js 内置追踪已记录 stack）
 * ================================================ */
'use strict';
const { pathToFileURL } = require('url');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9233;
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';

function killApp() {
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); } catch (e) { /* 未运行 */ }
}
function waitCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1500 }, res => {
        let b = ''; res.on('data', d => b += d);
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { retry(); } });
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => { if (Date.now() > deadline) return reject(new Error('CDP 未就绪')); setTimeout(tick, 500); };
    tick();
  });
}

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  for (let round = 1; round <= 2; round++) {
    console.log('\n' + '='.repeat(58));
    console.log(`第 ${round} 轮冷启动`);
    console.log('='.repeat(58));
    killApp();
    await new Promise(r => setTimeout(r, 1500));

    const child = spawn(EXE, [], {
      env: Object.assign({}, process.env, {
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + PORT,
      }),
      stdio: 'ignore',
    });
    await waitCdp(30000);
    const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();

    // ① 采集报错
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.message || e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });

    await page.waitForTimeout(2600);

    // ③ 装捕获期点击监听 + 开启状态改写追踪
    await page.evaluate(() => {
      window.__clicks = [];
      document.addEventListener('click', (e) => {
        const t = e.target;
        window.__clicks.push((t.id || t.tagName) + '|inBtn=' + String(!!(t.closest && t.closest('#tbMax'))));
      }, true);
      window.__KANSEKI_MAX_TRACE = true;
      window.__kansekiMaxTrace = [];
    });

    // ② 读 #tbMax 上的 click 监听数量
    const client = await page.context().newCDPSession(page);
    const btnRes = await client.send('Runtime.evaluate', { expression: "document.getElementById('tbMax')" });
    const ls = await client.send('DOMDebugger.getEventListeners', { objectId: btnRes.result.objectId });
    console.log('  #tbMax click 监听数: ' + ls.listeners.filter(l => l.type === 'click').length);

    // 点击
    await page.evaluate(() => document.getElementById('tbMax').click());
    await page.waitForTimeout(7000);

    const trace = await page.evaluate(() => window.__kansekiMaxTrace || []);
    const clicks = await page.evaluate(() => window.__clicks || []);
    const state = await page.evaluate(() => {
      const b = document.getElementById('tbMax');
      const vis = [...b.querySelectorAll('svg')]
        .filter(s => getComputedStyle(s).display !== 'none' && s.getBoundingClientRect().width > 0)
        .map(s => s.getAttribute('class')).join(',');
      return { vis, inner: window.innerWidth + 'x' + window.innerHeight };
    });

    console.log('  捕获期收到的点击: ' + JSON.stringify(clicks));
    console.log('  末态: ' + JSON.stringify(state));
    console.log('  判定: ' + (state.vis === 'tb-ico-restore' ? '成功' : '失败'));
    console.log('  状态改写轨迹（' + trace.length + ' 条）:');
    trace.forEach((x, i) => {
      console.log(`    [${i}] +${x.t}ms → ${x.max ? '最大化' : '未最大化'}`);
      String(x.stack || '').split(' | ').forEach(f => console.log('        ' + f.trim()));
    });
    console.log('  页面报错: ' + (errors.length ? '\n    ' + errors.join('\n    ') : '无'));

    await browser.close();
    killApp();
    await new Promise(r => setTimeout(r, 800));
  }
  setTimeout(() => process.exit(0), 300).unref();
})().catch(e => { console.error('异常: ' + (e && e.stack || e)); killApp(); process.exit(1); });
