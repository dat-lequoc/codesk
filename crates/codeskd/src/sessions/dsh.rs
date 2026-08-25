use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use super::{
    MAX_MESSAGES, cwd_matches, home_dir,
    meaningful_user_text, modified_rfc3339, sort_recent, string, truncate_title,
    unix_millis_rfc3339,
};
use crate::model::{Project, ProviderSession, SessionMessage};

pub(crate) fn index_dsh(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let mut files = dsh_project_session_files(&home_dir(), &project.path)?;
    sort_recent(&mut files);
    let scan_limit = (limit * 3).max(100);
    files.truncate(scan_limit);
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
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decompress {}", path.display()))?;
    let mut reader = BufReader::new(decoder);
    let mut first_line = String::new();
    if reader.read_line(&mut first_line)? == 0 {
        return Ok(None);
    }
    let header: Value = match serde_json::from_str(&first_line) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if header["type"] != "session" {
        return Ok(None);
    }
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
    let mut user_title = None::<String>;
    let mut provider_title = None::<String>;
    let mut fallback_title = None::<String>;
    let mut first_prompt = String::new();
    let mut line = String::new();
    let mut lines_checked = 0;
    while lines_checked < 5000 && reader.read_line(&mut line)? > 0 {
        lines_checked += 1;
        if line.contains("\"session/title\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value["type"] == "session/title" {
                    if let Some(t) = string(&value["data"]["title"]).filter(|s| !s.trim().is_empty()) {
                        let kind = value["data"]["source"]["kind"].as_str().unwrap_or_default();
                        match kind {
                            "user" => {
                                user_title = Some(t);
                                break;
                            }
                            "provider" => {
                                provider_title = Some(t);
                            }
                            _ => {
                                if fallback_title.is_none() {
                                    fallback_title = Some(t);
                                }
                            }
                        }
                    }
                }
            }
        } else if first_prompt.is_empty() && line.contains("\"user/message\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value["type"] == "user/message" {
                    let content_text = dsh_content_text(&value["data"]["content"]);
                    let meaningful = meaningful_user_text(content_text.clone());
                    if !meaningful.is_empty() {
                        first_prompt = meaningful;
                    } else if !content_text.is_empty() {
                        first_prompt = content_text;
                    }
                }
            }
        } else if first_prompt.is_empty() && line.contains("\"goal/change\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if let Some(obj) = string(&value["data"]["goal"]["objective"]) {
                    first_prompt = obj;
                }
            }
        } else if first_prompt.is_empty() && line.contains("\"command/run\"") {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value["data"]["name"] == "goal" {
                    if let Some(args) = string(&value["data"]["args"]) {
                        first_prompt = args;
                    }
                }
            }
        }
        line.clear();
    }
    let mut title = user_title
        .or(provider_title)
        .or(fallback_title)
        .unwrap_or(first_prompt);
    if title.trim().is_empty() {
        title = native_id.clone();
    }
    title = truncate_title(&title);
    if title.is_empty() {
        title = native_id.clone();
    }
    let modified_at = modified_rfc3339(&metadata);
    let created_at = header["createdAt"]
        .as_i64()
        .map(unix_millis_rfc3339)
        .unwrap_or_else(|| modified_at.clone());
    let updated_at = modified_at;
    let is_recent = metadata
        .modified()
        .ok()
        .and_then(|m| m.elapsed().ok())
        .is_some_and(|elapsed| elapsed <= std::time::Duration::from_secs(60));
    let is_active = is_recent && dsh_turn_active(path);
    let status = if is_active { "running" } else { "idle" };
    Ok(Some(ProviderSession {
        id: format!("dsh:{native_id}"),
        provider: "dsh".to_string(),
        native_session_id: native_id,
        project_id: project.id.clone(),
        cwd,
        title,
        created_at,
        updated_at,
        status: status.to_string(),
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

/// Live turn state has to come from the *latest* `turn/start` / `turn/end`, not
/// the first 8 MB of the zstd stream. A long DSH session with bulky tool output
/// otherwise looks "active" forever, and Move to tmux waits forever for idle.
pub(super) fn dsh_turn_active(path: &Path) -> bool {
    dsh_fold_turn_active(path).unwrap_or(false)
}

fn dsh_event_type(value: &Value) -> Option<&str> {
    value["type"]
        .as_str()
        .filter(|item| *item != "dsh.event")
        .or_else(|| value["event"]["type"].as_str())
}

fn dsh_fold_turn_active(path: &Path) -> Result<bool> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decompress {}", path.display()))?;
    let reader = BufReader::new(decoder);
    let mut active = false;
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"turn/") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match dsh_event_type(&value) {
            Some("turn/start") => active = true,
            Some("turn/end") => active = false,
            _ => {}
        }
    }
    Ok(active)
}

pub(super) fn parse_dsh_messages(
    path: &Path,
    after: Option<&str>,
    before: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<SessionMessage>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .with_context(|| format!("decompress {}", path.display()))?;
    let reader = BufReader::new(decoder);
    let mut messages = Vec::new();
    let mut turn_started = HashMap::<u64, i64>::new();

    for line in reader.lines().map_while(Result::ok) {
        // Fast skip of lines that are not messages/turns/tools
        if !line.contains("\"user/message\"")
            && !line.contains("\"assistant/message\"")
            && !line.contains("\"tool/call\"")
            && !line.contains("\"tool/result\"")
            && !line.contains("\"turn/start\"")
            && !line.contains("\"turn/end\"")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event_type = value["type"].as_str().unwrap_or_default();
        let seq = value["seq"].as_u64().unwrap_or_default();
        let time = value["time"].as_i64().unwrap_or_default();
        let timestamp = (time > 0)
            .then(|| unix_millis_rfc3339(time))
            .unwrap_or_default();
        let include = |ts: &str| {
            if let Some(cursor) = after {
                if ts < cursor {
                    return false;
                }
            }
            if let Some(cursor) = before {
                if ts >= cursor {
                    return false;
                }
            }
            true
        };
        match event_type {
            "user/message" => {
                let source_kind = value["data"]["source"]["kind"].as_str().unwrap_or_default();
                let text = dsh_content_text(&value["data"]["content"]);
                let is_context_injection = source_kind != "user"
                    || text.starts_with("Current runtime context")
                    || text.starts_with("The approval policy changed")
                    || text.starts_with("Additional instructions from:");
                let meaningful = meaningful_user_text(text.clone());
                if (!meaningful.is_empty() || is_context_injection) && include(&timestamp) {
                    messages.push(SessionMessage {
                        id: format!("dsh-{seq}"),
                        timestamp,
                        role: "user".to_string(),
                        text: if is_context_injection { text } else { meaningful },
                        kind: "message".to_string(),
                        meta: if is_context_injection {
                            Some(json!({
                                "is_context_injection": true,
                                "source": value["data"]["source"],
                                "form": value["data"]["source"]["form"],
                            }))
                        } else {
                            None
                        },
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
                let call_id = string(&value["data"]["callId"])
                    .unwrap_or_else(|| format!("dsh-tool-{seq}"));
                let path = dsh_tool_path(&arguments);
                let file_change = dsh_file_tool(&name) && path.is_some();
                let args_json = serde_json::from_str::<Value>(&arguments).ok();
                let todos = if name == "todo_write" || name == "todos" {
                    args_json.as_ref().and_then(|v| v.get("todos").cloned())
                } else {
                    None
                };
                let goal = if name == "create_goal" || name == "update_goal" {
                    args_json.as_ref().cloned()
                } else {
                    None
                };
                let command = if name == "bash" {
                    args_json
                        .as_ref()
                        .and_then(|v| v.get("command").and_then(Value::as_str))
                        .map(str::to_string)
                } else {
                    None
                };

                if include(&timestamp) {
                    let mut meta_obj = serde_json::Map::new();
                    meta_obj.insert("call_id".into(), json!(call_id));
                    meta_obj.insert("tool".into(), json!(name));
                    meta_obj.insert("display".into(), json!(format!("Used {name}")));
                    meta_obj.insert("command".into(), json!(arguments));
                    meta_obj.insert("status".into(), json!("completed"));
                    if let Some(todos_val) = todos {
                        meta_obj.insert("todos".into(), todos_val);
                    }
                    if let Some(goal_val) = goal {
                        meta_obj.insert("goal".into(), goal_val);
                    }
                    if let Some(cmd_val) = command {
                        meta_obj.insert("bash_command".into(), json!(cmd_val));
                    }
                    if file_change {
                        meta_obj.insert("changes".into(), json!([{"path": path, "kind": "edit"}]));
                    }

                    messages.push(SessionMessage {
                        id: call_id,
                        timestamp,
                        role: "assistant".to_string(),
                        text: String::new(),
                        kind: if file_change { "file_change" } else { "tool" }.to_string(),
                        meta: Some(Value::Object(meta_obj)),
                        duration_ms: None,
                    });
                }
            }
            "tool/result" => {
                let text = dsh_tool_result_text(&value["data"]);
                let call_id = string(&value["data"]["message"]["source"]["callId"])
                    .or_else(|| string(&value["data"]["callId"]));
                let is_error = value["data"]["message"]["content"][0]["isError"] == true;
                if include(&timestamp) {
                    messages.push(SessionMessage {
                        id: format!("dsh-tool-result-{seq}"),
                        timestamp,
                        role: "assistant".to_string(),
                        text: text.clone(),
                        kind: "tool_output".to_string(),
                        meta: Some(json!({
                            "call_id": call_id,
                            "tool": "DSH tool result",
                            "output": text,
                            "status": if is_error { "failed" } else { "completed" },
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
    if let Some(page_limit) = limit {
        if messages.len() > page_limit {
            if after.is_some() && before.is_none() {
                messages.truncate(page_limit);
            } else {
                let start = messages.len().saturating_sub(page_limit);
                return Ok(messages.split_off(start));
            }
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
        let messages = parse_messages(&path, "dsh", None, None, None).unwrap();
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

    #[test]
    fn turn_active_reads_the_end_of_a_large_dsh_transcript() {
        let home = std::env::temp_dir().join(format!("codesk-dsh-turn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&home).unwrap();
        let path = home.join("session.jsonl.zstd");
        let file = File::create(&path).unwrap();
        let mut encoder = zstd::stream::write::Encoder::new(file, 1).unwrap();
        writeln!(
            encoder,
            "{}",
            json!({"type":"turn/start","seq":1,"data":{"turn":1}})
        )
        .unwrap();
        writeln!(
            encoder,
            "{}",
            json!({"type":"tool/result","seq":2,"data":{"text":"x".repeat(8 * 1024 * 1024 + 64)}})
        )
        .unwrap();
        writeln!(
            encoder,
            "{}",
            json!({"type":"turn/end","seq":3,"data":{"turn":1,"reason":{"kind":"completed"}}})
        )
        .unwrap();
        encoder.finish().unwrap();
        assert!(
            !dsh_turn_active(&path),
            "a completed turn after bulky tool output must count as idle"
        );
        fs::remove_dir_all(home).unwrap();
    }
}
