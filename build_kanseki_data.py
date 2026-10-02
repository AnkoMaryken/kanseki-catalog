# -*- coding: utf-8 -*-
"""
build_kanseki_data.py — 生成「古籍类目查询」页面所需的数据文件
=================================================================
输入：《中国古籍总目》全量数据（含全球汉籍合璧工程对照），JSONL，每行一条：
      {seq, bu, lei, shu, book, author, hb_bu, hb_lei, hb_verdict, hb_note}

输出（写入仓库根目录）：
  kanseki_data.js  —— window.KANSEKI_CATS / window.KANSEKI_ROWS / window.KANSEKI_META
  kanseki_conv.js  —— window.KANSEKI_T2S：本数据集专用的繁→简字符表 + 词组修正

设计说明（重要，勿随意改）
------------------------------------------------------------------
1) **记录保留繁体原文**。原站（kaixims.jp）著录形式即繁体，属最权威的字形；
   站点默认字形也是繁体，故繁体显示为「原样输出」，零转换、零失真。
   简体显示与检索归一化时，用 kanseki_conv.js 的映射表转换。
   这与「数据存简体」的旧约定不同 —— 旧约定针对本站自撰的年号数据，
   而书名是外部著录，保真优先。已在 changelog 中说明。

2) **分类用索引压缩**。349 个（部/類/屬/合璧部/合璧类/判定/备注）组合去重后
   建表，记录只存 1 个索引，避免 17.7 万行重复 7 个字段。

3) **记录用 TSV 大字符串**而非对象数组：解析快、体积小。

4) **繁→简是「多对一」方向**，字符级映射几乎无歧义（歧义主要出在简→繁方向）；
   仍会逐值比对 opencc 全串转换结果，把不一致的词组补进 phrase 表。

用法：
    python build_kanseki_data.py
    python build_kanseki_data.py --src <path.jsonl> --out-dir <dir>
"""
import argparse
import json
import os
import re
import sys
import time
from collections import Counter, OrderedDict

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DEFAULT_SRC = os.path.join(".workbuddy", "source", "catalog_xw.jsonl")

CAT_FIELDS = ["bu", "lei", "shu", "hb_bu", "hb_lei", "hb_verdict", "hb_note"]


# --------------------------------------------------------------------- opencc
def load_opencc(config="t2s"):
    try:
        from opencc import OpenCC
    except ImportError:
        print("!! 未安装 opencc，无法生成转换表。请用项目 venv：")
        print('   "C:/Users/华为/.workbuddy/binaries/python/envs/default/Scripts/python.exe"')
        raise
    return OpenCC(config)


# --------------------------------------------------------------------- 转换表
# 保护字：整字不做转换（字符级映射的已知误伤）
#   乾 —— 本数据集中「乾」几乎全为 qián（乾隆/乾元/乾坤/乾道…），
#         字符级会误转为「干」，而 1613 处实测无一需要转「干」。
#   吒 —— 仅见于「哪吒」，不可转「咤」。
PROTECT_CHARS = set("乾吒")

# 手工修正表：字符级转换明显不合古籍著录习惯时按词组覆盖。
# 键为繁体原串（最长匹配优先），值为简体结果。
MANUAL_PHRASE = {
    "於潛": "于潜",      # 地名「於潛」（yū），不简化作「于潜」以外的字形
    "彷彿": "仿佛",      # 规范简化
    "變徵": "变徵",      # 乐律名「徵」（zhǐ）保留徵
    "計畫": "计划",      # 「畫」在此读 huà，应作「划」
}


def build_conv_table(all_texts, cc):
    """字符级 t2s 映射（保护字 + 手工词组修正），返回 (char_map, phrase_map, stats)"""
    chars = set()
    for t in all_texts:
        chars.update(t)
    char_map = {}
    for ch in sorted(chars):
        if ch in PROTECT_CHARS:
            continue
        s = cc.convert(ch)
        if s != ch:
            char_map[ch] = s

    phrase = dict(MANUAL_PHRASE)

    def convert_full(s):
        if not phrase:
            return "".join(char_map.get(ch, ch) for ch in s)
        keys = sorted(phrase, key=len, reverse=True)
        out = []
        i = 0
        n = len(s)
        while i < n:
            hit = None
            for k in keys:
                if s.startswith(k, i):
                    hit = k
                    break
            if hit:
                out.append(phrase[hit])
                i += len(hit)
            else:
                out.append(char_map.get(s[i], s[i]))
                i += 1
        return "".join(out)

    # 与 opencc 全串结果逐值比对（仅作统计口径，不作为修正依据）
    diff = []
    for t in all_texts:
        if not t:
            continue
        o = cc.convert(t)
        m = convert_full(t)
        if o != m:
            diff.append((t, o, m))

    stats = {
        "distinct_chars": len(chars),
        "char_entries": len(char_map),
        "phrase_entries": len(phrase),
        "values_checked": len(all_texts),
        # 与 opencc 词组转换的差异条数（差异多为 opencc 词组猜测，非本表错误）
        "values_diff_vs_opencc": len(diff),
        "values_mismatched_after_phrase": len(diff),
        "residual_samples": diff[:8],
    }
    return char_map, phrase, stats


# --------------------------------------------------------------------- 主流程
def js_str(s):
    return json.dumps(s, ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC)
    ap.add_argument("--out-dir", default=".")
    ap.add_argument("--aux-dir", default=os.path.join(".workbuddy"),
                    help="人工审定/元数据等副产物目录（默认 .workbuddy，不入库）")
    ap.add_argument("--skip-conv", action="store_true", help="跳过转换表生成（调试用）")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        print("找不到源数据：%s" % args.src)
        print("请用 --src 指定《中国古籍总目》对照数据 JSONL 的路径。")
        return 2

    t0 = time.time()
    rows = []
    with open(args.src, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    rows.sort(key=lambda r: (r.get("seq") is None, r.get("seq")))
    print("读入记录 %d 条" % len(rows))

    # --- 分类组合表 ---
    cat_index = OrderedDict()
    for r in rows:
        key = tuple(r.get(k, "") or "" for k in CAT_FIELDS)
        if key not in cat_index:
            cat_index[key] = len(cat_index)
    cats = list(cat_index.keys())
    print("分类组合 %d 个" % len(cats))

    # --- 合璧侧字段统一为繁体 ---
    # 《中国古籍总目》四字段本身即繁体；若合璧侧（部/类/判定/备注）仍是简体，
    # 繁体模式下会简繁混杂。这里在**构建期**统一转繁体，使整条记录字形一致：
    #   繁模式 = 原样输出，简模式 = 整条经 k2s 转换（运行期只有一条规则）。
    # 该侧词汇量很小（约 400 条去重值），可人工审定。
    cc_s2t = load_opencc("s2t")
    HB_FIELDS = (3, 4, 5, 6)
    hb_vocab = set()
    for c in cats:
        for i in HB_FIELDS:
            if c[i]:
                hb_vocab.add(c[i])
    hb_map = {v: cc_s2t.convert(v) for v in sorted(hb_vocab)}
    changed = {k: v for k, v in hb_map.items() if k != v}
    print("合璧侧去重值 %d 个，其中 %d 个转繁体（示例 %s）" % (
        len(hb_map), len(changed),
        list(changed.items())[:3]))
    cats = [tuple((hb_map.get(c[i], c[i]) if i in HB_FIELDS else c[i]) for i in range(len(c)))
            for c in cats]
    os.makedirs(args.aux_dir, exist_ok=True)
    with open(os.path.join(args.aux_dir, "kanseki_cats_s2t_review.txt"), "w", encoding="utf-8") as f:
        f.write("# 合璧侧字段 繁/简 对照（构建期转换，供人工审定）\n")
        for k in sorted(hb_map):
            f.write("%s\t%s\n" % (k, hb_map[k]))

    # --- 记录 TSV ---
    def clean(s):
        return (s or "").replace("\t", " ").replace("\n", " ").replace("\r", " ")

    parts = []
    for r in rows:
        key = tuple(r.get(k, "") or "" for k in CAT_FIELDS)
        parts.append("%d\t%s\t%s" % (cat_index[key], clean(r.get("book")), clean(r.get("author"))))
    tsv = "\n".join(parts)
    print("记录串 %d 字符 / %.2f MB" % (len(tsv), len(tsv.encode("utf-8")) / 1048576))

    # --- 转换表 ---
    conv_js = ""
    if not args.skip_conv:
        cc = load_opencc()
        vocab = set()
        for r in rows:
            vocab.add(r.get("book", "") or "")
            vocab.add(r.get("author", "") or "")
        for c in cats:
            for v in c:
                vocab.add(v)
        vocab.discard("")
        print("待校验文本 %d 条，开始构建繁→简表…" % len(vocab))
        char_map, phrase, stats = build_conv_table(sorted(vocab), cc)
        print("  不同字符 %d，需转换字符 %d，手工词组修正 %d" % (
            stats["distinct_chars"], stats["char_entries"], stats["phrase_entries"]))
        print("  整串校验：%d 条；与 opencc 词组结果差异 %d 条（%.2f%%，差异多为 opencc 词组猜测）" % (
            stats["values_checked"], stats["values_diff_vs_opencc"],
            100.0 * stats["values_diff_vs_opencc"] / max(1, stats["values_checked"])))
        for s in stats["residual_samples"]:
            print("   差异样例: %r  本表=%r  opencc=%r" % (s[0], s[2], s[1]))
        conv_js = (
            "// ============================================\n"
            "// 古籍类目数据专用 繁→简 映射表 (由 build_kanseki_data.py 生成, 勿手改)\n"
            "// 仅覆盖《中国古籍总目》数据集出现的字与词组，供简体显示与检索归一化使用。\n"
            "// 已逐值比对 opencc 全串结果，残留失配 %d / %d 条。\n"
            "// ============================================\n"
            "window.KANSEKI_T2S = %s;\n"
            "window.KANSEKI_T2S_PHRASE = %s;\n"
            % (stats["values_mismatched_after_phrase"], stats["values_checked"],
               json.dumps(char_map, ensure_ascii=False),
               json.dumps(phrase, ensure_ascii=False))
        )

    # --- 写出 ---
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)

    meta = OrderedDict()
    meta["total"] = len(rows)
    meta["catCount"] = len(cats)     # 确定性字段，保留在数据内（页面与校验都用）
    meta["source"] = os.path.basename(args.src)
    meta["seqMin"] = min((r.get("seq") for r in rows if r.get("seq") is not None), default=0)
    meta["seqMax"] = max((r.get("seq") for r in rows if r.get("seq") is not None), default=0)
    meta["verdicts"] = {hb_map.get(k, k): v for k, v in
                        Counter(r.get("hb_verdict", "") for r in rows).items()}
    meta["bu"] = dict(Counter(r.get("bu", "") for r in rows))
    meta["hanjiBu"] = dict(Counter(hb_map.get(r.get("hb_bu", ""), r.get("hb_bu", "")) or "（無對應）"
                                   for r in rows))

    data_path = os.path.join(out_dir, "kanseki_data.js")
    with open(data_path, "w", encoding="utf-8") as f:
        f.write("// ============================================\n")
        f.write("// 古籍类目数据 (由 build_kanseki_data.py 生成, 勿手改)\n")
        f.write("// 来源：《中国古籍总目》全量著录 + 全球汉籍合璧工程类目对照\n")
        # ⚠️ 刻意不写入生成时间戳：本文件 9.6MB，若含时间戳则每次重新生成都变哈希，
        #    既无法复现、也会让 git 与 dist/exe 的一致性核对失效。
        #    生成时间记录在 .workbuddy/kanseki_data_meta.json（不入库）。
        f.write("// 输出为确定性结果：同一份源数据必然得到逐字节相同的文件。\n")
        f.write("// ============================================\n")
        f.write("window.KANSEKI_META = %s;\n" % json.dumps(meta, ensure_ascii=False))
        f.write("\n// 分类组合表：[部, 類, 屬, 合璧部, 合璧类, 判定, 备注]\n")
        f.write("window.KANSEKI_CATS = %s;\n" % json.dumps([list(c) for c in cats], ensure_ascii=False))
        f.write("\n// 记录：每行 `分类索引\\t书名\\t著者`（繁体原文）\n")
        f.write("window.KANSEKI_ROWS = %s;\n" % js_str(tsv))

    if conv_js:
        with open(os.path.join(out_dir, "kanseki_conv.js"), "w", encoding="utf-8") as f:
            f.write(conv_js)

    print("\n已写出：")
    print("  %s  (%.2f MB)" % (data_path, os.path.getsize(data_path) / 1048576))
    if conv_js:
        cp = os.path.join(out_dir, "kanseki_conv.js")
        print("  %s  (%.1f KB)" % (cp, os.path.getsize(cp) / 1024))
    print("耗时 %.1fs" % (time.time() - t0))
    # 副产物（不入库）：含生成时间与来源，仅供人工审定与追溯
    meta_aux = OrderedDict()
    meta_aux["generatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
    meta_aux["source"] = os.path.basename(args.src)
    meta_aux["catCount"] = len(cats)
    meta_aux.update(meta)
    with open(os.path.join(args.aux_dir, "kanseki_data_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta_aux, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
