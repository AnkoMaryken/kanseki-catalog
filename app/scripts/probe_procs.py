# ================================================
# app/scripts/probe_procs.py — 观测 WebView2 子进程构成
# -------------------------------------------------
# 假设：本机安全策略拦截沙箱子进程。--disable-gpu-sandbox 只救活了 GPU 进程，
#   而承担 localStorage 落盘的 utility（storage service）进程仍被拦截，
#   导致写入只在渲染进程内存里可见、跨调用即丢。
#
# 本脚本分别以不同参数启动 exe，列出「直属本应用的」WebView2 子进程类型与数量，
# 对比 --no-sandbox（存储正常）与 --disable-gpu-sandbox（存储失效）的进程构成差异。
#
# 用法: python probe_procs.py <exe路径>
# ================================================
import ctypes
import ctypes.wintypes as wt
import os
import subprocess
import sys
import time

k32 = ctypes.windll.kernel32
k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
k32.OpenProcess.restype = ctypes.c_void_p
PROCESS_TERMINATE = 0x0001


class PE(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


def snap():
    s = k32.CreateToolhelp32Snapshot(2, 0)
    pe = PE()
    pe.dwSize = ctypes.sizeof(PE)
    out = []
    ok = k32.Process32First(s, ctypes.byref(pe))
    while ok:
        out.append((pe.th32ProcessID, pe.szExeFile.decode("gbk", "replace"),
                    pe.th32ParentProcessID))
        ok = k32.Process32Next(s, ctypes.byref(pe))
    k32.CloseHandle(s)
    return out


def kill(pid):
    h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if h:
        k32.TerminateProcess(h, 1)
        k32.CloseHandle(h)
        return True
    return False


def clean_own():
    """只清理本应用及其直属 WebView2 子进程"""
    rows = snap()
    apps = [p for p, n, _ in rows if n.lower() == "kanseki-app.exe"]
    kids = set()
    for a in apps:
        kids |= {p for p, n, par in rows if n.lower() == "msedgewebview2.exe" and par == a}
    n = 0
    for pid, name, _ in rows:
        if name.lower() == "kanseki-app.exe" or (pid in kids and name.lower() == "msedgewebview2.exe"):
            if kill(pid):
                n += 1
    return n


def descendants(root_pid):
    """收集 root 的全部后代 pid（含孙辈）"""
    rows = snap()
    by_parent = {}
    for pid, name, par in rows:
        by_parent.setdefault(par, []).append((pid, name))
    out = []
    stack = [root_pid]
    while stack:
        cur = stack.pop()
        for pid, name in by_parent.get(cur, []):
            out.append((pid, name, cur))
            stack.append(pid)
    return out


CASES = [
    ("GPU沙箱（存储失效）", "--disable-gpu-sandbox"),
    ("免沙箱（存储正常）", "--no-sandbox"),
    ("单进程", "--single-process"),
]


def main():
    exe = sys.argv[1] if len(sys.argv) > 1 else ""
    if not exe or not os.path.exists(exe):
        print("!! exe 不存在:", exe)
        return 2

    for title, args in CASES:
        print(f"\n{'='*62}\n== {title}   [{args}]\n{'='*62}")
        clean_own()
        time.sleep(1.5)

        env = dict(os.environ)
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
                  "ALL_PROXY", "all_proxy", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"):
            env.pop(k, None)
        env["NO_PROXY"] = "*"
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = args

        p = subprocess.Popen([exe], cwd=os.path.dirname(exe), env=env)

        # 观察 20 秒内后代进程构成变化
        for t in (5, 10, 15, 20):
            time.sleep(5)
            des = descendants(p.pid)
            wv = [(pid, par) for pid, name, par in des if name.lower() == "msedgewebview2.exe"]
            print(f"  [T+{t:2}s] 存活={p.poll() is None}  WebView2 后代数={len(wv)}")

        des = descendants(p.pid)
        wv = [(pid, par) for pid, name, par in des if name.lower() == "msedgewebview2.exe"]
        print(f"  最终 WebView2 后代 = {len(wv)}")

        # 读命令行区分进程类型（utility / renderer / gpu-process）
        try:
            import subprocess as sp
            out = sp.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter \"name='msedgewebview2.exe'\" | "
                 "ForEach-Object { \"$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)\" }"],
                capture_output=True, text=True, timeout=40,
            ).stdout
            types = {}
            pids = {pid for pid, _ in wv}
            for line in out.splitlines():
                parts = line.split("|", 2)
                if len(parts) < 3:
                    continue
                try:
                    pid = int(parts[0])
                except ValueError:
                    continue
                if pid not in pids:
                    continue
                cl = parts[2]
                ty = "browser"
                for token in ("--type=gpu-process", "--type=renderer", "--type=utility",
                              "--type=crashpad-handler", "--type=broker"):
                    if token in cl:
                        ty = token.split("=")[1]
                        break
                sub = ""
                if "storage" in cl.lower():
                    sub = "(storage)"
                elif ty == "utility" and "--utility-sub-type=" in cl:
                    sub = "(" + cl.split("--utility-sub-type=")[1].split()[0] + ")"
                types[ty + sub] = types.get(ty + sub, 0) + 1
            print(f"  进程类型分布: {types}")
        except Exception as e:
            print("  类型解析失败:", str(e)[:80])

        clean_own()
        time.sleep(1.5)

    return 0


if __name__ == "__main__":
    sys.exit(main())
