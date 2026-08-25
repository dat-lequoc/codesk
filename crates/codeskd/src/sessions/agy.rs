use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    MAX_INDEX_BYTES, MAX_MESSAGES, MAX_STREAM_BYTES, MAX_TRANSCRIPT_BYTES, cwd_matches, home_dir,
    meaningful_user_text, modified_rfc3339, readonly_database, string, truncate_title,
};
use crate::model::{Project, ProviderSession, SessionMessage};

pub(crate) fn index_agy(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    index_agy_from_home(&home_dir(), project, limit)
}

fn index_agy_from_home(
    home: &Path,
    project: &Project,
    limit: usize,
) -> Result<Vec<ProviderSession>> {
    let root = home.join(".gemini/antigravity-cli");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    let summary_db = root.join("conversation_summaries.db");
    if summary_db.is_file() {
        if let Ok(connection) = readonly_database(&summary_db) {
            if let Ok(mut statement) = connection.prepare(
                "SELECT conversation_id, COALESCE(title, ''), COALESCE(preview, ''),
                        COALESCE(workspace_uris, '[]'), COALESCE(last_modified_time, '')
                 FROM conversation_summaries
                 ORDER BY last_modified_time DESC
                 LIMIT ?1",
            ) {
                if let Ok(rows) =
                    statement.query_map([limit.saturating_mul(10).max(limit) as i64], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    })
                {
                    for row in rows.flatten() {
                        let (native_id, title, preview, workspace_uris, updated_at) = row;
                        if Uuid::parse_str(&native_id).is_err() {
                            continue;
                        }
                        let Some(cwd) = agy_workspace_paths(&workspace_uris)
                            .into_iter()
                            .filter(|cwd| cwd_matches(cwd, &project.path))
                            .max_by_key(|cwd| cwd.len())
                        else {
                            continue;
                        };
                        let transcript = agy_transcript_path(home, &native_id);
                        if !transcript.is_file() {
                            continue;
                        }
                        let (created_at, first_prompt) = agy_transcript_summary(&transcript)?;
                        let title =
                            truncate_title(&meaningful_user_text(if title.trim().is_empty() {
                                if preview.trim().is_empty() {
                                    first_prompt
                                } else {
                                    preview
                                }
                            } else {
                                title
                            }));
                        if title.is_empty() {
                            continue;
                        }
                        let metadata = fs::metadata(&transcript)?;
                        let modified_at = modified_rfc3339(&metadata);
                        sessions.push(ProviderSession {
                            id: format!("agy:{native_id}"),
                            provider: "agy".to_string(),
                            native_session_id: native_id.clone(),
                            project_id: project.id.clone(),
                            cwd,
                            title,
                            created_at: if created_at.is_empty() {
                                modified_at.clone()
                            } else {
                                created_at
                            },
                            updated_at: {
                                let provider_time = agy_timestamp_rfc3339(&updated_at);
                                if provider_time.is_empty() {
                                    modified_at
                                } else {
                                    provider_time
                                }
                            },
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
                        });
                        seen.insert(native_id);
                        if sessions.len() >= limit {
                            break;
                        }
                    }
                }
            }
        }
    }

    let recent_path = root.join("cache/last_conversations.json");
    if sessions.len() < limit && recent_path.is_file() {
        if let Ok(value) = serde_json::from_slice::<Value>(&fs::read(&recent_path)?) {
            for (cwd, native_id) in value.as_object().into_iter().flatten() {
                let Some(native_id) = native_id.as_str() else {
                    continue;
                };
                if seen.contains(native_id)
                    || Uuid::parse_str(native_id).is_err()
                    || !cwd_matches(cwd, &project.path)
                {
                    continue;
                }
                let transcript = agy_transcript_path(home, native_id);
                if !transcript.is_file() {
                    continue;
                }
                let metadata = fs::metadata(&transcript)?;
                let modified_at = modified_rfc3339(&metadata);
                let (created_at, first_prompt) = agy_transcript_summary(&transcript)?;
                let title = truncate_title(&meaningful_user_text(first_prompt));
                if title.is_empty() {
                    continue;
                }
                sessions.push(ProviderSession {
                    id: format!("agy:{native_id}"),
                    provider: "agy".to_string(),
                    native_session_id: native_id.to_string(),
                    project_id: project.id.clone(),
                    cwd: cwd.to_string(),
                    title,
                    created_at: if created_at.is_empty() {
                        modified_at.clone()
                    } else {
                        created_at
                    },
                    updated_at: modified_at,
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
                });
                seen.insert(native_id.to_string());
            }
        }
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(limit);
    Ok(sessions)
}

pub(super) fn agy_transcript_path(home: &Path, native_id: &str) -> PathBuf {
    home.join(".gemini/antigravity-cli/brain")
        .join(native_id)
        .join(".system_generated/logs/transcript.jsonl")
}

pub(super) fn agy_workspace_paths(value: &str) -> Vec<String> {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().and_then(agy_file_uri_path))
        .collect()
}

fn agy_file_uri_path(uri: &str) -> Option<String> {
    let path = uri.strip_prefix("file://")?;
    let path = path.strip_prefix("localhost").unwrap_or(path);
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

fn agy_timestamp_rfc3339(value: &str) -> String {
    if value.trim().is_empty() {
        return String::new();
    }
    let candidate = value.replacen(' ', "T", 1);
    chrono::DateTime::parse_from_rfc3339(&candidate)
        .map(|value| value.to_rfc3339())
        .unwrap_or(candidate)
}

fn agy_transcript_summary(path: &Path) -> Result<(String, String)> {
    let file = File::open(path)?;
    let mut created_at = String::new();
    let mut first_prompt = String::new();
    for line in BufReader::new(file)
        .take(MAX_INDEX_BYTES)
        .lines()
        .map_while(Result::ok)
    {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if created_at.is_empty() {
            created_at = string(&value["created_at"]).unwrap_or_default();
        }
        if value["source"] == "USER_EXPLICIT" && value["type"] == "USER_INPUT" {
            first_prompt =
                meaningful_user_text(agy_user_text(value["content"].as_str().unwrap_or_default()));
            if !first_prompt.is_empty() {
                break;
            }
        }
    }
    Ok((created_at, first_prompt))
}

pub(super) fn parse_agy_messages(path: &Path, after: Option<&str>) -> Result<Vec<SessionMessage>> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let length = file.metadata()?.len();
    let max_bytes = if after.is_some() {
        MAX_STREAM_BYTES
    } else {
        MAX_TRANSCRIPT_BYTES
    };
    let start = length.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file.take(max_bytes));
    if start > 0 {
        let mut partial = String::new();
        let _ = reader.read_line(&mut partial);
    }
    let mut messages = Vec::new();
    for (line_number, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let step_id = value["step_index"]
            .as_u64()
            .map(|value| value.to_string())
            .unwrap_or_else(|| format!("line-{line_number}"));
        let timestamp = string(&value["created_at"]).unwrap_or_default();
        let include = after.is_none_or(|cursor| timestamp.as_str() >= cursor);
        if value["source"] == "USER_EXPLICIT" && value["type"] == "USER_INPUT" {
            let text =
                meaningful_user_text(agy_user_text(value["content"].as_str().unwrap_or_default()));
            if include && !text.is_empty() {
                messages.push(SessionMessage {
                    id: format!("agy-user-{step_id}"),
                    timestamp,
                    role: "user".to_string(),
                    text,
                    kind: "message".to_string(),
                    meta: None,
                    duration_ms: None,
                });
            }
        } else if value["source"] == "MODEL" && value["type"] == "PLANNER_RESPONSE" {
            if let Some(thinking) = value["thinking"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                if include {
                    messages.push(SessionMessage {
                        id: format!("agy-reasoning-{step_id}"),
                        timestamp: timestamp.clone(),
                        role: "assistant".to_string(),
                        text: thinking.to_string(),
                        kind: "reasoning".to_string(),
                        meta: None,
                        duration_ms: None,
                    });
                }
            }
            for (tool_index, tool) in value["tool_calls"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                if !include {
                    continue;
                }
                let name = string(&tool["name"]).unwrap_or_else(|| "Antigravity tool".to_string());
                let arguments = &tool["args"];
                let path = agy_history_tool_path(arguments);
                let file_change = agy_history_file_tool(&name) && path.is_some();
                let command = agy_history_tool_title(&name, arguments);
                messages.push(SessionMessage {
                    id: format!("agy-tool-{step_id}-{tool_index}"),
                    timestamp: timestamp.clone(),
                    role: "assistant".to_string(),
                    text: String::new(),
                    kind: if file_change { "file_change" } else { "tool" }.to_string(),
                    meta: Some(if file_change {
                        json!({
                            "tool":name,
                            "display":command,
                            "command":agy_json_text(arguments),
                            "status":"completed",
                            "changes":[{"path":path,"kind":agy_history_change_kind(&name)}],
                        })
                    } else {
                        json!({
                            "tool":name,
                            "display":command,
                            "command":agy_json_text(arguments),
                            "status":"completed",
                        })
                    }),
                    duration_ms: None,
                });
            }
            if let Some(content) = value["content"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                if include {
                    messages.push(SessionMessage {
                        id: format!("agy-assistant-{step_id}"),
                        timestamp: timestamp.clone(),
                        role: "assistant".to_string(),
                        text: content.to_string(),
                        kind: "message".to_string(),
                        meta: None,
                        duration_ms: None,
                    });
                    messages.push(SessionMessage {
                        id: format!("agy-turn-{step_id}"),
                        timestamp,
                        role: "assistant".to_string(),
                        text: String::new(),
                        kind: "turn_completed".to_string(),
                        meta: None,
                        duration_ms: None,
                    });
                }
            }
        } else if value["source"] == "MODEL"
            && !matches!(
                value["type"].as_str(),
                Some("CHECKPOINT" | "CONVERSATION_HISTORY")
            )
        {
            let text = string(&value["content"]).unwrap_or_default();
            if include && !text.trim().is_empty() {
                let tool = value["type"]
                    .as_str()
                    .unwrap_or("Antigravity tool result")
                    .to_ascii_lowercase();
                let failed = value["exit_code"].as_i64().is_some_and(|code| code != 0)
                    || value["status"] == "ERROR"
                    || value["status"] == "FAILED";
                messages.push(SessionMessage {
                    id: format!("agy-tool-result-{step_id}"),
                    timestamp,
                    role: "assistant".to_string(),
                    text: text.clone(),
                    kind: "tool_output".to_string(),
                    meta: Some(json!({
                        "tool":tool,
                        "output":text,
                        "status":if failed { "failed" } else { "completed" },
                    })),
                    duration_ms: None,
                });
            }
        }
        if messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    Ok(messages)
}

fn agy_user_text(content: &str) -> String {
    if let Some(start) = content.find("<USER_REQUEST>") {
        let rest = &content[start + "<USER_REQUEST>".len()..];
        if let Some(end) = rest.find("</USER_REQUEST>") {
            return rest[..end].trim().to_string();
        }
    }
    content
        .split("<ADDITIONAL_METADATA>")
        .next()
        .unwrap_or(content)
        .trim()
        .to_string()
}

fn agy_history_tool_title(name: &str, arguments: &Value) -> String {
    [
        "toolAction",
        "toolSummary",
        "CommandLine",
        "command",
        "AbsolutePath",
        "path",
    ]
    .into_iter()
    .find_map(|key| arguments.get(key).and_then(Value::as_str))
    .map(|value| value.trim_matches('"').to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| name.replace('_', " "))
}

fn agy_history_file_tool(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "write", "edit", "replace", "patch", "delete", "move", "rename",
    ]
    .iter()
    .any(|candidate| name.contains(candidate))
}

fn agy_history_change_kind(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    if name.contains("delete") {
        "delete"
    } else if name.contains("move") || name.contains("rename") {
        "move"
    } else {
        "edit"
    }
}

fn agy_history_tool_path(arguments: &Value) -> Option<String> {
    [
        "path",
        "Path",
        "file_path",
        "FilePath",
        "AbsolutePath",
        "TargetFile",
        "TargetPath",
    ]
    .into_iter()
    .find_map(|key| arguments.get(key).and_then(Value::as_str))
    .map(|value| value.trim_matches('"').to_string())
}

fn agy_json_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim_matches('"').to_string(),
        Value::Null => String::new(),
        value => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params};

    use super::*;
    use crate::sessions::{
        parse_messages, source_path_from_home, test_project, transcript_turn_active,
    };

    #[test]
    fn indexes_resolves_and_parses_antigravity_history() {
        let home =
            std::env::temp_dir().join(format!("codesk-agy-history-{}", uuid::Uuid::new_v4()));
        let project_path = home.join("repo project");
        fs::create_dir_all(&project_path).unwrap();
        let project = test_project(&project_path);
        let native_id = "1cbe7f1c-229a-4271-bc20-dc9d46433d96";
        let transcript = agy_transcript_path(&home, native_id);
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let lines = [
            json!({
                "step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE",
                "created_at":"2026-08-15T12:00:00Z",
                "content":"<USER_REQUEST>\nInspect the project\n</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>"
            }),
            json!({
                "step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
                "created_at":"2026-08-15T12:00:01Z","thinking":"I should inspect it.",
                "tool_calls":[{"name":"run_command","args":{"CommandLine":"printf AGY_HISTORY_TOOL_OK"}}]
            }),
            json!({
                "step_index":2,"source":"MODEL","type":"RUN_COMMAND","status":"DONE",
                "created_at":"2026-08-15T12:00:02Z","exit_code":0,"content":"AGY_HISTORY_TOOL_OK"
            }),
            json!({
                "step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
                "created_at":"2026-08-15T12:00:03Z","content":"AGY_HISTORY_RESPONSE_OK"
            }),
        ];
        fs::write(
            &transcript,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let root = home.join(".gemini/antigravity-cli");
        fs::create_dir_all(root.join("cache")).unwrap();
        let connection = Connection::open(root.join("conversation_summaries.db")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE conversation_summaries (
                    conversation_id TEXT PRIMARY KEY,
                    title TEXT,
                    preview TEXT,
                    workspace_uris TEXT,
                    last_modified_time TEXT,
                    status TEXT,
                    project_id TEXT,
                    agent_name TEXT
                );",
            )
            .unwrap();
        let workspace_uri = format!(
            "file://{}",
            project_path.to_string_lossy().replace(' ', "%20")
        );
        connection
            .execute(
                "INSERT INTO conversation_summaries VALUES (?1, '', 'Antigravity history fixture', ?2, ?3, '', '', '')",
                params![
                    native_id,
                    json!([workspace_uri]).to_string(),
                    "2026-08-15 12:00:03+00:00"
                ],
            )
            .unwrap();
        drop(connection);

        let indexed = index_agy_from_home(&home, &project, 10).unwrap();
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].provider, "agy");
        assert_eq!(indexed[0].native_session_id, native_id);
        assert_eq!(indexed[0].cwd, project_path.to_string_lossy());
        assert_eq!(indexed[0].title, "Antigravity history fixture");
        assert_eq!(indexed[0].created_at, "2026-08-15T12:00:00Z");
        assert!(indexed[0].updated_at.starts_with("2026-08-15T12:00:03"));
        assert_eq!(
            source_path_from_home(&home, &project, "agy", native_id).unwrap(),
            transcript
        );

        let messages = parse_messages(&transcript, "agy", None, None, None).unwrap();
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "Inspect the project");
        assert!(messages.iter().any(|message| message.kind == "reasoning"));
        assert!(messages.iter().any(|message| {
            message.kind == "tool"
                && message
                    .meta
                    .as_ref()
                    .is_some_and(|meta| meta["display"] == "printf AGY_HISTORY_TOOL_OK")
        }));
        assert!(messages.iter().any(|message| {
            message.kind == "tool_output" && message.text == "AGY_HISTORY_TOOL_OK"
        }));
        assert!(messages.iter().any(|message| {
            message.role == "assistant" && message.text == "AGY_HISTORY_RESPONSE_OK"
        }));
        assert!(
            messages
                .iter()
                .any(|message| message.kind == "turn_completed")
        );
        assert!(!transcript_turn_active(&transcript, "agy"));
        fs::remove_dir_all(home).unwrap();
    }
}
