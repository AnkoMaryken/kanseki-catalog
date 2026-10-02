// ================================================
// src/system.rs — 系统级桥（设置窗口 / 外部链接）
// ================================================
// V9.2 新增：
//   open_settings_window() —— 显示「设置」独立窗口（个人中心 / 同步设置 / API 管理）
//   open_external(url)     —— 用系统默认程序打开 http(s) 或 mailto 链接（错误结果反馈用）
//
// 设计说明：
//   · 设置窗口**在 tauri.conf.json 中声明**（label = "settings"、visible = false），
//     而不是运行时用 WebviewWindowBuilder 创建 —— 因为 additionalBrowserArgs
//     （`--no-sandbox` 等）必须与主窗口完全一致，否则该窗口的 localStorage 会失效
//     （项目已知坑：WebView2 storage service 子进程被安全策略拦 → 跨次即失）。
//     在配置里声明可保证参数一字不差。
//   · open_external 只放行 http/https/mailto 三种前缀，避免被当成任意命令执行入口。
// ================================================
use tauri::Manager;

/// 显示并聚焦「设置」窗口
///
/// 该窗口在 tauri.conf.json 中声明（启动时隐藏），正常情况下**始终存在**：
/// main.rs 的 setup 已拦截关闭请求改为隐藏，故可反复打开。
/// 这里的重建分支只是兜底 —— 万一窗口仍被销毁（例如极端情况下的 WebView 崩溃），
/// 也能按同样参数重建，而不是把「设置窗口未创建」抛给用户。
#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("settings") {
        win.show().map_err(|e| format!("显示设置窗口失败：{}", e))?;
        win.set_focus().map_err(|e| format!("聚焦设置窗口失败：{}", e))?;
        return Ok(());
    }

    // ---- 兜底重建（参数须与 tauri.conf.json 的 settings 窗口保持一致）----
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("pages/settings.html".into()),
    )
    .title("设置 — 古代史及汉籍研究工具")
    .inner_size(920.0, 680.0)
    .min_inner_size(720.0, 520.0)
    .resizable(true)
    .center()
    // 与主窗口一致：自绘标题栏
    .decorations(false)
    .additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --no-sandbox",
    )
    .build()
    .map_err(|e| format!("创建设置窗口失败：{}", e))?;

    win.set_focus().map_err(|e| format!("聚焦设置窗口失败：{}", e))?;
    Ok(())
}

/// 返回程序版本号（唯一来源：tauri.conf.json / Cargo.toml）
/// 设置窗口的版本信息直接问 Rust 要，避免在页面里再复制一份版本字符串（易失同步）。
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 设置窗口当前是否可见（供自动化探针取证 —— CDP 侧无法可靠判断原生窗口可见性）
#[tauri::command]
pub async fn settings_window_visible(app: tauri::AppHandle) -> Result<bool, String> {
    match app.get_webview_window("settings") {
        Some(w) => w.is_visible().map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

/// 用系统默认程序打开外部链接（当前仅用于错误结果反馈的邮件撰写）
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("mailto:") || u.starts_with("https://") || u.starts_with("http://")) {
        return Err("仅允许打开 http(s) 或 mailto 链接".into());
    }

    #[cfg(target_os = "windows")]
    {
        // cmd /C start "" "<url>" —— 第一个空串是窗口标题占位，
        // 否则 start 会把带引号的 URL 当成标题而不去打开。
        std::process::Command::new("cmd")
            .args(["/C", "start", "", u])
            .spawn()
            .map_err(|e| format!("调用系统默认程序失败：{}", e))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(u)
            .spawn()
            .map_err(|e| format!("调用系统默认程序失败：{}", e))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(u)
            .spawn()
            .map_err(|e| format!("调用系统默认程序失败：{}", e))?;
        Ok(())
    }
}
