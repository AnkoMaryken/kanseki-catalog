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

/// 显示并聚焦「设置」窗口（已在 tauri.conf.json 声明，启动时隐藏）
#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("settings")
        .ok_or_else(|| "设置窗口未创建（请检查 tauri.conf.json 的 windows 声明）".to_string())?;
    win.show().map_err(|e| format!("显示设置窗口失败：{}", e))?;
    win.set_focus().map_err(|e| format!("聚焦设置窗口失败：{}", e))?;
    Ok(())
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
