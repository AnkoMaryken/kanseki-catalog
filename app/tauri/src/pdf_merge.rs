// ================================================
// src/pdf_merge.rs — 站方 PDF 的合并（V10.0）
// ================================================
// 背景：站方原生 PDF 每次请求最多 50 页（查看器页 data-limit-count），
// 超过 50 页的册会被拆成多个分卷（如 书名_1-50.pdf / 书名_51-98.pdf）。
// 用户要求「>50 页自动合并成一个 PDF」。
//
// 做法（不解码、不重编码，画质零损失）：
//   ① 这些 PDF 是「一页一张 JPEG」的图册（实测：50 页 PDF 恰好 50 个 /DCTDecode），
//      对象与流都是明文（未用对象流压缩），因此可以直接把内嵌 JPEG 原样取出来；
//   ② 按**页面树顺序**（Catalog→Pages→Kids，必要时递归）取出每页的图像对象，
//      从而保证页序与原书一致；
//   ③ 用 naj_dl::build_pdf 重新装订成一个 PDF（DCTDecode 原样内嵌）。
//   若页面树不可用，则退回「按对象在文件中出现的顺序」扫描 /DCTDecode —— 该站的
//   生成器是线性输出，两者一致；命令层再用页数校验兜底。
//
// ⚠️ 已知取舍：合并后只保留图像页；若站方某天在 PDF 里加文字层/书签，会被丢弃
//    （页数校验仍会拦住异常，不会静默产出错页）。
// ================================================
use std::collections::HashMap;

/// 一个 PDF 对象在文件中的位置
#[derive(Clone, Copy)]
struct ObjSpan {
    body_start: usize,
    body_end: usize,
}

/// 建立「对象号 → 对象体范围」索引。
///
/// ⚠️ **必须优先用 xref 表**：早期版本靠文本扫描 `endobj` 定位对象结束，
/// 而站方 PDF 是「一页一张 JPEG」，JPEG 压缩数据里**偶然出现 "endobj" 这 6 个字节**
/// 就会把对象截断、后续对象全部错位，表现为「50 页只提取出 49 页」——
/// 数据相关，所以时好时坏（实测踩过）。
fn index_objects(data: &[u8]) -> HashMap<u32, ObjSpan> {
    if let Some(map) = index_by_xref(data) {
        if !map.is_empty() {
            return map;
        }
    }
    index_by_scan(data)
}

/// 解析末尾的 xref 表，得到「对象号 → 文件偏移」；解析不出（如 xref 流）返回 None
fn parse_xref_offsets(data: &[u8]) -> Option<HashMap<u32, usize>> {
    // 从尾部找最后一个 startxref
    let mut pos = None;
    let mut i = data.len().saturating_sub(64);
    while i + 9 <= data.len() {
        if &data[i..i + 9] == b"startxref" {
            pos = Some(i);
        }
        i += 1;
    }
    let start = pos?;
    let tail = &data[start + 9..];
    let mut a = 0;
    while a < tail.len() && !tail[a].is_ascii_digit() {
        a += 1;
    }
    let mut b = a;
    while b < tail.len() && tail[b].is_ascii_digit() {
        b += 1;
    }
    if b == a {
        return None;
    }
    let off: usize = std::str::from_utf8(&tail[a..b]).ok()?.parse().ok()?;
    if off >= data.len() {
        return None;
    }
    let mut p = off;
    while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
        p += 1;
    }
    if p + 4 > data.len() || &data[p..p + 4] != b"xref" {
        return None; // 可能是 xref 流（/Type /XRef）—— 交给扫描回退
    }
    p += 4;
    let mut map = HashMap::new();
    loop {
        while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
            p += 1;
        }
        if p + 7 > data.len() || &data[p..p + 7] == b"trailer" {
            break;
        }
        let s0 = p;
        while p < data.len() && data[p].is_ascii_digit() {
            p += 1;
        }
        if p == s0 {
            break;
        }
        let first: u32 = std::str::from_utf8(&data[s0..p]).ok()?.parse().ok()?;
        while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
            p += 1;
        }
        let c0 = p;
        while p < data.len() && data[p].is_ascii_digit() {
            p += 1;
        }
        if p == c0 {
            break;
        }
        let count: u32 = std::str::from_utf8(&data[c0..p]).ok()?.parse().ok()?;
        for k in 0..count {
            while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
                p += 1;
            }
            // 记录格式固定 20 字节："0000000015 00000 n \n"
            //  0..9 偏移 | 10 空格 | 11..15 世代 | 16 空格 | 17 类型 | 18..19 行尾
            if p + 18 > data.len() {
                break;
            }
            let rec = &data[p..p + 18];
            let mut a2 = 0;
            while a2 < 10 && rec[a2].is_ascii_digit() {
                a2 += 1;
            }
            if a2 == 10 && rec[10] == b' ' && rec[16] == b' ' && rec[17] == b'n' {
                if let Ok(o) = std::str::from_utf8(&rec[0..10]).unwrap_or("").parse::<usize>() {
                    if o > 0 && o < data.len() {
                        map.insert(first + k, o);
                    }
                }
            }
            p += 18;
        }
    }
    if map.is_empty() {
        None
    } else {
        Some(map)
    }
}

/// 读出 `<objid> <gen> obj` 之后的对象体起点；格式不符返回 None
fn body_start_at(data: &[u8], off: usize, expect_id: u32) -> Option<usize> {
    let mut p = off;
    while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
        p += 1;
    }
    let s0 = p;
    while p < data.len() && data[p].is_ascii_digit() {
        p += 1;
    }
    if p == s0 {
        return None;
    }
    let id: u32 = std::str::from_utf8(&data[s0..p]).ok()?.parse().ok()?;
    if id != expect_id {
        return None;
    }
    while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
        p += 1;
    }
    let g0 = p;
    while p < data.len() && data[p].is_ascii_digit() {
        p += 1;
    }
    if p == g0 {
        return None;
    }
    while p < data.len() && matches!(data[p], b' ' | b'\r' | b'\n') {
        p += 1;
    }
    if p + 3 <= data.len() && &data[p..p + 3] == b"obj" {
        Some(p + 3)
    } else {
        None
    }
}

fn index_by_xref(data: &[u8]) -> Option<HashMap<u32, ObjSpan>> {
    let offs = parse_xref_offsets(data)?;
    let mut items: Vec<(u32, usize)> = offs.into_iter().collect();
    items.sort_by_key(|(_, o)| *o);
    let mut map = HashMap::new();
    for (i, (id, off)) in items.iter().enumerate() {
        let Some(bs) = body_start_at(data, *off, *id) else { continue };
        let end = items.get(i + 1).map(|(_, o)| *o).unwrap_or(data.len());
        if end > bs {
            map.insert(*id, ObjSpan { body_start: bs, body_end: end });
        }
    }
    // 健全性检查：若大半对象都没对上（xref 解析错位），宁可退回文本扫描
    if map.len() * 2 < items.len() {
        return None;
    }
    Some(map)
}

/// 回退：文本扫描（无 xref 表时用）。**扫描时必须跳过 stream 数据**，
/// 否则 JPEG 里的 "endobj" 会把对象截断。
fn index_by_scan(data: &[u8]) -> HashMap<u32, ObjSpan> {
    let mut map = HashMap::new();
    let mut i = 0usize;
    while i + 3 < data.len() {
        if data[i].is_ascii_digit() && (i == 0 || !data[i - 1].is_ascii_digit()) {
            let mut j = i;
            while j < data.len() && data[j].is_ascii_digit() {
                j += 1;
            }
            let id = std::str::from_utf8(&data[i..j])
                .ok()
                .and_then(|s| s.parse::<u32>().ok());
            let mut k = j;
            while k < data.len() && matches!(data[k], b' ' | b'\r' | b'\n' | b'\t') {
                k += 1;
            }
            let g0 = k;
            while k < data.len() && data[k].is_ascii_digit() {
                k += 1;
            }
            let has_gen = k > g0;
            while k < data.len() && matches!(data[k], b' ' | b'\r' | b'\n' | b'\t') {
                k += 1;
            }
            if let Some(id) = id {
                if has_gen
                    && k + 3 <= data.len()
                    && &data[k..k + 3] == b"obj"
                    && (k + 3 == data.len() || !data[k + 3].is_ascii_alphanumeric())
                {
                    let body_start = k + 3;
                    // 若对象体里有 stream，则按 /Length 跳过流数据，再找 endobj
                    let mut body_end = None;
                    if let Some(sp) = find(&data[body_start..], b"stream") {
                        let abs_sp = body_start + sp;
                        let mut ds = abs_sp + 6;
                        if ds < data.len() && data[ds] == b'\r' {
                            ds += 1;
                        }
                        if ds < data.len() && data[ds] == b'\n' {
                            ds += 1;
                        }
                        let hdr = &data[body_start..abs_sp];
                        let len = parse_len_direct(hdr);
                        if let Some(len) = len {
                            if ds + len <= data.len() {
                                if let Some(es) = find(&data[ds + len..], b"endobj") {
                                    body_end = Some(ds + len + es);
                                }
                            }
                        }
                    }
                    let body_end = body_end.or_else(|| {
                        find(&data[body_start..], b"endobj").map(|r| body_start + r)
                    });
                    if let Some(be) = body_end {
                        map.insert(id, ObjSpan { body_start, body_end: be });
                        i = be + 6;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    map
}

/// 从字典片段里直接取 `/Length <数字>`（不解析间接引用）
fn parse_len_direct(b: &[u8]) -> Option<usize> {
    let p = find(b, b"/Length")?;
    let mut i = p + 7;
    while i < b.len() && matches!(b[i], b' ' | b'\r' | b'\n' | b'\t') {
        i += 1;
    }
    let s = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == s {
        return None;
    }
    std::str::from_utf8(&b[s..i]).ok()?.parse().ok()
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    let first = needle[0];
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if hay[i] == first && &hay[i..i + needle.len()] == needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn body<'a>(data: &'a [u8], map: &HashMap<u32, ObjSpan>, id: u32) -> Option<&'a [u8]> {
    map.get(&id).map(|s| &data[s.body_start..s.body_end])
}

/// 从对象体里取 `/Length`（直接数字，或 `/Length 12 0 R` 这种间接引用）
fn obj_length(data: &[u8], map: &HashMap<u32, ObjSpan>, b: &[u8]) -> Option<usize> {
    let p = find(b, b"/Length")?;
    let mut i = p + 7;
    while i < b.len() && matches!(b[i], b' ' | b'\r' | b'\n' | b'\t') {
        i += 1;
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    let first: u32 = std::str::from_utf8(&b[start..i]).ok()?.parse().ok()?;
    // 后面若是 " 0 R" 说明是间接引用：真正的长度在 12 号对象的体里
    let mut j = i;
    while j < b.len() && matches!(b[j], b' ' | b'\r' | b'\n') {
        j += 1;
    }
    if j + 1 < b.len() && b[j] == b'0' && (b[j + 1] == b' ' || b[j + 1] == b'\r' || b[j + 1] == b'\n')
    {
        let ob = body(data, map, first)?;
        let s = String::from_utf8_lossy(ob);
        return s.trim().parse::<usize>().ok();
    }
    Some(first as usize)
}

/// 取对象体里的 `/Count`（用于挑根 Pages 节点）
fn obj_count_field(b: &[u8]) -> usize {
    if let Some(p) = find(b, b"/Count") {
        let mut i = p + 6;
        while i < b.len() && matches!(b[i], b' ' | b'\r' | b'\n' | b'\t') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i > start {
            return std::str::from_utf8(&b[start..i])
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        }
    }
    0
}

/// 取对象体里的流数据（stream … endstream），长度优先用 /Length，异常时退回到 endstream
fn stream_bytes(data: &[u8], map: &HashMap<u32, ObjSpan>, id: u32) -> Option<Vec<u8>> {
    let b = body(data, map, id)?;
    let sp = find(b, b"stream")?;
    let mut start = sp + 6;
    // 跳过 stream 之后的 CRLF / LF
    if start < b.len() && b[start] == b'\r' {
        start += 1;
    }
    if start < b.len() && b[start] == b'\n' {
        start += 1;
    }
    let abs_start = map.get(&id)?.body_start + start;
    let declared = obj_length(data, map, b);
    if let Some(len) = declared {
        if abs_start + len <= data.len() {
            return Some(data[abs_start..abs_start + len].to_vec());
        }
    }
    // 退回：到 endstream 为止
    let e = find(&data[abs_start..], b"endstream")?;
    let mut end = abs_start + e;
    while end > abs_start && (data[end - 1] == b'\r' || data[end - 1] == b'\n') {
        end -= 1;
    }
    Some(data[abs_start..end].to_vec())
}

fn is_image_xobject(b: &[u8]) -> bool {
    find(b, b"/Subtype").is_some() && find(b, b"/Image").is_some()
}

fn is_dct(b: &[u8]) -> bool {
    find(b, b"/DCTDecode").is_some()
}

/// 从页面对象的 /XObject << /Im0 4 0 R >> 里取第一个图像对象号
fn page_image_id(data: &[u8], map: &HashMap<u32, ObjSpan>, page_id: u32) -> Option<u32> {
    let b = body(data, map, page_id)?;
    // 优先 /XObject 字典
    if let Some(x) = find(b, b"/XObject") {
        let seg = &b[x..];
        // 形如 << /Im0 4 0 R >>
        let mut i = 0usize;
        while i + 4 < seg.len() {
            if seg[i] == b'/' {
                let mut j = i + 1;
                while j < seg.len()
                    && (seg[j].is_ascii_alphanumeric() || seg[j] == b'_' || seg[j] == b'-')
                {
                    j += 1;
                }
                let mut k = j;
                while k < seg.len() && (seg[k] == b' ' || seg[k] == b'\r' || seg[k] == b'\n') {
                    k += 1;
                }
                let mut m = k;
                while m < seg.len() && seg[m].is_ascii_digit() {
                    m += 1;
                }
                if m > k {
                    let mut n = m;
                    while n < seg.len() && (seg[n] == b' ' || seg[n] == b'\r' || seg[n] == b'\n') {
                        n += 1;
                    }
                    if n + 1 < seg.len() && seg[n] == b'0' && seg[n + 1] == b' ' {
                        let id: u32 = std::str::from_utf8(&seg[k..m]).ok()?.parse().ok()?;
                        // 该对象得是图像
                        if let Some(ib) = body(data, map, id) {
                            if is_image_xobject(ib) {
                                return Some(id);
                            }
                        }
                    }
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
    None
}

/// 递归收集页面对象的顺序
fn collect_pages(
    data: &[u8],
    map: &HashMap<u32, ObjSpan>,
    node: u32,
    out: &mut Vec<u32>,
    depth: u32,
) {
    if depth > 8 || out.len() > 20000 {
        return;
    }
    let Some(b) = body(data, map, node) else { return };
    let is_pages = find(b, b"/Kids").is_some();
    if !is_pages {
        out.push(node);
        return;
    }
    if let Some(kp) = find(b, b"/Kids") {
        let seg = &b[kp..];
        let Some(lb) = find(seg, b"[") else { return };
        let Some(rb) = find(&seg[lb..], b"]") else { return };
        let arr = &seg[lb + 1..lb + rb];
        let mut i = 0usize;
        while i < arr.len() {
            if arr[i].is_ascii_digit() {
                let mut j = i;
                while j < arr.len() && arr[j].is_ascii_digit() {
                    j += 1;
                }
                if let Ok(id) = std::str::from_utf8(&arr[i..j]).unwrap_or("").parse::<u32>() {
                    collect_pages(data, map, id, out, depth + 1);
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
}

/// 依页面树顺序取出全部内嵌 JPEG；结果数量与 `/DCTDecode` 计数不符时改用对象顺序扫描兜底
pub fn extract_images_in_page_order(data: &[u8]) -> Vec<Vec<u8>> {
    let declared = count_marker(data, b"/DCTDecode") as usize;
    let by_tree = collect_by_page_tree(data);
    if !by_tree.is_empty() && (declared == 0 || by_tree.len() == declared) {
        return by_tree;
    }
    let ordered = collect_by_object_order(data);
    if declared > 0 && ordered.len() == declared {
        return ordered;
    }
    if ordered.len() > by_tree.len() {
        return ordered;
    }
    by_tree
}

fn count_marker(data: &[u8], needle: &[u8]) -> u32 {
    if needle.is_empty() || data.len() < needle.len() {
        return 0;
    }
    let mut n = 0u32;
    let mut i = 0usize;
    while i + needle.len() <= data.len() {
        if &data[i..i + needle.len()] == needle {
            n += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    n
}

/// 按页面树（Catalog→Pages→Kids）顺序取图
fn collect_by_page_tree(data: &[u8]) -> Vec<Vec<u8>> {
    let map = index_objects(data);
    let mut pages: Vec<u32> = Vec::new();
    // 找根 Pages：在所有「含 /Kids 且 /Type /Pages」的对象里取 /Count 最大者
    let mut best: Option<(usize, u32)> = None;
    for (id, span) in &map {
        let b = &data[span.body_start..span.body_end];
        if find(b, b"/Kids").is_none() || find(b, b"/Pages").is_none() {
            continue;
        }
        let count = obj_count_field(b);
        if best.map(|(c, _)| count > c).unwrap_or(true) {
            best = Some((count, *id));
        }
    }
    if let Some((_, root)) = best {
        collect_pages(data, &map, root, &mut pages, 0);
    }

    let mut images = Vec::new();
    for pid in &pages {
        if let Some(iid) = page_image_id(data, &map, *pid) {
            if let Some(bytes) = stream_bytes(data, &map, iid) {
                if is_jpeg_bytes(&bytes) {
                    images.push(bytes);
                }
            }
        }
    }
    images
}

fn is_jpeg_bytes(bytes: &[u8]) -> bool {
    bytes.len() > 4
        && bytes[0] == 0xFF
        && bytes[1] == 0xD8
        && bytes[bytes.len() - 2] == 0xFF
        && bytes[bytes.len() - 1] == 0xD9
}

/// 兜底：按对象号升序扫描图像流（该站生成器是线性输出，对象序即页序）
fn collect_by_object_order(data: &[u8]) -> Vec<Vec<u8>> {
    let map = index_objects(data);
    let mut ids: Vec<u32> = map.keys().copied().collect();
    ids.sort_unstable();
    let mut images = Vec::new();
    for id in ids {
        let is_img = match body(data, &map, id) {
            Some(b) => is_dct(b) && is_image_xobject(b),
            None => false,
        };
        if !is_img {
            continue;
        }
        if let Some(bytes) = stream_bytes(data, &map, id) {
            if bytes.len() > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
                images.push(bytes);
            }
        }
    }
    images
}

/// 把多个分卷 PDF 的页按顺序合并为一份页图列表
pub fn collect_pages_from_parts(parts: &[Vec<u8>]) -> (Vec<Vec<u8>>, Vec<usize>) {
    let mut all = Vec::new();
    let mut per_part = Vec::new();
    for p in parts {
        let imgs = extract_images_in_page_order(p);
        per_part.push(imgs.len());
        all.extend(imgs);
    }
    (all, per_part)
}

// ============================================================ 单元测试

#[cfg(test)]
mod tests {
    use super::*;
    use crate::naj_dl::{build_pdf, count_dctdecode_for_test};

    /// 诊断：`NAJ_DIAG_PDF=<某个站方分卷.pdf>` cargo test -- --ignored diag_real_part
    #[test]
    #[ignore]
    fn diag_real_part() {
        let p = std::env::var("NAJ_DIAG_PDF").expect("需要 NAJ_DIAG_PDF");
        let data = std::fs::read(&p).unwrap();
        let map = index_objects(&data);
        println!("对象数 = {}，/DCTDecode 出现次数 = {}", map.len(), count_marker(&data, b"/DCTDecode"));
        let mut pages: Vec<u32> = Vec::new();
        let mut best: Option<(usize, u32)> = None;
        for (id, span) in &map {
            let b = &data[span.body_start..span.body_end];
            if find(b, b"/Kids").is_none() || find(b, b"/Pages").is_none() {
                continue;
            }
            let c = obj_count_field(b);
            if best.map(|(x, _)| c > x).unwrap_or(true) {
                best = Some((c, *id));
            }
        }
        println!("根 Pages = {:?}", best);
        if let Some((_, root)) = best {
            collect_pages(&data, &map, root, &mut pages, 0);
        }
        println!("页面树里的页面对象数 = {}", pages.len());
        let mut no_img = 0;
        for (i, pid) in pages.iter().enumerate() {
            match page_image_id(&data, &map, *pid) {
                Some(iid) => {
                    let bytes = stream_bytes(&data, &map, iid).map(|b| b.len()).unwrap_or(0);
                    if i < 3 || bytes == 0 {
                        println!("  第{}页 obj={} → 图 obj={} 字节={}", i + 1, pid, iid, bytes);
                    }
                    if bytes == 0 {
                        no_img += 1;
                    }
                }
                None => {
                    no_img += 1;
                    if let Some(span) = map.get(pid) {
                        let end = span.body_end.min(span.body_start + 320);
                        let body_txt = String::from_utf8_lossy(&data[span.body_start..end]);
                        println!("  第{}页 obj={} **未找到图**，对象体开头：{}", i + 1, pid, body_txt.replace('\n', " "));
                    }
                }
            }
        }
        println!("无图页面数 = {}", no_img);
        println!("按对象序扫到的图 = {}", collect_by_object_order(&data).len());
        println!("按页面树取到的图 = {}", collect_by_page_tree(&data).len());

        // 逐个对象看：哪些含 /DCTDecode、哪些是 /Image、哪些含 /Kids 或 /Type /Pages
        let mut ids: Vec<u32> = map.keys().copied().collect();
        ids.sort_unstable();
        let mut dct_not_img = Vec::new();
        let mut kids_objs = Vec::new();
        let mut pages_objs = Vec::new();
        for id in &ids {
            let Some(b) = body(&data, &map, *id) else { continue };
            let has_dct = find(b, b"/DCTDecode").is_some();
            let is_img = is_image_xobject(b);
            if has_dct && !is_img {
                dct_not_img.push(*id);
            }
            if find(b, b"/Kids").is_some() {
                kids_objs.push(*id);
            }
            if find(b, b"/Pages").is_some() {
                pages_objs.push(*id);
            }
        }
        println!("含 /DCTDecode 但不是 Image 的对象 = {:?}", dct_not_img);
        println!("含 /Kids 的对象 = {:?}", kids_objs);
        println!("含 /Pages 的对象 = {:?}", pages_objs);
        for id in kids_objs.iter().chain(pages_objs.iter()).take(4) {
            if let Some(span) = map.get(id) {
                let end = span.body_end.min(span.body_start + 400);
                println!("  obj {} 体：{}", id, String::from_utf8_lossy(&data[span.body_start..end]).replace('\n', " "));
            }
        }
        // 目录对象（含 /Type /Catalog 或 /Root）
        for id in &ids {
            if let Some(b) = body(&data, &map, *id) {
                if find(b, b"Catalog").is_some() {
                    println!("  Catalog obj {} 体：{}", id, String::from_utf8_lossy(&b[..b.len().min(300)]).replace('\n', " "));
                }
            }
        }
        let tail = &data[data.len().saturating_sub(400)..];
        println!("文件尾部：{}", String::from_utf8_lossy(tail).replace('\n', " | "));
    }

    fn tiny_jpeg(w: u32, h: u32, marker: u8) -> Vec<u8> {
        // 最小 JPEG 骨架（不参与解码），带一个可区分的填充字节便于校验顺序
        let mut d = vec![0xFF, 0xD8];
        d.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        d.extend_from_slice(&((h >> 8) as u8).to_be_bytes());
        d.extend_from_slice(&(h as u8).to_be_bytes());
        d.extend_from_slice(&((w >> 8) as u8).to_be_bytes());
        d.extend_from_slice(&(w as u8).to_be_bytes());
        d.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        d.extend_from_slice(&[marker; 16]);
        d.extend_from_slice(&[0xFF, 0xD9]);
        d
    }

    /// 用**站方真实 PDF** 验证合并（需要把分卷目录放进环境变量；不进日常测试）
    /// 例：$env:NAJ_MERGE_FIXTURE_DIR="...\591091_尔雅３"; cargo test --offline merge_real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn merge_real_site_pdfs_from_env() {
        let dir = match std::env::var("NAJ_MERGE_FIXTURE_DIR") {
            Ok(d) => d,
            Err(_) => return,
        };
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .expect("目录不可读")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "pdf").unwrap_or(false))
            .collect();
        files.sort();
        let mut parts: Vec<Vec<u8>> = Vec::new();
        for p in &files {
            parts.push(std::fs::read(p).expect("读分卷失败"));
        }
        let (pages, per_part) = collect_pages_from_parts(&parts);
        println!("分卷 {:?} → 合计 {} 页", per_part, pages.len());
        for (i, p) in pages.iter().enumerate() {
            assert!(p.len() > 1000, "第 {} 页过小，可能提取失败", i + 1);
        }
        let merged = build_pdf(&pages, "合订验证", "", "出典").unwrap();
        assert_eq!(count_dctdecode_for_test(&merged), pages.len() as u32);
        println!("合并后页数校验通过：{} 页", pages.len());
    }

    #[test]
    fn merge_two_pdfs_keeps_page_order() {
        // 两个「分卷」：第一个 3 页（标记 A），第二个 2 页（标记 B）
        let p1 = vec![tiny_jpeg(100, 200, b'A'), tiny_jpeg(100, 200, b'A'), tiny_jpeg(100, 200, b'A')];
        let p2 = vec![tiny_jpeg(100, 200, b'B'), tiny_jpeg(100, 200, b'B')];
        let pdf1 = build_pdf(&p1, "卷一", "", "出典").unwrap();
        let pdf2 = build_pdf(&p2, "卷二", "", "出典").unwrap();

        let (pages, per_part) = collect_pages_from_parts(&[pdf1, pdf2]);
        assert_eq!(per_part, vec![3, 2]);
        assert_eq!(pages.len(), 5);
        // 页序：前 3 页是 A，后 2 页是 B
        let marks: Vec<u8> = pages.iter().map(|p| p[p.len() - 3]).collect();
        assert_eq!(marks, vec![b'A', b'A', b'A', b'B', b'B']);

        let merged = build_pdf(&pages, "合订", "", "出典").unwrap();
        assert_eq!(count_dctdecode_for_test(&merged), 5);
    }

    #[test]
    fn extract_from_own_pdf_finds_all_images() {
        let pages = vec![tiny_jpeg(300, 400, b'X'); 4];
        let pdf = build_pdf(&pages, "t", "", "n").unwrap();
        let got = extract_images_in_page_order(&pdf);
        assert_eq!(got.len(), 4);
        assert_eq!(got[0].len(), pages[0].len());
    }

    #[test]
    fn garbage_input_yields_no_images() {
        assert!(extract_images_in_page_order(b"not a pdf at all").is_empty());
        assert!(extract_images_in_page_order(b"%PDF-1.6\n1 0 obj\n<< >>\nendobj\n%%EOF").is_empty());
    }

    /// 回归：JPEG 压缩数据里**偶然出现 "endobj" 这 6 个字节**时，不得把对象截断
    /// （真站 PDF 上表现为「50 页只提取出 49 页」，数据相关、时好时坏）
    #[test]
    fn jpeg_payload_containing_endobj_does_not_break_index() {
        fn jpeg_with_marker(w: u32, h: u32, marker: &[u8]) -> Vec<u8> {
            let mut d = vec![0xFF, 0xD8];
            d.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
            d.extend_from_slice(&((h >> 8) as u8).to_be_bytes());
            d.extend_from_slice(&(h as u8).to_be_bytes());
            d.extend_from_slice(&((w >> 8) as u8).to_be_bytes());
            d.extend_from_slice(&(w as u8).to_be_bytes());
            d.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
            d.extend_from_slice(marker);                 // ← 埋入 endobj / stream 等"陷阱字节"
            d.extend_from_slice(&[0xFF, 0xD9]);
            d
        }
        let pages: Vec<Vec<u8>> = (0..5)
            .map(|i| jpeg_with_marker(120, 160, format!("endobj stream {} 0 obj", i).as_bytes()))
            .collect();
        let pdf = build_pdf(&pages, "陷阱", "", "出典").unwrap();
        let got = extract_images_in_page_order(&pdf);
        assert_eq!(got.len(), 5, "含 endobj 字节的 JPEG 不应影响对象索引");
        for (i, g) in got.iter().enumerate() {
            assert_eq!(g.len(), pages[i].len());
        }

        // 直接验证"无 xref 时的文本扫描"也跳过流数据（把 xref 段砍掉）
        let cut = find(&pdf, b"\nxref\n").map(|p| pdf[..p].to_vec()).unwrap_or(pdf.clone());
        let scanned = index_by_scan(&cut);
        let img_objs = scanned
            .keys()
            .filter(|id| {
                body(&cut, &scanned, **id)
                    .map(|b| find(b, b"/DCTDecode").is_some())
                    .unwrap_or(false)
            })
            .count();
        assert_eq!(img_objs, 5, "无 xref 的扫描回退也必须数齐 5 张图");
    }

    /// 回归：对象头必须是 `<号> <世代> obj`（世代与 obj 之间有空格）
    #[test]
    fn object_header_with_space_is_indexed() {
        let pdf = build_pdf(&[tiny_jpeg(10, 10, b'A')], "t", "", "n").unwrap();
        let map = index_objects(&pdf);
        let mut ids: Vec<u32> = map.keys().copied().collect();
        ids.sort_unstable();
        assert!(map.contains_key(&1), "目录对象应被索引到，实际 = {:?}", ids);
        assert!(ids.len() >= 6, "至少应有 目录/Pages/Info/图/内容流/页 六个对象，实际 = {:?}", ids);
    }
}
