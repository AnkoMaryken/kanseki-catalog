# ================================================
# scripts/monitor_app.py — 桌面版崩溃观测工具
# -------------------------------------------------
# 用途：启动 kanseki-app.exe 后持续轮询，记录
#   - 进程是否存活、窗口是否出现/响应
#   - 期间是否新增 WebView2 崩溃转储（Crashpad reports）
# 用于区分「真崩溃」与「被任务管理回收」。
#
# 用法：
#   python monitor_app.py <exe路径> [轮询秒数] [间隔秒]
# ================================================
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time
from glob import glob

k32 = ctypes.windll.kernel32
u32 = ctypes.windll.user32

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_TERMINATE = 0x0001


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


def snapshot():
    """返回 [(pid, exe名)]，用 Toolhelp 快照，避免 tasklist 的 GBK/僵尸条目问题。"""
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


def kill_all(exe_name):
    n = 0
    for pid, name in snapshot():
        if name.lower() == exe_name.lower():
            h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
            if h:
                k32.TerminateProcess(h, 1)
                k32.CloseHandle(h)
                n += 1
    return n


def windows():
    """返回标题匹配的顶层窗口 [(pid, title, visible, hung, w, h)]"""
    res = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def cb(h, l):
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(h, buf, 512)
        t = buf.value
        if t and ("古代史" in t or "汉籍" in t):
            pid = wt.DWORD()
            u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
            r = wt.RECT()
            u32.GetWindowRect(h, ctypes.byref(r))
            res.append(
                {
                    "pid": pid.value,
                    "title": t,
                    "visible": bool(u32.IsWindowVisible(h)),
                    "hung": bool(u32.IsHungAppWindow(h)),
                    "w": r.right - r.left,
                    "h": r.bottom - r.top,
                }
            )
        return True

    u32.EnumWindows(WNDENUMPROC(cb), 0)
    return res


def dumps():
    base = os.path.join(
        os.environ.get("LOCALAPPDATA", ""), "cn.kanseki.catalog", "EBWebView", "Crashpad", "reports"
    )
    return set(glob(os.path.join(base, "*.dmp")))


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else ""
    total = int(sys.argv[2]) if len(sys.argv) > 2 else 180
    step = int(sys.argv[3]) if len(sys.argv) > 3 else 6

    if not exe or not os.path.exists(exe):
        print("!! exe 不存在:", exe)
        return 2

    before = dumps()
    print("启动前转储数:", len(before))

    killed = kill_all("kanseki-app.exe")
    if killed:
        print("已清理残留进程:", killed, "个")
        time.sleep(2)

    print("启动:", exe)
    p = subprocess.Popen([exe], cwd=os.path.dirname(exe))
    print("新进程 PID =", p.pid)

    start = time.time()
    first_seen = None
    last_seen = None
    died_at = None

    while time.time() - start < total:
        el = time.time() - start
        ws = windows()
        alive = any(pid == p.pid for pid, _ in snapshot())
        if ws:
            first_seen = first_seen or el
            last_seen = el
        if not alive:
            died_at = el
            break
        if ws:
            w = ws[0]
            print(f"[{el:6.1f}s] pid={w['pid']} vis={w['visible']} hung={w['hung']} {w['w']}x{w['h']}")
        else:
            print(f"[{el:6.1f}s] 进程在但无窗口")
        time.sleep(step)

    after = dumps()
    new = after - before
    print("\n===== 观测结果 =====")
    print(f"窗口首次出现: {first_seen if first_seen is None else round(first_seen,1)}s")
    print(f"窗口最后可见: {last_seen if last_seen is None else round(last_seen,1)}s")
    print(f"进程结束于:   {died_at if died_at is None else round(died_at,1)}s" + ("（观测期内未结束）" if died_at is None else ""))
    print(f"新增崩溃转储: {len(new)} 个")
    for f in sorted(new):
        print("   ", os.path.basename(f), os.path.getsize(f), "字节")

    # 收尾：清掉本次启动的实例
    kill_all("kanseki-app.exe")
    return 0


if __name__ == "__main__":
    sys.exit(main())
