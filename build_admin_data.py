# -*- coding: utf-8 -*-
"""
build_admin_data.py — 从 index.html 提取 CN_DYNASTIES / JP_PERIODS 数组，
生成 admin.html 使用的 site-data.js（V6.0 管理员工作台数据源）。
用法: python build_admin_data.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INDEX = ROOT / 'index.html'
OUT = ROOT / 'site-data.js'


def extract_array(text: str, decl: str) -> str:
    """提取 `decl = [` 到与之配平的 `];` 之间的完整文本（含数组字面量）。"""
    m = re.search(re.escape(decl) + r'\s*=\s*\[', text)
    if not m:
        raise RuntimeError(f'未找到声明: {decl}')
    start = m.end() - 1  # 指向 '['
    depth = 0
    i = start
    in_str = False
    quote = ''
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == quote:
                in_str = False
        else:
            if ch in ('"', "'", '`'):
                in_str = True
                quote = ch
            elif ch == '[':
                depth += 1
            elif ch == ']':
                depth -= 1
                if depth == 0:
                    return text[start:i + 1]
        i += 1
    raise RuntimeError(f'数组未闭合: {decl}')


def main() -> int:
    html = INDEX.read_text(encoding='utf-8')
    cn = extract_array(html, 'const CN_DYNASTIES')
    jp = extract_array(html, 'const JP_PERIODS')

    # V8.0: 周边政权 (OTHER_STATES) 一并提取
    ot_part = ''
    if 'const OTHER_STATES' in html:
        ot = extract_array(html, 'const OTHER_STATES')
        ot_part = '\nconst OTHER_STATES = ' + ot + ';\n'

    # 与 index.html 中定义方式一致：const 声明
    out = (
        '// ================================================\n'
        '// site-data.js — 管理员工作台数据源 (由 build_admin_data.py 生成)\n'
        '// 数据提取自 index.html (CN_DYNASTIES / JP_PERIODS / OTHER_STATES)，勿手工修改。\n'
        '// ================================================\n'
        'const CN_DYNASTIES = ' + cn + ';\n\n'
        'const JP_PERIODS = ' + jp + ';' + ot_part + '\n'
    )
    OUT.write_text(out, encoding='utf-8')
    print(f'OK: {OUT.name} ({OUT.stat().st_size} bytes)')
    print(f'  CN_DYNASTIES 数组字符数: {len(cn)}')
    print(f'  JP_PERIODS  数组字符数: {len(jp)}')
    if ot_part:
        print(f'  OTHER_STATES 数组字符数: {len(ot_part)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
