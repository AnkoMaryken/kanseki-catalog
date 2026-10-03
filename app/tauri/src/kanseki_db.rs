// ================================================
// src/kanseki_db.rs — 全国漢籍データベース 检索桥（无 CORS）
// ================================================
// 数据源：http://kanji.zinbun.kyoto-u.ac.jp/kanseki
//         （京都大学人文科学研究所附属東アジア人文情報学研究センター 运营）
//
// 为什么必须走 Rust 而不是浏览器（与 websearch.rs 同一结论）：
//   1) 该站不返回 Access-Control-Allow-Origin —— 浏览器 fetch 被同源策略拒绝；
//   2) 该站只有 http://（无 https）—— 从 https 页面直接请求属「混合内容」，浏览器拦截；
//   3) 该站为老旧 CGI，大结果集会在约 190 秒由服务器侧掐断连接，
//      浏览器对此只能报网络错误，拿不到已传回的部分。
//   桌面版经 reqwest 走本机网络栈，以上三点都不存在。网页版不做此功能（界面会说明）。
//
// 安全约束（重要）：
//   只允许访问 kanji.zinbun.kyoto-u.ac.jp 且路径以 /kanseki 开头，
//   禁止把本命令变成任意 URL 代理（否则等于给应用加了一个 SSRF 出口）。
//
// 部分结果保全：
//   服务器掐断时（连接中断/读超时），把**已经读到的字节**返回，并置 truncated=true；
//   前端据此明确提示「结果不完整，请细化检索条件」，绝不把残页当完整结果展示。
// ================================================
use serde::{Deserialize, Serialize};

const HOST: &str = "kanji.zinbun.kyoto-u.ac.jp";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
/// 单页上限：实测最大结果页约 2.5MB，给足余量，同时防止意外拉爆内存
const MAX_BYTES: usize = 24 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub struct KansekiHttpResponse {
    pub status: u16,
    pub body: String,
    pub bytes: usize,
    /// 服务器中途掐断 / 读超时 / 超出上限：body 为部分内容
    pub truncated: bool,
    pub url: String,
}

/// 白名单校验：只允许本站 /kanseki 路径
fn url_allowed(url: &str) -> bool {
    let rest = match url.strip_prefix("http://") {
        Some(r) => r,
        None => return false,
    };
    let (host_port, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let host = host_port.split(':').next().unwrap_or("");
    host.eq_ignore_ascii_case(HOST) && path.starts_with("/kanseki")
}

#[tauri::command]
pub async fn kanseki_fetch(
    url: String,
    timeout_secs: Option<u64>,
) -> Result<KansekiHttpResponse, String> {
    if !url_allowed(&url) {
        return Err(format!("仅允许访问全国漢籍データベース（{}）的 /kanseki 路径", HOST));
    }
    // 服务器约 190 秒自行掐断，故默认给到 200 秒：让「服务器中断」先发生，
    // 从而能返回部分结果并标记 truncated，而不是被本地超时一枪打死、什么都拿不到。
    let timeout = timeout_secs.unwrap_or(200).clamp(5, 300);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .user_agent(UA)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))?;

    let resp = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（{} 秒）——该站为老旧 CGI，命中的记录过多时会长时间无响应，请细化检索条件", timeout)
            } else {
                format!("网络请求失败：{}", e)
            }
        })?;

    let status = resp.status().as_u16();
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
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

    // 该站声明 charset=UTF-8，实测一致；仍做容错解码
    let body = String::from_utf8_lossy(&buf).into_owned();
    Ok(KansekiHttpResponse {
        status,
        bytes: buf.len(),
        body,
        truncated,
        url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_kanseki_host_and_path() {
        assert!(url_allowed("http://kanji.zinbun.kyoto-u.ac.jp/kanseki?ti=x"));
        assert!(url_allowed("http://kanji.zinbun.kyoto-u.ac.jp/kanseki?record=data/a/b.dat"));
        assert!(!url_allowed("https://kanji.zinbun.kyoto-u.ac.jp/kanseki?ti=x")); // 只走 http
        assert!(!url_allowed("http://kanji.zinbun.kyoto-u.ac.jp/other"));
        assert!(!url_allowed("http://evil.example.com/kanseki"));
        assert!(!url_allowed("http://kanji.zinbun.kyoto-u.ac.jp.evil.com/kanseki"));
        assert!(!url_allowed("file:///C:/windows/win.ini"));
    }
}
