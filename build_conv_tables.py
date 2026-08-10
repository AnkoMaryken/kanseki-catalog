# -*- coding: utf-8 -*-
"""
从 index.html 数据区提取文本，用 OpenCC 生成简繁转换映射表（上下文正确）。
生成文件: conv_tables.js  (S2T_MAP / T2S_MAP 两个对象)

修正规则（基于数据区语境审查）:
1. 数据区所有「历」均出现在年号/历法中 -> 繁体统一「曆」
2. 「高后」(吕后纪年年号) -> 保持「高后」, 不能转「高後」
3. 「汉冲帝」-> 「漢沖帝」(冲=沖), 不能用「衝」
"""
import re
import json
from opencc import OpenCC

SRC = r"D:\WorkBuddy空间\2026-08-01-13-40-21\index.html"
OUT = r"D:\WorkBuddy空间\2026-08-01-13-40-21\conv_tables.js"

with open(SRC, encoding="utf-8") as f:
    lines = f.readlines()

start_idx = end_idx = None
for i, line in enumerate(lines):
    if 'const GANZHI' in line and start_idx is None:
        start_idx = i
    if 'return data;' in line:
        end_idx = i
if start_idx is None or end_idx is None:
    raise SystemExit("无法定位数据区")

data_zone = "".join(lines[start_idx:end_idx + 1])
chars = sorted(set(re.findall(r'[\u4e00-\u9fff]', data_zone)))
print(f"数据区唯一汉字数: {len(chars)}")

cc_s2t = OpenCC('s2t')
cc_t2s = OpenCC('t2s')

# --- s2t: 整段转换 + 修正 ---
trad_zone = cc_s2t.convert(data_zone)
trad_zone = trad_zone.replace('高後', '高后')     # 吕后纪年「高后」
trad_zone = trad_zone.replace('漢衝', '漢沖')     # 汉冲帝 (冲=沖)
trad_zone = trad_zone.replace('歷', '曆')          # 数据区「历」均为年号/历法用字
trad_zone = trad_zone.replace('鹹', '咸')          # 咸 为年号用字 (咸亨/咸通/咸平/咸丰等)
trad_zone = trad_zone.replace('復闢', '復辟')      # 复辟 (辟=辟)
trad_zone = trad_zone.replace('乾隆', '乾隆')      # 乾隆 (乾=乾)
trad_zone = trad_zone.replace('乾', '乾')          # 乾 在年号/人名中保留 (乾道/乾亨/乾祐等)

# 提取段映射
def extract_segments(src, dst):
    mapping = {}
    i, n = 0, len(src)
    while i < n:
        if src[i] != dst[i]:
            j = i
            while j < n and src[j] != dst[j]:
                j += 1
            seg = src[i:j]
            mapping[seg] = dst[i:j]
            i = j
        else:
            i += 1
    return mapping

s2t_map = extract_segments(data_zone, trad_zone)

# 字符级补全 (确保每个源字符都有单字映射)
def ensure_char_maps(converter, base_map, src_chars, dst_zone=None):
    m = dict(base_map)
    for ch in src_chars:
        if ch in m:
            continue
        r = converter.convert(ch)
        if r != ch:
            m[ch] = r
    return m

s2t_map = ensure_char_maps(cc_s2t, s2t_map, chars, trad_zone)

# 显式覆盖歧义段 (长键优先, 前端按最长键匹配)
s2t_map['高后'] = '高后'
s2t_map['汉冲帝'] = '漢沖帝'
s2t_map['咸'] = '咸'
s2t_map['乾隆'] = '乾隆'
s2t_map['乾'] = '乾'
s2t_map['复辟'] = '復辟'
s2t_map['丑'] = '丑'    # 干支「丑」繁体同「丑」

# --- t2s: 从 s2t 反转 + OpenCC 补全 ---
t2s_map = {}
for k, v in s2t_map.items():
    if len(v) == len(k):
        t2s_map[v] = k  # 反转 (多字段和单字)

# 用 t2s 补全: 将繁体字符集转换
trad_chars = sorted(set(re.findall(r'[\u4e00-\u9fff]', trad_zone)))
for ch in trad_chars:
    if ch in t2s_map:
        continue
    r = cc_t2s.convert(ch)
    if r != ch:
        t2s_map[ch] = r

# 特殊: 某些 s2t 段是多对一(如 复->復 但 複->複 等), t2s 需要逐一展开
# 用 OpenCC t2s 对全部繁体字符逐一转换, 确保完整
for ch in trad_chars:
    if len(ch) == 1 and ch not in t2s_map:
        r = cc_t2s.convert(ch)
        if r != ch:
            t2s_map[ch] = r

# t2s 显式修正
t2s_map['乾'] = '乾'       # 乾隆/乾道 等保持「乾」
t2s_map['乾隆'] = '乾隆'
t2s_map['咸'] = '咸'       # 咸亨 等
t2s_map['鹹'] = '咸'
t2s_map['沖'] = '冲'
t2s_map['衝'] = '冲'
t2s_map['醜'] = '丑'       # 干支「丑」可输入「醜」也应查到
t2s_map['丑'] = '丑'
t2s_map['復辟'] = '复辟'

# --- UI 补充映射 (界面静态文本用字, 不在数据区) ---
UI_WORDS = [
    '导出', '确认', '取消', '全选', '清空', '选择', '范围', '仅当前页',
    '全部筛选结果', '更新日志', '学术参考工具', '将导出', '关闭', '记录',
    '返回', '编目', '工具', '项目', '查找', '搜索', '筛选', '跳转',
    '公历年份', '干支', '中国年号', '中国朝代', '在位皇帝', '日本时代',
    '日本年号', '在位天皇', '备注', '生肖', '每页', '条', '共',
    '未找到匹配的记录', '请尝试调整搜索关键词或放宽筛选条件',
    '数据覆盖', '并立政权年号均已尽可能完整罗列',
    '请至少选择一列', '导出CSV', '导出 CSV', '确认导出', '仅当前页',
    '全部筛选结果', '筛选条件', '清空筛选', '应用筛选', '回到顶部',
    '请输入有效的年份', '未找到该年份的数据', '复制年号',
]
for w in UI_WORDS:
    t = cc_s2t.convert(w)
    if t != w:
        s2t_map[w] = t
        # 反向 (等长时)
        if len(t) == len(w):
            t2s_map[t] = w
# 单字补全 (UI 常用字, 保证任意组合可用) — 注意「复」不在此列 (数据区已固定 复->復)
UI_CHARS = '导确认选围页仅录志术参记关闭筛选共条'
for ch in UI_CHARS:
    t = cc_s2t.convert(ch)
    if t != ch and ch not in s2t_map:
        s2t_map[ch] = t
    if len(t) == 1 and t not in t2s_map:
        t2s_map[t] = ch
# 数据区关键字的最终修正 (防止 UI 补全误覆盖 OpenCC 默认「複」)
s2t_map['复'] = '復'       # 天复/复辟 语境 -> 復
s2t_map['历'] = '曆'
s2t_map['咸'] = '咸'
s2t_map['乾'] = '乾'
s2t_map['丑'] = '丑'
t2s_map['複'] = '复'
t2s_map['復'] = '复'

# 输出
def fmt(obj):
    items = [f'  {json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}'
             for k, v in sorted(obj.items(), key=lambda x: -len(x[0]))]
    return '{\n' + ',\n'.join(items) + '\n}'

js = f"""// ============================================
// 简繁转换映射表 (由 build_conv_tables.py 生成, 勿手改)
// 基于 OpenCC 数据区上下文转换 + 专名修正
// S2T_MAP 键按长度降序排列, 转换时最长匹配优先
// ============================================
const S2T_MAP = {fmt(s2t_map)};
const T2S_MAP = {fmt(t2s_map)};
"""

with open(OUT, "w", encoding="utf-8") as f:
    f.write(js)

print(f"s2t 映射数: {len(s2t_map)}, t2s 映射数: {len(t2s_map)}")
print(f"输出文件: {OUT}")

# 自检
checks = [
    ('万历', '萬曆'), ('贞观', '貞觀'), ('乾隆', '乾隆'),
    ('高后', '高后'), ('后元', '後元'), ('后梁', '後梁'),
    ('汉冲帝', '漢沖帝'), ('汉冲', '漢沖'),
    ('圣历', '聖曆'), ('应历', '應曆'), ('凤历', '鳳曆'),
    ('咸亨', '咸亨'), ('咸丰', '咸豐'), ('咸熙', '咸熙'),
    ('宝历', '寶曆'), ('庆历', '慶曆'),
    ('天复', '天復'), ('复辟', '復辟'),
    ('神护景云', '神護景雲'), ('景云', '景雲'),
    ('乾道', '乾道'), ('乾祐', '乾祐'), ('丙子', '丙子'),
    ('癸丑', '癸丑'), ('乙丑', '乙丑'),
]
def convert(text, mapobj):
    keys = sorted(mapobj.keys(), key=lambda x: -len(x))
    result, i = '', 0
    while i < len(text):
        for k in keys:
            if text.startswith(k, i):
                result += mapobj[k]
                i += len(k)
                break
        else:
            result += text[i]
            i += 1
    return result

print("--- s2t 自检 ---")
for src, exp in checks:
    got = convert(src, s2t_map)
    flag = 'OK' if got == exp else 'FAIL'
    print(f"  [{flag}] {src} -> {got} (期望 {exp})")

t2s_checks = [('萬曆', '万历'), ('貞觀', '贞观'), ('後元', '后元'), ('後梁', '后梁'),
              ('漢沖帝', '汉冲帝'), ('聖曆', '圣历'), ('鹹', '咸'), ('鹹亨', '咸亨'),
              ('龍', '龙'), ('馬', '马'), ('雞', '鸡'), ('豬', '猪'),
              ('乾隆', '乾隆'), ('天復', '天复'), ('複製', '复制'),
              ('乾道', '乾道'), ('癸丑', '癸丑'), ('醜', '丑'),
              ('神護景雲', '神护景云')]
print("--- t2s 自检 ---")
for src, exp in t2s_checks:
    got = convert(src, t2s_map)
    flag = 'OK' if got == exp else 'FAIL'
    print(f"  [{flag}] {src} -> {got} (期望 {exp})")
