# ================================================
# scripts/test_single_instance.py — 单实例保护验证
# -------------------------------------------------
# 验证 V0.8 崩溃修复的核心机制：
#   1) 首次启动 → 正常出窗口
#   2) 重复启动 N 次 → kanseki-app.exe 进程数恒为 1
#      （修复前会叠加多个实例争抢 WebView2 数据目录 → 崩溃）
#   3) 重复启动期间不产生崩溃转储
#   4) 重复启动后原窗口仍存活、可响应
#
# 用法：
#   python test_single_instance.py <exe路径>
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
EXE = "kanseki-app.exe"


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
    return [pid for pid, name in snapshot() if name.lower() == EXE.lower()]


def kill_all():
    n = 0
    for pid in app_pids():
        h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if h:
            k32.TerminateProcess(h, 1)
            k32.CloseHandle(h)
            n += 1
    return n


def main_window():
    """返回标题匹配的可见顶层窗口，或 None。"""
    found = []

    def cb(h, l):
        buf = ctypes.create_unicode_buffer(512)
        u32.GetWindowTextW(h, buf, 512)
        t = buf.value
        if t and ("古代史" in t or "汉籍" in t):
            pid = wt.DWORD()
            u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
            found.append({
                "hwnd": h,
                "pid": pid.value,
                "title": t,
                "visible": bool(u32.IsWindowVisible(h)),
                "hung": bool(u32.IsHungAppWindow(h)),
            })
        return True

    u32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(cb), 0)
    return found[0] if found else None


def dumps():
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""),
                        "cn.kanseki.catalog", "EBWebView", "Crashpad", "reports")
    return set(glob(os.path.join(base, "*.dmp")))


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else ""
    if not exe or not os.path.exists(exe):
        print("!! exe 不存在:", exe)
        return 2

    results = []

    def check(name, cond, extra=""):
        results.append((cond, name, extra))
        print(("PASS" if cond else "FAIL") + " | " + name + ((" | " + extra) if extra else ""))

    before = dumps()
    print("启动前崩溃转储数:", len(before))

    n = kill_all()
    if n:
        print("已清理残留进程:", n, "个")
        time.sleep(2)

    # ---------- 1. 首次启动 ----------
    print("\n[1] 首次启动")
    p1 = subprocess.Popen([exe], cwd=os.path.dirname(exe))
    time.sleep(12)  # 等 WebView2 初始化完成
    w1 = main_window()
    check("首次启动出现窗口", w1 is not None, (w1 or {}).get("title", "无窗口"))
    check("窗口进程即为启动进程", bool(w1) and w1["pid"] == p1.pid,
          f"winPid={w1['pid'] if w1 else '?'} spawnPid={p1.pid}" if w1 else "")
    pids1 = app_pids()
    check("首次启动进程数 = 1", len(pids1) == 1, f"pids={pids1}")

    # ---------- 2. 重复启动 ----------
    print("\n[2] 重复启动 4 次（修复前会叠加出多个实例）")
    for i in range(4):
        subprocess.Popen([exe], cwd=os.path.dirname(exe))
        time.sleep(2.5)
        cur = app_pids()
        check(f"第 {i+1} 次重复启动后进程数仍 = 1", len(cur) == 1, f"pids={cur}")

    time.sleep(3)

    # ---------- 3. 原窗口仍正常 ----------
    print("\n[3] 原窗口状态")
    w2 = main_window()
    check("原窗口仍存在", w2 is not None)
    check("原窗口仍可见", bool(w2) and w2["visible"], str(w2))
    check("原窗口未无响应", bool(w2) and not w2["hung"], str(w2))
    check("窗口仍是首个进程的", bool(w2) and w2["pid"] == p1.pid,
          f"pid={w2['pid'] if w2 else '?'} 期望={p1.pid}")
    check("进程未退出", p1.poll() is None, f"returncode={p1.poll()}")

    # ---------- 4. 崩溃转储 ----------
    print("\n[4] 崩溃转储")
    new = dumps() - before
    check("重复启动期间无新增崩溃转储", len(new) == 0,
          "、".join(os.path.basename(f) for f in sorted(new)) or "无")

    # ---------- 收尾 ----------
    print("\n[清理]")
    print("结束进程数:", kill_all())
    time.sleep(1)

    fail = sum(1 for c, _, _ in results if not c)
    print(f"\n==== 单实例保护验证: {len(results) - fail} 通过, {fail} 失败 ====")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
