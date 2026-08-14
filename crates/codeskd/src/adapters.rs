use std::{env, fs, path::PathBuf};

use serde_json::{Value, json};

use crate::model::{AdapterCapability, StartRunRequest};

pub struct CommandSpec {
    pub command: String,
    pub args: Vec<String>,
    pub session_id: Option<String>,
}

pub fn capabilities() -> Vec<AdapterCapability> {
    vec![
        capability("codex", "Codex", "codex", true, true, true, true, true, vec!["Esc-Esc style rewind creates a source-preserving thread fork; it does not revert files already changed in the workspace".into()]),
        capability("pi", "Pi", "pi", true, true, true, true, false, vec![]),
        capability("claude", "Claude Code", "claude", true, false, true, true, false, vec!["Active print-mode sessions cannot accept live steering; use resume or fork after completion".into()]),
        AdapterCapability {
            id: "shell".into(),
            name: "Custom command".into(),
            available: true,
            executable: None,
            structured_output: false,
            live_input: true,
            resume: false,
            fork: false,
            native_interrupt: false,
            limitations: vec!["Resume and fork require provider-specific configuration".into()],
        },
    ]
}

fn capability(
    id: &str,
    name: &str,
    binary: &str,
    structured: bool,
    live: bool,
    resume: bool,
    fork: bool,
    native_interrupt: bool,
    limitations: Vec<String>,
) -> AdapterCapability {
    let executable = find_executable(binary);
    AdapterCapability {
        id: id.into(),
        name: name.into(),
        available: executable.is_some(),
        executable,
        structured_output: structured,
        live_input: live,
        resume,
        fork,
        native_interrupt,
        limitations,
    }
}

pub fn build(request: &StartRunRequest, session_key: &str) -> anyhow::Result<CommandSpec> {
    let model = request
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    Ok(match request.provider.as_str() {
        "codex" => {
            if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
                anyhow::ensure!(
                    request.resume_session_id.as_deref().is_some(),
                    "resume_session_id is required"
                );
            }
            CommandSpec {
                command: provider_command("codex")?,
                args: vec!["app-server".into()],
                session_id: request.resume_session_id.clone(),
            }
        }
        "pi" => {
            let mut args = vec!["--mode".into(), "rpc".into()];
            let selected_session = request.resume_session_id.as_deref().unwrap_or(session_key);
            match request.operation.as_deref() {
                Some("resume") => args.extend(["--session".into(), selected_session.into()]),
                Some("fork") => args.extend([
                    "--fork".into(),
                    selected_session.into(),
                    "--session-id".into(),
                    session_key.into(),
                ]),
                _ => args.extend(["--session-id".into(), session_key.into()]),
            }
            if let Some(value) = model {
                args.extend(["--model".into(), value.into()]);
            }
            CommandSpec {
                command: provider_command("pi")?,
                args,
                session_id: Some(if request.operation.as_deref() == Some("resume") {
                    selected_session.into()
                } else {
                    session_key.into()
                }),
            }
        }
        "claude" => {
            let mut args = vec![
                "--print".into(),
                "--verbose".into(),
                "--output-format".into(),
                "stream-json".into(),
            ];
            if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
                let session = request
                    .resume_session_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("resume_session_id is required"))?;
                args.extend(["--resume".into(), session.into()]);
                if request.operation.as_deref() == Some("fork") {
                    args.push("--fork-session".into());
                }
            }
            if let Some(value) = model {
                args.extend(["--model".into(), value.into()]);
            }
            args.push(request.prompt.clone());
            CommandSpec {
                command: provider_command("claude")?,
                args,
                session_id: request.resume_session_id.clone(),
            }
        }
        "shell" => CommandSpec {
            command: request
                .command
                .clone()
                .ok_or_else(|| anyhow::anyhow!("command is required for shell provider"))?,
            args: request.args.clone(),
            session_id: None,
        },
        value => anyhow::bail!("unsupported provider: {value}"),
    })
}

pub fn encode_initial_prompt(provider: &str, prompt: &str) -> Option<String> {
    match provider {
        "pi" => Some(
            json!({"id":uuid::Uuid::new_v4().to_string(),"type":"prompt","message":prompt})
                .to_string(),
        ),
        _ => None,
    }
}

pub fn encode_input(
    provider: &str,
    message: &str,
    request_id: &str,
    delivery: &str,
    last_turn_id: Option<&str>,
) -> Result<String, anyhow::Error> {
    match provider {
        "codex" => match delivery {
            "auto" | "steer" | "queue" => Ok(json!({
                "type":"submit",
                "message":message,
                "requestId":request_id,
                "delivery":delivery,
            })
            .to_string()),
            "fork" => Ok(json!({
                "type":"rewind",
                "message":message,
                "requestId":request_id,
                "lastTurnId":last_turn_id,
            })
            .to_string()),
            value => anyhow::bail!("unsupported Codex input delivery: {value}"),
        },
        "pi" => Ok(
            json!({"id":uuid::Uuid::new_v4().to_string(),"type":"steer","message":message})
                .to_string(),
        ),
        "shell" => Ok(message.to_string()),
        _ => anyhow::bail!("{provider} adapter does not support live steering yet"),
    }
}

pub fn normalize_line(
    provider: &str,
    channel: &str,
    line: &str,
) -> (String, Option<String>, Value, Option<Value>, Option<String>) {
    let Ok(raw) = serde_json::from_str::<Value>(line) else {
        return (
            if channel == "stderr" {
                "stderr"
            } else {
                "output"
            }
            .into(),
            None,
            json!({"text":line}),
            None,
            None,
        );
    };
    let event_type = raw
        .get("method")
        .or_else(|| raw.get("type"))
        .and_then(Value::as_str)
        .unwrap_or(if raw.get("id").is_some() {
            "rpc.response"
        } else {
            "event"
        })
        .to_string();
    let session_id = raw
        .pointer("/sessionId")
        .or_else(|| raw.pointer("/result/thread/id"))
        .or_else(|| raw.pointer("/params/thread/id"))
        .or_else(|| raw.pointer("/params/threadId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let text = extract_text(&raw).unwrap_or_else(|| {
        if provider == "codex" || event_type == "rpc.response" {
            String::new()
        } else {
            raw.to_string()
        }
    });
    let kind = if event_type == "codesk.input.ack" {
        if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
            "input.accepted"
        } else {
            "input.rejected"
        }
    } else if event_type == "codesk.control.ack" {
        if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
            "control.acknowledged"
        } else {
            "control.rejected"
        }
    } else if event_type == "codesk.session" {
        "thread.session"
    } else if event_type == "codesk.queue" {
        match raw.get("action").and_then(Value::as_str) {
            Some("added") => "queue.added",
            Some("started") => "queue.started",
            Some("paused") => "queue.paused",
            Some("removed") => "queue.removed",
            Some("failed") => "queue.failed",
            _ => "queue.updated",
        }
    } else if event_type == "rpc.response" {
        if raw.get("error").is_some() {
            "run.error"
        } else {
            "provider.response"
        }
    } else if event_type.contains("requestApproval") {
        "approval.required"
    } else if event_type.contains("requestUserInput") {
        "input.required"
    } else if event_type == "turn/started" {
        "turn.started"
    } else if event_type == "turn/completed" {
        "turn.completed"
    } else if event_type == "item/agentMessage/delta" {
        "assistant.message"
    } else if matches!(
        event_type.as_str(),
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta"
    ) {
        "reasoning.message"
    } else if matches!(
        event_type.as_str(),
        "item/commandExecution/outputDelta"
            | "item/commandExecution/terminalInteraction"
            | "item/fileChange/outputDelta"
    ) {
        "tool.output"
    } else if event_type == "item/completed"
        && raw.pointer("/params/item/type").and_then(Value::as_str) == Some("userMessage")
    {
        "user.message"
    } else if event_type == "item/completed"
        && raw.pointer("/params/item/type").and_then(Value::as_str) == Some("agentMessage")
    {
        "assistant.message"
    } else if event_type.contains("fileChange") {
        "file.change"
    } else if event_type.contains("commandExecution") || event_type.contains("tool") {
        "tool.output"
    } else if event_type.contains("error") {
        "run.error"
    } else if event_type.contains("assistant") || event_type.contains("message") {
        "assistant.message"
    } else {
        "agent.event"
    };
    (
        kind.into(),
        Some(format!("{provider}.{event_type}")),
        json!({
            "text":text,
            "rpc_id":raw.get("id"),
            "method":raw.get("method"),
            "turn_id":raw.pointer("/params/turnId")
                .or_else(|| raw.pointer("/params/turn/id"))
                .or_else(|| raw.pointer("/result/turn/id")),
            "item_id":raw.pointer("/params/itemId")
                .or_else(|| raw.pointer("/params/item/id")),
            "request_id":raw.get("requestId").or_else(|| raw.pointer("/params/requestId")),
            "action":raw.get("action"),
            "queue_id":raw.get("queueId"),
            "pending":raw.get("pending"),
            "last_turn_id":raw.get("lastTurnId"),
        }),
        Some(raw),
        session_id,
    )
}

pub fn status_from_event(provider: &str, raw: Option<&Value>) -> Option<&'static str> {
    if provider != "codex" {
        return None;
    }
    let raw = raw?;
    match raw.get("method").and_then(Value::as_str) {
        Some("turn/started") => Some("running"),
        Some("turn/completed") => Some("waiting_for_input"),
        _ if raw.get("type").and_then(Value::as_str) == Some("codesk.control.ack")
            && raw.get("accepted").and_then(Value::as_bool) == Some(false) =>
        {
            Some("waiting_for_input")
        }
        _ => None,
    }
}

fn extract_text(value: &Value) -> Option<String> {
    for pointer in [
        "/text",
        "/message",
        "/error/message",
        "/result",
        "/params/delta",
        "/params/reason",
        "/params/questions",
        "/params/command",
        "/params/item/text",
        "/params/item/content",
        "/delta/text",
        "/message/text",
        "/item/text",
        "/content",
    ] {
        match value.pointer(pointer) {
            Some(Value::String(text)) => return Some(text.clone()),
            Some(Value::Array(items)) => {
                let text = items
                    .iter()
                    .filter_map(|item| {
                        item.get("text")
                            .or_else(|| item.get("question"))
                            .or_else(|| item.get("label"))
                            .and_then(Value::as_str)
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    return Some(text);
                }
            }
            _ => {}
        }
    }
    None
}

fn find_executable(binary: &str) -> Option<String> {
    let mut directories = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        directories.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
            home.join(".local/share/pnpm"),
        ]);
        let node_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(node_versions) {
            let mut bins = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect::<Vec<_>>();
            bins.sort_by(|left, right| right.cmp(left));
            directories.extend(bins);
        }
    }
    directories
        .into_iter()
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

fn provider_command(binary: &str) -> anyhow::Result<String> {
    find_executable(binary).ok_or_else(|| anyhow::anyhow!("{binary} executable was not found"))
}

#[cfg(test)]
mod tests {
    use super::normalize_line;

    #[test]
    fn normalizes_current_codex_request_and_message_shapes() {
        let (kind, _, payload, _, _) = normalize_line(
            "codex",
            "stdout",
            r#"{"id":"ask-1","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","isBlocking":true,"questions":[{"id":"scope","header":"Scope","question":"Which scope?"}]}}"#,
        );
        assert_eq!(kind, "input.required");
        assert_eq!(payload["text"], "Which scope?");
        assert_eq!(payload["rpc_id"], "ask-1");

        let (kind, _, payload, _, _) = normalize_line(
            "codex",
            "stdout",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"agent-1","type":"agentMessage","text":"Done"}}}"#,
        );
        assert_eq!(kind, "assistant.message");
        assert_eq!(payload["text"], "Done");
        assert_eq!(payload["item_id"], "agent-1");
    }

    #[test]
    fn suppresses_raw_json_for_unrendered_codex_notifications() {
        let (kind, _, payload, _, _) = normalize_line(
            "codex",
            "stdout",
            r#"{"method":"thread/status/changed","params":{"threadId":"thread-1","status":{"type":"idle"}}}"#,
        );
        assert_eq!(kind, "agent.event");
        assert_eq!(payload["text"], "");
    }
}
