// ================================================
// src/tray.rs — 托盘图标与「关闭即最小化到托盘」（V10.0）
// ================================================
// 用户要求：把软件最小化或关闭后仍留在后台（下载继续跑），点托盘图标可再进入。
//
// 做法：
//   · 主窗口的「关闭」不再退出，而是**隐藏**（下载任务继续在后台跑）；
//   · 托盘左键单击 → 显示并聚焦主窗口；右键 → 菜单「显示主窗口 / 下载中心 / 退出」；
//   · 只有托盘菜单里的「退出」才真正结束进程（见 `EXITING`）。
//
// 说明：托盘图标用 `app.default_window_icon()`（即 tauri.conf.json 里配的图标），
// 不额外引入图片资源。
// ================================================
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

/// 是否「真的要退出」：只有托盘菜单置位；窗口关闭一律转隐藏
static EXITING: AtomicBool = AtomicBool::new(false);
/// 托盘点了「下载中心」→ 前端轮询到这个标记后打开抽屉
static OPEN_CENTER: AtomicBool = AtomicBool::new(false);

pub fn set_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

pub fn is_exiting() -> bool {
    EXITING.load(Ordering::SeqCst)
}

/// 前端取走「打开下载中心」请求（取走即清零）
pub fn take_open_center() -> bool {
    OPEN_CENTER.swap(false, Ordering::SeqCst)
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 建托盘（在 setup 里调用一次）
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let center = MenuItem::with_id(app, "center", "下载中心", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &center, &quit]).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id("kanseki-tray")
        .tooltip("古代史及汉籍研究工具（下载会在后台继续）")
        .menu(&menu)
        // 左键单击直接唤出窗口，右键才出菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            "center" => {
                OPEN_CENTER.store(true, Ordering::SeqCst);
                show_main(app);
            }
            "quit" => {
                set_exiting();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app).map_err(|e| e.to_string())?;
    Ok(())
}
