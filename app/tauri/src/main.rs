// ================================================
// src/main.rs — Tauri 入口
// ================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod http;
mod kanseki_db;
mod naj_db;
mod single_instance;
mod system;
mod websearch;

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
            // V9.1：AI 复检（DeepSeek）
            ai::ai_chat,
            ai::ai_check,
            // V9.3：模型列表（避免写死过时模型名）+ 联网查证
            ai::ai_models,
            websearch::web_search,
            // V9.4：全国漢籍データベース（日本所藏中文古籍）检索桥
            kanseki_db::kanseki_fetch,
            // V9.5：国立公文書館デジタルアーカイブ（日本国立公文书馆）检索桥
            naj_db::naj_fetch,
            // V9.2：设置窗口与外部链接
            system::open_settings_window,
            // V9.7：纪年小窗（可置顶）
            system::open_mini_window,
            system::settings_window_visible,
            system::app_version,
            system::open_external,
            // V9.3：导出保存与打开（右下角通知栏用）
            system::save_export,
            system::open_path,
            system::reveal_path,
        ])
        .setup(|app| {
            // V9.2.1 修复「设置窗口只能打开一次」：
            // 用户关闭设置窗口时，Tauri 默认**销毁**该窗口，此后
            // app.get_webview_window("settings") 返回 None，
            // 再点「设置」就报「设置窗口未创建」。
            // 这里拦截关闭请求，改为**隐藏**，窗口对象始终存活，可反复打开。
            // （system::open_settings_window 另有一层「缺失即重建」的兜底。）
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("settings") {
                let w = win.clone();
                win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }
            // 注：纪年小窗（label="mini"）**不在 tauri.conf.json 里声明**，
            // 而是首次点「纪年小窗」时由 system::open_mini_window 懒创建：
            // ① 省下启动开销（不必开机就建第二个 webview）；
            // ② 该窗口自身「关闭即隐藏」的拦截在创建处挂（见 system.rs）。
            // ⚠️ 排障备忘：若程序「启动即退出、退出码 101」，多半不是配置问题，
            //    而是**残留的 msedgewebview2 子进程**锁住了用户数据目录
            //    （表现为 Failed to create webview: HRESULT 0x8007139F）。
            //    强杀应用后请一并清理：taskkill /F /IM msedgewebview2.exe
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
