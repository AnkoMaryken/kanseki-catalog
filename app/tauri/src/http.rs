// ================================================
// src/http.rs — Rust HTTP 桥（WebDAV，无 CORS）
// ================================================
// Tauri command: 供前端 transport 调用，规避浏览器 CORS 限制。
//   webdav_request(method, url, headers, body) -> { status, headers, bodyText }
//   webdav_check(url, username, password) -> { ok, message }
// 认证: HTTP Basic（邮箱 + 应用密码），凭据由前端从本机 IndexedDB 读出后传入。
// ================================================
use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Deserialize)]
pub struct WebDavRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
}

#[derive(Serialize)]
pub struct WebDavResponse {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body_text: String,
}

#[derive(Serialize)]
pub struct WebDavCheckResult {
    ok: bool,
    message: String,
}

fn basic_auth(username: &str, password: &str) -> String {
    let cred = format!("{}:{}", username, password);
    let b64 = base64::engine::general_purpose::STANDARD.encode(cred.as_bytes());
    format!("Basic {}", b64)
}

async fn do_request(req: &WebDavRequest) -> Result<WebDavResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = match req.method.to_uppercase().as_str() {
        "GET" => client.get(&req.url),
        "PUT" => client.put(&req.url),
        "POST" => client.post(&req.url),
        "DELETE" => client.delete(&req.url),
        "PROPFIND" => client.request(reqwest::Method::PROPFIND, &req.url),
        other => {
            return Err(format!("unsupported method: {}", other));
        }
    };

    // 合并请求头
    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    // Basic 认证（若传入）
    if let (Some(u), Some(p)) = (&req.username, &req.password) {
        if !u.is_empty() && !p.is_empty() {
            builder = builder.header("Authorization", basic_auth(u, p));
        }
    }
    // body
    if let Some(b) = &req.body {
        builder = builder.body(b.clone());
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("network error: {}", e))?;

    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_string(), s.to_string()))
        })
        .collect::<std::collections::HashMap<String, String>>();
    let body_text = resp.text().await.unwrap_or_default();

    Ok(WebDavResponse {
        status,
        headers,
        body_text,
    })
}

/// 通用 WebDAV 请求桥（对应前端 provider-webdav.js 的 tauri transport）
#[tauri::command]
pub async fn webdav_request(app: tauri::AppHandle, req: WebDavRequest) -> Result<WebDavResponse, String> {
    let _ = &app; // 保留 AppHandle 便于未来扩展
    do_request(&req).await
}

/// 健康检查（PROPFIND 到 baseUrl，Depth: 0）
#[tauri::command]
pub async fn webdav_check(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<WebDavCheckResult, String> {
    let _ = &app;
    let req = WebDavRequest {
        method: "PROPFIND".into(),
        url,
        headers: {
            let mut m = std::collections::HashMap::new();
            m.insert("Depth".into(), "0".into());
            m.insert("Content-Type".into(), "application/xml".into());
            m
        },
        body: Some(r#"<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>"#.into()),
        username: Some(username),
        password: Some(password),
    };
    match do_request(&req).await {
        Ok(resp) => {
            if resp.status == 207 || (200..300).contains(&resp.status) {
                Ok(WebDavCheckResult { ok: true, message: "连接正常".into() })
            } else if resp.status == 401 || resp.status == 403 {
                Ok(WebDavCheckResult { ok: false, message: "认证失败：请检查邮箱与应用密码".into() })
            } else {
                Ok(WebDavCheckResult {
                    ok: false,
                    message: format!("HTTP {}", resp.status),
                })
            }
        }
        Err(e) => Ok(WebDavCheckResult { ok: false, message: e }),
    }
}
