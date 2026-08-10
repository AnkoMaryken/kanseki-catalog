import json, re

with open('D:/WorkBuddy空间/2026-08-01-13-40-21/doc2023_data.json', 'r', encoding='utf-8') as f:
    paras2023 = json.load(f)
with open('D:/WorkBuddy空间/2026-08-01-13-40-21/doc2025_data.json', 'r', encoding='utf-8') as f:
    paras2025 = json.load(f)
with open('D:/WorkBuddy空间/2026-08-01-13-40-21/catalog_data.json', 'r', encoding='utf-8') as f:
    catparas = json.load(f)

def escape_js(s):
    return s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '<br>').replace('\r', '')

# Detect if a paragraph is a section heading
def is_heading(text, is_styled_heading):
    if is_styled_heading:
        return True
    # Pattern-based detection for numbered/lettered sections
    patterns = [
        r'^[一二三四五六七八九十]+[、，．.]',
        r'^\d+[\.\、]',
        r'^[（(]\d+[）)]',
        r'^[①②③④⑤⑥⑦⑧⑨⑩]',
    ]
    for pat in patterns:
        if re.match(pat, text):
            return True
    # 2025 doc has List Paragraph styled section titles
    return False

# ==========================================
# Build docs as flat article with TOC markers
# ==========================================
def build_doc_sections(paras):
    """Convert flat paragraphs into structured sections with TOC"""
    result = []
    i = 0
    while i < len(paras):
        p = paras[i]
        text = p['text']
        styled_heading = 'List' in p.get('style', '') or 'Heading' in p.get('style', '')
        
        if is_heading(text, styled_heading):
            # This is a section header - collect all content until next heading
            content = []
            j = i + 1
            while j < len(paras) and not is_heading(paras[j]['text'], 'List' in paras[j].get('style', '') or 'Heading' in paras[j].get('style', '')):
                txt = paras[j]['text']
                # Detect examples (indented or special format)
                if txt.startswith('例') or txt.startswith('如') or txt.startswith('※'):
                    content.append(f'<div class="doc-example">{escape_js(txt)}</div>')
                else:
                    content.append(f'<p>{escape_js(txt)}</p>')
                j += 1
            
            result.append({
                'title': text,
                'id': f's{len(result)}',
                'html': '<br>'.join(content) if content else '<p>' + escape_js(text) + '</p>'
            })
            i = j
        else:
            # Standalone paragraph without heading
            result.append({
                'title': text[:30] + ('…' if len(text) > 30 else ''),
                'id': f's{len(result)}',
                'html': '<p>' + escape_js(text) + '</p>'
            })
            i += 1
    return result

doc2023 = build_doc_sections(paras2023)
doc2025 = build_doc_sections(paras2025)

# ==========================================
# Build catalog tree
# ==========================================
# The catalog document is flat: each paragraph is a category name
# We need to detect hierarchy:
# L1: 經部, 史部, 子部, 集部, 類叢部, 附新學類
# L2: 易類, 書類, 詩類, etc. (no 之屬 suffix)
# L3: 正文之屬, 傳說之屬, etc. (has 之屬/之部 suffix)

cat_tree = {}
cur_l1 = None
cur_l2 = None

for p in catparas:
    text = p['text']
    if text in ['漢文古籍分類表', '（徵求意見稿）']:
        continue
    
    # Detect L1
    if re.match(r'^(經部|史部|子部|集部|類叢部|附新學類)$', text):
        cur_l1 = text
        cat_tree[cur_l1] = {}
        cur_l2 = None
        continue
    
    if not cur_l1:
        continue
    
    # Detect L2 (category without 之屬)
    if '之屬' not in text and '之部' not in text:
        cur_l2 = text
        cat_tree[cur_l1][cur_l2] = []
        continue
    
    # L3 (has 之屬 or 之部)
    if cur_l2:
        cat_tree[cur_l1][cur_l2].append(text)
    else:
        # L3 directly under L1
        if '_direct' not in cat_tree[cur_l1]:
            cat_tree[cur_l1]['_direct'] = []
        cat_tree[cur_l1]['_direct'].append(text)

# Clean up: remove _direct from output, merge into proper structure
for l1 in cat_tree:
    if '_direct' in cat_tree[l1]:
        for item in cat_tree[l1]['_direct']:
            if item not in cat_tree[l1]:
                cat_tree[l1][item] = []
        del cat_tree[l1]['_direct']

# ==========================================
# Generate JS
# ==========================================
js = '// Auto-generated cataloging data\n\n'
js += 'const DOC2023 = [\n'
for s in doc2023:
    js += f"  {{id:'{s['id']}', title:'{escape_js(s['title'])}', html:'{s['html']}'}},\n"
js += '];\n\n'

js += 'const DOC2025 = [\n'
for s in doc2025:
    js += f"  {{id:'{s['id']}', title:'{escape_js(s['title'])}', html:'{s['html']}'}},\n"
js += '];\n\n'

js += 'const CATALOG_TREE = {\n'
for l1, l2map in cat_tree.items():
    js += f"  '{escape_js(l1)}': {{\n"
    for l2, l3list in l2map.items():
        l3str = ', '.join([f"'{escape_js(x)}'" for x in l3list])
        js += f"    '{escape_js(l2)}': [{l3str}],\n"
    js += '  },\n'
js += '};\n'

# Also generate plain text for search
js += '\nconst DOC2023_FLAT = '
js += json.dumps([p['text'] for p in paras2023], ensure_ascii=False)
js += ';\nconst DOC2025_FLAT = '
js += json.dumps([p['text'] for p in paras2025], ensure_ascii=False)
js += ';\n'

with open('D:/WorkBuddy空间/2026-08-01-13-40-21/catalog_data.js', 'w', encoding='utf-8') as f:
    f.write(js)

print(f'Doc2023: {len(doc2023)} sections')
print(f'Doc2025: {len(doc2025)} sections')
total_cat = sum(len(l2) for v in cat_tree.values() for l2 in v)
print(f'Catalog: {len(cat_tree)} L1, {total_cat} L2 categories')
for l1, l2map in cat_tree.items():
    print(f'  {l1}: {list(l2map.keys())[:5]}...')
print('Done!')
