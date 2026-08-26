#[cfg(test)]
use std::collections::HashSet;
use std::{
    fs::File,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

use anyhow::Result;
use rusqlite::params;
#[cfg(test)]
use rusqlite::params_from_iter;
use serde_json::Value;

use super::{
    MAX_INDEX_BYTES, MAX_MESSAGES, cwd_matches, home_dir, index_file, jsonl_files,
    meaningful_user_text, message, newest_numbered_database, parse_messages, readonly_database,
    sort_recent, string, text_content, truncate_title, unix_millis_rfc3339, unix_seconds_rfc3339,
};
use crate::model::{Project, ProviderSession, SessionMessage};

const MAX_CODEX_CANDIDATES: usize = 1500;

pub(crate) fn index_codex(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let codex_root = home_dir().join(".codex");
    let database_available = newest_numbered_database(&codex_root, "state_").is_some();
    let mut sessions = index_codex_database(project, &codex_root, limit).unwrap_or_default();
    // The state database is Codex's authoritative thread index, and it is just
    // as authoritative when it returns nothing: a project with no Codex history
    // is the common case, and it used to be the one that fell through to the
    // rollout scan below. That scan reads a thousand multi-megabyte transcripts
    // to confirm the empty answer the database already gave — nine seconds per
    // call, on every session poll, for every project. Only an installation with
    // no usable database needs the legacy scan.
    if sessions.len() >= limit || database_available {
        return Ok(sessions);
    }
    let directory = codex_root.join("sessions");
    if !directory.is_dir() {
        return Ok(sessions);
    }
    let mut files = jsonl_files(&directory, true)?;
    sort_recent(&mut files);
    files.truncate(MAX_CODEX_CANDIDATES);
    for path in files {
        if let Some(item) = index_file(project, "codex", &path)? {
            if sessions
                .iter()
                .any(|session| session.native_session_id == item.native_session_id)
            {
                continue;
            }
            sessions.push(item);
            if sessions.len() >= limit {
                break;
            }
        }
    }
    Ok(sessions)
}

fn index_codex_database(
    project: &Project,
    codex_root: &Path,
    limit: usize,
) -> Result<Vec<ProviderSession>> {
    let Some(path) = newest_numbered_database(codex_root, "state_") else {
        return Ok(Vec::new());
    };
    let connection = readonly_database(&path)?;
    let mut statement = connection.prepare(
        "SELECT id, cwd, title, first_user_message, created_at, updated_at
         FROM threads
         WHERE archived = 0 AND cwd = ?1
         ORDER BY updated_at DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![project.path, limit as i64], |row| {
        let native_id: String = row.get(0)?;
        let cwd: String = row.get(1)?;
        let title: String = row.get(2)?;
        let first_user_message: String = row.get(3)?;
        let created_at: i64 = row.get(4)?;
        let updated_at: i64 = row.get(5)?;
        Ok(ProviderSession {
            id: format!("codex:{native_id}"),
            provider: "codex".to_string(),
            native_session_id: native_id,
            project_id: project.id.clone(),
            cwd,
            title: truncate_title(&meaningful_user_text(if title.trim().is_empty() {
                first_user_message
            } else {
                title
            })),
            created_at: unix_seconds_rfc3339(created_at),
            updated_at: unix_seconds_rfc3339(updated_at),
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
        })
    })?;
    let mut sessions = rows.filter_map(|row| row.ok()).collect::<Vec<_>>();
    sessions.retain(|session| !session.title.is_empty());
    Ok(sessions)
}

#[cfg(test)]
fn enrich_codex_titles(codex_root: &Path, sessions: &mut [ProviderSession]) {
    let Some(path) = newest_numbered_database(codex_root, "thread_history_") else {
        return;
    };
    let Ok(connection) = readonly_database(&path) else {
        return;
    };
    let missing = sessions
        .iter()
        .filter(|session| meaningful_user_text(session.title.clone()).is_empty())
        .map(|session| session.native_session_id.clone())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return;
    }
    // Query all missing titles in one pass. The history database can be
    // hundreds of megabytes and one full-table scan per blank thread makes
    // navigation progressively slower as more sessions accumulate.
    let placeholders = std::iter::repeat_n("?", missing.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT thread_id, item_json
         FROM thread_items
         WHERE item_type = 'userMessage' AND thread_id IN ({placeholders})
         ORDER BY thread_id, rollout_ordinal ASC"
    );
    let Ok(mut statement) = connection.prepare(&sql) else {
        return;
    };
    let Ok(rows) = statement.query_map(params_from_iter(missing.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return;
    };
    let mut seen = HashSet::new();
    for row in rows.flatten() {
        let (thread_id, item_json) = row;
        if !seen.insert(thread_id.clone()) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&item_json) else {
            continue;
        };
        let title = meaningful_user_text(text_content(&value["content"]));
        if title.is_empty() {
            continue;
        }
        if let Some(session) = sessions
            .iter_mut()
            .find(|session| session.native_session_id == thread_id)
        {
            session.title = truncate_title(&title);
        }
    }
}

pub(crate) fn codex_messages_for_project(
    project: &Project,
    native_session_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let codex_root = home_dir().join(".codex");
    if let Some(path) = codex_rollout_path(&codex_root, native_session_id)? {
        if path.is_file() && codex_rollout_matches_project(&path, project)? {
            return parse_messages(&path, "codex", after, None, None);
        }
    }
    if codex_thread_matches_project(&codex_root, native_session_id, project)? {
        return codex_history_messages(&codex_root, native_session_id, after);
    }
    anyhow::bail!("Codex transcript was not found in this project")
}

fn codex_thread_matches_project(
    codex_root: &Path,
    native_session_id: &str,
    project: &Project,
) -> Result<bool> {
    let Some(path) = newest_numbered_database(codex_root, "state_") else {
        return Ok(false);
    };
    let connection = readonly_database(&path)?;
    let cwd = connection.query_row(
        "SELECT cwd FROM threads WHERE id = ?1",
        [native_session_id],
        |row| row.get::<_, String>(0),
    );
    match cwd {
        Ok(cwd) => Ok(cwd_matches(&cwd, &project.path)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn codex_rollout_matches_project(path: &Path, project: &Project) -> Result<bool> {
    let file = File::open(path)?;
    for line in BufReader::new(file)
        .take(MAX_INDEX_BYTES)
        .lines()
        .map_while(Result::ok)
    {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["type"] == "session_meta" {
            return Ok(string(&value["payload"]["cwd"])
                .is_some_and(|cwd| cwd_matches(&cwd, &project.path)));
        }
    }
    Ok(false)
}

pub(super) fn codex_rollout_path(
    codex_root: &Path,
    native_session_id: &str,
) -> Result<Option<PathBuf>> {
    let Some(path) = newest_numbered_database(codex_root, "state_") else {
        return Ok(None);
    };
    let connection = readonly_database(&path)?;
    let value = connection.query_row(
        "SELECT rollout_path FROM threads WHERE id = ?1",
        [native_session_id],
        |row| row.get::<_, String>(0),
    );
    match value {
        Ok(path) if !path.trim().is_empty() => Ok(Some(PathBuf::from(path))),
        Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn codex_history_messages(
    codex_root: &Path,
    native_session_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let Some(path) = newest_numbered_database(codex_root, "thread_history_") else {
        anyhow::bail!("Codex transcript was not found")
    };
    let connection = readonly_database(&path)?;
    let mut statement = connection.prepare(
        "SELECT item_json, created_at_ms
         FROM thread_items
         WHERE thread_id = ?1 AND item_type IN ('userMessage', 'agentMessage')
         ORDER BY rollout_ordinal, created_at_ms
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![native_session_id, MAX_MESSAGES as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut messages = Vec::new();
    for (line_number, row) in rows.enumerate() {
        let Ok((item_json, created_at_ms)) = row else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&item_json) else {
            continue;
        };
        let (role, text) = match value["type"].as_str() {
            Some("userMessage") => ("user", text_content(&value["content"])),
            Some("agentMessage") => (
                "assistant",
                string(&value["text"]).unwrap_or_else(|| text_content(&value["content"])),
            ),
            _ => continue,
        };
        if let Some(mut item) = message(&value, line_number, role, text) {
            item.timestamp = unix_millis_rfc3339(created_at_ms);
            if after.is_none_or(|cursor| item.timestamp.as_str() >= cursor) {
                messages.push(item);
            }
        }
    }
    Ok(messages)
}

pub(super) fn parse_codex_history_event(
    value: &Value,
    line_number: usize,
    messages: &mut Vec<SessionMessage>,
    after: Option<&str>,
    turn_started: &mut Option<String>,
) {
    let timestamp = string(&value["timestamp"]).unwrap_or_default();
    let Some(payload) = value.get("payload") else {
        return;
    };
    let mut push =
        |id: String, kind: &str, text: String, meta: Option<Value>, duration_ms: Option<i64>| {
            let item = SessionMessage {
                id,
                timestamp: timestamp.clone(),
                role: "assistant".to_string(),
                text: text.trim().to_string(),
                kind: kind.to_string(),
                meta,
                duration_ms,
            };
            if after.is_none_or(|cursor| item.timestamp.as_str() >= cursor)
                && (kind == "turn_completed" || !item.text.is_empty() || item.meta.is_some())
            {
                messages.push(item);
            }
        };

    if value["type"] == "response_item" {
        let item_type = payload["type"].as_str().unwrap_or_default();
        match item_type {
            "custom_tool_call" => {
                let name = string(&payload["name"]).unwrap_or_else(|| "tool".to_string());
                push(
                    string(&payload["call_id"]).unwrap_or_else(|| format!("tool-{line_number}")),
                    "tool",
                    String::new(),
                    Some(serde_json::json!({
                        "tool": name,
                        "display": format!("Used {name}"),
                        "input": payload["input"].clone(),
                    })),
                    None,
                );
            }
            "function_call" => {
                let name = string(&payload["name"]).unwrap_or_else(|| "tool".to_string());
                push(
                    string(&payload["call_id"]).unwrap_or_else(|| format!("tool-{line_number}")),
                    "tool",
                    String::new(),
                    Some(serde_json::json!({
                        "tool": name,
                        "display": format!("Used {name}"),
                        "input": payload["arguments"].clone(),
                    })),
                    None,
                );
            }
            "custom_tool_call_output" | "function_call_output" => {
                let output = payload["output"].clone();
                let text = if output.is_string() {
                    string(&output).unwrap_or_default()
                } else {
                    serde_json::to_string_pretty(&output).unwrap_or_default()
                };
                push(
                    string(&payload["call_id"])
                        .unwrap_or_else(|| format!("tool-output-{line_number}")),
                    "tool_output",
                    text.clone(),
                    Some(serde_json::json!({"output": text})),
                    None,
                );
            }
            _ => {}
        }
        return;
    }

    if value["type"] != "event_msg" {
        return;
    }
    match payload["type"].as_str().unwrap_or_default() {
        "item_completed" => {
            let item = &payload["item"];
            let item_type = item["type"].as_str().unwrap_or_default();
            let id = string(&item["id"]).unwrap_or_else(|| format!("item-{line_number}"));
            match item_type {
                "CommandExecution" => {
                    let command = match &item["command"] {
                        Value::Array(parts) => parts
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" "),
                        Value::String(command) => command.clone(),
                        _ => String::new(),
                    };
                    let output = string(&item["aggregated_output"]).unwrap_or_default();
                    push(
                        id,
                        "tool",
                        output.clone(),
                        Some(serde_json::json!({
                            "command": command,
                            "output": output,
                            "status": item["status"].clone(),
                        })),
                        None,
                    );
                }
                "FileChange" => {
                    let changes = item["changes"]
                        .as_object()
                        .map(|changes| {
                            changes
                                .iter()
                                .map(|(path, change)| {
                                    let mut value = change.clone();
                                    if let Some(object) = value.as_object_mut() {
                                        object.insert(
                                            "path".to_string(),
                                            Value::String(path.clone()),
                                        );
                                    }
                                    value
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    push(
                        id,
                        "file_change",
                        String::new(),
                        Some(serde_json::json!({
                            "changes": changes,
                            "status": item["status"].clone(),
                        })),
                        None,
                    );
                }
                "McpToolCall" => {
                    let server = string(&item["server"]).unwrap_or_else(|| "provider".to_string());
                    let tool = string(&item["tool"]).unwrap_or_else(|| "tool".to_string());
                    push(
                        id,
                        "tool",
                        String::new(),
                        Some(serde_json::json!({
                            "server": server,
                            "tool": tool,
                            "display": format!("Used {server} integration, loaded a tool"),
                            "status": item["status"].clone(),
                        })),
                        None,
                    );
                }
                _ => {}
            }
        }
        "task_started" => {
            *turn_started = Some(timestamp);
        }
        "task_complete" => {
            let duration_ms = payload["duration_ms"].as_i64().or_else(|| {
                turn_started
                    .take()
                    .and_then(|started| duration_between(&started, &timestamp))
            });
            let turn_id = string(&payload["turn_id"])
                .map(|id| format!("turn-{id}"))
                .or_else(|| (!timestamp.is_empty()).then(|| format!("turn-{timestamp}")))
                .unwrap_or_else(|| format!("turn-{line_number}"));
            push(turn_id, "turn_completed", String::new(), None, duration_ms);
        }
        _ => {}
    }
}

pub(super) fn duration_between(start: &str, end: &str) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(start).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(end).ok()?;
    Some((end - start).num_milliseconds().max(0))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use rusqlite::Connection;

    use super::*;
    use crate::sessions::{MAX_SESSIONS_PER_PROVIDER, test_project};

    #[test]
    fn indexes_codex_threads_from_state_database() {
        let root = std::env::temp_dir().join(format!("codesk-state-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let project_path = root.join("repo");
        let connection = Connection::open(root.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (
                    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
                    first_user_message TEXT NOT NULL, created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL, archived INTEGER NOT NULL
                 );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, '', ?3, 100, 200, 0)",
                params![
                    "thread-1",
                    project_path.to_string_lossy(),
                    "A fresh conversation"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES (?1, ?2, '', ?3, 101, 201, 0)",
                params![
                    "thread-child",
                    project_path.join("nested").to_string_lossy(),
                    "A nested conversation"
                ],
            )
            .unwrap();
        drop(connection);

        let sessions = index_codex_database(
            &test_project(&project_path),
            &root,
            MAX_SESSIONS_PER_PROVIDER,
        )
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_session_id, "thread-1");
        assert_eq!(sessions[0].title, "A fresh conversation");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_codex_messages_from_history_database() {
        let root =
            std::env::temp_dir().join(format!("codesk-history-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let connection = Connection::open(root.join("thread_history_1.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_items (
                    thread_id TEXT NOT NULL, item_json TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL, item_type TEXT NOT NULL,
                    rollout_ordinal INTEGER NOT NULL
                 );",
            )
            .unwrap();
        connection.execute(
            "INSERT INTO thread_items VALUES (?1, ?2, 1000, 'userMessage', 1)",
            params!["thread-1", serde_json::json!({"type":"userMessage","id":"u1","content":[{"type":"text","text":"Hello"}]}).to_string()],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO thread_items VALUES (?1, ?2, 2000, 'agentMessage', 2)",
                params![
                    "thread-1",
                    serde_json::json!({"type":"agentMessage","id":"a1","text":"Hi"}).to_string()
                ],
            )
            .unwrap();
        drop(connection);

        let messages = codex_history_messages(&root, "thread-1", None).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text, "Hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, "Hi");

        let messages =
            codex_history_messages(&root, "thread-1", Some("1970-01-01T00:00:01.500+00:00"))
                .unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "Hi");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verifies_codex_rollout_project_ownership() {
        let root =
            std::env::temp_dir().join(format!("codesk-rollout-project-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        fs::write(
            &path,
            serde_json::json!({
                "type":"session_meta",
                "payload":{"cwd":root.join("repo").to_string_lossy()}
            })
            .to_string(),
        )
        .unwrap();

        assert!(codex_rollout_matches_project(&path, &test_project(&root.join("repo"))).unwrap());
        assert!(!codex_rollout_matches_project(&path, &test_project(&root.join("other"))).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_provider_title_over_later_codex_history_prompts() {
        let root = std::env::temp_dir().join(format!("codesk-title-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let connection = Connection::open(root.join("thread_history_1.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE thread_items (
                    thread_id TEXT NOT NULL, item_json TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL, item_type TEXT NOT NULL,
                    rollout_ordinal INTEGER NOT NULL
                 );",
            )
            .unwrap();
        for (ordinal, text) in [
            (1, "First request"),
            (2, "/model"),
            (3, "Explain this codebase"),
        ] {
            connection.execute(
                "INSERT INTO thread_items VALUES (?1, ?2, ?3, 'userMessage', ?4)",
                params![
                    "thread-1",
                    serde_json::json!({"type":"userMessage","content":[{"type":"text","text":text}]}).to_string(),
                    ordinal * 1000,
                    ordinal
                ],
            ).unwrap();
        }
        drop(connection);
        let mut sessions = vec![ProviderSession {
            id: "codex:thread-1".into(),
            provider: "codex".into(),
            native_session_id: "thread-1".into(),
            project_id: "project-1".into(),
            cwd: "/repo".into(),
            title: "First request".into(),
            created_at: String::new(),
            updated_at: String::new(),
            status: "idle".into(),
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
        }];

        enrich_codex_titles(&root, &mut sessions);

        assert_eq!(sessions[0].title, "First request");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_codex_historical_activity_and_turn_duration() {
        let root = std::env::temp_dir().join(format!("codesk-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let lines = [
            serde_json::json!({
                "timestamp":"2026-08-15T16:12:53.666Z",
                "type":"response_item",
                "payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Run the benchmark"}]}
            }),
            serde_json::json!({"timestamp":"2026-08-15T16:12:53.700Z","type":"event_msg","payload":{"type":"task_started"}}),
            serde_json::json!({
                "timestamp":"2026-08-15T16:12:54.000Z",
                "type":"response_item",
                "payload":{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"echo hi"}
            }),
            serde_json::json!({
                "timestamp":"2026-08-15T16:12:54.200Z",
                "type":"response_item",
                "payload":{"type":"custom_tool_call_output","call_id":"call-1","output":"hi"}
            }),
            serde_json::json!({
                "timestamp":"2026-08-15T16:12:54.500Z",
                "type":"event_msg",
                "payload":{"type":"item_completed","item":{"type":"McpToolCall","id":"mcp-1","server":"instant_context","tool":"instant_context","status":"completed"}}
            }),
            serde_json::json!({"timestamp":"2026-08-15T16:12:55.200Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1"}}),
        ];
        fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let messages = parse_messages(&path, "codex", None, None, None).unwrap();
        assert_eq!(messages.len(), 5);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].kind, "tool");
        assert_eq!(messages[2].kind, "tool_output");
        assert_eq!(
            messages[3].meta.as_ref().unwrap()["server"],
            "instant_context"
        );
        assert_eq!(messages[4].kind, "turn_completed");
        assert_eq!(messages[4].id, "turn-turn-1");
        assert_eq!(messages[4].duration_ms, Some(1500));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_codex_turn_completion_id_stable_across_read_windows() {
        let event = serde_json::json!({
            "timestamp":"2026-08-15T16:12:55.200Z",
            "type":"event_msg",
            "payload":{"type":"task_complete","turn_id":"01a009e5-9c13-7d92-ac2f-4d261d7abff7","duration_ms":23000}
        });
        let mut full_messages = Vec::new();
        let mut incremental_messages = Vec::new();
        let mut full_started = None;
        let mut incremental_started = None;

        parse_codex_history_event(&event, 14_339, &mut full_messages, None, &mut full_started);
        parse_codex_history_event(
            &event,
            16,
            &mut incremental_messages,
            None,
            &mut incremental_started,
        );

        assert_eq!(full_messages.len(), 1);
        assert_eq!(incremental_messages.len(), 1);
        assert_eq!(full_messages[0].id, incremental_messages[0].id);
        assert_eq!(
            full_messages[0].id,
            "turn-01a009e5-9c13-7d92-ac2f-4d261d7abff7"
        );
        assert_eq!(full_messages[0].duration_ms, Some(23_000));
    }
}
