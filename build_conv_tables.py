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
import argparse
from pathlib import Path
from opencc import OpenCC

# 参数化根目录：默认脚本所在目录，可用 --root 覆盖（跨平台迁移用）
ROOT = Path(__file__).resolve().parent
_parser = argparse.ArgumentParser(description='生成简繁转换映射表')
_parser.add_argument('--root', default=str(ROOT), help='项目根目录（默认脚本所在目录）')
_args = _parser.parse_args()
ROOT = Path(_args.root)

SRC = ROOT / 'index.html'
OUT = ROOT / 'conv_tables.js'

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
    '历史', '搜索历史', '清空历史', '搜索建议',
    '说明文档', '使用介绍', '纪年查询', '快速跳转', '快捷跳转',
    '跳转', '快捷', '收起', '展开', '打开', '网站', '网址', '输入网址',
    '该年号下的所有年份', '该年号全部年份',
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
# --- V9.0 新增界面文案 (「古籍类目查询」页, 规格 §6.2) ---
# 只增不改: 已存在的键一律保留原值, 保证旧条目不丢失、生成结果只增不减。
V9_UI_WORDS = [
    # 规格 §6.2 明确列出的全部文案
    '古籍类目查询', '查询结果', '共 X 条', '导出 CSV', '清空全部',
    '筛选', '部', '类', '属', '判定', '完全相同', '可对应', '无对应',
    '合璧对应类目', '著者', '书名', '分类路径', '每页',
    '提示：支持空格分词与错字容错', '正在载入古籍类目数据…',
    # 同页其余界面用语 (检索引擎 / 筛选器 / 分页 / 导出)
    '古籍', '类目', '检索', '模糊', '多词', '错字', '容错', '分词', '字段', '限定',
    '关键词', '输入关键词', '请输入关键词', '未找到', '没有结果', '无结果',
    '正在载入', '载入中', '数据加载', '合计', '总计', '结果数',
    '合璧判定', '合璧备注', '判定结果', '序号', '简体', '繁体', '字形',
    '全部', '重置', '首页', '上一页', '下一页', '末页', '条/页',
]
for w in V9_UI_WORDS:
    if w in s2t_map:
        continue
    t = cc_s2t.convert(w)
    s2t_map[w] = t          # 同形词 (t == w, 如「清空全部」「判定」) 也显式登记, 便于验收核对
    if len(t) == len(w) and t not in t2s_map:
        t2s_map[t] = w
# V9.0 单字补全 (上述文案中出现、旧表可能缺漏的简体专用字)
V9_UI_CHARS = '询结属对应书径词与错载据数类检关键未简体页条'
for ch in V9_UI_CHARS:
    t = cc_s2t.convert(ch)
    if t != ch and ch not in s2t_map:
        s2t_map[ch] = t
    if len(t) == 1 and t not in t2s_map:
        t2s_map[t] = ch

# --- V9.0 补遗 (「古籍类目查询」页实际用到的其余文案) ---
# ⚠️ 严格只补「无歧义的简体专用字」：单/级/库/个 在繁体文本中不会出现，加单字安全。
#    绝不加「注」这类双向常用字 —— 注→註 会把「注意」误转成「註意」。
#    「备注」用词组条目覆盖（见下），由最长匹配优先保证正确。
V9_UI_WORDS_2 = [
    '单字降级', '全库', '精确匹配', '模糊匹配', '容错匹配',
    '未找到匹配的记录', '字段限定', '已为你列出', '包含其中',
    '检索《中国古籍总目》全量著录', '全球汉籍合璧工程类目',
    '输入书名', '分类路径', '每页显示', '条目', '显示',
    '备注', '合璧备注', '备注说明',
]
for w in V9_UI_WORDS_2:
    if w in s2t_map:
        continue
    t = cc_s2t.convert(w)
    s2t_map[w] = t
    if len(t) == len(w) and t not in t2s_map:
        t2s_map[t] = w
V9_UI_CHARS_2 = '单级库个'
for ch in V9_UI_CHARS_2:
    t = cc_s2t.convert(ch)
    if t != ch and ch not in s2t_map:
        s2t_map[ch] = t
    if len(t) == 1 and t not in t2s_map:
        t2s_map[t] = ch

# ---- 先应用专名修正，再据此生成 V9.2 文案的繁体形式 ----
# 原因：opencc 的**词组**转换会覆盖本站的单字修正 —— 例如本站规定 复→復，
#       但 opencc 会把「复检」整体转成「複檢」。故 V9.2 文案一律改用
#       「本站映射表的最长匹配」来转换（与站点运行时 convertText 同一语义）。
#       同一批修正语句在文件末尾还有一份，作用于数据区关键字，两处效果一致。
s2t_map['复'] = '復'
s2t_map['历'] = '曆'
s2t_map['咸'] = '咸'
s2t_map['乾'] = '乾'
s2t_map['丑'] = '丑'
s2t_map['联系'] = '聯繫'      # opencc 给「聯系」，规范繁体为「聯繫」
s2t_map['干支'] = '干支'
s2t_map['天干'] = '天干'
s2t_map['周'] = '周'
t2s_map['複'] = '复'
t2s_map['復'] = '复'


def conv_by_map(s):
    """用当前 s2t_map 做最长匹配转换（与站点运行时 convertText 同一语义）"""
    keys = sorted(s2t_map.keys(), key=len, reverse=True)
    out, i, n = [], 0, len(s)
    while i < n:
        hit = None
        for k in keys:
            if s.startswith(k, i):
                hit = k
                break
        if hit:
            out.append(s2t_map[hit]); i += len(hit)
        else:
            out.append(s[i]); i += 1
    return ''.join(out)


# --- V9.2 新增文案（AI 复检改造 + 表头改名 + 设置窗口） ---
# 做法与此前不同：这些文案里有大量**拼接**出来的动态句子
# （如「正在复检第 12 条…」），只登记整句无法覆盖，
# 故除整句外，**自动把这些文案用到的每个字**都补进字符表。
# 新增的字映射会打印出来供人工复核。
V9_2_UI_WORDS = [
    # 表头改名
    '合璧中是否有相同类目', '是否一致',
    # 工具条与弹窗
    'AI 复检', 'AI 复检结果', 'AI 复检与提问', '整页复检', '开始整页复检',
    '导出 Markdown', '收起', '关闭', '打开设置', '送审范围',
    '针对当前筛选结果提问，例如：这些「无对应」的条目按内容应归入哪个合璧类目？',
    '复检结论与本表类目完全不一致。', '请截图此结果并联系软件开发者修改条目内容。',
    '反馈错误结果', '邮件发送', '复制报告', '可补充说明（选填）',
    # 导出 Markdown 的字段标签
    '古籍类目复检报告', '复检意见', '复检结果', '本表合璧类目', '本表判定',
    '序列号', '书名', '本表合璧类目', '通道',
    '桌面版（Rust 桥）', '网页版（直连）', '《中国古籍总目》分类', '原著者空缺',
    # 运行期提示
    '尚未配置 API', '未配置 API', '模型',
    '请先在表格中点击选中一条记录，再点「AI 复检」。（长按本按钮可整页复检或提问）',
    '尚未配置 DeepSeek API。桌面版：设置 → API 管理；网页版：个人中心 → API 管理。',
    '尚未配置 DeepSeek API，请先到设置中填写。',
    '正在复检第 N 条…', '正在整页复检…', '正在回答…', '正在请求…',
    '整页复检：送审 N 条（当前页）', '当前结果为空，没有可送审的条目。',
    '对话已清空。', '已了解这批条目，请提问。',
    '未填收件邮箱，已改为复制报告', '已调用系统邮件客户端',
    '报告已复制到剪贴板', '复制失败，请手动选择文本',
    '维持', '推翻', '存疑', '错误', '提示', '我',
    # 设置窗口（个人中心 / 同步设置 / API 管理）
    '设置', '个人中心', '同步设置', 'API 管理', 'API Key', 'API 地址',
    '反馈收件邮箱', '保存', '测试连接', '清除', '显示', '隐藏',
    '连接正常', '尚未配置', '只保存在本机，不会上传到任何第三方',
    '坚果云邮箱', '应用密码', '连接测试', '保存凭据', '立即同步', '同步状态',
    '上次同步', '待同步变更', '最近日志', '删除', '修改', '退出登录', '登录',
]
for w in V9_2_UI_WORDS:
    if w in s2t_map:
        continue
    t = cc_s2t.convert(w)
    # opencc 的词组结果偶尔与本站既定规则冲突，按站规显式纠正：
    #   本站规定「复」作「復」（复制除外，另有词组条目），opencc 会把「复检」转成「複檢」
    #   规范繁体「联系」作「聯繫」，opencc 给「聯系」
    for _bad, _good in (('複檢', '復檢'), ('複查', '復查'), ('複核', '復核'), ('聯系', '聯繫')):
        t = t.replace(_bad, _good)
    s2t_map[w] = t
    if len(t) == len(w) and t not in t2s_map:
        t2s_map[t] = w

# 自动补齐：抽出上述全部文案里的字，逐字补进字符表（动态句子靠这一层兜底）
V9_2_UI_CHARS = ''.join(sorted(set(''.join(V9_2_UI_WORDS))))
_added_chars = []
for ch in V9_2_UI_CHARS:
    t = cc_s2t.convert(ch)
    if t != ch and ch not in s2t_map:
        s2t_map[ch] = t
        _added_chars.append('%s->%s' % (ch, t))
    if len(t) == 1 and t not in t2s_map:
        t2s_map[t] = ch
print('[V9.2] 新增单字映射 %d 个：%s' % (len(_added_chars), ' '.join(_added_chars)))

# --- V9.3 新增文案（AI 联网查证 + 一致性判定 + 导出通知 + 设置页） ---
# 与 V9.2 同一做法：整句登记 + 自动补齐这些文案用到的每个字
# （界面里大量文案是拼接出来的动态句子，只登记整句覆盖不到）。
V9_3_UI_WORDS = [
    # 一致性判定与结果区
    '一致性判定', '一致', '可能不一致', '不一致', '复检意见', '复检结果',
    '复检对象', '本表第', '搜索框内容', '网络查证', '网络查证资料来源',
    '已联网查证', '未能联网查证', '条网络资料', '条资料', '未能取得',
    '未检索到结果', '网页版无法联网查证（浏览器跨域限制），桌面版可用',
    '正在联网查证并复检第', '未取得网络资料，改为凭模型知识复检第',
    # 导出
    '导出失败', '已导出 Markdown', '已导出 CSV', '请查看浏览器下载',
    # 反馈
    '未填收件邮箱，已改为复制报告', '报告已复制到剪贴板', '复制失败，请手动选择文本',
    '已调用系统邮件客户端', '反馈错误结果',
    '复检结论与本表分类不一致。请截图此结果并联系软件开发者修改条目内容。',
    '复检结论与本表分类可能不一致，请人工复核后再决定是否修改条目。',
    # 入口提示
    '请先在搜索框输入书名，或在表格中点击选中一条记录，再点「AI 复检」。（长按本按钮可整页复检或提问）',
    '尚未配置 DeepSeek API。桌面版：设置 → API 管理；网页版：设置页 → API 管理。',
    '古籍类目复检报告', '复检意见', '模型', '时间', '通道',
    '桌面版（Rust 桥）', '网页版（直连）',
    # 设置页新增
    '刷新列表', '最大输出 tokens', '正在向 DeepSeek 拉取可用模型',
    '已获取', '个可用模型', '未能获取模型列表', '接口未返回',
    '当前设置，接口未返回',
]
for w in V9_3_UI_WORDS:
    if w in s2t_map:
        continue
    t = cc_s2t.convert(w)
    for _bad, _good in (('複檢', '復檢'), ('複查', '復查'), ('複核', '復核'), ('聯系', '聯繫')):
        t = t.replace(_bad, _good)
    s2t_map[w] = t
    if len(t) == len(w) and t not in t2s_map:
        t2s_map[t] = w
V9_3_UI_CHARS = ''.join(sorted(set(''.join(V9_3_UI_WORDS))))
_added3 = []
for ch in V9_3_UI_CHARS:
    t = cc_s2t.convert(ch)
    if t != ch and ch not in s2t_map:
        s2t_map[ch] = t
        _added3.append('%s->%s' % (ch, t))
    if len(t) == 1 and t not in t2s_map:
        t2s_map[t] = ch
print('[V9.3] 新增单字映射 %d 个：%s' % (len(_added3), ' '.join(_added3)))

# V9.3 补充：漏网的单字 + 规范繁体用词
#   · 验 → 驗（简体专用字，前面几轮一直没登记）
#   · 剪贴板：规范繁体作「剪貼簿」（opencc 给「剪貼板」）
V9_3_EXTRA_CHARS = '验'
for ch in V9_3_EXTRA_CHARS:
    t = cc_s2t.convert(ch)
    if t != ch and ch not in s2t_map:
        s2t_map[ch] = t
    if len(t) == 1 and t not in t2s_map:
        t2s_map[t] = ch
s2t_map['剪贴板'] = '剪貼簿'
t2s_map['剪貼簿'] = '剪贴板'
# 注意：上面登记的长句（如「报告已复制到剪贴板」）比「剪贴板」长，转换时最长匹配优先，
# 所以必须把**所有条目值**里的「剪貼板」统一改成规范写法，否则长句仍会输出旧写法。
for _k in list(s2t_map.keys()):
    if '剪貼板' in s2t_map[_k]:
        s2t_map[_k] = s2t_map[_k].replace('剪貼板', '剪貼簿')

# 数据区关键字的最终修正 (防止 UI 补全误覆盖 OpenCC 默认「複」)
s2t_map['复'] = '復'       # 天复/复辟 语境 -> 復
s2t_map['历'] = '曆'
s2t_map['咸'] = '咸'
s2t_map['乾'] = '乾'
s2t_map['丑'] = '丑'
t2s_map['複'] = '复'
t2s_map['復'] = '复'

# --- V9.0 追加专名修正 (Lead 审计发现的两处既有误转) ---
# 依据：全站文本逐语境审计（含 index.html 数据区）
#   ①「干」在站内 100% 出现在「干支」（本站核心概念：公历年份、干支、年号…），
#      而「干」被 OpenCC 单字映射为「幹」→ 繁体模式下全部显示成「幹支」。
#      已实测桌面版表头确实渲染为「幹支」。
#   ②「周」在站内出现在「周烈王/西周/北周/武周/周边政权」等语境，全部应保留「周」；
#      全站「週」出现 0 次，故整字保护是安全的（「週末/一週」等本站不用）。
# 注：「后→後」经审计为**正确**（站内为「后醍醐天皇」「后花园天皇」「后元」），不改。
s2t_map['干支'] = '干支'
s2t_map['天干'] = '天干'
s2t_map['周'] = '周'

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
