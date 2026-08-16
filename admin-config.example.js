/* ================================================
 * admin-config.example.js — 管理员配置模板 (V6.3)
 * -------------------------------------------------
 * 使用方法:
 *   1. 复制本文件为 admin-config.js (同目录)
 *   2. 把下方 emails 数组改成你自己的管理员邮箱
 *   3. 刷新 admin.html 即生效 (无需改任何 HTML)
 *
 * 注意:
 *   - admin-config.js 已被 .gitignore 排除, 不会提交到公开仓库
 *   - emails 是 Supabase 认证用户的邮箱白名单, 大小写/空格不敏感
 *   - 也可通过 Supabase 给用户设置 user_metadata.role = 'admin'
 *     来授予权限, 两种方式等价, 任选其一
 * ================================================ */
window.ADMIN_CONFIG = {
  // 管理员邮箱白名单: 拥有该邮箱的 Supabase 用户可登录工作台
  emails: [
    // 'you@example.com',        // <-- 改成你的管理员邮箱
    // 'colleague@example.com'   // 可多个
  ]
  // 可选: displayName 默认显示名
  // displayName: '站点管理员'
};
