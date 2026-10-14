// ================================================
// app/tests/browser/najdl_live.test.cjs — 国立公文书馆「整册 PDF 下载」真机实测（CDP 直连）
// -------------------------------------------------
// 与 najdb_live.test.cjs 同一套手法：以 --remote-debugging-port 启动真 exe，
// 用 playwright connectOverCDP 接入 WebView2，**真实点击界面**跑完一次下载。
//
// 验证的是真链路：
//   结果行「下载」→ 解析 /file/ 目录页 →（Rust naj_dl.rs）POST /contentDownload → 原子落盘
//   → 逐册页数校验（/DCTDecode 计数）→ 零缺册门禁 → 打包 ZIP → 报告
//
// 用例：
//   [1] 结果行右侧存在「下载」按钮
//   [2] 点击后弹出下载面板，并解析出册清单与估算
//   [3] 自定义命名模板 → 预览随之变化
//   [4] 真实下载（默认原生 PDF 主通道）→ 全部册完成、无失败
//   [5] 落盘产物齐全：每册 PDF + _任务.json + _报告.csv + ZIP
//   [6] ★零缺册：任务文件中每册 done 且页数校验通过；**独立复核** PDF 内 /DCTDecode 计数 == 记录页数
//
// 用法： node app/tests/browser/najdl_live.test.cjs
// 说明：会真实联网下载一本册数不多的书（默认取「古逸叢書叙目」，22 页）；
//       若首选记录解析出的册数 > MAX_VOLUMES，则中止下载用例并记 FAIL（避免误下大部头）。
// ================================================
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const config = require('../../../tests/helpers/config.js');

const EXE = path.join(__dirname, '..', '..', 'tauri', 'target', 'release', 'kanseki-app.exe');
const PORT = 9225;                 // 与 kansekidb_live(9223)/najdb_live(9224) 错开
const OUT_DIR = path.join(__dirname, '..', '.tmp-najdl-live');
const TITLE_KEYWORD = '古逸叢書叙目';
const MAX_VOLUMES = 3;             // 安全阀：超过此册数就不在实测里下载
const EXPECT_PAGES = 22;           // 《古逸叢書叙目》实测 22 页（用来独立复核 PDF 页数）
const DOWNLOAD_TIMEOUT_MS = 300000;

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}
process.env.NO_PROXY = '*';
process.env.no_proxy = '*';

function killApp() {
  // ⚠️ 本项目有单实例互斥体（Local\cn.kanseki.catalog.singleinstance），
  //    若另有版本在跑（例如桌面的「…_portable.exe」），新 exe 会「启动即交接退出」，
  //    CDP 永远连不上。故这里按进程名把**所有**同名/同源的实例一并结束。
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
  try { execFileSync('taskkill', ['/F', '/IM', 'kanseki-app.exe'], { stdio: 'ignore' }); } catch (_) { }
  // 强杀应用会留下孤儿 WebView2，锁住用户数据目录 → 下次启动 panic
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

/** 独立复核：数出 PDF 内 /DCTDecode 的次数（该站 PDF 一页一张 JPEG，故等值于页数） */
function countDctDecode(file) {
  const buf = fs.readFileSync(file);
  const needle = Buffer.from('/DCTDecode', 'latin1');
  let n = 0, i = 0;
  while ((i = buf.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

(async () => {
  const pw = await import(pathToFileURL(config.playwrightCorePath()).href);
  const chromium = pw.default.chromium || pw.chromium;

  if (!fs.existsSync(EXE)) { console.log('!! 未找到 exe:', EXE); process.exit(2); }

  // 发布门禁：exe 必须晚于前端与 Rust 源文件
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
      console.log('!! exe 早于源文件，请先重新打包（node scripts/build.mjs + tauri build --no-bundle）');
      console.log('   exe=' + new Date(fs.statSync(EXE).mtimeMs).toISOString() + '  最新源=' + newest.f + ' @ ' + new Date(newest.t).toISOString());
      process.exit(3);
    }
  }

  // 干净的输出目录（避免续传逻辑把上一次的产物当成已完成）
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
    console.log((cond ? '  ✔ ' : '  ✘ ') + name + (extra ? '  [' + extra + ']' : ''));
  };

  killApp();
  await new Promise((r) => setTimeout(r, 1500));

  console.log('启动 exe（远程调试 ' + PORT + '）...');
  const env = Object.assign({}, process.env);
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  env.NO_PROXY = '*';
  env.no_proxy = '*';
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
    // ---------- 进入视图并检索 ----------
    await page.locator('.nav-item[data-view="najdb"]').click();
    await page.waitForTimeout(800);
    await page.fill('#najKw', TITLE_KEYWORD);
    await page.locator('#najSearchBtn').click();
    await page.waitForSelector('#najResults .naj-row', { timeout: 120000 });
    console.log('检索完成，命中行数 =', await page.locator('#najResults .naj-row').count());

    // ---------- [1] 下载按钮 ----------
    console.log('\n[1] 结果行右侧「下载」按钮');
    const btnAll = await page.locator('#najResults .naj-row [data-naj-dl]').count();
    ok('每条结果都有下载按钮', btnAll > 0, 'count=' + btnAll);
    const firstRowHasBtn = await page.locator('#najResults .naj-row').first().locator('[data-naj-dl]').count();
    ok('下载按钮位于结果行内（右侧）', firstRowHasBtn === 1);

    // 选定目标行（按标题匹配；找不到就用第一条）
    let target = page.locator('#najResults .naj-row').filter({ hasText: TITLE_KEYWORD }).first();
    if (await target.count() === 0) target = page.locator('#najResults .naj-row').first();
    const targetTitle = (await target.locator('.naj-row-title').textContent().catch(() => '')) || '';
    console.log('目标记录 =', targetTitle.trim());
    await target.locator('[data-naj-dl]').click();

    // ---------- [2] 面板与册清单 ----------
    console.log('\n[2] 下载面板与册清单解析');
    await page.waitForSelector('#najDlOverlay:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('#najDlEstimate .dl-est-badge', { timeout: 120000 });
    const badge = ((await page.locator('#najDlEstimate .dl-est-badge').textContent()) || '').trim();
    const volCount = parseInt((badge.match(/(\d+)\s*册/) || [])[1] || '0', 10);
    ok('解析出册清单并给出估算', volCount >= 1, badge);
    if (volCount > MAX_VOLUMES) {
      ok(`册数不超过实测安全阀（≤${MAX_VOLUMES}）`, false, `实得 ${volCount} 册，已放弃实测下载`);
      throw new Error('safety-abort');
    }

    // ---------- [3] 命名模板与预览 ----------
    console.log('\n[3] 自定义命名');
    await page.fill('#najDlTplFolder', 'LIVE_{书名}');
    await page.fill('#najDlTplFile', '{册次:02}_{册名}');
    await page.waitForTimeout(300);
    const preview = (await page.locator('#najDlPreview').textContent()) || '';
    ok('改名后预览同步更新', preview.includes('LIVE_'), preview.replace(/\s+/g, ' ').slice(0, 80));
    ok('预览含按册次补零的文件名', /\d{2}_/.test(preview), (preview.match(/\d{2}_[^\s]*/) || [''])[0]);

    // ---------- [4] 真实下载 ----------
    console.log('\n[4] 真实下载（原生 PDF 主通道；输出到 ' + OUT_DIR + '）');
    await page.fill('#najDlOut', OUT_DIR.replace(/\\/g, '/'));
    await page.click('#najDlStart');

    const t0 = Date.now();
    let final = null;
    while (Date.now() - t0 < DOWNLOAD_TIMEOUT_MS) {
      final = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#najDlList .dl-item')];
        const problems = document.getElementById('najDlProblems');
        return {
          total: items.length,
          done: items.filter((i) => i.querySelector('.dl-b-ok')).length,
          failed: items.filter((i) => i.querySelector('.dl-b-err')).length,
          problems: !!(problems && !problems.hidden),
          text: items.map((i) => i.textContent.replace(/\s+/g, ' ').trim()).slice(0, 4),
        };
      });
      if (final.total > 0 && (final.done === final.total || final.problems)) break;
      await page.waitForTimeout(3000);
    }
    console.log('  界面状态:', JSON.stringify(final));
    ok('全部册完成（界面上无未完成册）', !!final && final.total > 0 && final.done === final.total, `done=${final && final.done}/${final && final.total}`);
    ok('未出现完整性门禁告警', !!final && final.problems === false);

    // ---------- [5] 落盘产物 ----------
    // V10.2 起：完成后**只留 PDF 与压缩包**——不写 _报告.csv/_manifest.jsonl，_任务.json 也删掉。
    // 故这里等「PDF + ZIP 都在、且任务文件已消失」再断言。
    console.log('\n[5] 落盘产物（只留 PDF）');
    const dirs = fs.readdirSync(OUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(OUT_DIR, d.name));
    ok('生成了书目录', dirs.length === 1, dirs.map((d) => path.basename(d)).join(','));
    const dir = dirs[0] || OUT_DIR;

    let files = [];
    const tw = Date.now();
    while (Date.now() - tw < 150000) {
      files = fs.readdirSync(dir);
      const hasPdf = files.some((f) => /\.pdf$/i.test(f));
      const hasZip = files.some((f) => /\.zip$/i.test(f));
      if (hasPdf && hasZip && !files.includes('_任务.json')) break;
      await page.waitForTimeout(1500);
    }
    const pdfs = files.filter((f) => /\.pdf$/i.test(f));
    const zips = files.filter((f) => /\.zip$/i.test(f));
    ok('每册都有 PDF', pdfs.length >= 1, pdfs.join(' / '));
    ok('压缩包已生成', zips.length === 1, zips.join(','));
    ok('★完成后目录里只剩 PDF 与压缩包（无 _任务.json/_报告.csv/_manifest.jsonl）',
      files.every((f) => /\.pdf$|\.zip$/i.test(f)), files.join(' / '));

    // ---------- [6] 零缺册独立复核 ----------
    console.log('\n[6] 零缺册独立复核（独立数 PDF 内页数）');
    let pageCheckOk = pdfs.length >= 1;
    const details = [];
    for (const f of pdfs) {
      const n = countDctDecode(path.join(dir, f));
      details.push(`${f}=${n}页`);
      if (n !== EXPECT_PAGES) pageCheckOk = false;
    }
    ok(`★PDF 页数 = ${EXPECT_PAGES}（独立复核 /DCTDecode）`, pageCheckOk, details.join(' | '));
    ok('PDF 已非空且结构完整（含 %%EOF）',
      pdfs.every((f) => {
        const buf = fs.readFileSync(path.join(dir, f));
        return buf.length > 10000 && buf.toString('latin1').includes('%%EOF');
      }), details.join(' | '));

    // ---------- [7] 兜底通道：IIIF 逐页 → Rust 合成 PDF ----------
    console.log('\n[7] 兜底通道（IIIF 逐页合成）');
    const OUT2 = OUT_DIR + '-iiif';
    fs.rmSync(OUT2, { recursive: true, force: true });
    fs.mkdirSync(OUT2, { recursive: true });
    await page.click('#najDlOverlay [data-dl-close]');
    await page.waitForTimeout(400);
    await target.locator('[data-naj-dl]').click();
    await page.waitForSelector('#najDlEstimate .dl-est-badge', { timeout: 120000 });
    await page.selectOption('#najDlKind', '__iiif');
    await page.fill('#najDlOut', OUT2.replace(/\\/g, '/'));
    await page.click('#najDlStart');
    const t1 = Date.now();
    let final2 = null;
    while (Date.now() - t1 < DOWNLOAD_TIMEOUT_MS) {
      final2 = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#najDlList .dl-item')];
        const problems = document.getElementById('najDlProblems');
        return {
          total: items.length,
          done: items.filter((i) => i.querySelector('.dl-b-ok')).length,
          problems: !!(problems && !problems.hidden),
          text: items.map((i) => i.textContent.replace(/\s+/g, ' ').trim()).slice(0, 2),
        };
      });
      if (final2.total > 0 && (final2.done === final2.total || final2.problems)) break;
      await page.waitForTimeout(3000);
    }
    console.log('  界面状态:', JSON.stringify(final2));
    ok('兜底通道完成全部册', !!final2 && final2.done === final2.total && final2.total > 0, `done=${final2 && final2.done}/${final2 && final2.total}`);
    const dirs2 = fs.readdirSync(OUT2, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(OUT2, d.name));
    const dir2 = dirs2[0] || OUT2;
    // 等收尾：PDF 出现且不再有任务文件（V10.2 起完成后只留 PDF）
    let files2 = [];
    const tw2 = Date.now();
    while (Date.now() - tw2 < 150000) {
      files2 = fs.readdirSync(dir2);
      if (files2.some((f) => /\.pdf$/i.test(f)) && !files2.includes('_任务.json')) break;
      await page.waitForTimeout(1500);
    }
    const pdf2 = files2.find((f) => /\.pdf$/i.test(f));
    ok('兜底通道产出 PDF', !!pdf2, files2.join(' / '));
    ok('★兜底完成后目录里只剩 PDF / 压缩包',
      files2.every((f) => /\.pdf$|\.zip$/i.test(f)), files2.join(' / '));
    if (pdf2) {
      const real = countDctDecode(path.join(dir2, pdf2));
      ok(`★兜底 PDF 页数 = ${EXPECT_PAGES}（独立复核）`, real === EXPECT_PAGES, `实测=${real}`);
    } else {
      ok(`★兜底 PDF 页数 = ${EXPECT_PAGES}（独立复核）`, false, '未产出 PDF');
    }

    ok('全程无页面脚本错误', errors.length === 0, errors.slice(0, 3).join(' ; '));
  } catch (e) {
    if (e && e.message !== 'safety-abort') {
      console.log('!! 实测异常：', e && e.message);
      results.push('FAIL | 实测异常 | ' + (e && e.message));
    }
  }

  try { await browser.close(); } catch (_) { }
  killApp();

  console.log('\n================ 结果 ================');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n通过 ${results.length - failed} / ${results.length}`);
  fs.writeFileSync(path.join(__dirname, 'najdl_live.last.txt'), results.join('\n') + '\n');
  process.exit(failed ? 1 : 0);
})();
