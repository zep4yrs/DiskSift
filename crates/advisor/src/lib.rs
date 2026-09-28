//! AI advisor: provider-agnostic, JSON-mode structured output.
//!
//! Sends only directory metadata and sample paths — never file contents.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtShare {
    pub ext: String,
    pub share: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvisorRequest {
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub top_extensions: Vec<ExtShare>,
    pub sample_paths: Vec<String>,
    pub neighbors: Vec<String>,
    pub scaffold_hint: Option<String>,
    /// 分诊图层 O2 反馈通道（triage-overlay-spec §5.3）：如「用户曾忽略此目录的
    /// 判定」。user_prompt 就是整个请求的 JSON，此字段有值即随 prompt 到达模型；
    /// default 保证旧调用方照常反序列化，skip_serializing_if 保证缺省时
    /// 序列化结果与旧格式逐字节一致。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_note: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AdvisorResponse {
    pub what: String,
    pub category: String,
    pub safe_to_delete: bool,
    pub risk: String,
    pub action: String,
    pub reasoning: String,
    #[serde(default)]
    pub needs_inspection: bool,
    #[serde(default)]
    pub suggested_scaffold: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Provider {
    OpenAI {
        api_key: String,
        model: String,
        base_url: String,
    },
    Anthropic {
        api_key: String,
        model: String,
        base_url: String,
    },
    Ollama {
        base_url: String,
        model: String,
    },
    Gemini {
        api_key: String,
        model: String,
        base_url: String,
    },
}

const SYSTEM: &str = r#"You are Pinkbin's local file advisor. Given a folder's metadata, decide what it is and whether it can be cleaned. Reply in strict JSON ONLY, matching this schema exactly:

{
  "what": "string",
  "category": "browser_cache|app_cache|package_cache|build_artifact|game_data|user_content|system|model_weights|unknown",
  "safe_to_delete": true|false,
  "risk": "low|medium|high",
  "action": "keep|recycle|delete|custom",
  "reasoning": "short string, one sentence",
  "needs_inspection": true|false,
  "suggested_scaffold": "string or null"
}

Rules:
- Be conservative. If uncertain, set needs_inspection=true and action="keep".
- "user_content" (Documents/Pictures/Music/Source code) is never safe_to_delete.
- "model_weights" (HuggingFace, Ollama models) is medium risk: deletable but expensive to redownload.
- Do not include any prose outside the JSON object."#;

/// response_format 兼容判定（与前端 advisorClient.ts 的 isResponseFormatRejection
/// 同规则）：免费接入三路径（GLM-4-Flash 官方免费档、硅基流动部分免费模型、
/// Ollama 本地/其 OpenAI 兼容层）都不支持 json_object，首发带该参数会直接 4xx。
/// 任何 4xx 一律视为「参数被拒」（鉴权/限流类误伤只是多一次注定失败的重试，
/// 第二次的错误原样抛出，语义不变）；5xx 等其余状态码兜底看错误文本是否点名
/// 该参数（response_format / json_object / json mode / json_mode 都算命中）。
fn is_response_format_rejection(status: u16, err_text: &str) -> bool {
    if (400..500).contains(&status) {
        return true;
    }
    let t = err_text.to_lowercase();
    ["response_format", "json_object", "json mode", "json_mode"]
        .iter()
        .any(|k| t.contains(k))
}

/// baseUrl 指向 Ollama（默认端口 11434 或原生 /api/chat 路径）时，其 OpenAI
/// 兼容层不吃 response_format，首发就不带——与前端 detectProvider 同判据；
/// 本机 OpenAI 兼容中转（one-api/new-api/vLLM 等）同样常绑 localhost，不能靠
/// “本地地址”判 ollama。
fn looks_like_ollama(base_url: &str) -> bool {
    let u = base_url.to_lowercase();
    u.contains("11434") || u.contains("/api/chat")
}

pub async fn advise(provider: &Provider, req: &AdvisorRequest) -> anyhow::Result<AdvisorResponse> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let user_prompt = serde_json::to_string_pretty(req)?;

    let raw = match provider {
        Provider::OpenAI {
            api_key,
            model,
            base_url,
        } => {
            let make_body = |with_format: bool| {
                let mut body = serde_json::Map::new();
                body.insert("model".into(), serde_json::json!(model));
                // response_format 兼容：① 首选仍带（主流网关靠它保证纯 JSON）；
                // ② 上游拒绝（4xx / 错误文本点名 json mode，见
                // is_response_format_rejection）→ 去掉该字段原样重试一次；
                // ③ baseUrl 判定为 ollama（11434 或 /api/chat 本地模型）→ 首发
                // 就不带，免一次注定失败的请求。重试至多一次，无循环。
                if with_format {
                    body.insert(
                        "response_format".into(),
                        serde_json::json!({ "type": "json_object" }),
                    );
                }
                body.insert(
                    "messages".into(),
                    serde_json::json!([
                        { "role": "system", "content": SYSTEM },
                        { "role": "user",   "content": user_prompt }
                    ]),
                );
                serde_json::Value::Object(body)
            };
            let mut with_format = !looks_like_ollama(base_url);
            let mut retried = false;
            let raw_text = loop {
                let r = client
                    .post(format!(
                        "{}/chat/completions",
                        base_url.trim_end_matches('/')
                    ))
                    .bearer_auth(api_key)
                    .json(&make_body(with_format))
                    .send()
                    .await?;
                let status = r.status().as_u16();
                if r.status().is_success() {
                    break r.text().await?;
                }
                // body 只能读一次：读完再决定重试还是带上下文报错。
                let err_text = r.text().await.unwrap_or_default();
                if with_format && !retried && is_response_format_rejection(status, &err_text) {
                    with_format = false;
                    retried = true;
                    continue;
                }
                anyhow::bail!("openai {status}: {err_text}");
            };
            let v: serde_json::Value = serde_json::from_str(&raw_text)?;
            v["choices"][0]["message"]["content"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("openai: missing message.content"))?
                .to_string()
        }
        Provider::Anthropic {
            api_key,
            model,
            base_url,
        } => {
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 2048,
                "system": SYSTEM,
                "messages": [{ "role": "user", "content": user_prompt }]
            });
            let r = client
                .post(format!("{}/v1/messages", base_url.trim_end_matches('/')))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let v: serde_json::Value = r.json().await?;
            // extended-thinking 模型先返 {type:"thinking",...} 再返 {type:"text",...},
            // 不能假设 content[0] 是 text；遍历 content 数组拼所有 text block。
            let text = v["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b["type"] == "text")
                        .filter_map(|b| b["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if text.trim().is_empty() {
                let stop = v["stop_reason"].as_str().unwrap_or("unknown");
                if stop == "max_tokens" {
                    anyhow::bail!(
                        "anthropic: 没拿到 text block (stop_reason=max_tokens) — 模型在 thinking 阶段被截断, 把 max_tokens 调大重试"
                    );
                }
                anyhow::bail!("anthropic: 没拿到 text block (stop_reason={stop})");
            }
            text
        }
        Provider::Gemini {
            api_key,
            model,
            base_url,
        } => {
            let body = serde_json::json!({
                "systemInstruction": { "parts": [{ "text": SYSTEM }] },
                "contents": [{ "role": "user", "parts": [{ "text": user_prompt }] }],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 0.2
                }
            });
            let url = format!(
                "{}/v1beta/models/{}:generateContent?key={}",
                base_url.trim_end_matches('/'),
                model,
                api_key
            );
            let r = client
                .post(url)
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let v: serde_json::Value = r.json().await?;
            v["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .ok_or_else(|| {
                    anyhow::anyhow!("gemini: missing candidates[0].content.parts[0].text")
                })?
                .to_string()
        }
        Provider::Ollama { base_url, model } => {
            let body = serde_json::json!({
                "model": model,
                "format": "json",
                "stream": false,
                "messages": [
                    { "role": "system", "content": SYSTEM },
                    { "role": "user",   "content": user_prompt }
                ]
            });
            let r = client
                .post(format!("{}/api/chat", base_url.trim_end_matches('/')))
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
            let v: serde_json::Value = r.json().await?;
            v["message"]["content"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("ollama: missing message.content"))?
                .to_string()
        }
    };

    let parsed: AdvisorResponse =
        serde_json::from_str(&raw).or_else(|_| serde_json::from_str(strip_codefence(&raw)))?;
    Ok(parsed)
}

fn strip_codefence(s: &str) -> &str {
    let s = s.trim();
    let s = s.strip_prefix("```json").unwrap_or(s);
    let s = s.strip_prefix("```").unwrap_or(s);
    s.strip_suffix("```").unwrap_or(s).trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_4xx_counts_as_rejection() {
        for status in [400u16, 401, 403, 404, 422, 429] {
            assert!(
                is_response_format_rejection(status, ""),
                "{status} 应判为参数被拒"
            );
        }
    }

    #[test]
    fn non_4xx_needs_error_text_mentioning_json_mode() {
        assert!(is_response_format_rejection(
            500,
            r#"{"error":{"message":"response_format is not supported by this model"}}"#
        ));
        assert!(is_response_format_rejection(502, "upstream: json_object unsupported"));
        assert!(is_response_format_rejection(500, "Json Mode is not enabled"));
        assert!(is_response_format_rejection(500, "JSON_MODE disabled"));
        assert!(!is_response_format_rejection(500, "internal server error"));
        assert!(!is_response_format_rejection(200, ""));
    }

    #[test]
    fn ollama_detection_by_url() {
        assert!(looks_like_ollama("http://localhost:11434"));
        assert!(looks_like_ollama("http://127.0.0.1:11434/v1"));
        assert!(looks_like_ollama("HTTP://LocalHost:11434"));
        assert!(looks_like_ollama("http://localhost:20128/api/chat"));
        // 本机 OpenAI 兼容中转 / 官方免费档不能误判：
        assert!(!looks_like_ollama("https://open.bigmodel.cn/api/paas/v4"));
        assert!(!looks_like_ollama("https://api.siliconflow.cn/v1"));
        assert!(!looks_like_ollama("http://localhost:20128/v1"));
    }
}
