/* ================================================
 * admin-config.example.js — 管理员配置模板 (V6.4)
 * -------------------------------------------------
 * V6.4 起优先推荐「角色方案」(无需前端配置):
 *   在 Supabase Dashboard → Authentication → Users → 点用户 →
 *   修改 user_metadata, 加一行 "role": "admin" 即可。
 *   线上部署自动生效, 不依赖本文件。
 *
 * 本文件 (emails 白名单) 仅作本地补充, 在角色判断后兜底。
 * 使用方法:
 *   1. 复制本文件为 admin-config.js (同目录)
 *   2. 把 emails 数组改成管理员邮箱 (可选, 角色方案可留空)
 *   3. 刷新 admin.html 即生效
 *
 * 注意:
 *   - admin-config.js 已被 .gitignore 排除, 不会提交到公开仓库
 *   - emails 大小写/空格不敏感
 * ================================================ */
window.ADMIN_CONFIG = {
  // 管理员邮箱白名单 (可选, 角色方案下可留空)
  emails: [
    // 'you@example.com'
  ]
  // 可选: displayName 默认显示名
  // displayName: '站点管理员'
};
