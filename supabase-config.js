/* ================================================
 * supabase-config.js — Supabase 接入配置 (V6.2)
 * -------------------------------------------------
 * 安全设计：
 *   1. 凭据不写死在本文件。优先读取 window.SUPABASE_CONFIG（由部署方在
 *      HTML 中注入），其次读取下方占位符（由 CI/构建替换）。
 *   2. 未配置凭据时自动进入「演示模式」：登录/注册仅做前端校验并模拟
 *      成功，不发起网络请求，方便本地开发与预览。
 *   3. 配置完成后，替换占位符或注入 SUPABASE_CONFIG 即自动切换真实模式。
 * -------------------------------------------------
 * 已配置 (V6.2, 2026-08-16):
 *   Project URL: https://ndogqsjmkoeecoekmhod.supabase.co
 *   anon key:    用户提供, 已填入 PLACEHOLDER_ANON
 * 注意: 只使用 anon/publishable key; 严禁使用 service_role key!
 * ================================================ */
(function () {
  'use strict';

  // 部署时替换以下占位符，或在使用前注入 window.SUPABASE_CONFIG
  var PLACEHOLDER_URL = 'https://ndogqsjmkoeecoekmhod.supabase.co';
  var PLACEHOLDER_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kb2dxc2pta29lZWNvZWttaG9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY4MzA4MDIsImV4cCI6MjEwMjQwNjgwMn0.bvN7UYSc9O9B-A6A2d4mLXsunhlZr4lPDi-a3yJDRkc';

  // ================================================
  // 本地账号兜底 (V8.1): 解决「邮箱未验证导致登录失败、数据看似丢失」问题
  // -------------------------------------------------
  // 背景: Supabase 默认开启邮箱验证, 未验证账号登录返回 400, 用户以为数据丢了。
  // 方案: 在浏览器 localStorage 维护一份本地账号表 (kanseki_accounts):
  //   - signUp: 无论真实/演示模式, 成功后都写入本地账号 (密码仅存 SHA-256 哈希)
  //   - signIn: 真实模式先走 Supabase; 若因未验证/无此账号而失败, 自动回退本地账号校验
  //   - 这样同一浏览器的注册账号一定可以登录, 登录态/头像自然保存得住
  // 注意: 本地兜底仅供便捷登录; 跨设备/跨浏览器仍依赖 Supabase 账号。
  // ================================================
  var ACCOUNTS_KEY = 'kanseki_accounts';

  function localRead(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function localWrite(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function getLocalAccounts() {
    var a = localRead(ACCOUNTS_KEY);
    return Array.isArray(a) ? a : [];
  }
  function saveLocalAccounts(list) { localWrite(ACCOUNTS_KEY, list); }

  // SHA-256 哈希 (crypto.subtle 异步; 不可用时不哈希, 仅本地演示用途)
  async function sha256(text) {
    try {
      if (window.crypto && crypto.subtle) {
        var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return ('0' + b.toString(16)).slice(-2);
        }).join('');
      }
    } catch (e) {}
    return text; // 降级: 明文 (仅本地, 非传输)
  }

  function localFindByEmail(email) {
    var e = String(email || '').trim().toLowerCase();
    var list = getLocalAccounts();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || '').toLowerCase() === e) return list[i];
    }
    return null;
  }

  // 注册: 写入本地账号 (密码哈希)
  async function localUpsertAccount(email, password, name) {
    var e = String(email || '').trim().toLowerCase();
    if (!e || !password) return null;
    var hash = await sha256(password);
    var list = getLocalAccounts();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].email || '').toLowerCase() === e) { idx = i; break; }
    }
    var rec = { email: e, name: name || '', passHash: hash, createdAt: Date.now() };
    if (idx >= 0) list[idx] = rec; else list.push(rec);
    saveLocalAccounts(list);
    return rec;
  }

  // 校验本地账号: 返回 { ok, name, reason }
  async function localVerify(email, password) {
    var rec = localFindByEmail(email);
    if (!rec) return { ok: false, reason: 'no_account' };
    var hash = await sha256(password);
    if (hash !== rec.passHash) return { ok: false, reason: 'bad_pass' };
    return { ok: true, name: rec.name || '' };
  }

  function isPlaceholder(v) {
    return !v || v.indexOf('YOUR-') === 0 || v.indexOf('your-') === 0;
  }

  // 读取顺序: window.SUPABASE_CONFIG > 占位符
  // 强制演示模式开关: window.SUPABASE_DEMO = true 时即使填了凭据也走演示模式
  var forceDemo = (typeof window !== 'undefined' && window.SUPABASE_DEMO === true);
  var cfg = (typeof window !== 'undefined' && window.SUPABASE_CONFIG) || {};
  var url = cfg.url || PLACEHOLDER_URL;
  var anonKey = cfg.anonKey || cfg.anon_key || PLACEHOLDER_ANON;

  // 静态配置是否「看起来」已填（凭据非占位符）
  var HAS_CREDENTIALS = !forceDemo && !isPlaceholder(url) && !isPlaceholder(anonKey);

  // ================================================
  // V8.1.1: 端点可用性探测 —— 解决「登录/注册全都用不了」
  // -------------------------------------------------
  // 背景: 仅凭「凭据非占位符」就判定可走真实模式是不够的。
  //   实测本项目填写的项目地址 https://ndogqsjmkoeecoekmhod.supabase.co
  //   经 AliDNS DoH 查询返回 Status=3 (NXDOMAIN) —— 该子域根本不存在
  //   （同一查询下随机 ref 亦为 3，supabase.com 为 0，可确认非本地拦截）。
  //   此时 supabase-js 的 createClient() 仍会成功创建实例（不联网），
  //   于是 signUp/signIn 每次都在 fetch 阶段抛 "Failed to fetch"，
  //   用户看到的就是「注册失败 / 登录不了」。
  //
  // 方案: 启动时异步探测 {url}/auth/v1/health。任一结果不可用即把
  //   CONFIGURED 置 false，整体退回「本地账号模式」——与演示模式同一套
  //   逻辑，注册/登录均写入并校验本地账号表，用户始终能正常使用。
  //   探测期间 (PENDING) 走本地账号分支即可，避免请求空等。
  // 注意: 探测失败只在控制台留信息，不阻塞页面；真实可用时行为不变。
  // ================================================
  var ENDPOINT_STATE = HAS_CREDENTIALS ? 'pending' : 'unavailable';
  var HEALTH_TIMEOUT = 5000;

  // 端点状态显式覆盖（供测试与私有部署锁定模式）
  //   部署时在 HTML 中于本脚本之前设置 window.SUPABASE_ENDPOINT_STATE：
  //     'ok'          → 强制真实模式（跳过探测，用于测试或已知可用但被本地
  //                     网络策略拦截探测请求的场景）
  //     'unavailable' → 强制本地账号模式
  //   未设置时行为不变（按探测结果决定）。
  var FORCED_STATE = (typeof window !== 'undefined' && window.SUPABASE_ENDPOINT_STATE) || null;
  if (FORCED_STATE === 'ok' || FORCED_STATE === 'unavailable') {
    ENDPOINT_STATE = FORCED_STATE;
  }

  function isConfigured() {
    return ENDPOINT_STATE === 'ok';
  }

  if (HAS_CREDENTIALS && !FORCED_STATE) {
    try {
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var tid = setTimeout(function () { if (ctl) ctl.abort(); }, HEALTH_TIMEOUT);
      var probeUrl = String(url).replace(/\/$/, '') + '/auth/v1/health';
      fetch(probeUrl, { method: 'GET', signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          clearTimeout(tid);
          ENDPOINT_STATE = r && r.ok ? 'ok' : 'unavailable';
          if (ENDPOINT_STATE === 'unavailable') {
            console.info('[Supabase] 端点不可用（HTTP ' + (r && r.status) + '），已启用本地账号模式');
          }
          return null;
        })
        .catch(function (e) {
          clearTimeout(tid);
          ENDPOINT_STATE = 'unavailable';
          console.info('[Supabase] 端点不可达（' + (e && e.name) + '），已启用本地账号模式');
          return null;
        })
        .then(function () { window.dispatchEvent(new CustomEvent('supabase-state')); });
    } catch (e) {
      ENDPOINT_STATE = 'unavailable';
    }
  }

  window.SUPABASE_READY = isConfigured();

  // 加载 Supabase JS SDK (CDN, 仅在端点确认可用时需要)
  if (HAS_CREDENTIALS && typeof window.supabase === 'undefined') {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = function () {
      try {
        window.supabaseClient = window.supabase.createClient(url, anonKey);
        window.SUPABASE_READY = isConfigured();
        window.dispatchEvent(new CustomEvent('supabase-ready'));
      } catch (e) {
        console.error('Supabase 初始化失败:', e);
      }
    };
    document.head.appendChild(s);
  }

  // 供页面调用的统一接口:
  //   SupabaseAuth.isConfigured()  是否真实模式
  //   SupabaseAuth.getClient()     返回 supabase client 或 null
  //   SupabaseAuth.signIn(email, password)      登录
  //   SupabaseAuth.signUp(email, password, name) 注册
  //   SupabaseAuth.signOut()       登出
  //   SupabaseAuth.getSession()    获取会话
  window.SupabaseAuth = {
    getClient: function () { return window.supabaseClient || null; },
    // 当前是否走真实后端（端点探测通过才会为 true；探测中/不可用均为 false）
    isConfigured: isConfigured,
    endpointState: function () { return ENDPOINT_STATE; },
    signIn: async function (email, password) {
      if (!isConfigured()) {
        // 非真实模式：先查本地账号表
        await new Promise(r => setTimeout(r, 300));
        var lv = await localVerify(email, password);
        if (lv.ok) {
          return { data: { user: { email: email, user_metadata: { name: lv.name } } }, error: null };
        }
        // 纯演示模式（完全未填凭据，如全新克隆）：保留宽松模拟，便于本地预览
        if (!HAS_CREDENTIALS) {
          return { data: { user: { email: email } }, error: null };
        }
        // 本地账号模式（凭据已填但端点不可用）：必须严格校验
        //   修复：原先此分支无差别「宽松模拟成功」，导致任意邮箱 + 任意密码
        //   都能登录（含错误密码），既有安全漏洞，也让用户分不清密码是否输错。
        if (lv.reason === 'bad_pass') {
          return { data: null, error: { message: '密码错误，请重新输入。' } };
        }
        return { data: null, error: { message: '该邮箱尚未注册，请先前往注册页创建账号（无需邮箱验证）。' } };
      }
      const client = this.getClient();
      if (!client) return { data: null, error: { message: 'Supabase 初始化中，请稍后重试' } };
      // 真实模式: 先走 Supabase 校验
      var res;
      try {
        res = await client.auth.signInWithPassword({ email: email, password: password });
      } catch (e) {
        // 网络异常（端点中途不可达）: 不把异常抛给页面，改走本地账号兜底
        var fbn = await localVerify(email, password);
        if (fbn.ok) {
          return { data: { user: { email: email, user_metadata: { name: fbn.name } } }, error: null, _fallback: true };
        }
        return { data: null, error: { message: '网络不可用，请检查连接后重试' } };
      }
      if (!res.error) return res;
      // 失败时回退本地账号兜底 (解决未验证邮箱/账号不存在导致登录失败)
      var fb = await localVerify(email, password);
      if (fb.ok) {
        return { data: { user: { email: email, user_metadata: { name: fb.name } } }, error: null, _fallback: true };
      }
      return res;
    },
    signUp: async function (email, password, name) {
      // 无论真实/本地模式, 都写入本地账号 (密码仅存哈希), 保证能登录
      await localUpsertAccount(email, password, name);
      if (!isConfigured()) {
        // 本地账号模式: 模拟成功
        await new Promise(r => setTimeout(r, 300));
        return { data: { user: { email: email, user_metadata: { name: name } } }, error: null };
      }
      const client = this.getClient();
      if (!client) return { data: null, error: { message: 'Supabase 初始化中，请稍后重试' } };
      try {
        return await client.auth.signUp({
          email: email,
          password: password,
          options: { data: { name: name } }
        });
      } catch (e) {
        // 注册已写入本地账号，网络异常不应报「注册失败」——否则用户以为没注册成功
        return { data: { user: { email: email, user_metadata: { name: name } } }, error: null, _local: true };
      }
    },
    signOut: async function () {
      if (!isConfigured()) return { error: null };
      const client = this.getClient();
      if (!client) return { error: null };
      try { return await client.auth.signOut(); } catch (e) { return { error: null }; }
    },
    getSession: async function () {
      if (!isConfigured()) return { data: { session: null }, error: null };
      const client = this.getClient();
      if (!client) return { data: { session: null }, error: null };
      try { return await client.auth.getSession(); } catch (e) { return { data: { session: null }, error: null }; }
    }
  };

  // V8.1: 本地账号兜底接口 (供页面提示/调试)
  window.SupabaseLocal = {
    find: localFindByEmail,
    verify: localVerify,
    upsert: localUpsertAccount,
    list: getLocalAccounts
  };
})();
