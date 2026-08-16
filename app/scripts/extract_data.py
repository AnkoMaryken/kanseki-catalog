# -*- coding: utf-8 -*-
"""
extract_data.py — 从静态站 index.html 提取 CN_DYNASTIES / JP_PERIODS 数据区
=====================================================================
输出: app/src/js/data/dynasties.mjs
  export const CN_DYNASTIES = [...];
  export const JP_PERIODS = [...];
数据变更时只需重跑本脚本（数据单一源仍是 index.html）。

用法: python extract_data.py [--root 项目根目录] [--html index.html路径] [--out 输出mjs路径]
"""
import re
import sys
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # app/
_parser = argparse.ArgumentParser(description='提取朝代/时代数据为 ESM 模块')
_parser.add_argument('--root', default=str(ROOT), help='app 目录（默认脚本上级）')
_parser.add_argument('--html', default=None, help='index.html 路径（默认项目根目录）')
_parser.add_argument('--out', default=None, help='输出 mjs 路径（默认 app/src/js/data/dynasties.mjs）')
_args = _parser.parse_args()

APP = Path(_args.root)
PROJECT = APP.parent  # 项目根（index.html 所在）
HTML = Path(_args.html) if _args.html else PROJECT / 'index.html'
OUT = Path(_args.out) if _args.out else APP / 'src' / 'js' / 'data' / 'dynasties.mjs'


def extract_array(name, text):
    """找到 const NAME = [ 并括号配对提取完整数组文本（复用 build_pinyin.py 逻辑）"""
    m = re.search(r'const\s+' + name + r'\s*=\s*\[', text)
    if not m:
        sys.exit(f'未找到 {name}')
    start = m.end() - 1
    depth = 0
    i = start
    n = len(text)
    while i < n:
        c = text[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    sys.exit(f'{name} 数组未闭合')


def main():
    html = HTML.read_text(encoding='utf-8')
    cn = extract_array('CN_DYNASTIES', html)
    jp = extract_array('JP_PERIODS', html)

    out = (
        '// ================================================\n'
        '// dynasties.mjs — 朝代/时代数据 (由 extract_data.py 生成, 勿手改)\n'
        '// 数据单一源: 静态站 index.html 的 CN_DYNASTIES / JP_PERIODS\n'
        '// ================================================\n'
        f'export const CN_DYNASTIES = {cn};\n\n'
        f'export const JP_PERIODS = {jp};\n'
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(out, encoding='utf-8')
    print(f'输出: {OUT}')
    print(f'CN_DYNASTIES 字符数: {len(cn)}, JP_PERIODS 字符数: {len(jp)}')


if __name__ == '__main__':
    main()
