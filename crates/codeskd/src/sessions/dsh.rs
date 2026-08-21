use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use super::{
    MAX_MESSAGES, MAX_TRANSCRIPT_BYTES, cwd_matches, home_dir, latest_rfc3339,
    meaningful_user_text, modified_rfc3339, sort_recent, string, truncate_title,
    unix_millis_rfc3339,
};
use crate::model::{Project, ProviderSession, SessionMessage};

pub(crate) fn index_dsh(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let mut files = dsh_project_session_files(&home_dir(), &project.path)?;
    sort_recent(&mut files);
    files.truncate(limit);
    let mut result = files
        .into_iter()
        .filter_map(|path| index_dsh_file(project, &path).transpose())
        .collect::<Result<Vec<_>>>()?;
    result.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    result.truncate(limit);
    Ok(result)
}

pub(super) fn dsh_project_directory(home: &Path, project_path: &str) -> PathBuf {
    home.join(".dsh/sessions").join(format!(
        "--{}--",
        project_path.trim_matches('/').replace('/', "-")
    ))
}

fn dsh_project_session_files(home: &Path, project_path: &str) -> Result<Vec<PathBuf>> {
    let directory = dsh_project_directory(home, project_path);
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(directory)?
        .flatten()
        .map(|entry| entry.path().join("session.jsonl.zstd"))
        .filter(|path| path.is_file())
        .collect())
}

pub(super) fn dsh_session_files(home: &Path) -> Result<Vec<PathBuf>> {
    let root = home.join(".dsh/sessions");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for project in fs::read_dir(root)?.flatten() {
        if !project.path().is_dir() {
            continue;
        }
        for session in fs::read_dir(project.path())?.flatten() {
            let path = session.path().join("session.jsonl.zstd");
            if path.is_file() {
                files.push(path);
            }
        }
    }
    Ok(files)
}

fn index_dsh_file(project: &Project, path: &Path) -> Result<Option<ProviderSession>> {
    let metadata = fs::metadata(path)?;
    let values = dsh_values(path, MAX_TRANSCRIPT_BYTES)?;
    let Some(header) = values.iter().find(|value| value["type"] == "session") else {
        return Ok(None);
    };
    let cwd = string(&header["cwd"]).unwrap_or_default();
    if cwd.is_empty() || !cwd_matches(&cwd, &project.path) {
        return Ok(None);
    }
    let native_id = string(&header["id"])
        .or_else(|| {
            path.parent()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    if native_id.is_empty() {
        return Ok(None);
    }
    let mut title = String::new();
    let mut first_prompt = String::new();
    let mut latest_time = None::<i64>;
    for value in &values {
        if let Some(time) = value.get("time").and_then(Value::as_i64) {
            latest_time = Some(latest_time.map_or(time, |current| current.max(time)));
        }
        if value["type"] == "session/title" {
            if let Some(value) = string(&value["data"]["title"]) {
                title = value;
            }
        } else if first_prompt.is_empty()
            && value["type"] == "user/message"
            && value["data"]["source"]["kind"] == "user"
        {
            first_prompt = meaningful_user_text(dsh_content_text(&value["data"]["content"]));
        }
    }
    if title.trim().is_empty() {
        title = first_prompt;
    }
    title = truncate_title(&title);
    if title.is_empty() {
        return Ok(None);
    }
    let modified_at = modified_rfc3339(&metadata);
    let created_at = header["createdAt"]
        .as_i64()
        .map(unix_millis_rfc3339)
        .unwrap_or_else(|| modified_at.clone());
    let updated_at = latest_time
        .map(unix_millis_rfc3339)
        .map(|value| latest_rfc3339(&modified_at, &value))
        .unwrap_or(modified_at);
    Ok(Some(ProviderSession {
        id: format!("dsh:{native_id}"),
        provider: "dsh".to_string(),
        native_session_id: native_id,
        project_id: project.id.clone(),
        cwd,
        title,
        created_at,
        updated_at,
        status: "idle".to_string(),
        pid: None,
        managed_run_id: None,
        model: None,
        effort: None,
        input_available: false,
        input_transport: None,
        tmux_name: None,
        tmux_access_command: None,
        tmux_controlled: false,
        tmux_owned: false,
    }))
}

pub(super) fn dsh_values(path: &Path, max_bytes: u64) -> Result<Vec<Value>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decompress {}", path.display()))?;
    let reader = BufReader::new(decoder.take(max_bytes));
    Ok(reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect())
}

pub(super) fn parse_dsh_messages(path: &Path, after: Option<&str>) -> Result<Vec<SessionMessage>> {
    let values = dsh_values(path, MAX_TRANSCRIPT_BYTES)?;
    let mut messages = Vec::new();
    let mut turn_started = HashMap::<u64, i64>::new();
    for value in values {
        let event_type = value["type"].as_str().unwrap_or_default();
        let seq = value["seq"].as_u64().unwrap_or_default();
        let time = value["time"].as_i64().unwrap_or_default();
        let timestamp = (time > 0)
            .then(|| unix_millis_rfc3339(time))
            .unwrap_or_default();
        let include = |timestamp: &str| after.is_none_or(|cursor| timestamp >= cursor);
        match event_type {
            "user/message" if value["data"]["source"]["kind"] == "user" => {
                let text = meaningful_user_text(dsh_content_text(&value["data"]["content"]));
                if !text.is_empty() && include(&timestamp) {
                    messages.push(SessionMessage {
                        id: format!("dsh-{seq}"),
                        timestamp,
                        role: "user".to_string(),
                        text,
                        kind: "message".to_string(),
                        meta: None,
                        duration_ms: None,
                    });
                }
            }
            "assistant/message" => {
                let message_id =
                    string(&value["data"]["message"]["id"]).unwrap_or_else(|| format!("dsh-{seq}"));
                for (index, content) in value["data"]["message"]["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let (kind, text) = match content["type"].as_str() {
                        Some("text") => ("message", string(&content["text"]).unwrap_or_default()),
                        Some("reasoning") => {
                            ("reasoning", string(&content["text"]).unwrap_or_default())
                        }
                        _ => continue,
                    };
                    if !text.trim().is_empty() && include(&timestamp) {
                        messages.push(SessionMessage {
                            id: format!("{message_id}:{kind}:{index}"),
                            timestamp: timestamp.clone(),
                            role: "assistant".to_string(),
                            text,
                            kind: kind.to_string(),
                            meta: None,
                            duration_ms: None,
                        });
                    }
                }
            }
            "tool/call" => {
                let name = string(&value["data"]["name"]).unwrap_or_else(|| "tool".to_string());
                let arguments = string(&value["data"]["arguments"]).unwrap_or_default();
                let path = dsh_tool_path(&arguments);
                let file_change = dsh_file_tool(&name) && path.is_some();
                if include(&timestamp) {
                    messages.push(SessionMessage {
                        id: string(&value["data"]["callId"])
                            .unwrap_or_else(|| format!("dsh-tool-{seq}")),
                        timestamp,
                        role: "assistant".to_string(),
                        text: String::new(),
                        kind: if file_change { "file_change" } else { "tool" }.to_string(),
                        meta: Some(if file_change {
                            json!({
                                "tool":name,
                                "display":format!("Used {name}"),
                                "command":arguments,
                                "status":"completed",
                                "changes":[{"path":path,"kind":"edit"}],
                            })
                        } else {
                            json!({
                                "tool":name,
                                "display":format!("Used {name}"),
                                "command":arguments,
                                "status":"completed",
                            })
                        }),
                        duration_ms: None,
                    });
                }
            }
            "tool/result" => {
                let text = dsh_tool_result_text(&value["data"]);
                if include(&timestamp) {
                    messages.push(SessionMessage {
                        id: format!("dsh-tool-result-{seq}"),
                        timestamp,
                        role: "assistant".to_string(),
                        text: text.clone(),
                        kind: "tool_output".to_string(),
                        meta: Some(json!({
                            "tool":"DSH tool result",
                            "output":text,
                            "status":if value["data"]["message"]["content"][0]["isError"] == true { "failed" } else { "completed" },
                        })),
                        duration_ms: None,
                    });
                }
            }
            "turn/start" => {
                if let Some(turn) = value["data"]["turn"].as_u64() {
                    turn_started.insert(turn, time);
                }
            }
            "turn/end" => {
                let duration_ms = value["data"]["turn"]
                    .as_u64()
                    .and_then(|turn| turn_started.remove(&turn))
                    .map(|started| time.saturating_sub(started));
                if include(&timestamp) {
                    messages.push(SessionMessage {
                        id: format!("dsh-turn-{seq}"),
                        timestamp,
                        role: "assistant".to_string(),
                        text: String::new(),
                        kind: "turn_completed".to_string(),
                        meta: Some(json!({"stop_reason":value["data"]["reason"]["kind"]})),
                        duration_ms,
                    });
                }
            }
            _ => {}
        }
        if messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    Ok(messages)
}

fn dsh_content_text(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "text")
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn dsh_tool_result_text(data: &Value) -> String {
    data["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn dsh_file_tool(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "edit" | "write" | "delete" | "move" | "apply_patch" | "str_replace_editor"
    )
}

fn dsh_tool_path(arguments: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(arguments).ok()?;
    ["file_path", "path", "filePath", "target"]
        .into_iter()
        .find_map(|key| string(&value[key]))
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::sessions::{
        parse_messages, source_path_from_home, test_project, transcript_turn_active,
    };

    #[test]
    fn indexes_resolves_and_parses_dsh_zstd_history() {
        let home =
            std::env::temp_dir().join(format!("codesk-dsh-history-{}", uuid::Uuid::new_v4()));
        let project_path = home.join("repo");
        let session_id = "session-dsh-fixture";
        let session_dir = home.join(".dsh/sessions/--repo--").join(session_id);
        fs::create_dir_all(&session_dir).unwrap();
        fs::create_dir_all(&project_path).unwrap();
        let path = session_dir.join("session.jsonl.zstd");
        let values = [
            json!({"type":"session","version":0,"id":session_id,"createdAt":1786840000000_i64,"cwd":project_path}),
            json!({"type":"turn/start","seq":1,"time":1786840000100_i64,"data":{"turn":1}}),
            json!({"type":"user/message","seq":2,"time":1786840000200_i64,"data":{"content":[{"type":"text","text":"Inspect package.json"}],"source":{"kind":"user","rpcId":"prompt-1"},"role":"user","id":"user-1"}}),
            json!({"type":"session/title","seq":3,"time":1786840000300_i64,"data":{"title":"Inspect the package"}}),
            json!({"type":"tool/call","seq":4,"time":1786840000400_i64,"data":{"turn":1,"step":1,"callId":"call-1","name":"read","arguments":"{\"file_path\":\"package.json\"}"}}),
            json!({"type":"tool/result","seq":5,"time":1786840000500_i64,"data":{"turn":1,"step":1,"message":{"source":{"kind":"tool","callId":"call-1"},"content":[{"type":"tool-result","toolCallId":"call-1","content":[{"type":"text","text":"codesk"}],"isError":false}],"role":"user","id":"result-1"}}}),
            json!({"type":"assistant/message","seq":6,"time":1786840000600_i64,"data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"reasoning","text":"Checked it"},{"type":"text","text":"Done"}],"source":{"kind":"model"},"id":"assistant-1"}}}),
            json!({"type":"turn/end","seq":7,"time":1786840001100_i64,"data":{"turn":1,"reason":{"kind":"completed"}}}),
        ];
        let file = File::create(&path).unwrap();
        let mut encoder = zstd::stream::write::Encoder::new(file, 1).unwrap();
        for value in values {
            writeln!(encoder, "{value}").unwrap();
        }
        encoder.finish().unwrap();

        let project = test_project(&project_path);
        let indexed = index_dsh_file(&project, &path).unwrap().unwrap();
        assert_eq!(indexed.provider, "dsh");
        assert_eq!(indexed.native_session_id, session_id);
        assert_eq!(indexed.title, "Inspect the package");
        assert_eq!(
            source_path_from_home(&home, &project, "dsh", session_id).unwrap(),
            path
        );
        let messages = parse_messages(&path, "dsh", None).unwrap();
        assert_eq!(messages[0].role, "user");
        assert!(messages.iter().any(|message| message.kind == "tool"));
        assert!(messages.iter().any(|message| message.kind == "tool_output"));
        assert!(
            messages
                .iter()
                .any(|message| message.kind == "reasoning" && message.text == "Checked it")
        );
        assert!(
            messages
                .iter()
                .any(|message| message.kind == "message" && message.text == "Done")
        );
        assert_eq!(
            messages
                .iter()
                .find(|message| message.kind == "turn_completed")
                .and_then(|message| message.duration_ms),
            Some(1000)
        );
        assert!(!transcript_turn_active(&path, "dsh"));
        fs::remove_dir_all(home).unwrap();
    }
}
