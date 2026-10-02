// ================================================
// src/ai.rs — AI 复检桥（DeepSeek，无 CORS）
// ================================================
// 背景（V9.1）：在「古籍类目查询」页增加 AI 复检，需要调用 DeepSeek 的
//   /chat/completions 接口。浏览器/WebView 直连会被 CORS 拦住（该接口不返回
//   Access-Control-Allow-Origin），故与 WebDAV 一样走 Rust 侧转发。
//
//   ai_chat(req)  -> { ok, content, error, model, prompt_tokens, completion_tokens, total_tokens }
//   ai_check(api_key, endpoint, model) -> { ok, message, model }   仅用于「测试连接」
//
// 安全：API Key 只作为一次请求的 Authorization 头使用，**不落盘、不打印、不缓存**；
//       持久化由前端负责（用户明确同意「存在本机、明文保存」）。
// ================================================
use serde::{Deserialize, Serialize};

const DEFAULT_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL: &str = "deepseek-chat";
const DEFAULT_TIMEOUT_SECS: u64 = 120;

#[derive(Deserialize)]
pub struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
pub struct AiChatRequest {
    api_key: String,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    model: Option<String>,
    messages: Vec<ChatMessage>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
pub struct AiChatResult {
    ok: bool,
    content: String,
    error: String,
    model: String,
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
}

#[derive(Serialize)]
pub struct AiCheckResult {
    ok: bool,
    message: String,
    model: String,
}

// ⚠️ 用结构体而不是多个平铺参数：Tauri v2 对**顶层命令参数名**会做 snake_case → camelCase
//    映射（Rust 的 api_key 在 JS 侧要写 apiKey），极易踩坑；而**嵌套字段名原样传递**
//    （参见 http.rs 的 WebDavRequest，其 body_text 在 JS 侧就是 body_text）。
//    这里统一走 `{ req: {...} }`，与既有 webdav_request 用法完全一致。
#[derive(Deserialize)]
pub struct AiCheckRequest {
    api_key: String,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

/// 把失败响应翻成用户能看懂的中文提示（优先采用接口返回的 error.message）
fn friendly_error(status: u16, body: &str) -> String {
    let api_msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        });
    let base = match status {
        400 => "请求格式有误",
        401 => "API Key 无效或已过期，请在设置中重新填写",
        402 => "DeepSeek 账户余额不足",
        403 => "该 Key 无权访问此模型",
        404 => "接口地址不存在（请检查 API 地址设置）",
        422 => "请求参数不被接受",
        429 => "请求过于频繁或已达配额上限，请稍后再试",
        500..=599 => "DeepSeek 服务暂时不可用",
        _ => "请求失败",
    };
    match api_msg {
        Some(m) => format!("{}（HTTP {}）：{}", base, status, m),
        None => format!("{}（HTTP {}）", base, status),
    }
}

async fn call_deepseek(req: &AiChatRequest) -> Result<AiChatResult, String> {
    if req.api_key.trim().is_empty() {
        return Err("尚未填写 DeepSeek API Key".into());
    }
    if req.messages.is_empty() {
        return Err("没有要发送的内容".into());
    }

    let endpoint = req
        .endpoint
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string());
    let model = req
        .model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let timeout = req
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(10, 600);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))?;

    let msgs: Vec<serde_json::Value> = req
        .messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut payload = serde_json::json!({
        "model": model.clone(),
        "messages": msgs,
        "stream": false,
    });
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
    }
    if let Some(mt) = req.max_tokens {
        payload["max_tokens"] = serde_json::json!(mt);
    }

    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", req.api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（{} 秒）：DeepSeek 未在预期时间内返回，可稍后重试", timeout)
            } else if e.is_connect() {
                "无法连接 DeepSeek：请检查本机网络或代理设置".to_string()
            } else {
                format!("网络错误：{}", e)
            }
        })?;

    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        return Err(friendly_error(status, &body));
    }

    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析响应失败：{}", e))?;

    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let usage = v.get("usage");
    let num = |k: &str| -> u32 {
        usage
            .and_then(|u| u.get(k))
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32
    };
    let model_returned = v
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(&model)
        .to_string();

    Ok(AiChatResult {
        ok: !content.is_empty(),
        error: if content.is_empty() {
            "DeepSeek 返回了空内容".to_string()
        } else {
            String::new()
        },
        content,
        model: model_returned,
        prompt_tokens: num("prompt_tokens"),
        completion_tokens: num("completion_tokens"),
        total_tokens: num("total_tokens"),
    })
}

/// AI 复检 / 对话：前端把完整 messages 传进来，本命令只负责转发与错误翻译
#[tauri::command]
pub async fn ai_chat(req: AiChatRequest) -> Result<AiChatResult, String> {
    call_deepseek(&req).await
}

/// 测试连接：发一条极小请求，验证 Key 与网络是否可用
#[tauri::command]
pub async fn ai_check(req: AiCheckRequest) -> Result<AiCheckResult, String> {
    let model = req.model.clone();
    let chat = AiChatRequest {
        api_key: req.api_key,
        endpoint: req.endpoint,
        model: req.model,
        messages: vec![ChatMessage {
            role: "user".into(),
            content: "ping".into(),
        }],
        temperature: Some(0.0),
        max_tokens: Some(8),
        timeout_secs: Some(30),
    };
    match call_deepseek(&chat).await {
        Ok(r) => Ok(AiCheckResult {
            ok: true,
            message: format!("连接正常（模型 {}）", r.model),
            model: r.model,
        }),
        Err(e) => Ok(AiCheckResult {
            ok: false,
            message: e,
            model: model.unwrap_or_default(),
        }),
    }
}
