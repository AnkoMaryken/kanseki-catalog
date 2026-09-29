// ================================================
// src/single_instance.rs — 单实例保护（纯 Win32 FFI，零额外依赖）
// ================================================
// 背景（V0.8 修复「打开后容易崩溃」）：
//   Tauri / WebView2 的 user data folder（%LOCALAPPDATA%\<identifier>\EBWebView）
//   不支持多个浏览器进程并发访问。用户重复点击图标 → 多个实例争抢同一目录
//   → msedgewebview2.exe 崩溃（Crashpad SubCode=0x80000003 STATUS_BREAKPOINT）
//   并在系统里残留无响应进程。
//
// 方案：进程启动时创建具名 Mutex。若 GetLastError() == ERROR_ALREADY_EXISTS
//   说明已有实例在跑 —— 把它的窗口前置，然后本次启动直接退出。
//   若旧实例窗口已无响应（IsHungAppWindow），则结束该进程并继续启动，
//   避免「僵尸实例占坑、用户点图标毫无反应」。
//
// 为何手写 FFI：tauri-plugin-single-instance 需新增 crate，而当前网络环境下
//   crates.io / static.crates.io 均返回 403，无法下载依赖。
//   kernel32 / user32 为系统库，直接用 #[link] 声明即可，不产生新依赖。

use std::ffi::c_void;

const ERROR_ALREADY_EXISTS: u32 = 183;

const SW_RESTORE: i32 = 9;
const PROCESS_TERMINATE: u32 = 0x0001;

/// 窗口标题 —— 必须与 tauri.conf.json 的 app.windows[0].title 一致
const WINDOW_TITLE: &str = "古代史及汉籍研究工具";
/// Mutex 名。Local\ 作用域 = 当前登录会话，无需额外权限（Global\ 要特权）
const MUTEX_NAME: &str = r"Local\cn.kanseki.catalog.singleinstance";

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(attrs: *const c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
    fn GetLastError() -> u32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn TerminateProcess(handle: *mut c_void, exit_code: u32) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn Sleep(ms: u32);
}

#[link(name = "user32")]
unsafe extern "system" {
    fn FindWindowW(class: *const u16, title: *const u16) -> *mut c_void;
    fn IsHungAppWindow(hwnd: *mut c_void) -> i32;
    fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
    fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
    fn SetForegroundWindow(hwnd: *mut c_void) -> i32;
}

/// &str → 以 NUL 结尾的 UTF-16 宽字符串（Win32 的 LPCWSTR）
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 是否已有实例在运行？
/// 注意：必须在 CreateMutexW 之后**立刻**读 GetLastError，
/// 中间不能插入其它会改写 last-error 的调用。
pub fn already_running() -> bool {
    let name = wide(MUTEX_NAME);
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            // 创建失败（极少见）：不阻止启动，避免误伤
            return false;
        }
        // 句柄故意不关闭 —— 进程存活期间持有该 Mutex
        GetLastError() == ERROR_ALREADY_EXISTS
    }
}

/// 把已有实例的窗口恢复并前置。
/// 返回 true = 交接成功（本次启动应退出）；false = 旧实例不可用，本次应继续启动。
pub fn handoff_to_existing() -> bool {
    let title = wide(WINDOW_TITLE);
    unsafe {
        // 旧实例可能仍在初始化（WebView2 尚未建出窗口），轮询等待最多约 1.5s
        for attempt in 0..7 {
            if attempt > 0 {
                Sleep(250);
            }
            let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
            if !hwnd.is_null() {
                return focus_or_clear(hwnd);
            }
        }
        // 始终找不到窗口：可能是残留进程，放行本次启动（互斥失败也不会崩）
        false
    }
}

/// 聚焦旧窗口；若其已无响应则结束该进程并返回 false（让新实例接手）。
unsafe fn focus_or_clear(hwnd: *mut c_void) -> bool {
    if IsHungAppWindow(hwnd) != 0 {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != 0 {
            let proc = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !proc.is_null() {
                TerminateProcess(proc, 1);
                CloseHandle(proc);
                return false;
            }
        }
        // 拿不到进程句柄：仍按不可用处理，让新实例启动（避免用户点图标无反应）
        return false;
    }
    ShowWindow(hwnd, SW_RESTORE);
    SetForegroundWindow(hwnd);
    true
}
