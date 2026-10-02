/* ============================================================
 * ai-config.js — DeepSeek 连接配置 + 双通道调用（网页版 / 桌面版共用）
 * ------------------------------------------------------------
 * 为什么单独抽一个文件：
 *   「API 管理」在桌面版位于**独立的设置窗口**，在网页版位于**个人中心页**，
 *   而调用发生在「古籍类目查询」页 —— 三处必须共用同一份配置与同一套错误语义。
 *   本文件由 build.mjs 同步进 dist，网页版与桌面版加载的是同一份。
 *
 * 存储：localStorage（同源共享）。
 *   桌面版两个窗口同源（tauri.localhost）→ 设置窗口写入，查询页立即可读。
 *   网页版同源（github.io）→ 个人中心写入，查询页可读。
 *
 * 通道：
 *   · 桌面版 → invoke('ai_chat')，经 Rust/reqwest 转发
 *   · 网页版 → 直接 fetch。**实测 DeepSeek 会返回 CORS 头**
 *       （OPTIONS 预检 200 且回 `access-control-allow-origin` = 请求方 Origin，
 *         `allow-methods: POST`、`allow-headers: authorization,content-type`），
 *         故浏览器可直连，无需自建代理。
 *
 * 安全：API Key 只存本机 localStorage，只用于 Authorization 头，不发送给任何第三方。
 * ============================================================ */
(function () {
  'use strict';

  var K_KEY = 'kanseki_deepseek_key';
  var K_MODEL = 'kanseki_deepseek_model';
  var K_ENDPOINT = 'kanseki_deepseek_endpoint';
  var K_EMAIL = 'kanseki_feedback_email';

  var DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
  var DEFAULT_MODEL = 'deepseek-chat';

  var MODELS = [
    { id: 'deepseek-chat', label: 'deepseek-chat（通用，快）' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner（推理，更细但慢）' }
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

  function getConfig() {
    return {
      key: ls(true, K_KEY),
      model: ls(true, K_MODEL) || DEFAULT_MODEL,
      endpoint: ls(true, K_ENDPOINT) || DEFAULT_ENDPOINT,
      email: ls(true, K_EMAIL),
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
    var usage = (env && env.usage) || {};
    var content = '';
    try {
      content = ((env.choices || [])[0].message.content || '').trim();
    } catch (e) { content = ''; }
    return {
      ok: !!content,
      content: content,
      error: content ? '' : 'DeepSeek 返回了空内容',
      model: (env && env.model) || '',
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      via: via
    };
  }

  /* 统一入口：messages = [{role, content}, ...]
     成功 resolve 归一化结果对象；失败 reject(Error) */
  function chat(messages, opts) {
    opts = opts || {};
    var cfg = getConfig();
    var temperature = (opts.temperature == null ? 0.2 : opts.temperature);
    var maxTokens = opts.maxTokens || 3000;
    var timeoutSecs = opts.timeoutSecs || 180;

    return Promise.resolve().then(function () {
      if (!cfg.key) throw new Error('尚未配置 DeepSeek API Key');
      if (!messages || !messages.length) throw new Error('没有要发送的内容');

      if (isDesktop()) {
        return window.__TAURI_INTERNALS__.invoke('ai_chat', {
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
          return normalize(env, 'fetch');
        });
      }, function (e) {
        if (timer) clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + timeoutSecs + ' 秒）：DeepSeek 未在预期时间内返回，可稍后重试');
        throw new Error('无法连接 DeepSeek：' + ((e && e.message) || '请检查网络或代理设置'));
      });
    });
  }

  /* 测试连接：发一条极小请求 */
  function test() {
    var cfg = getConfig();
    if (!cfg.key) return Promise.resolve({ ok: false, message: '请先填写 DeepSeek API Key', model: '' });
    if (isDesktop()) {
      return window.__TAURI_INTERNALS__.invoke('ai_check', {
        req: { api_key: cfg.key, endpoint: cfg.endpoint, model: cfg.model }
      }).then(function (r) {
        return { ok: !!(r && r.ok), message: (r && r.message) || '', model: (r && r.model) || cfg.model };
      }, function (e) {
        return { ok: false, message: String((e && e.message) || e), model: cfg.model };
      });
    }
    return chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, temperature: 0, timeoutSecs: 30 })
      .then(function (r) { return { ok: true, message: '连接正常（模型 ' + r.model + '）', model: r.model }; },
        function (e) { return { ok: false, message: String(e.message || e), model: cfg.model }; });
  }

  window.KansekiAI = {
    MODELS: MODELS,
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    DEFAULT_MODEL: DEFAULT_MODEL,
    KEYS: { KEY: K_KEY, MODEL: K_MODEL, ENDPOINT: K_ENDPOINT, EMAIL: K_EMAIL },
    isDesktop: isDesktop,
    getConfig: getConfig,
    setConfig: setConfig,
    clearKey: function () { return setConfig({ key: '' }); },
    chat: chat,
    test: test,
    friendlyError: friendlyError,
    openExternal: openExternal,
    openSettings: openSettings
  };

  /* ---------- 跨窗口 / 系统能力（与 AI 同处一个共享文件，避免再多一个待同步脚本） ---------- */

  /* 打开外部链接。桌面版经 Rust 调系统默认程序 —— WebView2 内 window.open 对 mailto
     并不可靠（常无反应）；网页版直接开新标签页。 */
  function openExternal(url) {
    if (isDesktop()) {
      return window.__TAURI_INTERNALS__.invoke('open_external', { url: url })
        .catch(function () { try { window.open(url, '_blank'); } catch (e) { /* 忽略 */ } });
    }
    try { window.open(url, '_blank'); } catch (e) { /* 忽略 */ }
    return Promise.resolve();
  }

  /* 打开「设置」：桌面版弹独立设置窗口；网页版没有独立窗口，跳个人中心的 API 管理区。 */
  function openSettings() {
    if (isDesktop()) {
      return window.__TAURI_INTERNALS__.invoke('open_settings_window', {})
        .catch(function (e) { throw new Error(String((e && e.message) || e)); });
    }
    location.href = 'profile.html#api';
    return Promise.resolve();
  }
})();
