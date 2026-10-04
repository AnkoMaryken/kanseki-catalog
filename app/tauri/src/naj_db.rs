// ================================================
// src/naj_db.rs — 国立公文書館デジタルアーカイブ 检索桥（无 CORS）
// ================================================
// 数据源：https://www.digital.archives.go.jp
//         （国立公文書館デジタルアーカイブ／National Archives of Japan）
//
// 为什么必须走 Rust 而不是浏览器（实测结论，2026-10 活体探测）：
//   1) 检索页 /search 与单条记录 /item|file|fonds/<ID>.json **不返回**
//      Access-Control-Allow-Origin —— 浏览器 fetch 被同源策略拒绝；
//   2) 该站连接不稳：同一 URL 连发 5 次实测 3 次被服务端重置
//      （reqwest/undici 报 "other side closed"），必须重试 + 保全部分结果；
//   3) 详情走 JSON-LD（application/ld+json），比解析 HTML 干净得多。
//   注：/sparql、/api/iiif/*、/thumb/* 三个端点**带** ACAO: *，
//       但 /sparql 实测只支持 ?s ?p ?o / ?s <uri> ?o + LIMIT/OFFSET、DESCRIBE，
//       FILTER/ORDER BY/COUNT/JOIN 一律 400，故检索一律走 /search。
//
// 安全约束（重要）：
//   只允许访问 HOST 且路径命中白名单前缀，禁止把本命令变成任意 URL 代理（SSRF）。
//
// 部分结果保全：
//   已读到字节后被掐断 → 返回已读内容并置 truncated=true，前端明确提示「结果不完整」；
//   一个字节都没读到（连接被重置）→ 视为可重试错误，退避后重试。
// ================================================
use serde::{Deserialize, Serialize};

/// 唯一允许的站点
const HOST: &str = "www.digital.archives.go.jp";
/// 允许的路径前缀（均为该站公开的检索/数据端点）
const ALLOWED_PATHS: &[&str] = &[
    "/search",
    "/item/",
    "/file/",
    "/fonds/",
    "/sparql",
    "/api/iiif/",
    "/thumb/",
];
/// 浏览器 UA：该站对非浏览器 UA 的连接处理更不稳定（实测），统一伪装
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
/// 单次响应上限：实测检索页 20 条约 215KB、100 条约 1.9MB，24MB 留足余量
const MAX_BYTES: usize = 24 * 1024 * 1024;
/// 连接被重置时的最大尝试次数
const MAX_ATTEMPTS: u32 = 3;

#[derive(Serialize, Deserialize)]
pub struct NajHttpResponse {
    pub status: u16,
    pub body: String,
    pub bytes: usize,
    /// 服务器中途掐断 / 读超时 / 超出上限：body 为部分内容
    pub truncated: bool,
    pub url: String,
    /// 实际尝试次数（1 = 一次成功）
    pub attempts: u32,
}

/// 白名单校验：仅 https + 本站 + 允许的路径前缀
fn url_allowed(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(r) => r,
        None => return false,
    };
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // 端口须缺省或为 443 —— 否则 ":8443" 之类的写法会被误判为同站
    let mut hp = host_port.splitn(2, ':');
    let host = hp.next().unwrap_or("");
    if let Some(port) = hp.next() {
        if port != "443" {
            return false;
        }
    }
    if !host.eq_ignore_ascii_case(HOST) {
        return false;
    }
    let path_only = path.split(['?', '#']).next().unwrap_or("");
    // 归一化防护：不允许上跳、单点段与反斜杠；
    // 同时拒绝这些字符的百分号编码（本应用的 URL 由 buildSearchUrl/buildRecordUrl 拼装，
    // 只会出现 /level/数字 与 .json 等 ASCII 明文，绝不需要 %2e/%2f/%5c）
    let lower = path_only.to_ascii_lowercase();
    if path_only.contains('\\')
        || path_only.split('/').any(|s| s == ".." || s == ".")
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
    {
        return false;
    }
    // 目录型端点（以 / 结尾）按前缀匹配；文件型端点（/search、/sparql）必须**整段相等**，
    // 否则 /searching、/item 这类同前缀的不同端点会被误放行
    ALLOWED_PATHS.iter().any(|p| {
        if p.ends_with('/') {
            path_only.starts_with(p)
        } else {
            path_only == *p
        }
    })
}

/// 按目标端点选择 Accept。
///
/// ⚠️ 实测（2026-10）：该站的 `.json` 数据端点会**按 Accept 内容协商** ——
/// 若把 `text/html` 放在前面，服务端会改回 HTML 页面（甚至只回半页，
/// 表现为 status=200 + truncated=true + body 是 `<!DOCTYPE html>`），
/// 于是 JSON-LD 解析必然失败。故数据端点只接受 JSON/文本序列化。
fn accept_for(url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or("");
    if path.ends_with(".json") {
        "application/ld+json, application/json;q=0.9, */*;q=0.1"
    } else if path.ends_with(".ttl") {
        "text/turtle, */*;q=0.1"
    } else if path.ends_with(".rdf") {
        "application/rdf+xml, */*;q=0.1"
    } else if path.ends_with("/sparql") {
        "application/sparql-results+json, application/json;q=0.9"
    } else {
        "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    }
}

/// 单次请求：返回 (status, bytes, truncated)
async fn fetch_once(
    client: &reqwest::Client,
    url: &str,
) -> Result<(u16, Vec<u8>, bool), String> {
    let resp = client
        .get(url)
        .header("Accept", accept_for(url))
        .header("Accept-Language", "ja,zh-CN,zh;q=0.8,en;q=0.6")
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{}", e))?;

    let status = resp.status().as_u16();
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::with_capacity(128 * 1024);
    let mut truncated = false;

    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() >= MAX_BYTES {
                    buf.truncate(MAX_BYTES);
                    truncated = true;
                    break;
                }
            }
            Ok(None) => break,
            // 服务器掐断（IncompleteRead）或读超时：保留已读到的部分
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }
    Ok((status, buf, truncated))
}

#[tauri::command]
pub async fn naj_fetch(
    url: String,
    timeout_secs: Option<u64>,
) -> Result<NajHttpResponse, String> {
    if !url_allowed(&url) {
        return Err(format!(
            "仅允许访问国立公文書館デジタルアーカイブ（{}）的检索与数据端点",
            HOST
        ));
    }
    let timeout = timeout_secs.unwrap_or(45).clamp(5, 120);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .connect_timeout(std::time::Duration::from_secs(15))
        // 禁止跟随重定向：白名单只在「发出请求前」把关，若跟随 3xx 就可能把请求
        // 带到站外主机（该站当前所有端点都直接 200，用不到跳转）
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(UA)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))?;

    let mut last_err = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        match fetch_once(&client, &url).await {
            Ok((status, buf, truncated)) => {
                if (300..400).contains(&status) {
                    return Err(format!(
                        "原站返回重定向（HTTP {}），为防越出白名单已拒绝跟随",
                        status
                    ));
                }
                // 4xx 是**确定性**回答（如记录不存在 404）：直接交给前端显示状态码，
                // 不要当「连接不稳」重试 3 次后再报「服务器未正常响应」——那会误导用户
                if (400..500).contains(&status) {
                    return Ok(NajHttpResponse {
                        status,
                        body: String::from_utf8_lossy(&buf).into_owned(),
                        bytes: buf.len(),
                        truncated,
                        url,
                        attempts: attempt,
                    });
                }
                // 5xx 或空响应才当作可重试错误（该站偶发连接重置/空响应）
                if buf.is_empty() && !(200..400).contains(&status) {
                    last_err = format!("服务器返回 HTTP {}（空响应）", status);
                } else {
                    return Ok(NajHttpResponse {
                        status,
                        body: String::from_utf8_lossy(&buf).into_owned(),
                        bytes: buf.len(),
                        truncated,
                        url,
                        attempts: attempt,
                    });
                }
            }
            Err(e) => last_err = e,
        }
        if attempt < MAX_ATTEMPTS {
            // 该站实测会连续重置连接，退避后再试。
            // 这里用阻塞 sleep 而不再引入 tokio 依赖：命令本身是「一次网络往返」型，
            // 退避总时长 ≤ 1.2s，对单用户桌面应用可接受。
            std::thread::sleep(std::time::Duration::from_millis(if attempt == 1 { 350 } else { 850 }));
        }
    }
    Err(format!(
        "国立公文書館服务器连续 {} 次未正常响应（该站偶发连接重置，可稍后重试）：{}",
        MAX_ATTEMPTS, last_err
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_naj_host_and_known_paths() {
        assert!(url_allowed("https://www.digital.archives.go.jp/search?kw0=x&ks0=kw_all"));
        assert!(url_allowed("https://www.digital.archives.go.jp/item/1017408.json"));
        assert!(url_allowed("https://www.digital.archives.go.jp/file/3879332.json"));
        assert!(url_allowed("https://www.digital.archives.go.jp/fonds/3415072.ttl"));
        assert!(url_allowed("https://www.digital.archives.go.jp/api/iiif/1017408/manifest.json"));
        assert!(url_allowed("https://www.digital.archives.go.jp/thumb/1017408/C101355535600.jpg"));
        assert!(url_allowed("https://www.digital.archives.go.jp/sparql?query=select%20*"));
        assert!(url_allowed("https://www.digital.archives.go.jp/search"));
    }

    #[test]
    fn accept_header_matches_endpoint() {
        // 数据端点必须只接受 JSON/序列化，否则会被内容协商成 HTML（实测）
        assert!(accept_for("https://www.digital.archives.go.jp/file/3879332.json").starts_with("application/ld+json"));
        assert!(accept_for("https://www.digital.archives.go.jp/item/1.json?v=1").starts_with("application/ld+json"));
        assert!(accept_for("https://www.digital.archives.go.jp/fonds/1.ttl").starts_with("text/turtle"));
        assert!(accept_for("https://www.digital.archives.go.jp/file/1.rdf").starts_with("application/rdf+xml"));
        assert!(accept_for("https://www.digital.archives.go.jp/sparql?query=x").contains("sparql-results+json"));
        // 检索页仍按浏览器取 HTML
        assert!(accept_for("https://www.digital.archives.go.jp/search?kw0=x").starts_with("text/html"));
    }

    #[test]
    fn rejects_other_hosts_schemes_and_paths() {
        assert!(!url_allowed("http://www.digital.archives.go.jp/search")); // 只走 https
        assert!(!url_allowed("https://www.digital.archives.go.jp/"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/contentDownload/a.pdf"));
        assert!(!url_allowed("https://www.digital.archives.go.jp.evil.com/search"));
        assert!(!url_allowed("https://evil.example.com/search"));
        assert!(!url_allowed("https://www.digital.archives.go.jp:8443/search"));
        assert!(!url_allowed("file:///C:/windows/win.ini"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/searching")); // 前缀须整段命中
        assert!(!url_allowed("https://evil.com@www.digital.archives.go.jp/search")); // 用户名混淆
    }

    #[test]
    fn rejects_path_traversal_and_bare_bases() {
        // 上跳 / 反斜杠 / 单点段一律拒绝（否则可绕过前缀判断）
        assert!(!url_allowed("https://www.digital.archives.go.jp/item/../../contentDownload/a.pdf"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/search/../contentDownload/a.pdf"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/./search"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/item\\..\\contentDownload"));
        // 百分号编码的上跳/斜杠同样拒绝（URL 生成器不会产生这些写法）
        assert!(!url_allowed("https://www.digital.archives.go.jp/item/%2e%2e/contentDownload"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/item/%2E%2E/x"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/item%2f1"));
        // 目录型端点的「裸 base」不是真实端点，也不再放行
        assert!(!url_allowed("https://www.digital.archives.go.jp/item"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/file"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/thumb"));
        assert!(!url_allowed("https://www.digital.archives.go.jp/api/iiif"));
        // 目录型端点的正常用法仍放行
        assert!(url_allowed("https://www.digital.archives.go.jp/item/1"));
        assert!(url_allowed("https://www.digital.archives.go.jp/thumb/1/x.jpg"));
        // 查询串里的其它主机不会影响判定（主机取自 URL 本体）
        assert!(url_allowed("https://www.digital.archives.go.jp/search?u=https://evil.com"));
        // 大小写主机名放行（等价写法）
        assert!(url_allowed("https://WWW.DIGITAL.ARCHIVES.GO.JP/search"));
        // 明确 443 端口放行
        assert!(url_allowed("https://www.digital.archives.go.jp:443/search"));
    }
}
