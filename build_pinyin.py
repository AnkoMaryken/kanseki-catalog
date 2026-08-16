# -*- coding: utf-8 -*-
"""
build_pinyin.py — 生成 pinyin_data.js (v2.0 拼音检索数据)
==========================================================
从 index.html 的 CN_DYNASTIES / JP_PERIODS 数据结构中提取:
  - 中国: 朝代名 + 年号名 (含 subEras) + 君主名
  - 日本: 时代名 + 年号名 (含 subEras) + 天皇名
用 pypinyin 为每个词生成: 全拼 (多音字以 | 分隔)、首字母、声母。
输出 pinyin_data.js: const PINYIN_MAP = {...}  (字 -> 读音数组, 无多音时为空数组)
                  const PINYIN_TERMS = [{w, py, initials, initialsLower}...]
用法: python build_pinyin.py
"""
import json, re, sys, argparse
from pathlib import Path

# 参数化根目录：默认脚本所在目录，可用 --root 覆盖（跨平台迁移用）
ROOT = Path(__file__).resolve().parent
_parser = argparse.ArgumentParser(description='生成 pinyin_data.js（拼音检索数据）')
_parser.add_argument('--root', default=str(ROOT), help='项目根目录（默认脚本所在目录）')
_args = _parser.parse_args()
ROOT = Path(_args.root)

try:
    from pypinyin import pinyin, Style, lazy_pinyin
except ImportError:
    sys.exit('缺少 pypinyin, 请先 pip install pypinyin')

# ---------------------------------------------------------------
# 1. 提取 CN_DYNASTIES / JP_PERIODS 数组文本 (从 index.html)
# ---------------------------------------------------------------
html = (ROOT / 'index.html').read_text(encoding='utf-8')

def extract_array(name):
    m = re.search(r'const\s+' + name + r'\s*=\s*\[', html)
    if not m:
        sys.exit(f'未找到 {name}')
    # 用大括号配对找到数组结束
    start = m.end() - 1
    depth = 0
    i = start
    while i < len(html):
        c = html[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                return html[start:i + 1]
        i += 1
    sys.exit(f'{name} 数组未闭合')

# ---------------------------------------------------------------
# 2. 解析对象列表: 提取 { key:val, ... } 对象
# ---------------------------------------------------------------
def parse_objects(text):
    """返回对象原文列表"""
    objs = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == '{':
            depth = 0
            j = i
            while j < n:
                if text[j] == '{':
                    depth += 1
                elif text[j] == '}':
                    depth -= 1
                    if depth == 0:
                        objs.append(text[i:j + 1])
                        i = j + 1
                        break
                j += 1
        i += 1
    return objs

def get_field(obj_text, field):
    """从对象原文提取字段值 (字符串或数组), 返回字符串值或 None"""
    # 匹配 field:'xxx' 或 field:'xxx' 带逗号
    m = re.search(r"\b" + re.escape(field) + r"\s*:\s*'((?:[^'\\]|\\.)*)'", obj_text)
    if m:
        return m.group(1).replace("\\'", "'")
    return None

def extract_balanced(text, open_pos):
    """从 open_pos 的 '[' 开始, 括号配对找到匹配的 ']', 返回含括号的完整数组文本"""
    depth = 0
    i = open_pos
    n = len(text)
    while i < n:
        c = text[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                return text[open_pos:i + 1]
        i += 1
    return None

def find_field_array(obj_text, field):
    """找字段对应的数组 (field:[...]), 返回数组完整文本或 None"""
    m = re.search(r"\b" + re.escape(field) + r"\s*:\s*\[", obj_text)
    if not m:
        return None
    return extract_balanced(obj_text, m.end() - 1)

def get_sub_eras(obj_text):
    """提取 subEras 数组内的 name 列表"""
    arr = find_field_array(obj_text, 'subEras')
    if not arr:
        return []
    inner = arr[1:-1]
    return [get_field(o, 'name') for o in parse_objects(inner) if get_field(o, 'name')]

# ---------------------------------------------------------------
# 3. 遍历朝代 -> 年号 (含 subEras) + 君主; 日本时代 -> 年号 + 天皇
# ---------------------------------------------------------------
terms = []   # {w, kind, dyn}
seen = set()

def add(w, kind, dyn=''):
    if not w or not w.strip():
        return
    w = w.strip()
    key = (w, kind, dyn)
    if key in seen:
        return
    seen.add(key)
    terms.append({'w': w, 'kind': kind, 'dyn': dyn})

cn_src = extract_array('CN_DYNASTIES')
for d in parse_objects(cn_src):
    dname = get_field(d, 'name')
    if not dname:
        continue
    add(dname, 'dynasty')
    # 年号
    em = find_field_array(d, 'eras')
    if not em:
        continue
    for e in parse_objects(em[1:-1]):
        ename = get_field(e, 'name')
        if ename and ename != '—':
            add(ename, 'era', dname)
        for sub in get_sub_eras(e):
            if sub and sub != '—':
                add(sub, 'era', dname)
        ruler = get_field(e, 'ruler')
        if ruler:
            # 君主名: 取括号前的主名 + 括号内人名, 并去掉"天皇"后缀
            main = ruler.split('(')[0].strip()
            inner = ruler.split('(')[1].split(')')[0].strip() if '(' in ruler else ''
            for nm in (main, inner):
                if nm and len(nm) <= 12:
                    add(nm, 'ruler', dname)

jp_src = extract_array('JP_PERIODS')
for p in parse_objects(jp_src):
    pname = get_field(p, 'name')
    if not pname:
        continue
    add(pname, 'period')
    em = find_field_array(p, 'eras')
    if not em:
        continue
    for e in parse_objects(em[1:-1]):
        ename = get_field(e, 'name')
        if ename and ename != '—':
            add(ename, 'jpEra', pname)
        for sub in get_sub_eras(e):
            if sub and sub != '—':
                add(sub, 'jpEra', pname)
        ruler = get_field(e, 'ruler')
        if ruler:
            for part in re.split(r'[/、]', ruler):
                part = part.strip().replace('天皇', '')
                if part and len(part) <= 12:
                    add(part, 'jpRuler', pname)

# ---------------------------------------------------------------
# 4. pypinyin 生成读音
# ---------------------------------------------------------------
def py_full(word):
    """每字读音 (主读音, 无多音字歧义): [['xuan'],['wang']]"""
    return [[p] for p in lazy_pinyin(word)]

def initials(word):
    """每字首字母 (主读音): [['x'],['w']]"""
    return [[p[0]] for p in lazy_pinyin(word)]

# 字级映射: 记录常用多音字候选读音 (主读音之外的常见读音, 用于查询端扩展)
# 例如"景"主读 jing, 但"景"作姓时可读 ying — 这里只保留主读音, 避免歧义干扰
char_map = {}

def reg_char(c, pys):
    if c not in char_map:
        char_map[c] = []
    for p in pys:
        if p and p not in char_map[c]:
            char_map[c].append(p)

entries = []
for t in terms:
    w = t['w']
    full = py_full(w)
    init = initials(w)
    entries.append({
        'w': w, 'k': t['kind'], 'd': t['dyn'],
        'py': full, 'i': init
    })

# ---------------------------------------------------------------
# 5. 输出 pinyin_data.js
# ---------------------------------------------------------------
def js_str(s):
    return json.dumps(s, ensure_ascii=False)

lines = []
lines.append('// ================================================')
lines.append('// pinyin_data.js — 拼音检索数据 (v2.0, 由 build_pinyin.py 生成)')
lines.append('// 内容: 全部年号/朝代/时代/君主 的拼音全拼/首字母')
lines.append('// py 为每字读音数组 (主读音, 无多音歧义); i 为每字首字母数组')
lines.append('// ================================================')
lines.append('const PINYIN_TERMS = [')
for e in entries:
    lines.append('  {w:' + js_str(e['w']) + ',k:' + js_str(e['k']) + ',d:' + js_str(e['d'])
                + ',py:' + js_str(e['py']) + ',i:' + js_str(e['i']) + '},')
lines.append('];')
lines.append('')

out = ROOT / 'pinyin_data.js'
out.write_text('\n'.join(lines), encoding='utf-8')
print(f'写入 {out}  ({len(entries)} 词条, 多音字 {len(char_map)} 个)')

# 调试: 打印几个样例
for e in entries[:8]:
    print(' ', e['w'], '|', e['py'], '|', e['i'], '|', e['d'])
