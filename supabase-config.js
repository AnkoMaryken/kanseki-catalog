/* ================================================
 * supabase-config.js — Supabase 接入配置 (V6.0)
 * -------------------------------------------------
 * 安全设计：
 *   1. 凭据不写死在本文件。优先读取 window.SUPABASE_CONFIG（由部署方在
 *      HTML 中注入），其次读取全局占位符（由 CI/构建替换）。
 *   2. 未配置凭据时自动进入「演示模式」：登录/注册仅做前端校验并模拟
 *      成功，不发起网络请求，方便本地开发与预览。
 *   3. 配置完成后，替换占位符或注入 SUPABASE_CONFIG 即自动切换真实模式。
 * ================================================ */
(function () {
  'use strict';

  // 部署时替换以下占位符，或在使用前注入 window.SUPABASE_CONFIG
  var PLACEHOLDER_URL = 'https://YOUR-PROJECT.supabase.co';
  var PLACEHOLDER_ANON = 'YOUR-ANON-KEY';

  function isPlaceholder(v) {
    return !v || v.indexOf('YOUR-') === 0 || v.indexOf('your-') === 0;
  }

  // 读取顺序: window.SUPABASE_CONFIG > 占位符
  var cfg = (typeof window !== 'undefined' && window.SUPABASE_CONFIG) || {};
  var url = cfg.url || PLACEHOLDER_URL;
  var anonKey = cfg.anonKey || cfg.anon_key || PLACEHOLDER_ANON;

  var CONFIGURED = !isPlaceholder(url) && !isPlaceholder(anonKey);

  window.SUPABASE_READY = CONFIGURED;

  // 加载 Supabase JS SDK (CDN, 仅真实模式需要)
  if (CONFIGURED && typeof window.supabase === 'undefined') {
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
    s.onload = function () {
      try {
        window.supabaseClient = window.supabase.createClient(url, anonKey);
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
    isConfigured: function () { return CONFIGURED; },
    getClient: function () { return window.supabaseClient || null; },
    signIn: async function (email, password) {
      if (!CONFIGURED) {
        // 演示模式: 模拟成功
        await new Promise(r => setTimeout(r, 500));
        return { data: { user: { email: email } }, error: null };
      }
      const client = this.getClient();
      if (!client) return { data: null, error: { message: 'Supabase 初始化中，请稍后重试' } };
      return client.auth.signInWithPassword({ email: email, password: password });
    },
    signUp: async function (email, password, name) {
      if (!CONFIGURED) {
        // 演示模式: 模拟成功
        await new Promise(r => setTimeout(r, 500));
        return { data: { user: { email: email } }, error: null };
      }
      const client = this.getClient();
      if (!client) return { data: null, error: { message: 'Supabase 初始化中，请稍后重试' } };
      return client.auth.signUp({
        email: email,
        password: password,
        options: { data: { name: name } }
      });
    },
    signOut: async function () {
      if (!CONFIGURED) return { error: null };
      const client = this.getClient();
      if (!client) return { error: null };
      return client.auth.signOut();
    },
    getSession: async function () {
      if (!CONFIGURED) return { data: { session: null }, error: null };
      const client = this.getClient();
      if (!client) return { data: { session: null }, error: null };
      return client.auth.getSession();
    }
  };
})();
