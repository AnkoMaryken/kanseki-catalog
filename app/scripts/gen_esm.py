# -*- coding: utf-8 -*-
"""
gen_esm.py — 将静态站的全局 const 数据 JS 转换为 ES module (*.mjs)
=====================================================================
源文件（保持原样不动）:
  conv_tables.js   → S2T_MAP / T2S_MAP
  pinyin_data.js   → PINYIN_TERMS
  knowledge.js     → KNOWLEDGE_DATA
  catalog_data.js  → DOC2023 / DOC2025 / CATALOG_TREE / DOC2023_FLAT / DOC2025_FLAT
转换方式: 纯文本级替换 `const X = ` → `export const X = `（零语义变化）。
数据变更时重跑本脚本即可。

用法: python gen_esm.py [--root 项目根目录]
"""
import re
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # app/
_parser = argparse.ArgumentParser(description='将全局 const 数据 JS 转为 ESM')
_parser.add_argument('--root', default=str(ROOT), help='app 目录（默认脚本上级）')
_args = _parser.parse_args()

APP = Path(_args.root)
PROJECT = APP.parent
SRC_DIR = PROJECT
DST_DIR = APP / 'src' / 'js' / 'data'

# 源文件名 -> (ESM 文件名, 需转换的顶层 const 名列表)
# 顶层 const 名：用于把 `const X =` 精准替换为 `export const X =`（避免误改嵌套）
JOBS = [
    ('conv_tables.js', 'conv-tables.mjs', ['S2T_MAP', 'T2S_MAP']),
    ('pinyin_data.js', 'pinyin-terms.mjs', ['PINYIN_TERMS']),
    ('knowledge.js', 'knowledge-data.mjs', ['KNOWLEDGE_DATA']),
    ('catalog_data.js', 'catalog-data.mjs',
     ['DOC2023', 'DOC2025', 'CATALOG_TREE', 'DOC2023_FLAT', 'DOC2025_FLAT']),
]

# 顶层 const 匹配：行首（允许缩进0）+ 可选注释前缀后 + `const X =`
TOP_CONST_RE = re.compile(r'^(const\s+([A-Za-z_$][\w$]*)\s*=)', re.M)


def convert(src_path, dst_path, names):
    text = src_path.read_text(encoding='utf-8')
    wanted = set(names)

    def repl(m):
        name = m.group(2)
        if name in wanted:
            return 'export ' + m.group(1)
        return m.group(0)

    out = TOP_CONST_RE.sub(repl, text)
    # 文件头加来源说明
    header = (
        '// ================================================\n'
        f'// {dst_path.name} — 由 gen_esm.py 从静态站 {src_path.name} 转换生成\n'
        '// 数据单一源: 静态站文件, 请勿手改本文件\n'
        '// ================================================\n'
    )
    out = header + out
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_path.write_text(out, encoding='utf-8')
    exported = [n for n in names if re.search(rf'^export const {n}\s*=', out, re.M)]
    print(f'{src_path.name} -> {dst_path.name}  导出: {exported}')
    if len(exported) != len(names):
        missing = set(names) - set(exported)
        print(f'  ⚠️ 未导出: {missing}')
        return False
    return True


def main():
    ok = True
    for src_name, dst_name, names in JOBS:
        src = SRC_DIR / src_name
        if not src.exists():
            print(f'⚠️ 跳过（源不存在）: {src}')
            continue
        if not convert(src, DST_DIR / dst_name, names):
            ok = False
    print('完成。' if ok else '存在未导出项，请检查源文件。')


if __name__ == '__main__':
    main()
