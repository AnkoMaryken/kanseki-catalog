# ================================================
# scripts/shot_app.py — 桌面版窗口截图
# -------------------------------------------------
# 启动 exe，等窗口出现后用 PrintWindow 抓取窗口内容，
# 用于确认「打开后不能用」的具体表现（白屏 / 报错 / 正常）。
#
# 用法: python shot_app.py <exe路径> <输出png> [等待秒数]
# ================================================
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

k32 = ctypes.windll.kernel32
u32 = ctypes.windll.user32
g32 = ctypes.windll.gdi32

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_TERMINATE = 0x0001
EXE = "kanseki-app.exe"

PW_RENDERFULLCONTENT = 0x00000002
SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wt.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
        ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD),
    ]


def snapshot():
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    pe = PROCESSENTRY32()
    pe.dwSize = ctypes.sizeof(PROCESSENTRY32)
    out = []
    ok = k32.Process32First(snap, ctypes.byref(pe))
    while ok:
        out.append((pe.th32ProcessID, pe.szExeFile.decode("gbk", "replace")))
        ok = k32.Process32Next(snap, ctypes.byref(pe))
    k32.CloseHandle(snap)
    return out


def app_pids():
    return [p for p, n in snapshot() if n.lower() == EXE.lower()]


def kill_all():
    n = 0
    for pid in app_pids():
        h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if h:
            k32.TerminateProcess(h, 1)
            k32.CloseHandle(h)
            n += 1
    return n


def find_window(pid=None):
    found = []

    def cb(h, l):
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(h, buf, 512)
        t = buf.value
        if t and ("古代史" in t or "汉籍" in t):
            wp = wt.DWORD()
            u32.GetWindowThreadProcessId(h, ctypes.byref(wp))
            if pid is None or wp.value == pid:
                found.append((h, t, wp.value))
        return True

    u32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(cb), 0)
    return found


def capture(hwnd, out_path):
    """优先用屏幕抓取（WebView2 走 DirectComposition，
    PrintWindow 常抓到空白）；失败再退回 PrintWindow。"""
    # Windows 句柄在 64 位下是 64 位宽，若不声明 restype 会被截断成 int32，
    # 传给 gdi32 时 ctypes 无法转换 → "Don't know how to convert parameter 1"。
    u32.GetDC.restype = ctypes.c_void_p
    u32.GetDC.argtypes = [ctypes.c_void_p]
    u32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    g32.CreateCompatibleDC.restype = ctypes.c_void_p
    g32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    g32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    g32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    g32.SelectObject.restype = ctypes.c_void_p
    g32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    g32.DeleteObject.argtypes = [ctypes.c_void_p]
    g32.DeleteDC.argtypes = [ctypes.c_void_p]

    r = wt.RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    if w <= 0 or h <= 0:
        print("!! 窗口尺寸异常:", w, h)
        return False

    # 强制置顶并激活，确保屏幕抓取拿到的是本窗口而非遮挡窗口
    HWND_TOPMOST = -1
    SWP_NOSIZE, SWP_NOMOVE, SWP_SHOWWINDOW = 0x0001, 0x0002, 0x0040
    u32.ShowWindow(hwnd, 9)  # SW_RESTORE
    u32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                     SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW)
    u32.SetForegroundWindow(hwnd)
    u32.BringWindowToTop(hwnd)
    time.sleep(1.5)

    # 抓取前重新读一次窗口位置（置顶后可能已改变）
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top

    # --- 屏幕 DC 抓取窗口所在区域 ---
    screen = u32.GetDC(0)
    memdc = g32.CreateCompatibleDC(screen)
    bmp = g32.CreateCompatibleBitmap(screen, w, h)
    g32.SelectObject(memdc, bmp)
    ok = g32.BitBlt(memdc, 0, 0, w, h, screen, r.left, r.top, SRCCOPY)

    bi = BITMAPINFOHEADER()
    bi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.biWidth = w
    bi.biHeight = -h  # top-down
    bi.biPlanes = 1
    bi.biBitCount = 32
    bi.biCompression = 0

    buf = ctypes.create_string_buffer(w * h * 4)
    g32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bi), DIB_RGB_COLORS)

    g32.DeleteObject(bmp)
    g32.DeleteDC(memdc)
    u32.ReleaseDC(0, screen)

    if not ok:
        print("!! BitBlt 返回 0")
        return False

    from PIL import Image
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    img.save(out_path)

    # 分区域统计，判断渲染情况
    px = list(img.convert("L").get_flattened_data()) if hasattr(img.convert("L"), "get_flattened_data") else list(img.convert("L").getdata())
    total = w * h
    dark = sum(1 for v in px if v < 40)
    mid = sum(1 for v in px if 40 <= v < 215)
    print(f"   保存 {out_path}  {w}x{h}  暗={dark/total:.1%} 中灰={mid/total:.1%}")
    return True


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else ""
    out = sys.argv[2] if len(sys.argv) > 2 else "app_shot.png"
    wait = int(sys.argv[3]) if len(sys.argv) > 3 else 14

    if not exe or not os.path.exists(exe):
        print("!! exe 不存在:", exe)
        return 2

    n = kill_all()
    if n:
        print("已清理残留:", n)
        time.sleep(2)

    print("启动:", exe)
    p = subprocess.Popen([exe], cwd=os.path.dirname(exe))
    time.sleep(wait)

    ws = find_window(p.pid)
    if not ws:
        print("!! 未找到窗口")
        print("存活:", app_pids())
        kill_all()
        return 1

    hwnd, title, pid = ws[0]
    print(f"窗口: pid={pid} title={title!r} hung={bool(u32.IsHungAppWindow(hwnd))}")
    u32.SetForegroundWindow(hwnd)
    time.sleep(1.5)
    capture(hwnd, out)

    print("结束进程数:", kill_all())
    return 0


if __name__ == "__main__":
    sys.exit(main())
