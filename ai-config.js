/* ============================================================
 * ai-config.js — DeepSeek 配置 + 调用 + 联网查证 + 导出（网页版 / 桌面版共用）
 * ------------------------------------------------------------
 * 为什么单独抽一个文件：
 *   「API 管理」在桌面版位于**独立的设置窗口**，在网页版位于**设置页**，
 *   而调用发生在「古籍类目查询」页 —— 三处必须共用同一份配置与同一套错误语义。
 *
 * 存储：localStorage（同源共享）。
 *   桌面版两个窗口同源（tauri.localhost）→ 设置窗口写入，查询页立即可读。
 *
 * 通道：
 *   · 桌面版 → invoke(...)，经 Rust/reqwest 转发（无跨域限制，可联网检索）
 *   · 网页版 → 直接 fetch。DeepSeek 会返回 CORS 头，可直连；
 *     但**搜索引擎不返回 CORS 头**，故网页版无法联网查证（见 search()）。
 *
 * V9.3 变更：
 *   · 默认模型改为 deepseek-flash（旧名 deepseek-chat / deepseek-reasoner
 *     已不在官方价格表内，写死旧名是「返回空内容」的诱因之一）
 *   · 新增 listModels()：问接口要账号真实可用的模型，不再写死
 *   · 新增 search()：联网检索（桌面版走 Rust 的 web_search）
 *   · 新增 saveExport / openPath / revealPath / notifyExport：
 *     导出文件落盘后回传绝对路径，并在主界面右下角通知栏提供「打开」入口
 *
 * 安全：API Key 只存本机 localStorage，只用于 Authorization 头。
 * ============================================================ */
(function () {
  'use strict';

  var K_KEY = 'kanseki_deepseek_key';
  var K_MODEL = 'kanseki_deepseek_model';
  var K_ENDPOINT = 'kanseki_deepseek_endpoint';
  var K_EMAIL = 'kanseki_feedback_email';
  var K_MAXTOK = 'kanseki_deepseek_maxtokens';
  var K_USAGE = 'kanseki_token_usage';
  var USAGE_RECENT_MAX = 50;

  var DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
  var DEFAULT_MODEL = 'deepseek-flash';
  var DEFAULT_MAX_TOKENS = 8000;

  /* 兜底候选（真实列表由 listModels() 从接口拉取后覆盖） */
  var MODELS = [
    { id: 'deepseek-flash', label: 'deepseek-flash（现行主力，快）' },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（更强，慢）' }
  ];

  function ls(get, key, val) {
    try {
      if (get) return localStorage.getItem(key) || '';
      if (val) localStorage.setItem(key, val);
      else localStorage.removeItem(key);
    } catch (e) { /* 隐私模式等忽略 */ }
    return '';
  }

  function isDesktop() {
    return !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function');
  }

  function invoke(cmd, args) {
    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }

  function getConfig() {
    var mt = parseInt(ls(true, K_MAXTOK), 10);
    return {
      key: ls(true, K_KEY),
      model: ls(true, K_MODEL) || DEFAULT_MODEL,
      endpoint: ls(true, K_ENDPOINT) || DEFAULT_ENDPOINT,
      email: ls(true, K_EMAIL),
      maxTokens: (isFinite(mt) && mt >= 256) ? mt : DEFAULT_MAX_TOKENS,
      hasKey: !!ls(true, K_KEY),
      desktop: isDesktop()
    };
  }

  function setConfig(c) {
    c = c || {};
    if ('key' in c) ls(false, K_KEY, String(c.key || '').trim());
    if ('model' in c) ls(false, K_MODEL, String(c.model || '').trim());
    if ('endpoint' in c) ls(false, K_ENDPOINT, String(c.endpoint || '').trim());
    if ('email' in c) ls(false, K_EMAIL, String(c.email || '').trim());
    if ('maxTokens' in c) {
      var n = parseInt(c.maxTokens, 10);
      ls(false, K_MAXTOK, (isFinite(n) && n >= 256) ? String(n) : '');
    }
    return getConfig();
  }

  /* 与 Rust 侧 friendly_error 保持同一套文案 */
  function friendlyError(status, body) {
    var apiMsg = '';
    try {
      var j = JSON.parse(body || '');
      if (j && j.error && j.error.message) apiMsg = String(j.error.message);
    } catch (e) { /* 非 JSON 响应 */ }
    var base;
    if (status === 400) base = '请求格式有误';
    else if (status === 401) base = 'API Key 无效或已过期，请在设置中重新填写';
    else if (status === 402) base = 'DeepSeek 账户余额不足';
    else if (status === 403) base = '该 Key 无权访问此模型';
    else if (status === 404) base = '接口地址不存在（请检查 API 地址设置）';
    else if (status === 422) base = '请求参数不被接受';
    else if (status === 429) base = '请求过于频繁或已达配额上限，请稍后再试';
    else if (status >= 500 && status <= 599) base = 'DeepSeek 服务暂时不可用';
    else base = '请求失败';
    return apiMsg ? (base + '（HTTP ' + status + '）：' + apiMsg) : (base + '（HTTP ' + status + '）');
  }

  function normalize(env, via) {
    var choice = (env && env.choices && env.choices[0]) || {};
    var msg = choice.message || {};
    var usage = (env && env.usage) || {};
    var det = usage.completion_tokens_details || {};
    var content = String(msg.content == null ? '' : msg.content).trim();
    var reasoning = String(msg.reasoning_content == null ? '' : msg.reasoning_content).trim();
    var finish = choice.finish_reason || '';
    var fromReasoning = false;
    var error = '';
    if (!content) {
      if (reasoning) {
        content = '（模型本次只输出了思维链、未给出最终回答，以下为思维链内容；如需完整回答请重试或调高「最大输出 tokens」）\n\n' + reasoning;
        fromReasoning = true;
      } else if (finish === 'length') {
        error = '输出被截断：tokens 预算被思维链耗尽，最终回答为空。请在设置中调高「最大输出 tokens」，或改用非思考模型。';
      } else {
        error = 'DeepSeek 返回了空内容';
      }
    }
    return {
      ok: !!content,
      content: content,
      error: error,
      model: (env && env.model) || '',
      finish_reason: finish,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      reasoning_tokens: det.reasoning_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      from_reasoning: fromReasoning,
      via: via
    };
  }

  /* 统一入口：messages = [{role, content}, ...]；成功 resolve 归一化结果，失败 reject(Error) */
  function chat(messages, opts) {
    opts = opts || {};
    var cfg = getConfig();
    var temperature = (opts.temperature == null ? 0.2 : opts.temperature);
    var maxTokens = opts.maxTokens || cfg.maxTokens || DEFAULT_MAX_TOKENS;
    var timeoutSecs = opts.timeoutSecs || 300;

    return Promise.resolve().then(function () {
      if (!cfg.key) throw new Error('尚未配置 DeepSeek API Key');
      if (!messages || !messages.length) throw new Error('没有要发送的内容');

      if (isDesktop()) {
        return invoke('ai_chat', {
          req: {
            api_key: cfg.key,
            endpoint: cfg.endpoint,
            model: cfg.model,
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens,
            timeout_secs: timeoutSecs
          }
        }).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || 'DeepSeek 未返回内容');
          r.via = 'tauri';
          recordUsage(r);
          return r;
        }, function (e) {
          throw new Error(String((e && e.message) || e));
        });
      }

      // 网页版：直连（DeepSeek 支持 CORS）
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = null;
      if (ctl) timer = setTimeout(function () { ctl.abort(); }, timeoutSecs * 1000);
      return fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + cfg.key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages,
          stream: false,
          temperature: temperature,
          max_tokens: maxTokens
        }),
        signal: ctl ? ctl.signal : undefined
      }).then(function (resp) {
        if (timer) clearTimeout(timer);
        return resp.text().then(function (body) {
          if (!resp.ok) throw new Error(friendlyError(resp.status, body));
          var env;
          try { env = JSON.parse(body); }
          catch (e) { throw new Error('解析响应失败：' + e.message); }
          var r = normalize(env, 'fetch');
          if (!r.ok) throw new Error(r.error);
          recordUsage(r);
          return r;
        });
      }, function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + timeoutSecs + ' 秒）：DeepSeek 未在预期时间内返回，可稍后重试');
        throw new Error('无法连接 DeepSeek：' + ((e && e.message) || '请检查网络或代理设置'));
      });
    });
  }

  /* 测试连接 */
  function test() {
    var cfg = getConfig();
    if (!cfg.key) return Promise.resolve({ ok: false, message: '请先填写 DeepSeek API Key', model: '' });
    if (isDesktop()) {
      return invoke('ai_check', {
        req: { api_key: cfg.key, endpoint: cfg.endpoint, model: cfg.model }
      }).then(function (r) {
        return { ok: !!(r && r.ok), message: (r && r.message) || '', model: (r && r.model) || cfg.model };
      }, function (e) {
        return { ok: false, message: String((e && e.message) || e), model: cfg.model };
      });
    }
    return chat([{ role: 'user', content: 'ping' }], { maxTokens: 512, temperature: 0, timeoutSecs: 60 })
      .then(function (r) { return { ok: true, message: '连接正常（模型 ' + r.model + '）', model: r.model }; },
        function (e) { return { ok: false, message: String(e.message || e), model: cfg.model }; });
  }

  function modelsEndpoint(chatEndpoint) {
    var t = String(chatEndpoint || '').replace(/\/+$/, '');
    var i = t.lastIndexOf('/chat/completions');
    if (i >= 0) return t.slice(0, i) + '/models';
    var j = t.lastIndexOf('/');
    return (j >= 0 ? t.slice(0, j) : t) + '/models';
  }

  /* 拉取账号真实可用的模型列表（避免写死过时模型名） */
  function listModels() {
    var cfg = getConfig();
    if (!cfg.key) return Promise.resolve({ ok: false, models: [], error: '尚未配置 API Key' });
    if (isDesktop()) {
      return invoke('ai_models', {
        req: { api_key: cfg.key, endpoint: cfg.endpoint, model: cfg.model }
      }).then(function (r) {
        return { ok: !!(r && r.ok), models: (r && r.models) || [], error: (r && r.error) || '' };
      }, function (e) {
        return { ok: false, models: [], error: String((e && e.message) || e) };
      });
    }
    return fetch(modelsEndpoint(cfg.endpoint), {
      headers: { 'Authorization': 'Bearer ' + cfg.key }
    }).then(function (resp) {
      return resp.text().then(function (b) {
        if (!resp.ok) return { ok: false, models: [], error: friendlyError(resp.status, b) };
        var v = {};
        try { v = JSON.parse(b); } catch (e) { return { ok: false, models: [], error: '解析模型列表失败' }; }
        var ids = (v.data || []).map(function (m) { return m.id; }).filter(Boolean).sort();
        return { ok: ids.length > 0, models: ids, error: '' };
      });
    }, function (e) {
      return { ok: false, models: [], error: '无法连接：' + ((e && e.message) || e) };
    });
  }

  /* ---------------- Token 用量统计（V9.3.1） ----------------
     每次调用成功后记录接口返回的 usage；只写本机 localStorage，不上传。
     设置页的「Token 用量」可视化读这份数据。 */
  function emptyUsage() {
    return { calls: 0, prompt: 0, completion: 0, reasoning: 0, total: 0, byModel: {}, recent: [], firstAt: '', lastAt: '' };
  }

  function getUsage() {
    try {
      var o = JSON.parse(localStorage.getItem(K_USAGE) || 'null');
      if (o && typeof o === 'object') {
        var u = emptyUsage();
        u.calls = o.calls || 0;
        u.prompt = o.prompt || 0;
        u.completion = o.completion || 0;
        u.reasoning = o.reasoning || 0;
        u.total = o.total || 0;
        u.byModel = (o.byModel && typeof o.byModel === 'object') ? o.byModel : {};
        u.recent = Array.isArray(o.recent) ? o.recent : [];
        u.firstAt = o.firstAt || '';
        u.lastAt = o.lastAt || '';
        return u;
      }
    } catch (e) { /* 解析失败按空处理 */ }
    return emptyUsage();
  }

  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function recordUsage(r) {
    if (!r) return null;
    var p = r.prompt_tokens || 0;
    var c = r.completion_tokens || 0;
    var rt = r.reasoning_tokens || 0;
    var t = r.total_tokens || (p + c);
    var u = getUsage();
    var at = stamp();
    u.calls += 1;
    u.prompt += p;
    u.completion += c;
    u.reasoning += rt;
    u.total += t;
    var m = r.model || '（未知模型）';
    if (!u.byModel[m]) u.byModel[m] = { calls: 0, total: 0 };
    u.byModel[m].calls += 1;
    u.byModel[m].total += t;
    if (!u.firstAt) u.firstAt = at;
    u.lastAt = at;
    u.recent.unshift({ at: at, model: m, prompt: p, completion: c, reasoning: rt, total: t });
    if (u.recent.length > USAGE_RECENT_MAX) u.recent.length = USAGE_RECENT_MAX;
    try { localStorage.setItem(K_USAGE, JSON.stringify(u)); } catch (e) { /* 配额满等忽略 */ }
    try { window.dispatchEvent(new CustomEvent('kanseki-usage', { detail: u })); } catch (e) { /* 忽略 */ }
    return u;
  }

  function resetUsage() {
    try { localStorage.removeItem(K_USAGE); } catch (e) { /* 忽略 */ }
    var u = emptyUsage();
    try { window.dispatchEvent(new CustomEvent('kanseki-usage', { detail: u })); } catch (e) { /* 忽略 */ }
    return u;
  }

  /* ---------------- 联网查证 ----------------
     桌面版走 Rust（reqwest 无跨域限制）；网页版做不到 —— 搜索引擎不返回 CORS 头。 */
  function search(query, limit) {
    var q = String(query == null ? '' : query).trim();
    if (!q) return Promise.resolve({ ok: false, query: '', hits: [], error: '检索词为空' });
    if (!isDesktop()) {
      return Promise.resolve({
        ok: false, query: q, hits: [],
        error: '网页版无法联网查证（浏览器跨域限制），桌面版可用'
      });
    }
    return invoke('web_search', { req: { query: q, limit: limit || 5 } })
      .then(function (r) {
        return { ok: !!(r && r.ok), query: (r && r.query) || q, hits: (r && r.hits) || [], error: (r && r.error) || '' };
      }, function (e) {
        return { ok: false, query: q, hits: [], error: String((e && e.message) || e) };
      });
  }

  /* ---------------- 导出与打开 ----------------
     桌面版：写到系统下载目录并回传绝对路径（用户可知文件在哪）；
     网页版：交给浏览器下载（拿不到路径）。 */
  function saveExport(name, content) {
    var fname = String(name || '导出.txt');
    if (isDesktop()) {
      return invoke('save_export', { name: fname, content: String(content == null ? '' : content) })
        .then(function (p) { return { ok: true, path: String(p || ''), name: fname, via: 'tauri' }; },
          function (e) { return { ok: false, path: '', name: fname, error: String((e && e.message) || e) }; });
    }
    try {
      var blob = new Blob([String(content == null ? '' : content)], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      return Promise.resolve({ ok: true, path: '', name: fname, via: 'browser' });
    } catch (e) {
      return Promise.resolve({ ok: false, path: '', name: fname, error: String(e && e.message || e) });
    }
  }

  function openPath(p) {
    if (!isDesktop()) return Promise.resolve(false);
    return invoke('open_path', { path: p }).then(function () { return true; }, function () { return false; });
  }
  function revealPath(p) {
    if (!isDesktop()) return Promise.resolve(false);
    return invoke('reveal_path', { path: p }).then(function () { return true; }, function () { return false; });
  }

  /* 把「已导出」事件通知主界面：在 iframe 里则交给外壳显示右下角通知栏；
     不在 iframe（网页版直开）则自己弹一个轻量提示。 */
  function notifyExport(info) {
    info = info || {};
    var payload = {
      type: 'kanseki-export',
      name: info.name || '',
      path: info.path || '',
      kind: info.kind || '',
      size: info.size || 0,
      desktop: isDesktop()
    };
    var inFrame = false;
    try { inFrame = window.parent && window.parent !== window; } catch (e) { inFrame = false; }
    if (inFrame) {
      try { window.parent.postMessage(payload, '*'); } catch (e) { /* 忽略 */ }
      return true;
    }
    return false;
  }

  window.KansekiAI = {
    MODELS: MODELS,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
    KEYS: { KEY: K_KEY, MODEL: K_MODEL, ENDPOINT: K_ENDPOINT, EMAIL: K_EMAIL, MAXTOK: K_MAXTOK, USAGE: K_USAGE },
    isDesktop: isDesktop,
    getConfig: getConfig,
    setConfig: setConfig,
    clearKey: function () { return setConfig({ key: '' }); },
    chat: chat,
    test: test,
    listModels: listModels,
    modelsEndpoint: modelsEndpoint,
    search: search,
    getUsage: getUsage,
    resetUsage: resetUsage,
    friendlyError: friendlyError,
    openExternal: openExternal,
    openSettings: openSettings,
    saveExport: saveExport,
    openPath: openPath,
    revealPath: revealPath,
    notifyExport: notifyExport
  };

  /* ---------- 跨窗口 / 系统能力 ---------- */

  /* 打开外部链接。桌面版经 Rust 调系统默认程序 —— WebView2 内 window.open 对 mailto
     并不可靠（常无反应）；网页版直接开新标签页。 */
  function openExternal(url) {
    if (isDesktop()) {
      return invoke('open_external', { url: url })
        .catch(function () { try { window.open(url, '_blank'); } catch (e) { /* 忽略 */ } });
    }
    try { window.open(url, '_blank'); } catch (e) { /* 忽略 */ }
    return Promise.resolve();
  }

  /* 打开「设置」：桌面版弹独立设置窗口；网页版跳到设置页的 API 管理分区。 */
  function openSettings() {
    if (isDesktop()) {
      return invoke('open_settings_window', {})
        .catch(function (e) { throw new Error(String((e && e.message) || e)); });
    }
    location.href = 'settings.html#api';
    return Promise.resolve();
  }
})();
