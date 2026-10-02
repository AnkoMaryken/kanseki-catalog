// ================================================
// src/websearch.rs — 联网查证（供 AI 复检查证用）
// ================================================
// 为什么自己实现检索：
//   DeepSeek 的 API **没有**服务端联网搜索 —— Responses API 文档明确写
//   「内置工具类型会被忽略」，tools 只接受 function；Chat Completions 亦然。
//   所以「让 AI 上网查」只能由本程序去查，再把查到的真实网页资料喂给模型核对。
//
// 为什么走 Rust 而不是浏览器：
//   搜索引擎不返回 Access-Control-Allow-Origin，网页版受同源策略限制拿不到结果；
//   桌面版经 reqwest 无此限制。网页版因此不做联网查证（会在界面上说明）。
//
// 数据源选择（实测网络环境）：
//   · zh.wikipedia.org / wikidata / duckduckgo —— **超时不可达**（本机网络）
//   · cn.bing.com —— 200，结果可稳定解析（b_algo 块）
//   · baidu —— 200，但页面重、需 JS/Cookie，解析脆弱
//   故以 cn.bing.com 为准；容器结构若变化，解析失败会返回空列表而不是乱码资料。
//
// ⚠️ 只做「把公开搜索结果的标题/摘要/链接交给模型参考」，不做抓取正文、不落盘。
// ================================================
use serde::{Deserialize, Serialize};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const MAX_BYTES: usize = 3_000_000;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Deserialize)]
pub struct WebSearchRequest {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
pub struct WebSearchResult {
    ok: bool,
    query: String,
    hits: Vec<SearchHit>,
    error: String,
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 去标签 + 常见实体解码 + 空白压缩
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&ensp;", " ")
        .replace("&emsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    // 压掉连续空白
    let mut squeezed = String::with_capacity(decoded.len());
    let mut prev_space = false;
    for ch in decoded.chars() {
        let is_ws = ch.is_whitespace();
        if is_ws {
            if !prev_space {
                squeezed.push(' ');
            }
        } else {
            squeezed.push(ch);
        }
        prev_space = is_ws;
    }
    squeezed.trim().to_string()
}

/// 去掉 &nbsp; 之类的数字实体（&#123;）
fn decode_numeric_entities(s: &str) -> String {
    let bytes: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '&' && i + 2 < bytes.len() && bytes[i + 1] == '#' {
            let mut j = i + 2;
            let mut num = String::new();
            while j < bytes.len() && bytes[j].is_ascii_digit() && num.len() < 7 {
                num.push(bytes[j]);
                j += 1;
            }
            if j < bytes.len() && bytes[j] == ';' && !num.is_empty() {
                if let Ok(n) = num.parse::<u32>() {
                    if let Some(c) = char::from_u32(n) {
                        out.push(c);
                        i = j + 1;
                        continue;
                    }
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// 从一个 b_algo 块里取 {title, url, snippet}
fn parse_block(block: &str) -> Option<SearchHit> {
    // <h2 ...><a ... href="URL" ...>TITLE</a>
    let h2 = block.find("<h2")?;
    let a_rel = block[h2..].find("<a")?;
    let a = h2 + a_rel;
    let href_key = block[a..].find("href=\"")?;
    let href_start = a + href_key + 6;
    let href_end = href_start + block[href_start..].find('"')?;
    let url = block[href_start..href_end].to_string();

    let gt = href_end + block[href_end..].find('>')? + 1;
    let title_end = gt + block[gt..].find("</a>")?;
    let title = decode_numeric_entities(&strip_tags(&block[gt..title_end]));

    let snippet = match block.find("<p") {
        Some(p) => {
            let pgt = match block[p..].find('>') {
                Some(k) => p + k + 1,
                None => p,
            };
            let pend = match block[pgt..].find("</p>") {
                Some(k) => pgt + k,
                None => (pgt + 400).min(block.len()),
            };
            decode_numeric_entities(&strip_tags(&block[pgt..pend]))
        }
        None => String::new(),
    };

    if url.is_empty() || title.is_empty() {
        return None;
    }
    Some(SearchHit { title, url, snippet })
}

fn parse_bing(html: &str, limit: usize) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let marker = "class=\"b_algo\"";
    let mut pos = 0usize;
    while hits.len() < limit {
        let rel = match html[pos..].find(marker) {
            Some(i) => i,
            None => break,
        };
        let start = pos + rel;
        // 块范围：到下一个 b_algo（或一个合理的上限）
        let next = html[start + marker.len()..]
            .find(marker)
            .map(|i| start + marker.len() + i)
            .unwrap_or_else(|| (start + 20_000).min(html.len()));
        let block = &html[start..next];
        if let Some(h) = parse_block(block) {
            // 去重（同一链接只保留一条）
            if !hits.iter().any(|x: &SearchHit| x.url == h.url) {
                hits.push(h);
            }
        }
        pos = next;
        if pos >= html.len() {
            break;
        }
    }
    hits
}

async fn search_bing(query: &str, limit: usize, timeout_secs: u64) -> Result<Vec<SearchHit>, String> {
    let url = format!(
        "https://cn.bing.com/search?q={}&setlang=zh-Hans&ensearch=0",
        urlencode(query)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .user_agent(UA)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))?;

    let resp = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("联网查证超时（{} 秒）", timeout_secs)
            } else {
                format!("联网查证失败：{}", e)
            }
        })?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!("检索服务返回 HTTP {}", status));
    }
    let body = if body.len() > MAX_BYTES {
        &body[..MAX_BYTES]
    } else {
        &body[..]
    };
    Ok(parse_bing(body, limit))
}

/// 联网检索：返回公开搜索结果的标题/摘要/链接，供 AI 交叉核对
#[tauri::command]
pub async fn web_search(req: WebSearchRequest) -> Result<WebSearchResult, String> {
    let q = req.query.trim().to_string();
    if q.is_empty() {
        return Ok(WebSearchResult {
            ok: false,
            query: q,
            hits: vec![],
            error: "检索词为空".into(),
        });
    }
    let limit = req.limit.unwrap_or(5).clamp(1, 10);
    let timeout = req.timeout_secs.unwrap_or(20).clamp(5, 60);
    match search_bing(&q, limit, timeout).await {
        Ok(hits) => Ok(WebSearchResult {
            ok: !hits.is_empty(),
            query: q,
            error: if hits.is_empty() {
                "未检索到结果（可能是网络受限或检索词过窄）".to_string()
            } else {
                String::new()
            },
            hits,
        }),
        Err(e) => Ok(WebSearchResult {
            ok: false,
            query: q,
            hits: vec![],
            error: e,
        }),
    }
}
