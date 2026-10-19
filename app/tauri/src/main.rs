// ================================================
// src/main.rs — Tauri 入口
// ================================================
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod http;
mod kanseki_db;
mod naj_db;
mod naj_dl;
mod pdf_merge;
mod single_instance;
mod system;
mod tray;
mod websearch;

/// Windows 任务栏图标 / 分组标识。
/// 用户反馈：软件在任务栏不显示自己的 logo。
/// 原因之一是进程没有显式 AppUserModelID，任务栏可能按宿主（WebView2）归类而丢图标。
/// 这里用 kernel32 动态调用 SetCurrentProcessExplicitAppUserModelID，不引入新 crate。
#[cfg(target_os = "windows")]
fn set_app_user_model_id(id: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetProcAddress(module: *mut core::ffi::c_void, name: *const u8) -> *mut core::ffi::c_void;
        fn LoadLibraryW(name: *const u16) -> *mut core::ffi::c_void;
    }
    type SetAumid = unsafe extern "system" fn(*const u16) -> i32;
    let wide: Vec<u16> = OsStr::new(id).encode_wide().chain(std::iter::once(0)).collect();
    unsafe {
        let shell: Vec<u16> = OsStr::new("shell32.dll").encode_wide().chain(std::iter::once(0)).collect();
        let lib = LoadLibraryW(shell.as_ptr());
        if lib.is_null() { return; }
        let proc_name = b"SetCurrentProcessExplicitAppUserModelID\0";
        let f = GetProcAddress(lib, proc_name.as_ptr());
        if f.is_null() { return; }
        let func: SetAumid = std::mem::transmute(f);
        let _ = func(wide.as_ptr());
    }
}

fn main() {
    // V1.3：显式 AppUserModelID，保证任务栏图标/分组使用本程序自己的标识
    #[cfg(target_os = "windows")]
    set_app_user_model_id("com.ankomaryken.kanseki.tool");

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
            // V9.8：国立公文书馆 批量下载（原生 PDF 主通道 + IIIF 兜底 + 打包/校验）
            naj_dl::naj_dl_native_pdf,
            naj_dl::naj_dl_iiif_volume,
            naj_dl::naj_dl_zip,
            naj_dl::naj_dl_verify_pdf,
            naj_dl::naj_dl_write_text,
            naj_dl::naj_dl_read_text,
            naj_dl::naj_dl_stat,
            naj_dl::naj_dl_mkdir,
            naj_dl::naj_dl_default_root,
            naj_dl::naj_dl_pick_folder,
            naj_dl::naj_dl_progress,
            naj_dl::naj_dl_progress_reset,
            naj_dl::naj_dl_merge_pdfs,
            naj_dl::naj_dl_remove,
            // V10.0：托盘（关闭转后台）相关
            system::app_show_main,
            system::app_take_open_center,
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
            // V10.0：托盘图标 —— 关闭窗口不再退出，而是隐藏到托盘，下载在后台继续
            {
                use tauri::Manager;
                if let Err(e) = tray::init(app.handle()) {
                    eprintln!("托盘初始化失败（不影响主功能）：{}", e);
                }
                // 主窗口「关闭」→ 隐藏（只有托盘菜单「退出」才真正结束）
                if let Some(win) = app.get_webview_window("main") {
                    // V1.3：显式设置窗口图标，保证任务栏显示本软件 logo
                    if let Some(icon) = app.default_window_icon() {
                        let _ = win.set_icon(icon.clone());
                    }
                    let w = win.clone();
                    win.on_window_event(move |ev| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                            if !tray::is_exiting() {
                                api.prevent_close();
                                let _ = w.hide();
                            }
                        }
                    });
                }
            }

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
