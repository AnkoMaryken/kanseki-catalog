// ================================================
// src/main.rs — Tauri 入口
// ================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod http;
mod single_instance;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
