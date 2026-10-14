// ================================================
// src/naj_dl.rs — 国立公文書館デジタルアーカイブ 下载桥（V9.8 · P0/P1）
// ================================================
// 通道（实测结论，2026-10 抓包 + 单页验证）：
//
//   ① 原生 PDF（主通道）
//      查看器页 /img/<冊ID> 里有隐藏表单：
//          <form method="POST" action="/contentDownload/<冊ID>" id="download-form">
//      前端 naj-viewer.js 的 doDownload() 会往表单塞 `cid` 隐藏域（每页一个，
//      取值形如 da12/C104174385500，即查看器页里 .p-viewer-download__checkbox 的 value），
//      然后 POST 到 action + `?type=<格式>`。格式取值**不是** `pdf`：
//          iiifcanvas 内容 → imageJpeg / imageJp2 / imagePdf
//          pdf 内容       → pdfJpeg / pdfPdf
//      实测：POST /contentDownload/591091?type=imagePdf + body `cid=da12%2F…`
//            → 200 application/pdf（%PDF-1.6），Content-Disposition 给出文件名。
//      上限：查看器页 data-limit-count 给出「图像 100 页/批」「PDF 50 页/批」。
//
//   ② IIIF 逐页（兜底通道）
//      ① 失败（403/结构变更/单册页数超批上限拆批仍失败）时，改走
//      /api/iiif/<冊ID>/manifest.json 取 canvas 列表，逐页取图后由本模块合成 PDF
//      （JPEG 以 DCTDecode **原样内嵌**，不重编码）。
//      注意：该站 IIIF 单次响应有 3000px 硬上限（实测 full/max 亦只回 3000×2312）。
//
//   ③ 完整性（用户硬性要求：绝不能「下了第 13 册、漏了第 2 册」）
//      · 每册产物必须通过页数校验才允许标记完成：原生 PDF 用 /DCTDecode 计数
//        （实测该站 PDF 为「一页一张 JPEG」，50 页 PDF 恰好 50 个 /DCTDecode）；
//      · 无法计数（对象流压缩等）时**不得**判为完成，改走 IIIF 兜底重出（可精确校验）；
//      · 全部写盘走「.part → rename」原子替换，断电只留 .part，不留半个成品。
//
// 合规（重要）：/contentDownload/* 在 robots.txt 中为 Disallow，故本模块：
//   · 只由用户在检索结果上**显式点选**触发，不提供「整部/整库」入口；
//   · 批次之间强制间隔（politeness delay），并发默认 1，最高 2；
//   · 界面须展示数据来源与出典。参数由前端传入，默认值不做「越权放大」。
// ================================================
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// 与 naj_db.rs 同源的站点常量
const HOST: &str = "www.digital.archives.go.jp";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
/// 单个响应上限（50 页 PDF 实测约 50MB，留足余量）
const MAX_DL_BYTES: usize = 512 * 1024 * 1024;
/// 单页图像上限
const MAX_IMG_BYTES: usize = 64 * 1024 * 1024;

// ============================================================ 公共结果类型

#[derive(Serialize, Clone)]
pub struct NajSavedFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
    /// 内嵌 JPEG 数（= PDF 页数的可靠代理；该站 PDF 一页一张 JPEG）
    pub pages_dct: u32,
    /// 文件尾部是否有 %%EOF（PDF 结构完整性的最低要求）
    pub eof_ok: bool,
}

#[derive(Serialize)]
pub struct NajNativeResult {
    pub status: u16,
    pub content_type: String,
    pub requested_pages: u32,
    pub files: Vec<NajSavedFile>,
    /// 响应是 ZIP（多文件）时为 true
    pub from_zip: bool,
}

#[derive(Serialize)]
pub struct NajIiifResult {
    pub total: u32,
    /// 1 基页号，失败页
    pub failed: Vec<u32>,
    /// 全部页成功时才写出文件
    pub file: Option<NajSavedFile>,
}

#[derive(Serialize)]
pub struct NajVerify {
    pub ok: bool,
    pub bytes: u64,
    pub pages_dct: u32,
    pub eof_ok: bool,
    pub sha256: String,
    /// 判据：dct（一页一张 JPEG）/ eof（仅结构完整，页数不可知）
    pub method: String,
}

#[derive(Serialize)]
pub struct NajStat {
    pub exists: bool,
    pub is_dir: bool,
    pub bytes: u64,
}

// ============================================================ 下载进度（供「下载中心」轮询）

/// 实时进度快照。前端每 500ms 轮询一次 `naj_dl_progress`，
/// 而不走 Tauri 事件：本项目的 IPC 只用了 `__TAURI_INTERNALS__.invoke`，
/// 轮询可以完全不依赖 @tauri-apps/api 的事件封装（零依赖）。
#[derive(Serialize, Clone, Default)]
pub struct NajProgress {
    /// 是否有正在进行的传输
    pub active: bool,
    /// 当前正在下的对象（书名 / 冊名）
    pub label: String,
    /// native | iiif | zip
    pub kind: String,
    pub bytes_done: u64,
    /// 0 = 未知总长
    pub bytes_total: u64,
    /// 已取页 / 总页（IIIF 通道有意义）
    pub pages_done: u32,
    pub pages_total: u32,
    /// 平滑后的瞬时速度（字节/秒）
    pub speed_bps: f64,
    /// 本次传输已耗时（毫秒）
    pub elapsed_ms: u64,
    /// 最近一次更新时间戳（Unix 毫秒）
    pub updated_ms: u64,
}

#[derive(Default)]
struct ProgressInner {
    active: bool,
    label: String,
    kind: String,
    bytes_done: u64,
    bytes_total: u64,
    pages_done: u32,
    pages_total: u32,
    speed_bps: f64,
    started_ms: u64,
    last_ms: u64,
    last_bytes: u64,
    updated_ms: u64,
}

static PROGRESS: Mutex<Option<ProgressInner>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn prog_begin(label: &str, kind: &str, bytes_total: u64, pages_total: u32) {
    let mut g = PROGRESS.lock().unwrap();
    let now = now_ms();
    *g = Some(ProgressInner {
        active: true,
        label: label.to_string(),
        kind: kind.to_string(),
        bytes_done: 0,
        bytes_total,
        pages_done: 0,
        pages_total,
        speed_bps: 0.0,
        started_ms: now,
        last_ms: now,
        last_bytes: 0,
        updated_ms: now,
    });
}

/// 累加字节并更新速度（滑动窗口 + 指数平滑，避免抖动）
fn prog_add_bytes(n: u64) {
    let mut g = PROGRESS.lock().unwrap();
    let now = now_ms();
    if let Some(p) = g.as_mut() {
        p.bytes_done += n;
        let dt = now.saturating_sub(p.last_ms) as f64 / 1000.0;
        if dt >= 0.25 {
            let inst = (p.bytes_done.saturating_sub(p.last_bytes)) as f64 / dt;
            p.speed_bps = if p.speed_bps <= 0.0 { inst } else { p.speed_bps * 0.6 + inst * 0.4 };
            p.last_ms = now;
            p.last_bytes = p.bytes_done;
        }
        p.updated_ms = now;
    }
}

fn prog_page_done(done: u32) {
    let mut g = PROGRESS.lock().unwrap();
    if let Some(p) = g.as_mut() {
        p.pages_done = done;
        p.updated_ms = now_ms();
    }
}

fn prog_end() {
    let mut g = PROGRESS.lock().unwrap();
    if let Some(p) = g.as_mut() {
        p.active = false;
        p.speed_bps = 0.0;
        p.updated_ms = now_ms();
    }
}

fn prog_snapshot() -> NajProgress {
    let g = PROGRESS.lock().unwrap();
    match g.as_ref() {
        Some(p) => NajProgress {
            active: p.active,
            label: p.label.clone(),
            kind: p.kind.clone(),
            bytes_done: p.bytes_done,
            bytes_total: p.bytes_total,
            pages_done: p.pages_done,
            pages_total: p.pages_total,
            speed_bps: if p.active { p.speed_bps } else { 0.0 },
            elapsed_ms: p.updated_ms.saturating_sub(p.started_ms),
            updated_ms: p.updated_ms,
        },
        None => NajProgress::default(),
    }
}

/// 读取当前下载进度（前端「下载中心」轮询；无传输时 active=false）
#[tauri::command]
pub async fn naj_dl_progress() -> Result<NajProgress, String> {
    Ok(prog_snapshot())
}

/// 清空进度（任务取消/结束时调用）
#[tauri::command]
pub async fn naj_dl_progress_reset() -> Result<(), String> {
    prog_end();
    Ok(())
}

// ============================================================ 请求类型
//
// ⚠️ 字段一律按 camelCase 反序列化：
//    Tauri 只对**命令顶层参数名**做 camelCase→snake_case 转换，
//    结构体内部字段仍由 serde 按 Rust 名严格匹配。前端传的是 { recordId, outDir, fileStem }
//    这类 camelCase，若不加 rename_all，会报
//    「invalid args `req` … missing field `record_id`」（实测踩过）。

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePdfReq {
    /// 冊 ID（= 查看器页 /img/<id> 的 id，也是表单 action 的路径段）
    pub record_id: String,
    /// 每页 cid（查看器页 .p-viewer-download__checkbox 的 value），顺序即页序
    pub cids: Vec<String>,
    /// 输出目录（绝对路径）
    pub out_dir: String,
    /// 文件名主干（前端已按命名模板渲染并做过非法字符处理）
    pub file_stem: String,
    /// 格式：默认 imagePdf（另可 imageJpeg / imageJp2）
    pub kind: Option<String>,
    pub timeout_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IiifVolumeReq {
    /// 页图 URL（按页序）
    pub urls: Vec<String>,
    pub out_dir: String,
    pub file_stem: String,
    pub title: Option<String>,
    pub author: Option<String>,
    /// 写入 PDF /Info 的出典说明
    pub source_note: Option<String>,
    pub concurrency: Option<u32>,
    pub delay_ms: Option<u64>,
    pub timeout_secs: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZipReq {
    /// 待打包文件（绝对路径）
    pub files: Vec<String>,
    /// 输出 zip 绝对路径
    pub out_path: String,
    /// zip 内是否套一层目录（留空则平铺）
    pub root: Option<String>,
}

/// 分卷合并请求（>50 页的册：站方按 50 页/批返回多个 PDF，这里并成一个）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReq {
    /// 分卷文件（**按页序**，即 _1-50、_51-98 …）
    pub parts: Vec<String>,
    pub out_path: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub source_note: Option<String>,
    /// 期望总页数（与单册 canvas 数一致，用于合并后校验）
    pub expect_pages: Option<u32>,
}

// ============================================================ 小工具

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// 文件系统安全的单段名（Windows 非法字符 + 控制字符 → 下划线；合并连续点）
pub fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let bad = matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || (c as u32) < 0x20;
        out.push(if bad { '_' } else { c });
    }
    // 连续点合并为一个
    let mut merged = String::with_capacity(out.len());
    let mut last_dot = false;
    for c in out.chars() {
        if c == '.' {
            if last_dot {
                continue;
            }
            last_dot = true;
        } else {
            last_dot = false;
        }
        merged.push(c);
    }
    let t = merged.trim().trim_matches('.').to_string();
    if t.is_empty() {
        "未命名".to_string()
    } else {
        t
    }
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败（{}）：{}", p.display(), e))
}

/// &str → NUL 结尾的 UTF-16（Win32 LPCWSTR）
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 原子写：先写 `<path>.part`，再 rename 覆盖（同目录 rename 在 Windows 上为原子替换）
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        ensure_dir(dir)?;
    }
    let tmp = PathBuf::from(format!("{}.part", path.to_string_lossy()));
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("创建临时文件失败（{}）：{}", tmp.display(), e))?;
        f.write_all(data)
            .map_err(|e| format!("写入临时文件失败（{}）：{}", tmp.display(), e))?;
        f.flush().map_err(|e| format!("刷盘失败：{}", e))?;
    }
    // Windows 上 rename 不能覆盖已存在文件：先移除目标（失败则忽略）
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("落盘失败（{} → {}）：{}", tmp.display(), path.display(), e)
    })
}

/// 目标文件已存在且非空时另起名字（绝不覆盖既有产物）
fn unique_in_dir(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let base = sanitize_segment(stem);
    let mut cand = dir.join(format!("{}{}", base, ext));
    let mut i = 2;
    while cand.exists() {
        cand = dir.join(format!("{}_{}{}", base, i, ext));
        i += 1;
        if i > 9999 {
            break;
        }
    }
    cand
}

fn count_occurrences(hay: &[u8], needle: &[u8]) -> u32 {
    if needle.is_empty() || hay.len() < needle.len() {
        return 0;
    }
    let mut n = 0u32;
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            n += 1;
            i += needle.len();
        } else {
            i += 1;
        }
    }
    n
}

/// 该站 PDF 为「一页一张 JPEG」，故 /DCTDecode 计数即页数
fn count_dctdecode(data: &[u8]) -> u32 {
    count_occurrences(data, b"/DCTDecode")
}

/// 供 pdf_merge 的单测复用
#[cfg(test)]
pub fn count_dctdecode_for_test(data: &[u8]) -> u32 {
    count_dctdecode(data)
}

fn has_eof(data: &[u8]) -> bool {
    let tail = if data.len() > 4096 {
        &data[data.len() - 4096..]
    } else {
        data
    };
    count_occurrences(tail, b"%%EOF") > 0
}

/// 写盘后统一做产物登记
fn register_file(path: &Path, data: &[u8]) -> NajSavedFile {
    NajSavedFile {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        bytes: data.len() as u64,
        sha256: sha256_hex(data),
        pages_dct: count_dctdecode(data),
        eof_ok: has_eof(data),
    }
}

// ============================================================ JPEG 尺寸

/// 解析 JPEG 的 SOF 段，返回 (宽, 高, 分量数)
pub fn jpeg_info(d: &[u8]) -> Option<(u32, u32, u8)> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 9 < d.len() {
        if d[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = d[i + 1];
        // 无长度字段的标记
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break; // 进入扫描数据
        }
        let len = ((d[i + 2] as usize) << 8) | d[i + 3] as usize;
        if len < 2 {
            break;
        }
        let is_sof = matches!(
            marker,
            0xC0 | 0xC1 | 0xC2 | 0xC3 | 0xC5 | 0xC6 | 0xC7 | 0xC9 | 0xCA | 0xCB | 0xCD | 0xCE | 0xCF
        );
        if is_sof && i + 9 < d.len() {
            let h = ((d[i + 5] as u32) << 8) | d[i + 6] as u32;
            let w = ((d[i + 7] as u32) << 8) | d[i + 8] as u32;
            let comps = d[i + 9];
            if w > 0 && h > 0 {
                return Some((w, h, comps));
            }
            return None;
        }
        i += 2 + len;
    }
    None
}

fn is_jpeg(d: &[u8]) -> bool {
    d.len() > 3 && d[0] == 0xFF && d[1] == 0xD8 && d[d.len() - 2] == 0xFF && d[d.len() - 1] == 0xD9
}

fn is_pdf(d: &[u8]) -> bool {
    d.len() > 5 && &d[0..5] == b"%PDF-"
}

fn is_zip(d: &[u8]) -> bool {
    d.len() > 4 && d[0] == 0x50 && d[1] == 0x4B
}

// ============================================================ PDF 合成（JPEG 原样内嵌）

fn pdf_utf16_hex(s: &str) -> String {
    let mut out = String::from("<FEFF");
    for u in s.encode_utf16() {
        out.push_str(&format!("{:04X}", u));
    }
    out.push('>');
    out
}

fn push_obj(out: &mut Vec<u8>, offsets: &mut Vec<usize>, id: usize, body: &[u8]) {
    // 对象号从 1 起，offsets[id] 记录字节偏移
    if offsets.len() <= id {
        offsets.resize(id + 1, 0);
    }
    offsets[id] = out.len();
    out.extend_from_slice(format!("{} 0 obj\n", id).as_bytes());
    out.extend_from_slice(body);
    out.extend_from_slice(b"\nendobj\n");
}

/// 把一册的 JPEG 页合成为 PDF（DCTDecode 原样内嵌，不重编码）
pub fn build_pdf(pages: &[Vec<u8>], title: &str, author: &str, note: &str) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("没有可用的页面图像".into());
    }
    let n = pages.len();
    let mut dims: Vec<(u32, u32, u8)> = Vec::with_capacity(n);
    for (i, p) in pages.iter().enumerate() {
        match jpeg_info(p) {
            Some(d) => dims.push(d),
            None => return Err(format!("第 {} 页不是可识别的 JPEG，已中止合成", i + 1)),
        }
    }

    // 对象编号：1 Catalog / 2 Pages / 3 Info / 之后每页 3 个（图 / 内容流 / 页）
    let img_id = |i: usize| 4 + 3 * i;
    let cnt_id = |i: usize| 5 + 3 * i;
    let page_id = |i: usize| 6 + 3 * i;
    let total_objs = 3 + 3 * n;

    let mut out: Vec<u8> = Vec::with_capacity(pages.iter().map(|p| p.len()).sum::<usize>() + 8192);
    let mut offsets: Vec<usize> = vec![0; total_objs + 1];
    out.extend_from_slice(b"%PDF-1.6\n%\xE2\xE3\xCF\xD3\n");

    // Catalog
    push_obj(&mut out, &mut offsets, 1, b"<< /Type /Catalog /Pages 2 0 R >>");

    // Pages
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", page_id(i))).collect();
    push_obj(
        &mut out,
        &mut offsets,
        2,
        format!("<< /Type /Pages /Count {} /Kids [{}] >>", n, kids.join(" ")).as_bytes(),
    );

    // Info（书名 / 著者 / 出典 —— 出典是馆方要求的注明方式）
    let info = format!(
        "<< /Title {} /Author {} /Producer {} /Creator {} >>",
        pdf_utf16_hex(title),
        pdf_utf16_hex(author),
        pdf_utf16_hex("古代史及汉籍研究工具 · 国立公文书馆下载"),
        pdf_utf16_hex(note)
    );
    push_obj(&mut out, &mut offsets, 3, info.as_bytes());

    for i in 0..n {
        let (w, h, comps) = dims[i];
        let cs = match comps {
            1 => "/DeviceGray",
            4 => "/DeviceCMYK",
            _ => "/DeviceRGB",
        };
        // 图像 XObject：直接把 JPEG 字节作为流
        let head = format!(
            "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {} \
/BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            w, h, cs, pages[i].len()
        );
        if offsets.len() <= img_id(i) {
            offsets.resize(img_id(i) + 1, 0);
        }
        offsets[img_id(i)] = out.len();
        out.extend_from_slice(format!("{} 0 obj\n", img_id(i)).as_bytes());
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(&pages[i]);
        out.extend_from_slice(b"\nendstream\nendobj\n");

        // 内容流
        let content = format!("q\n{} 0 0 {} 0 0 cm\n/Im0 Do\nQ\n", w, h);
        let cnt = format!(
            "<< /Length {} >>\nstream\n{}endstream",
            content.len(),
            content
        );
        push_obj(&mut out, &mut offsets, cnt_id(i), cnt.as_bytes());

        // 页对象
        let page = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] \
/Resources << /XObject << /Im0 {} 0 R >> >> /Contents {} 0 R >>",
            w,
            h,
            img_id(i),
            cnt_id(i)
        );
        push_obj(&mut out, &mut offsets, page_id(i), page.as_bytes());
    }

    // 交叉引用表
    let xref_off = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", total_objs + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for id in 1..=total_objs {
        out.extend_from_slice(format!("{:010} 00000 n \n", offsets[id]).as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{}\n%%EOF\n",
            total_objs + 1,
            xref_off
        )
        .as_bytes(),
    );
    Ok(out)
}

// ============================================================ ZIP 读（原生响应为 ZIP 时）

fn u16le(d: &[u8], i: usize) -> u16 {
    (d[i] as u16) | ((d[i + 1] as u16) << 8)
}
fn u32le(d: &[u8], i: usize) -> u32 {
    (d[i] as u32) | ((d[i + 1] as u32) << 8) | ((d[i + 2] as u32) << 16) | ((d[i + 3] as u32) << 24)
}

/// 解析 ZIP（支持 store 与 deflate；不处理加密与 ZIP64）
pub fn unzip(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    // 从尾部找 EOCD（0x06054b50）
    if data.len() < 22 {
        return Err("ZIP 过短".into());
    }
    let mut eocd = None;
    let start = data.len().saturating_sub(66_000);
    let mut i = data.len() - 22;
    loop {
        if u32le(data, i) == 0x0605_4B50 {
            eocd = Some(i);
            break;
        }
        if i == start || i == 0 {
            break;
        }
        i -= 1;
    }
    let e = eocd.ok_or_else(|| "未找到 ZIP 中央目录（EOCD）".to_string())?;
    let count = u16le(data, e + 10) as usize;
    let cd_off = u32le(data, e + 16) as usize;
    let mut p = cd_off;
    let mut out = Vec::new();
    for _ in 0..count {
        if p + 46 > data.len() || u32le(data, p) != 0x0201_4B50 {
            break;
        }
        let method = u16le(data, p + 10);
        let comp_size = u32le(data, p + 20) as usize;
        let name_len = u16le(data, p + 28) as usize;
        let extra_len = u16le(data, p + 30) as usize;
        let comment_len = u16le(data, p + 32) as usize;
        let local_off = u32le(data, p + 42) as usize;
        let name = String::from_utf8_lossy(&data[p + 46..p + 46 + name_len]).to_string();
        p += 46 + name_len + extra_len + comment_len;

        if local_off + 30 > data.len() {
            continue;
        }
        let l_name_len = u16le(data, local_off + 26) as usize;
        let l_extra_len = u16le(data, local_off + 28) as usize;
        let data_start = local_off + 30 + l_name_len + l_extra_len;
        if data_start + comp_size > data.len() {
            continue;
        }
        let raw = &data[data_start..data_start + comp_size];
        let bytes = match method {
            0 => raw.to_vec(),
            8 => {
                let mut dec = flate2::read::DeflateDecoder::new(raw);
                let mut buf = Vec::new();
                dec.read_to_end(&mut buf)
                    .map_err(|e| format!("ZIP 解压失败（{}）：{}", name, e))?;
                buf
            }
            m => return Err(format!("不支持的 ZIP 压缩方式（{}）：{}", m, name)),
        };
        out.push((name, bytes));
    }
    if out.is_empty() {
        return Err("ZIP 内没有可提取的文件".into());
    }
    Ok(out)
}

// ============================================================ ZIP 写（store 模式打包）

fn crc32_table() -> &'static [u32; 256] {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            t[i as usize] = c;
        }
        t
    })
}

pub fn crc32(data: &[u8]) -> u32 {
    let t = crc32_table();
    let mut c = 0xFFFF_FFFFu32;
    for b in data {
        c = t[((c ^ (*b as u32)) & 0xFF) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFF_FFFF
}

/// 打包为 ZIP（store：内容已是 PDF/JPEG，压缩无收益）
pub fn write_zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = Vec::new();
    let (dos_time, dos_date) = (0u16, 0x21u16); // 占位时间戳（1980-01-01）
    for (name, data) in files {
        let nb = name.as_bytes();
        let crc = crc32(data);
        offsets.push(out.len() as u32);
        // 本地文件头
        out.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // method = store
        out.extend_from_slice(&dos_time.to_le_bytes());
        out.extend_from_slice(&dos_date.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(nb);
        out.extend_from_slice(data);

        // 中央目录项
        central.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&dos_time.to_le_bytes());
        central.extend_from_slice(&dos_date.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(nb.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra
        central.extend_from_slice(&0u16.to_le_bytes()); // comment
        central.extend_from_slice(&0u16.to_le_bytes()); // disk
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central.extend_from_slice(&offsets[offsets.len() - 1].to_le_bytes());
        central.extend_from_slice(nb);
    }
    let cd_off = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    // EOCD
    out.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_off.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

// ============================================================ 表单编码 / 延迟

/// encodeURIComponent 等价（cid 含 `/`，必须编码）
pub fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn polite_sleep(ms: u64) {
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

fn build_client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs.clamp(10, 1800)))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(UA)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))
}

// ============================================================ 命令：原生 PDF

/// POST /contentDownload/<id>?type=imagePdf 取回一批（≤50 页）PDF
fn native_pdf_blocking(req: NativePdfReq) -> Result<NajNativeResult, String> {
    if req.cids.is_empty() {
        return Err("本批没有任何页（cid 列表为空）".into());
    }
    let kind = req.kind.unwrap_or_else(|| "imagePdf".to_string());
    let url = format!("https://{}/contentDownload/{}?type={}", HOST, req.record_id, kind);
    if !crate::naj_db::url_allowed(&url) {
        return Err("下载地址不在允许清单内（仅限国立公文书馆本站端点）".into());
    }
    let referer = format!("https://{}/img/{}", HOST, req.record_id);
    let body = req
        .cids
        .iter()
        .map(|c| format!("cid={}", form_encode(c)))
        .collect::<Vec<_>>()
        .join("&");

    let client = build_client(req.timeout_secs.unwrap_or(600))?;
    let resp = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
        .header("Accept", "application/pdf, application/zip, */*;q=0.8")
        .header("Referer", referer)
        .header("Origin", format!("https://{}", HOST))
        .header("X-Requested-With", "XMLHttpRequest")
        .body(body)
        .send()
        .map_err(|e| format!("请求失败：{}", e))?;

    let status = resp.status().as_u16();
    let ctype = resp
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap_or("").to_string())
        .unwrap_or_default();
    let total_len = resp.content_length().unwrap_or(0);
    prog_begin(&req.file_stem, "native", total_len, req.cids.len() as u32);

    let mut buf: Vec<u8> = Vec::with_capacity(4 * 1024 * 1024);
    let mut read_err: Option<String> = None;
    {
        let mut r = resp;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match r.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    prog_add_bytes(n as u64);
                    if buf.len() > MAX_DL_BYTES {
                        prog_end();
                        return Err("响应超过单批上限，已中止".into());
                    }
                }
                Err(e) => {
                    // ⚠️ V10.3：**半截响应绝不能当成功**。
                    // 早期版本在这里 break 后继续走：被掐断的 PDF 照样落盘，而校验只数 /DCTDecode
                    // 又恰好数够（图都在、只是少掉尾部的页面树/xref/trailer），
                    // 于是残缺 PDF 一路进到压缩包里（实测：一卷 50 页的 PDF 没有 xref/trailer）。
                    read_err = Some(e.to_string());
                    break;
                }
            }
        }
    }
    prog_end();

    if let Some(e) = read_err {
        return Err(format!(
            "响应传输中断（已收到 {} 字节{}）：{}；本批不计为成功，将自动重试或走兜底通道",
            buf.len(),
            if total_len > 0 { format!(" / 共 {} 字节", total_len) } else { String::new() },
            e
        ));
    }
    if total_len > 0 && (buf.len() as u64) < total_len {
        return Err(format!(
            "响应不完整（收到 {} 字节，服务端声明 {} 字节）；本批不计为成功，将自动重试或走兜底通道",
            buf.len(),
            total_len
        ));
    }

    if status != 200 {
        let preview = String::from_utf8_lossy(&buf[..buf.len().min(200)]).to_string();
        return Err(format!(
            "原站返回 HTTP {}（{}）；响应开头：{}",
            status,
            ctype,
            preview.replace('\n', " ")
        ));
    }

    let out_dir = PathBuf::from(&req.out_dir);
    ensure_dir(&out_dir)?;
    let mut files: Vec<NajSavedFile> = Vec::new();
    let mut from_zip = false;

    if is_pdf(&buf) {
        let path = out_dir.join(format!("{}.pdf", sanitize_segment(&req.file_stem)));
        let f = register_file(&path, &buf);
        // ⚠️ V10.3：PDF 结构必须完整（有 %%EOF / 尾部 xref）。少了尾部就是被掐断的半成品，
        // 不能落盘当成果，否则会出现「页数数得对、文件却打不开」的残缺 PDF。
        if !f.eof_ok {
            return Err(format!(
                "收到的 PDF 结构不完整（缺少文件尾部 %%EOF，共 {} 字节）：多半是传输被掐断；\
                 本批不计为成功，将自动重试或走兜底通道",
                buf.len()
            ));
        }
        write_atomic(&path, &buf)?;
        files.push(f);
    } else if is_zip(&buf) {
        from_zip = true;
        let entries = unzip(&buf)?;
        let mut idx = 0usize;
        for (name, data) in entries {
            if !is_pdf(&data) {
                continue;
            }
            idx += 1;
            let stem = if idx == 1 {
                req.file_stem.clone()
            } else {
                format!("{}_{}", req.file_stem, idx)
            };
            let _ = name;
            let f = register_file(&out_dir.join(format!("{}.pdf", sanitize_segment(&stem))), &data);
            if !f.eof_ok {
                return Err(format!(
                    "ZIP 里的 PDF 结构不完整（{}，缺少 %%EOF）：本批不计为成功，将自动重试或走兜底通道",
                    stem
                ));
            }
            let path = PathBuf::from(&f.path);
            write_atomic(&path, &data)?;
            files.push(f);
        }
        if files.is_empty() {
            return Err("ZIP 响应里没有 PDF".into());
        }
    } else {
        let preview = String::from_utf8_lossy(&buf[..buf.len().min(200)]).to_string();
        return Err(format!(
            "原站返回的不是 PDF（Content-Type: {}；开头：{}）",
            ctype,
            preview.replace('\n', " ")
        ));
    }

    Ok(NajNativeResult {
        status,
        content_type: ctype,
        requested_pages: req.cids.len() as u32,
        files,
        from_zip,
    })
}

#[tauri::command]
pub async fn naj_dl_native_pdf(req: NativePdfReq) -> Result<NajNativeResult, String> {
    tauri::async_runtime::spawn_blocking(move || native_pdf_blocking(req))
        .await
        .map_err(|e| format!("下载线程异常：{}", e))?
}

// ============================================================ 命令：IIIF 兜底

fn iiif_volume_blocking(req: IiifVolumeReq) -> Result<NajIiifResult, String> {
    let total = req.urls.len() as u32;
    if total == 0 {
        return Err("该册没有任何页（IIIF 清单为空）".into());
    }
    let conc = req.concurrency.unwrap_or(2).clamp(1, 2);
    let delay = req.delay_ms.unwrap_or(400);
    let timeout = req.timeout_secs.unwrap_or(600);
    let client = build_client(timeout)?;

    let slots: Vec<std::sync::Mutex<Option<Vec<u8>>>> =
        (0..req.urls.len()).map(|_| std::sync::Mutex::new(None)).collect();
    let failed: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
    let cursor = AtomicUsize::new(0);
    let done_pages = AtomicUsize::new(0);
    prog_begin(&req.file_stem, "iiif", 0, total);

    let urls = &req.urls;
    let slots_ref = &slots;
    let failed_ref = &failed;
    let cursor_ref = &cursor;
    let client_ref = &client;
    let done_ref = &done_pages;

    std::thread::scope(|scope| {
        for _ in 0..conc {
            scope.spawn(move || loop {
                let i = cursor_ref.fetch_add(1, Ordering::SeqCst);
                if i >= urls.len() {
                    break;
                }
                let url = &urls[i];
                if !crate::naj_db::url_allowed(url) {
                    failed_ref.lock().unwrap().push((i + 1) as u32);
                    continue;
                }
                let mut ok = false;
                for attempt in 0..3u32 {
                    match fetch_image(client_ref, url) {
                        Ok(bytes) if is_jpeg(&bytes) => {
                            prog_add_bytes(bytes.len() as u64);
                            prog_page_done(done_ref.fetch_add(1, Ordering::SeqCst) as u32 + 1);
                            *slots_ref[i].lock().unwrap() = Some(bytes);
                            ok = true;
                            break;
                        }
                        Ok(_) => {
                            // 拿到了但不是 JPEG（多半是限流/错误页）：退避后重试
                            polite_sleep(if attempt == 0 { 800 } else { 2000 });
                        }
                        Err(_) => {
                            polite_sleep(if attempt == 0 { 500 } else { 1500 });
                        }
                    }
                }
                if !ok {
                    failed_ref.lock().unwrap().push((i + 1) as u32);
                }
                polite_sleep(delay);
            });
        }
    });
    prog_end();

    let mut failed = failed.into_inner().unwrap();
    failed.sort_unstable();
    if !failed.is_empty() {
        return Ok(NajIiifResult {
            total,
            failed,
            file: None,
        });
    }

    let mut pages: Vec<Vec<u8>> = Vec::with_capacity(slots.len());
    for s in slots {
        match s.into_inner().unwrap() {
            Some(v) => pages.push(v),
            None => {
                return Ok(NajIiifResult {
                    total,
                    failed: vec![0],
                    file: None,
                })
            }
        }
    }

    let title = req.title.clone().unwrap_or_default();
    let author = req.author.clone().unwrap_or_default();
    let note = req
        .source_note
        .clone()
        .unwrap_or_else(|| "国立公文書館デジタルアーカイブ（IIIF 逐页）".to_string());
    let pdf = build_pdf(&pages, &title, &author, &note)?;

    let out_dir = PathBuf::from(&req.out_dir);
    ensure_dir(&out_dir)?;
    let path = unique_in_dir(&out_dir, &req.file_stem, ".pdf");
    write_atomic(&path, &pdf)?;
    Ok(NajIiifResult {
        total,
        failed: Vec::new(),
        file: Some(register_file(&path, &pdf)),
    })
}

fn fetch_image(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .header("Accept", "image/jpeg, image/*;q=0.8, */*;q=0.5")
        .header("Referer", format!("https://{}/", HOST))
        .send()
        .map_err(|e| format!("网络请求失败：{}", e))?;
    if resp.status().as_u16() != 200 {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let mut buf: Vec<u8> = Vec::with_capacity(1024 * 1024);
    let mut r = resp;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match r.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > MAX_IMG_BYTES {
                    return Err("单页图像超过上限".into());
                }
            }
            Err(e) => {
                if buf.is_empty() {
                    return Err(format!("读取失败：{}", e));
                }
                break;
            }
        }
    }
    Ok(buf)
}

#[tauri::command]
pub async fn naj_dl_iiif_volume(req: IiifVolumeReq) -> Result<NajIiifResult, String> {
    tauri::async_runtime::spawn_blocking(move || iiif_volume_blocking(req))
        .await
        .map_err(|e| format!("兜底下载线程异常：{}", e))?
}

// ============================================================ 命令：打包 / 校验 / 文件 IO

#[tauri::command]
pub async fn naj_dl_zip(req: ZipReq) -> Result<NajSavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<NajSavedFile, String> {
        if req.files.is_empty() {
            return Err("没有可打包的文件".into());
        }
        let root = req.root.map(|r| sanitize_segment(&r));
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for f in &req.files {
            let p = PathBuf::from(f);
            let data = std::fs::read(&p)
                .map_err(|e| format!("读取待打包文件失败（{}）：{}", p.display(), e))?;
            let base = p
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let name = match &root {
                Some(r) => format!("{}/{}", r, base),
                None => base,
            };
            entries.push((name, data));
        }
        let zip = write_zip(&entries);
        let out = PathBuf::from(&req.out_path);
        if let Some(dir) = out.parent() {
            ensure_dir(dir)?;
        }
        write_atomic(&out, &zip)?;
        Ok(register_file(&out, &zip))
    })
    .await
    .map_err(|e| format!("打包线程异常：{}", e))?
}

/// 把站方返回的多个分卷 PDF 合并成一个（>50 页的册用）。
///
/// 不解码、不重编码：按页面树顺序把各分卷内嵌的 JPEG 原样取出，再用 build_pdf 装订，
/// 因此画质与分卷完全一致；合并后 /DCTDecode 计数 == 期望页数才算成功。
#[tauri::command]
pub async fn naj_dl_merge_pdfs(req: MergeReq) -> Result<NajSavedFile, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<NajSavedFile, String> {
        if req.parts.is_empty() {
            return Err("没有待合并的分卷".into());
        }
        let mut datas: Vec<Vec<u8>> = Vec::with_capacity(req.parts.len());
        for p in &req.parts {
            let path = PathBuf::from(p);
            let d = std::fs::read(&path)
                .map_err(|e| format!("读取分卷失败（{}）：{}", path.display(), e))?;
            if !is_pdf(&d) {
                return Err(format!("分卷不是 PDF：{}", path.display()));
            }
            datas.push(d);
        }

        let (pages, per_part) = crate::pdf_merge::collect_pages_from_parts(&datas);
        let declared: usize = datas.iter().map(|d| count_dctdecode(d) as usize).sum();
        if pages.is_empty() {
            return Err("分卷里没有可提取的页面图像（原站 PDF 结构可能已变）".into());
        }
        // 先逐卷核对（能直接指出是哪一卷出的问题），再核对总数
        for (i, d) in datas.iter().enumerate() {
            let n = count_dctdecode(d) as usize;
            if n > 0 && n != per_part[i] {
                return Err(format!(
                    "第 {} 个分卷页数不符：PDF 内声明 {} 页，实际提取 {} 页",
                    i + 1,
                    n,
                    per_part[i]
                ));
            }
        }
        if declared > 0 && declared != pages.len() {
            return Err(format!(
                "合并页数校验失败：分卷共声明 {} 页，实际提取 {} 页",
                declared,
                pages.len()
            ));
        }
        if let Some(exp) = req.expect_pages {
            if exp > 0 && pages.len() != exp as usize {
                return Err(format!(
                    "合并页数校验失败：整册应为 {} 页，合并得到 {} 页",
                    exp,
                    pages.len()
                ));
            }
        }

        let pdf = build_pdf(
            &pages,
            &req.title.unwrap_or_default(),
            &req.author.unwrap_or_default(),
            &req.source_note
                .unwrap_or_else(|| "国立公文書館デジタルアーカイブ（分卷合并）".to_string()),
        )?;
        let out = PathBuf::from(&req.out_path);
        if let Some(dir) = out.parent() {
            ensure_dir(dir)?;
        }
        write_atomic(&out, &pdf)?;
        Ok(register_file(&out, &pdf))
    })
    .await
    .map_err(|e| format!("合并线程异常：{}", e))?
}

#[tauri::command]
pub async fn naj_dl_verify_pdf(path: String, expect_pages: u32) -> Result<NajVerify, String> {    let p = PathBuf::from(&path);
    let data = std::fs::read(&p).map_err(|e| format!("读取文件失败：{}", e))?;
    let pages_dct = count_dctdecode(&data);
    let eof_ok = has_eof(&data);
    let ok = if pages_dct > 0 {
        expect_pages == 0 || pages_dct == expect_pages
    } else {
        // 页数不可知时**不**判为通过（宁可走兜底重出，也不接受「可能缺页」的产物）
        false
    };
    Ok(NajVerify {
        ok,
        bytes: data.len() as u64,
        pages_dct,
        eof_ok,
        sha256: sha256_hex(&data),
        method: if pages_dct > 0 { "dct".into() } else { "eof".into() },
    })
}

#[tauri::command]
pub async fn naj_dl_write_text(path: String, text: String) -> Result<u64, String> {
    let p = PathBuf::from(&path);
    write_atomic(&p, text.as_bytes())?;
    Ok(text.len() as u64)
}

#[tauri::command]
pub async fn naj_dl_read_text(path: String) -> Result<Option<String>, String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(None);
    }
    let data = std::fs::read(&p).map_err(|e| format!("读取失败：{}", e))?;
    Ok(Some(String::from_utf8_lossy(&data).to_string()))
}

#[tauri::command]
pub async fn naj_dl_stat(path: String) -> Result<NajStat, String> {
    let p = PathBuf::from(&path);
    match std::fs::metadata(&p) {
        Ok(m) => Ok(NajStat {
            exists: true,
            is_dir: m.is_dir(),
            bytes: m.len(),
        }),
        Err(_) => Ok(NajStat {
            exists: false,
            is_dir: false,
            bytes: 0,
        }),
    }
}

#[tauri::command]
pub async fn naj_dl_mkdir(path: String) -> Result<(), String> {
    ensure_dir(&PathBuf::from(&path))
}

/// 默认输出根目录：<系统下载目录>/国立公文书馆下载
#[tauri::command]
pub async fn naj_dl_default_root(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("取下载目录失败：{}", e))?;
    let root = dir.join("国立公文书馆下载");
    ensure_dir(&root)?;
    Ok(root.to_string_lossy().replace('\\', "/"))
}

// ============================================================ 命令：选择下载位置（手写 Win32 FFI）
//
// 为何不用 rfd / tauri-plugin-dialog：本机 cargo 缓存中没有这两个 crate，
// 而项目既有的 single_instance.rs 已确立「手写 FFI、零额外依赖」的做法（同源原因）。
// SHBrowseForFolderW 是 shell32 的老牌接口，配合 BIF_NEWDIALOGSTYLE 会给出
// 可调整大小、可新建文件夹、可粘贴路径的选择框；标题与按钮语言跟随系统（中文系统即中文）。
//
// ⚠️ 对话框必须挂在主窗口 HWND 上，否则会在主窗口后面弹不出来。

#[repr(C)]
struct BrowseInfoW {
    hwnd_owner: *mut c_void,
    pidl_root: *mut c_void,
    psz_display_name: *mut u16,
    lpsz_title: *const u16,
    ul_flags: u32,
    lpfn: Option<BrowseCallbackProc>,
    l_param: isize,
    i_image: i32,
}

type BrowseCallbackProc =
    unsafe extern "system" fn(hwnd: *mut c_void, msg: u32, l_param: isize, lp_data: isize) -> i32;

const BIF_RETURNONLYFSDIRS: u32 = 0x0001;
const BIF_EDITBOX: u32 = 0x0010;
const BIF_NEWDIALOGSTYLE: u32 = 0x0040;
const BFFM_INITIALIZED: u32 = 1;
const BFFM_SETSELECTIONW: u32 = 0x0467; // WM_USER + 103

/// 回调里用到「初始目录」：用全局变量传给 C 回调（回调不能再带闭包）
static BROWSE_INIT_DIR: Mutex<Option<Vec<u16>>> = Mutex::new(None);

unsafe extern "system" fn browse_callback(
    hwnd: *mut c_void,
    msg: u32,
    l_param: isize,
    _lp_data: isize,
) -> i32 {
    if msg == BFFM_INITIALIZED {
        if let Ok(g) = BROWSE_INIT_DIR.lock() {
            if let Some(s) = g.as_ref() {
                SendMessageW(hwnd, BFFM_SETSELECTIONW, 1, s.as_ptr() as isize);
            }
        }
    }
    let _ = l_param;
    0
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn SHBrowseForFolderW(lpbi: *mut BrowseInfoW) -> *mut c_void;
    fn SHGetPathFromIDListW(pidl: *const c_void, psz_path: *mut u16) -> i32;
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoTaskMemFree(pv: *mut c_void);
    fn CoInitializeEx(pv: *mut c_void, coinit: u32) -> i32;
    fn CoUninitialize();
}

#[link(name = "user32")]
unsafe extern "system" {
    fn SendMessageW(hwnd: *mut c_void, msg: u32, w_param: usize, l_param: isize) -> isize;
}

/// 弹出「选择文件夹」对话框；用户取消时返回 None
#[tauri::command]
pub async fn naj_dl_pick_folder(
    app: tauri::AppHandle,
    title: Option<String>,
    initial: Option<String>,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let owner = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as *mut c_void)
            .unwrap_or(std::ptr::null_mut());

        // 供回调使用的初始目录（NUL 结尾宽字符）
        {
            let mut g = BROWSE_INIT_DIR.lock().unwrap();
            *g = initial
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| {
                    let cleaned = s.replace('/', "\\");
                    let mut v: Vec<u16> = cleaned.encode_utf16().collect();
                    v.push(0);
                    v
                });
        }

        let hr = unsafe { CoInitializeEx(std::ptr::null_mut(), 0x2 /* APARTMENTTHREADED */) };
        let com_ok = hr >= 0;

        let title_w = wide(&title.unwrap_or_else(|| "选择下载位置".to_string()));
        let mut display = vec![0u16; 260];
        let mut bi = BrowseInfoW {
            hwnd_owner: owner,
            pidl_root: std::ptr::null_mut(),
            psz_display_name: display.as_mut_ptr(),
            lpsz_title: title_w.as_ptr(),
            ul_flags: BIF_RETURNONLYFSDIRS | BIF_EDITBOX | BIF_NEWDIALOGSTYLE,
            lpfn: Some(browse_callback),
            l_param: 0,
            i_image: 0,
        };

        let pidl = unsafe { SHBrowseForFolderW(&mut bi) };
        let out = if pidl.is_null() {
            None // 用户取消
        } else {
            let mut path = vec![0u16; 1024];
            let ok = unsafe { SHGetPathFromIDListW(pidl, path.as_mut_ptr()) };
            unsafe { CoTaskMemFree(pidl) };
            if ok == 0 {
                None
            } else {
                let end = path.iter().position(|&c| c == 0).unwrap_or(path.len());
                Some(String::from_utf16_lossy(&path[..end]))
            }
        };

        if com_ok {
            unsafe { CoUninitialize() };
        }
        Ok(out.map(|s| s.replace('\\', "/")))
    })
    .await
    .map_err(|e| format!("选择目录线程异常：{}", e))?
}

/// 删除文件或目录（仅用于清理临时分页图与用户显式要求的重下）
#[tauri::command]
pub async fn naj_dl_remove(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(());
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("删除目录失败：{}", e))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("删除文件失败：{}", e))
    }
}

// ============================================================ 单元测试

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_jpeg(w: u32, h: u32) -> Vec<u8> {
        // 仅含 SOF0 的最小 JPEG 骨架（不参与解码，只用于尺寸解析与内嵌）
        let mut d = vec![0xFF, 0xD8];
        d.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        d.extend_from_slice(&((h >> 8) as u8).to_be_bytes());
        d.extend_from_slice(&(h as u8).to_be_bytes());
        d.extend_from_slice(&((w >> 8) as u8).to_be_bytes());
        d.extend_from_slice(&(w as u8).to_be_bytes());
        d.extend_from_slice(&[0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        d.extend_from_slice(&[0xFF, 0xD9]);
        d
    }

    #[test]
    fn sanitize_windows_names() {
        assert_eq!(sanitize_segment("a/b:c*d?e\"f<g>h|i"), "a_b_c_d_e_f_g_h_i");
        assert_eq!(sanitize_segment("书名..卷"), "书名.卷");
        assert_eq!(sanitize_segment("..."), "未命名");
        assert_eq!(sanitize_segment("  尔雅３  "), "尔雅３");
    }

    #[test]
    fn jpeg_dimension_parse() {
        let j = tiny_jpeg(3779, 2913);
        assert_eq!(jpeg_info(&j), Some((3779, 2913, 3)));
        assert!(is_jpeg(&j));
        assert!(!is_jpeg(&[0xFF, 0xD8, 0x00]));
        assert_eq!(jpeg_info(&[0x00, 0x01]), None);
    }

    #[test]
    fn pdf_has_one_image_per_page() {
        let pages = vec![tiny_jpeg(100, 200), tiny_jpeg(300, 400)];
        let pdf = build_pdf(&pages, "书名", "著者", "出典").unwrap();
        assert!(is_pdf(&pdf));
        assert!(has_eof(&pdf));
        // 页数校验的判据：/DCTDecode 数 == 页数
        assert_eq!(count_dctdecode(&pdf), 2);
        let s = String::from_utf8_lossy(&pdf).to_string();
        assert!(s.contains("/Count 2"));
        assert!(s.contains("/MediaBox [0 0 100 200]"));
        assert!(s.contains("/MediaBox [0 0 300 400]"));
        assert!(s.contains("xref"));
        assert!(s.contains("/Root 1 0 R"));
    }

    #[test]
    fn pdf_rejects_non_jpeg() {
        let e = build_pdf(&[vec![1, 2, 3]], "t", "a", "n");
        assert!(e.is_err());
    }

    #[test]
    fn zip_roundtrip_store() {
        let files = vec![
            ("001.pdf".to_string(), b"%PDF-1.6 fake".to_vec()),
            ("dir/002.pdf".to_string(), b"%PDF-1.6 fake2".to_vec()),
        ];
        let z = write_zip(&files);
        assert!(is_zip(&z));
        let back = unzip(&z).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].0, "001.pdf");
        assert_eq!(back[1].0, "dir/002.pdf");
        assert_eq!(back[1].1, b"%PDF-1.6 fake2");
    }

    #[test]
    fn zip_roundtrip_deflate() {
        // 用 flate2 造一个 deflate 条目，验证解压路径
        use flate2::write::DeflateEncoder;
        use flate2::Compression;
        let payload = b"%PDF-1.6 deflated content".to_vec();
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&payload).unwrap();
        let comp = enc.finish().unwrap();

        let name = "x.pdf".to_string();
        let mut local: Vec<u8> = Vec::new();
        local.extend_from_slice(&0x0403_4B50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&8u16.to_le_bytes()); // deflate
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(&crc32(&payload).to_le_bytes());
        local.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        local.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name.as_bytes());
        local.extend_from_slice(&comp);
        let cd_off = local.len() as u32;
        let mut cd: Vec<u8> = Vec::new();
        cd.extend_from_slice(&0x0201_4B50u32.to_le_bytes());
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&8u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&crc32(&payload).to_le_bytes());
        cd.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
        cd.extend_from_slice(&[0u8; 8]);
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(name.as_bytes());
        let cd_size = cd.len() as u32;
        let mut z = local;
        z.extend_from_slice(&cd);
        z.extend_from_slice(&0x0605_4B50u32.to_le_bytes());
        z.extend_from_slice(&[0u8; 4]);
        z.extend_from_slice(&1u16.to_le_bytes());
        z.extend_from_slice(&1u16.to_le_bytes());
        z.extend_from_slice(&cd_size.to_le_bytes());
        z.extend_from_slice(&cd_off.to_le_bytes());
        z.extend_from_slice(&0u16.to_le_bytes());

        let back = unzip(&z).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].1, payload);
    }

    #[test]
    fn form_encoding_matches_encodeuricomponent() {
        assert_eq!(form_encode("da12/C104174385500"), "da12%2FC104174385500");
        assert_eq!(form_encode("a b~c-d_e.f"), "a%20b~c-d_e.f");
    }

    #[test]
    fn crc32_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn sha256_known_value() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    /// 回归：前端传 camelCase，必须能反序列化成功
    /// （Tauri 只转顶层参数名；结构体字段若不 rename_all 会报 missing field `record_id`）
    #[test]
    fn request_structs_accept_camel_case() {
        let v = serde_json::json!({
            "recordId": "591091",
            "cids": ["da12/C104174385500"],
            "outDir": "D:/out",
            "fileStem": "001_爾雅３",
            "kind": "imagePdf",
            "timeoutSecs": 900
        });
        let r: NativePdfReq = serde_json::from_value(v).expect("NativePdfReq 应接受 camelCase");
        assert_eq!(r.record_id, "591091");
        assert_eq!(r.out_dir, "D:/out");
        assert_eq!(r.file_stem, "001_爾雅３");
        assert_eq!(r.timeout_secs, Some(900));

        let v = serde_json::json!({
            "urls": ["https://www.digital.archives.go.jp/api/content/item/a/iiif/b.jp2/full/max/0/native.jpg"],
            "outDir": "D:/out",
            "fileStem": "x",
            "sourceNote": "出典",
            "concurrency": 2,
            "delayMs": 400,
            "timeoutSecs": 900
        });
        let r: IiifVolumeReq = serde_json::from_value(v).expect("IiifVolumeReq 应接受 camelCase");
        assert_eq!(r.out_dir, "D:/out");
        assert_eq!(r.source_note.as_deref(), Some("出典"));
        assert_eq!(r.delay_ms, Some(400));

        let v = serde_json::json!({ "files": ["a.pdf"], "outPath": "D:/out/a.zip", "root": "书" });
        let r: ZipReq = serde_json::from_value(v).expect("ZipReq 应接受 camelCase");
        assert_eq!(r.out_path, "D:/out/a.zip");
        assert_eq!(r.root.as_deref(), Some("书"));
    }

    /// 回归：页面未给出页数（或 /DCTDecode 计数为 0）时，**不得**判为完成
    #[test]
    fn verify_rejects_unverifiable_page_count() {
        // 构造一个不带 /DCTDecode 的「PDF」：页数不可核验 → 必须失败
        let dir = std::env::temp_dir().join("naj_dl_test_verify");
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("fake.pdf");
        std::fs::write(&f, b"%PDF-1.6\n1 0 obj\n<< >>\nendobj\ntrailer\n%%EOF\n").unwrap();
        let data = std::fs::read(&f).unwrap();
        assert_eq!(count_dctdecode(&data), 0);
        assert!(has_eof(&data));
        // 判据与命令实现一致：pages_dct==0 → ok=false
        let ok = count_dctdecode(&data) > 0;
        assert!(!ok, "页数不可核验必须不计为完成");
        let _ = std::fs::remove_file(&f);
    }
}
