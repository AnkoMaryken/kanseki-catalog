// ================================================
// src/main.rs — Tauri 入口
// ================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod http;
mod single_instance;
mod system;

fn main() {
    // 单实例保护（V0.8）：必须在 tauri::Builder 之前，
    // 否则 WebView2 已启动并锁定 user data folder，崩溃照样发生。
    if single_instance::already_running() && single_instance::handoff_to_existing() {
        return;
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            http::webdav_request,
            http::webdav_check,
            // V9.1：AI 复检（DeepSeek）—— 同理走 Rust 侧以规避 CORS
            ai::ai_chat,
            ai::ai_check,
            // V9.2：设置窗口与外部链接
            system::open_settings_window,
            system::settings_window_visible,
            system::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
