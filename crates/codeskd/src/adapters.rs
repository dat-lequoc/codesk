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
        capability("codex", "Codex", "codex", true, false, true, false, vec!["Live steering is unavailable in codex exec mode".into(), "Fork is unavailable from the non-interactive CLI".into()]),
        capability("pi", "Pi", "pi", true, true, true, true, vec![]),
        capability("claude", "Claude Code", "claude", true, false, true, true, vec!["Active print-mode sessions cannot accept live steering; use resume or fork after completion".into()]),
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
        native_interrupt: false,
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
            let mut args = vec!["exec".into()];
            if request.operation.as_deref() == Some("resume") {
                let session = request
                    .resume_session_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("resume_session_id is required"))?;
                args.extend([
                    "resume".into(),
                    "--json".into(),
                    "--skip-git-repo-check".into(),
                ]);
                if let Some(value) = model {
                    args.extend(["--model".into(), value.into()]);
                }
                args.extend([session.into(), request.prompt.clone()]);
                return Ok(CommandSpec {
                    command: provider_command("codex")?,
                    args,
                    session_id: Some(session.into()),
                });
            }
            if request.operation.as_deref() == Some("fork") {
                anyhow::bail!("Codex CLI does not expose a reliable non-interactive fork operation")
            }
            args.extend(["--json".into(), "--skip-git-repo-check".into()]);
            if let Some(value) = model {
                args.extend(["--model".into(), value.into()]);
            }
            args.push(request.prompt.clone());
            CommandSpec {
                command: provider_command("codex")?,
                args,
                session_id: None,
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

pub fn encode_input(provider: &str, message: &str) -> Result<String, anyhow::Error> {
    match provider {
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
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("event")
        .to_string();
    let session_id = ["session_id", "sessionId", "thread_id", "threadId"]
        .iter()
        .find_map(|key| raw.get(key).and_then(Value::as_str))
        .map(str::to_string);
    let text = extract_text(&raw).unwrap_or_else(|| raw.to_string());
    let kind = if event_type.contains("tool") {
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
        json!({"text":text}),
        Some(raw),
        session_id,
    )
}

fn extract_text(value: &Value) -> Option<String> {
    for pointer in [
        "/text",
        "/result",
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
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
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
