# -*- coding: utf-8 -*-
"""
v1.4: 将用户提供的两份 Markdown 细则原文（.workbuddy/v14_doc2023.md / v14_doc2025.md）
转换为 catalog_data.js 的 DOC2023 / DOC2025 数组。

规则：
- 「」引号 → 全角双引号 “”
- **粗体** → <b>
- # 大标题 / 紧随的次标题 → 前两个 section（页面渲染时居中）
- ## 章节 → section（.stitle 标题）
- ### 子章节 → section（.stitle 标题）
- #### 小节 → html 内 <p class="doc-sub2">
- 编号行 ^数字. → 独立 <p>
- - 列表项 → <p class="doc-item">
- > 引用块 → <div class="doc-ex">（连续 > 行合并）
- ``` 代码块 → <pre class="doc-code">
- --- 分隔线忽略
- CATALOG_TREE 从现有 catalog_data.js 原样提取
- DOC2023_FLAT / DOC2025_FLAT 同步重新生成（每 section: title + 各块纯文本）
"""
import re, io
import argparse
from pathlib import Path

# 参数化根目录：默认脚本所在目录，可用 --root 覆盖（跨平台迁移用）
ROOT = Path(__file__).resolve().parent
_parser = argparse.ArgumentParser(description='由 Markdown 细则重建 catalog_data.js')
_parser.add_argument('--root', default=str(ROOT), help='项目根目录（默认脚本所在目录）')
_args = _parser.parse_args()
ROOT = Path(_args.root)

SRC2023 = ROOT / '.workbuddy' / 'v14_doc2023.md'
SRC2025 = ROOT / '.workbuddy' / 'v14_doc2025.md'
OLD_JS  = ROOT / 'catalog_data.js'
OUT_JS  = ROOT / 'catalog_data.js'

def esc(s):
    """HTML 转义（在 <b> 标签插入之后对文本段调用）"""
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def md_inline(text):
    """行内处理：**粗体** → <b>，其余转义"""
    parts = re.split(r'(\*\*[^*]+\*\*)', text)
    out = []
    for p in parts:
        if p.startswith('**') and p.endswith('**') and len(p) > 4:
            out.append('<b>' + esc(p[2:-2]) + '</b>')
        else:
            out.append(esc(p))
    return ''.join(out)

def quote_fix(s):
    """「」→ “”"""
    return s.replace('「', '“').replace('」', '”')

def js_str(s):
    """JS 单引号字符串转义（换行 → \\n 转义序列，保留在 pre 中）"""
    return s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n')

def parse_md(path):
    """解析 Markdown → (main_title, sub_title, sections)
    sections: [{title, blocks:[(kind, html, text)]}]
    kind: 'p' 段落 | 'sub2' 小节标题 | 'item' 列表项 | 'ex' 引用块 | 'code' 代码块
    text 为纯文本（FLAT 用，未转义）。"""
    with io.open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')

    main_title = None
    sub_title = None
    sections = []
    cur = None
    i, n = 0, len(lines)

    def new_sec(title):
        nonlocal cur
        cur = {'title': quote_fix(title.strip()), 'blocks': []}
        sections.append(cur)

    def add(kind, html, text):
        if cur is not None:
            cur['blocks'].append((kind, html, text))

    # ---- 大标题 / 次标题 ----
    while i < n and not lines[i].strip():
        i += 1
    if i < n and lines[i].startswith('# '):
        main_title = quote_fix(lines[i][2:].strip())
        i += 1
        while i < n and not lines[i].strip():
            i += 1
        if i < n and not lines[i].startswith('#'):
            sub_title = quote_fix(lines[i].strip())
            i += 1

    # ---- 正文 ----
    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped:                      # 空行
            i += 1
            continue
        if re.match(r'^-{3,}$', stripped):    # --- 分隔线
            i += 1
            continue
        if stripped.startswith('```'):        # 代码块
            i += 1
            code_lines = []
            while i < n and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i].rstrip('\n'))
                i += 1
            i += 1  # 跳过结束 ```
            raw = '\n'.join(code_lines)
            q = quote_fix(raw)
            add('code', '<pre class="doc-code">' + esc(q) + '</pre>', raw)
            continue
        if stripped.startswith('# '):
            # 防御：正文中出现一级标题（原文不会）
            new_sec(stripped[2:])
            i += 1
            continue
        m = re.match(r'^##+\s+(.*)$', line)
        if m:
            new_sec(m.group(1))
            i += 1
            continue
        if stripped.startswith('>'):          # 引用块：合并连续 > 行，空行分隔为多个块
            while i < n and lines[i].strip().startswith('>'):
                q_lines = []
                while i < n:
                    t = lines[i].strip()
                    if t.startswith('>'):
                        t = t[1:].strip()
                        if t:
                            q_lines.append(t)
                        else:
                            q_lines.append('')
                        i += 1
                    elif t == '':
                        # 引用块内的空行：结束当前块（外层会重新处理下一段）
                        break
                    else:
                        break
                while q_lines and q_lines[-1] == '':
                    q_lines.pop()
                txt = '\n'.join(q_lines)
                html_parts = []
                for ql in q_lines:
                    if ql:
                        html_parts.append('<p>' + md_inline(quote_fix(ql)) + '</p>')
                add('ex', '<div class="doc-ex">' + ''.join(html_parts) + '</div>', txt)
            continue
        if stripped.startswith('- '):         # 无序列表项
            item = stripped[2:].strip()
            add('item', '<p class="doc-item">' + md_inline(quote_fix(item)) + '</p>', item)
            i += 1
            continue
        if re.match(r'^\d+[.、]\s*', stripped) or re.match(r'^[①②③④⑤⑥⑦⑧⑨⑩]', stripped):
            # 编号行：独立成段（标题性），不与其后文本合并
            add('p', '<p>' + md_inline(quote_fix(stripped)) + '</p>', stripped)
            i += 1
            continue
        # 普通段落：合并连续非空非特殊行（<br> 分隔）
        buf = []
        while i < n:
            s = lines[i].strip()
            if not s or s.startswith('#') or s.startswith('>') or s.startswith('- ') or \
               re.match(r'^\d+[.、]\s*', s) or re.match(r'^[①②③④⑤⑥⑦⑧⑨⑩]', s) or \
               s.startswith('```') or re.match(r'^-{3,}$', s):
                break
            buf.append(s)
            i += 1
        if buf:
            txt = '\n'.join(buf)
            inner = '<br>'.join(md_inline(quote_fix(b)) for b in buf)
            add('p', '<p>' + inner + '</p>', txt)
        # 注意：while 内 break 时 i 未前进，外层循环会重新处理该行

    return main_title, sub_title, sections

def gen_doc_array(sections):
    """生成 DOC2023/DOC2025 数组 JS 文本与 FLAT 列表"""
    arr = []
    flat = []
    for idx, s in enumerate(sections):
        title_js = js_str(s['title'])
        html_parts = []
        for kind, html, text in s['blocks']:
            html_parts.append(html)
            flat.append(quote_fix(text))   # FLAT 也须经过引号转换
        html_js = js_str(''.join(html_parts))
        arr.append("  {id:'s%d', title:'%s', html:'%s'}" % (idx, title_js, html_js))
        flat.insert(0, s['title'])  # FLAT: 先 title 后各块
    return '[\n' + ',\n'.join(arr) + '\n]', flat

def main():
    # 1) 解析两份 md
    m23, s23, sec23 = parse_md(SRC2023)
    m25, s25, sec25 = parse_md(SRC2025)
    # 强制首位为 大标题/次标题 section
    sec23.insert(0, {'title': m23, 'blocks': []})
    sec23.insert(1, {'title': s23, 'blocks': []})
    sec25.insert(0, {'title': m25, 'blocks': []})
    sec25.insert(1, {'title': s25, 'blocks': []})

    # 2) 生成数组
    arr23, flat23 = gen_doc_array(sec23)
    arr25, flat25 = gen_doc_array(sec25)

    # 3) 提取旧文件中的 CATALOG_TREE（原样保留）
    with io.open(OLD_JS, encoding='utf-8') as f:
        old = f.read()
    mtree = re.search(r'const CATALOG_TREE = \{.*?\n\};', old, re.S)
    if not mtree:
        raise RuntimeError('CATALOG_TREE 未找到')
    tree = mtree.group(0)

    # 4) FLAT 数组 JS
    def flat_js(flat):
        return '[' + ', '.join('"%s"' % js_str(x) for x in flat) + ']'

    out = []
    out.append('// Auto-generated cataloging data (v1.4: 用户 Markdown 重建)')
    out.append('')
    out.append('const DOC2023 = ' + arr23 + ';')
    out.append('')
    out.append('const DOC2025 = ' + arr25 + ';')
    out.append('')
    out.append(tree)
    out.append('')
    out.append('const DOC2023_FLAT = ' + flat_js(flat23) + ';')
    out.append('const DOC2025_FLAT = ' + flat_js(flat25) + ';')
    out.append('')

    with io.open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))

    print('DOC2023 sections:', len(sec23))
    print('DOC2025 sections:', len(sec25))
    print('FLAT2023 items  :', len(flat23))
    print('FLAT2025 items  :', len(flat25))
    print('done.')

if __name__ == '__main__':
    main()
