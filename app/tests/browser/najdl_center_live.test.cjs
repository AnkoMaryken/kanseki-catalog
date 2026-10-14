// ================================================
// app/tests/browser/najdl_center_live.test.cjs — 「下载中心 / 批量下载」真机实测（CDP 直连）
// -------------------------------------------------
// 覆盖 V9.9 的四项用户要求：
//   [1] 自选下载位置（面板里有「浏览…」，且默认值来自系统下载目录）
//   [2] 标题栏右上角（最小化旁）「下载中心」按钮：可开抽屉看**速度与进度**，且**不阻塞**其它功能
//   [3] 整包下载完成后主界面顶部横幅 + 右下角提示
//   [4] 批量提交 → 读取书目信息 → 排队下载；失败时右下角弹窗并等待用户选择（略过/重试/暂停/取消）；
//       可暂停/继续
//
// 实测策略：批量里放两本——一本刻意用不存在的 ID（必然失败），一本用真实的
// 《古逸叢書叙目》（22 页）。于是可以完整走一遍「失败 → 用户选择略过 → 自动继续下一本 → 全部完成」。
//
// 用法： node app/tests/browser/najdl_center_live.test.cjs
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9226;
const OUT_DIR = path.join(__dirname, '..', '.tmp-najdl-center');
const GOOD_ID = '591227';       // 古逸叢書叙目（22 页）
const BAD_ID = '99999999';      // 故意不存在 → 走失败分支

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    for (const line of out.split(/\r?\n/)) {
      const name = (line.split('","')[0] || '').replace(/^"/, '');
      if (!name) continue;
      if (/^kanseki-app\.exe$/i.test(name) || /古代史及汉籍研究工具/.test(name)) {
        try { execFileSync('taskkill', ['/F', '/IM', name], { stdio: 'ignore' }); } catch (_) { }
      }
    }
  } catch (_) { }
  try { execFileSync('taskkill', ['/F', '/IM', 'msedgewebview2.exe'], { stdio: 'ignore' }); } catch (_) { }
}

function waitForCdp(timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      });
      req.on('error', () => {
        if (Date.now() > deadline) resolve(null);
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;
  if (!fs.existsSync(EXE)) { console.log('!! 未找到 exe:', EXE); process.exit(2); }

  // exe 新鲜度门禁
  {
    const newest = { t: 0, f: '' };
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { const t = fs.statSync(p).mtimeMs; if (t > newest.t) { newest.t = t; newest.f = p; } }
      }
    };
    for (const r of [path.join(__dirname, '..', '..', 'src'), path.join(__dirname, '..', '..', 'tauri', 'src')]) {
      if (fs.existsSync(r)) walk(r);
    }
    if (fs.statSync(EXE).mtimeMs < newest.t) {
      console.log('!! exe 早于源文件，请先重新打包'); process.exit(3);
    }
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
    console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  [' + extra + ']' : ''));
  };

  killApp();
  await new Promise((r) => setTimeout(r, 1500));

  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*'; env.no_proxy = '*';
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=' + PORT + ' --no-sandbox';
  const child = spawn(EXE, [], { cwd: path.dirname(EXE), env, detached: true, stdio: 'ignore' });
  child.unref();

  if (!(await waitForCdp())) { console.log('!! 未能连上 CDP'); killApp(); process.exit(1); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, { timeout: 30000 });

  let page = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !page) {
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        if (/devtools/.test(p.url())) continue;
        try { if (await p.evaluate(() => !!document.getElementById('app'))) { page = p; break; } } catch (_) { }
      }
      if (page) break;
    }
    if (!page) await new Promise((r) => setTimeout(r, 600));
  }
  if (!page) { console.log('!! 未找到应用页面'); await browser.close(); killApp(); process.exit(1); }

  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  try {
    // ---------- [1] 标题栏按钮 ----------
    console.log('\n[1] 标题栏「下载中心」按钮（最小化旁边）');
    await page.waitForSelector('#tbDl', { timeout: 15000 });
    const pos = await page.evaluate(() => {
      const b = document.getElementById('tbDl');
      const min = document.getElementById('tbMin');
      const br = b.getBoundingClientRect(), mr = min.getBoundingClientRect();
      return {
        nextIsMin: b.nextElementSibling && b.nextElementSibling.id === 'tbMin',
        leftOfMin: br.left < mr.left,
        inTitlebar: !!b.closest('.app-titlebar'),
        w: Math.round(br.width), h: Math.round(br.height),
      };
    });
    ok('按钮紧跟最小化按钮左侧', pos.nextIsMin && pos.leftOfMin, JSON.stringify(pos));
    ok('按钮已渲染（非 0 尺寸）', pos.w > 12 && pos.h > 12);

    // ---------- [2] 抽屉：看进度/速度，且不阻塞其它功能 ----------
    console.log('\n[2] 点开抽屉查看下载详情（不阻塞其它功能）');
    await page.click('#tbDl');
    await page.waitForTimeout(400);
    ok('抽屉已打开', await page.locator('#dlcDrawer:not([hidden])').count() === 1);
    ok('抽屉内有「当前任务/状态」区', (await page.locator('#dlcState').count()) === 1);

    await page.click('.nav-item[data-view="query"]');
    await page.waitForTimeout(700);
    const switched = await page.locator('#view-query.active').count() === 1;
    const drawerStill = await page.locator('#dlcDrawer:not([hidden])').count() === 1;
    ok('切到「纪年查询」后抽屉仍在（不阻塞、可边下边用）', switched && drawerStill, `view=${switched} drawer=${drawerStill}`);
    await page.click('#tbDl');   // 收起

    // ---------- [3] 单本面板：自选下载位置 ----------
    console.log('\n[3] 单本面板的「自选下载位置」');
    // 上一阶段验证「不阻塞」时切到了纪年查询，这里切回国立公文书馆
    await page.click('.nav-item[data-view="najdb"]');
    await page.waitForTimeout(700);
    await page.fill('#najKw', '古逸叢書叙目');
    await page.click('#najSearchBtn');
    await page.waitForSelector('#najResults .naj-row [data-naj-dl]', { timeout: 150000 });
    await page.click('#najResults .naj-row [data-naj-dl]');
    await page.waitForSelector('#najDlOverlay:not([hidden])', { timeout: 20000 });
    ok('单本面板有「浏览…」自选位置', (await page.locator('#najDlBrowse').count()) === 1);
    const singleOut = await page.inputValue('#najDlOut');
    ok('单本面板下载位置有默认值', singleOut.length > 2, singleOut);
    await page.click('#najDlOverlay [data-dl-close]');
    await page.waitForTimeout(300);

    // ---------- [4] 批量面板：读取书目信息 ----------
    console.log('\n[4] 批量提交 → 读取书目信息');
    await page.click('#najBatchBtn');
    await page.waitForSelector('#dlbOverlay:not([hidden])', { timeout: 10000 });
    ok('批量面板已打开', true);
    ok('批量面板含自选下载位置（浏览…）', (await page.locator('#dlbBrowse').count()) === 1);
    const outDefault = await page.inputValue('#dlbOut');
    // 只断言「有默认值」——上次选过的目录会被记住（这正是「自选位置」的要求），
    // 所以默认值不一定是系统下载目录（实测第二次跑就会带出上次的目录）。
    ok('批量面板下载位置有默认值（并会记住上次选择）', !!outDefault && outDefault.length > 2, outDefault);

    await page.fill('#dlbInput', `# 实测批量\n${BAD_ID}\n${GOOD_ID}\n`);
    await page.fill('#dlbOut', OUT_DIR.replace(/\\/g, '/'));
    await page.click('#dlbRead');
    // 等两条都读到终态（已核对/失败）。⚠️ 不能只等「没有读取中」：
    // readAll 是逐条解析的，两条之间会出现「一条已核对、另一条仍待读取」的瞬间。
    const t0 = Date.now();
    let items = null;
    while (Date.now() - t0 < 180000) {
      items = await page.evaluate(() => [...document.querySelectorAll('.dlb-item')].map((it) => it.textContent.replace(/\s+/g, ' ').trim()));
      if (items.length === 2 && !items.some((t) => t.includes('读取中') || t.includes('待读取'))) break;
      await page.waitForTimeout(1000);
    }
    console.log('  清单:', JSON.stringify(items));
    ok('两条都已读取完成', !!items && items.length === 2 && !items.some((t) => t.includes('读取中') || t.includes('待读取')));
    ok('真实条目读到了书名', !!items && items.some((t) => t.includes('古逸叢書叙目')), (items || []).join(' | ').slice(0, 120));

    // ---------- [5] 排队下载：失败 → 用户决策 → 自动继续下一本 ----------
    console.log('\n[5] 排队下载（含失败分支）');
    await page.click('#dlbStart');
    await page.waitForSelector('#dlcDrawer:not([hidden])', { timeout: 15000 });
    ok('开始后下载中心自动打开', true);

    // 采样式验证「下载速度」确有显示
    let sawSpeed = false;
    let sawProgressText = false;
    let pausedOk = false;

    // 失败分支：右下角通知 + 抽屉里的四个决策按钮
    let decideSeen = false;
    let alertSeen = false;
    let pauseTested = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 300000) {
      const st = await page.evaluate(() => ({
        speed: (document.querySelector('#dlcDrawer .dlc-speed') || {}).textContent || '',
        live: (document.querySelector('#dlcDrawer .dlc-live') || {}).textContent || '',
        state: (document.getElementById('dlcState') || {}).textContent || '',
        decideHidden: (document.getElementById('dlcDecideSec') || {}).hidden !== false,
        alerts: document.querySelectorAll('#dlcAlerts .dlc-alert').length,
        banner: (document.getElementById('dlcBanner') || {}).hidden === false
          ? (document.getElementById('dlcBannerTitle') || {}).textContent + '｜' + (document.getElementById('dlcBannerText') || {}).textContent
          : '',
        queue: [...document.querySelectorAll('.dlc-qitem')].map((q) => q.textContent.replace(/\s+/g, ' ').trim()),
      }));
      if (/KB\/s|MB\/s/.test(st.speed)) sawSpeed = true;
      if (/页|MB/.test(st.live)) sawProgressText = true;
      if (st.alerts > 0) alertSeen = true;
      if (!st.decideHidden) {
        decideSeen = true;
        // 顺手验证「暂停」按钮的状态文案（用 try 包住：即便被通知挡住也不该让整轮实测崩掉）
        if (!pauseTested) {
          pauseTested = true;
          try {
            await page.click('#dlcPause', { timeout: 8000 });
            await page.waitForTimeout(1200);
            const s2 = await page.evaluate(() => (document.getElementById('dlcState') || {}).textContent || '');
            const btn = await page.evaluate(() => (document.getElementById('dlcPause') || {}).textContent || '');
            pausedOk = s2.includes('暂停') && btn.includes('继续');
            await page.click('#dlcPause', { timeout: 8000 });   // 继续
            await page.waitForTimeout(600);
          } catch (e) {
            console.log('  （暂停按钮点击被遮挡或超时：' + (e && e.message ? e.message.split('\n')[0] : e) + '）');
          }
        }
        // 选择「略过，继续下一本」
        await page.click('[data-dlc-decide="skip"]');
        await page.waitForTimeout(1500);
      }
      if (st.banner && /批量下载结束|批量下载已取消/.test(st.banner)) {
        console.log('  结束横幅:', st.banner);
        break;
      }
      await page.waitForTimeout(700);
    }

    ok('失败时右下角弹出通知', alertSeen);
    ok('失败时给出「重试/略过/暂停/取消」四个选项', decideSeen);
    ok('点「暂停」后状态变为已暂停、按钮变「继续」', pausedOk);
    ok('下载过程中显示实时速度', sawSpeed);
    ok('下载过程中显示进度信息', sawProgressText);

    const banner = await page.evaluate(() => ({
      hidden: (document.getElementById('dlcBanner') || {}).hidden,
      title: (document.getElementById('dlcBannerTitle') || {}).textContent,
      text: (document.getElementById('dlcBannerText') || {}).textContent,
    }));
    ok('整批结束后主界面顶部弹出提醒', banner.hidden === false && /批量下载结束/.test(banner.title || ''), JSON.stringify(banner));

    const queue = await page.evaluate(() => [...document.querySelectorAll('.dlc-qitem')].map((q) => q.textContent.replace(/\s+/g, ' ').trim()));
    console.log('  队列:', JSON.stringify(queue));
    ok('队列里失败那条被标为「已略过」', queue.some((q) => q.includes('已略过')), queue.join(' | ').slice(0, 140));
    ok('队列里真实那本已完成', queue.some((q) => q.includes('古逸叢書叙目') && q.includes('完成')), queue.join(' | ').slice(0, 140));

    // ---------- [5] 落盘核对 ----------
    // V10.2 起：成功那本**只留 PDF 与压缩包**（不写报告、任务文件也删掉）；
    //            失败那本保留 _任务.json 供续传，但同样不写报告。
    console.log('\n[5] 落盘核对');
    let dirs = [];
    const td = Date.now();
    while (Date.now() - td < 150000) {
      dirs = fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(OUT_DIR, d.name));
      const good = dirs.find((d) => fs.readdirSync(d).some((f) => /\.pdf$/i.test(f)) && fs.readdirSync(d).some((f) => /\.zip$/i.test(f)));
      if (good && !fs.readdirSync(good).includes('_任务.json')) break;
      await page.waitForTimeout(1500);
    }
    ok('生成了书目录（失败那本也会留下目录）', dirs.length >= 1, dirs.map((d) => path.basename(d)).join(' , '));
    let dir = dirs.find((d) => fs.readdirSync(d).some((f) => /\.pdf$/i.test(f))) || dirs[0];
    const badDir = dirs.find((d) => d !== dir);
    const files = fs.readdirSync(dir);
    ok('成功那本已产出 PDF', files.some((f) => /\.pdf$/i.test(f)), files.join(' / '));
    ok('成功那本已打包 ZIP', files.some((f) => /\.zip$/i.test(f)), files.filter((f) => /\.zip$/i.test(f)).join(','));
    ok('★成功那本目录里只剩 PDF 与压缩包（无报告、无任务文件）',
      files.every((f) => /\.pdf$|\.zip$/i.test(f)), files.join(' / '));
    ok('整批成功后队列文件已清理', !fs.existsSync(path.join(OUT_DIR, '_批量队列.json')));
    if (badDir) {
      const bf = fs.readdirSync(badDir);
      ok('失败那本：无 PDF、无 ZIP，保留 _任务.json 供续传、且不写报告',
        !bf.some((f) => /\.pdf$/i.test(f)) && !bf.some((f) => /\.zip$/i.test(f))
        && bf.includes('_任务.json') && !bf.some((f) => /_报告\.csv|_manifest\.jsonl/.test(f)),
        path.basename(badDir) + ' → ' + bf.join(' / '));
    }

    ok('全程无页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' ; '));
  } catch (e) {
    console.log('!! 实测异常：', e && e.message);
    results.push('FAIL | 实测异常 | ' + (e && e.message));
  }

  try { await browser.close(); } catch (_) { }
  killApp();

  console.log('\n================ 结果 ================');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n通过 ${results.length - failed} / ${results.length}`);
  process.exit(failed ? 1 : 0);
})();
