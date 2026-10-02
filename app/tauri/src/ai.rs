// ================================================
// src/ai.rs — AI 复检桥（DeepSeek）
// ================================================
// 背景：在「古籍类目查询」页增加 AI 复检，需要调用 DeepSeek。
//   桌面版经这里转发（reqwest）；网页版由浏览器直连（实测 DeepSeek 会返回
//   CORS 头，可直连，见 V9.2 更新日志的更正）。
//
//   ai_chat(req)   -> { ok, content, error, model, finish_reason, ... , total_tokens }
//   ai_check(req)  -> { ok, message, model }       仅用于「测试连接」
//   ai_models(req) -> { ok, models: [..], error }  拉取账号可用的模型列表
//
// ---- V9.3 修复「deepseek 返回了空内容」----
// 官方文档（api-docs.deepseek.com/zh-cn/guides/thinking_mode）明确：
//   · 思考模式下**思维链与正文共享同一份 max_tokens 预算**
//     （Responses API 里叫 max_output_tokens，注明「包含可见的输出 token 与思维链 token」）。
//     此前单条复检只给 400 tokens，推理模型把预算全烧在思维链上 → content 为空，
//     前端就报「DeepSeek 返回了空内容」。
//   · 旧模型名 deepseek-chat / deepseek-reasoner 已不在现行价格表内；
//     现行是 deepseek-flash / deepseek-v4-pro。写死的旧名字是空内容的另一诱因。
// 对策：
//   ① 默认模型改为 deepseek-flash（现行）；
//   ② max_tokens 不再由前端压到极小值；
//   ③ content 为空时回落到 reasoning_content 并明确标注，而不是直接报错；
//   ④ finish_reason == "length" 时给出「预算被思维链吃光」的可执行提示；
//   ⑤ 新增 ai_models，让设置页列出账号**真实可用**的模型，避免再写死。
//
// 安全：API Key 只作为单次请求的 Authorization 头，不落盘、不打印、不缓存。
// ================================================
use serde::{Deserialize, Serialize};

const DEFAULT_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
/// 现行模型（旧名 deepseek-chat / deepseek-reasoner 已不在官方价格表内）
const DEFAULT_MODEL: &str = "deepseek-flash";
const DEFAULT_TIMEOUT_SECS: u64 = 180;
/// 思考模式下思维链与正文共享预算，默认给足（官方输出上限 384K，这里取保守值）
const DEFAULT_MAX_TOKENS: u32 = 8000;

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
    finish_reason: String,
    prompt_tokens: u32,
    completion_tokens: u32,
    reasoning_tokens: u32,
    total_tokens: u32,
    /// 仅在「正文为空、已回落为思维链」时为 true，前端据此提示
    from_reasoning: bool,
}

#[derive(Serialize)]
pub struct AiCheckResult {
    ok: bool,
    message: String,
    model: String,
}

#[derive(Serialize)]
pub struct AiModelsResult {
    ok: bool,
    models: Vec<String>,
    error: String,
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

fn resolve_endpoint(e: &Option<String>) -> String {
    e.clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
}

/// 由 chat 端点推出 /models 端点：
/// https://api.deepseek.com/chat/completions -> https://api.deepseek.com/models
fn models_endpoint(chat: &str) -> String {
    let t = chat.trim_end_matches('/');
    if let Some(i) = t.rfind("/chat/completions") {
        format!("{}/models", &t[..i])
    } else if let Some(i) = t.rfind('/') {
        // 自定义端点：退到上一级再拼 /models
        format!("{}/models", &t[..i])
    } else {
        format!("{}/models", t)
    }
}

async fn call_deepseek(req: &AiChatRequest) -> Result<AiChatResult, String> {
    if req.api_key.trim().is_empty() {
        return Err("尚未填写 DeepSeek API Key".into());
    }
    if req.messages.is_empty() {
        return Err("没有要发送的内容".into());
    }

    let endpoint = resolve_endpoint(&req.endpoint);
    let model = req
        .model
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let timeout = req
        .timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(10, 900);
    let max_tokens = req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS).clamp(64, 65536);

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
        "max_tokens": max_tokens,
    });
    // 思考模式不支持 temperature（传了也不报错、只是不生效），仍保留以便非思考模型使用
    if let Some(t) = req.temperature {
        payload["temperature"] = serde_json::json!(t);
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

    let choice = v.get("choices").and_then(|c| c.get(0));
    let msg = choice.and_then(|c| c.get("message"));
    let s = |k: &str| -> String {
        msg.and_then(|m| m.get(k))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let content_raw = s("content");
    let reasoning = s("reasoning_content");
    let finish_reason = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let usage = v.get("usage");
    let num = |k: &str| -> u32 {
        usage
            .and_then(|u| u.get(k))
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32
    };
    let reasoning_tokens = usage
        .and_then(|u| u.get("completion_tokens_details"))
        .and_then(|d| d.get("reasoning_tokens"))
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;

    let model_returned = v
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(&model)
        .to_string();

    // ---- 空内容的三条出路 ----
    let (content, error, from_reasoning) = if !content_raw.is_empty() {
        (content_raw, String::new(), false)
    } else if !reasoning.is_empty() {
        (
            format!(
                "（模型本次只输出了思维链、未给出最终回答，以下为思维链内容；如需完整回答请重试或调高「最大输出 tokens」）\n\n{}",
                reasoning
            ),
            String::new(),
            true,
        )
    } else if finish_reason == "length" {
        (
            String::new(),
            format!(
                "输出被截断：{} tokens 预算被思维链耗尽，最终回答为空。请在设置中调高「最大输出 tokens」（当前 {}），或改用非思考模型。",
                max_tokens, max_tokens
            ),
            false,
        )
    } else {
        (String::new(), "DeepSeek 返回了空内容".to_string(), false)
    };

    Ok(AiChatResult {
        ok: !content.is_empty(),
        content,
        error,
        model: model_returned,
        finish_reason,
        prompt_tokens: num("prompt_tokens"),
        completion_tokens: num("completion_tokens"),
        reasoning_tokens,
        total_tokens: num("total_tokens"),
        from_reasoning,
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
        // 思考模式下 8 tokens 会被思维链吃光 → 给足，避免「测试连接」假失败
        max_tokens: Some(512),
        timeout_secs: Some(60),
    };
    match call_deepseek(&chat).await {
        Ok(r) => Ok(AiCheckResult {
            ok: true,
            message: format!(
                "连接正常（模型 {}{}）",
                r.model,
                if r.finish_reason.is_empty() { String::new() } else { format!("，finish={}", r.finish_reason) }
            ),
            model: r.model,
        }),
        Err(e) => Ok(AiCheckResult {
            ok: false,
            message: e,
            model: model.unwrap_or_default(),
        }),
    }
}

/// 拉取账号可用模型列表（GET /models），供设置页动态展示，避免写死过时模型名
#[tauri::command]
pub async fn ai_models(req: AiCheckRequest) -> Result<AiModelsResult, String> {
    if req.api_key.trim().is_empty() {
        return Ok(AiModelsResult {
            ok: false,
            models: vec![],
            error: "尚未填写 DeepSeek API Key".into(),
        });
    }
    let url = models_endpoint(&resolve_endpoint(&req.endpoint));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{}", e))?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", req.api_key.trim()))
        .send()
        .await
        .map_err(|e| format!("无法连接 DeepSeek：{}", e))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Ok(AiModelsResult {
            ok: false,
            models: vec![],
            error: friendly_error(status, &body),
        });
    }
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let mut models: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    Ok(AiModelsResult {
        ok: !models.is_empty(),
        models,
        error: String::new(),
    })
}
