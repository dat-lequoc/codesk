use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::{
    MAX_MESSAGES, cwd_matches, home_dir, meaningful_user_text, readonly_database, string,
    truncate_title, unix_millis_rfc3339,
};
use crate::model::{Project, ProviderSession, SessionMessage};

/// OpenCode's own word for "this assistant step asked for tools", the only
/// finish reason that leaves a turn open.
const OPENCODE_MID_TURN_FINISH: &str = "tool-calls";
const OPENCODE_ACTIVE_WINDOW_MS: i64 = 60_000;

fn opencode_database() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local/share"))
        .join("opencode/opencode.db")
}

pub(crate) fn index_opencode(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    index_opencode_database(project, &opencode_database(), limit)
}

fn index_opencode_database(
    project: &Project,
    database: &Path,
    limit: usize,
) -> Result<Vec<ProviderSession>> {
    if !database.is_file() {
        return Ok(Vec::new());
    }
    let connection = readonly_database(database)?;
    let mut statement = connection.prepare(
        "SELECT id, directory, title, time_created, time_updated
         FROM session
         WHERE directory = ?1 AND time_archived IS NULL
         ORDER BY time_updated DESC
         LIMIT ?2",
    )?;
    let mut updated_millis = HashMap::new();
    let rows = statement.query_map(params![project.path, limit as i64], |row| {
        let native_id: String = row.get(0)?;
        let cwd: String = row.get(1)?;
        let title: String = row.get(2)?;
        let created_at: i64 = row.get(3)?;
        let updated_at: i64 = row.get(4)?;
        updated_millis.insert(native_id.clone(), updated_at);
        Ok(ProviderSession {
            id: format!("opencode:{native_id}"),
            provider: "opencode".to_string(),
            native_session_id: native_id,
            project_id: project.id.clone(),
            cwd,
            title: truncate_title(&meaningful_user_text(title)),
            created_at: unix_millis_rfc3339(created_at),
            updated_at: unix_millis_rfc3339(updated_at),
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
    let mut sessions = rows
        .filter_map(|row| row.ok())
        .filter(|session| !session.title.is_empty())
        .collect::<Vec<_>>();
    // OpenCode keeps its history in SQLite, so it has no transcript file for the
    // shared turn-active scan to read and used to be the one provider that could
    // never report a live turn. Its own rows answer the question directly.
    for session in sessions.iter_mut() {
        let updated_at = updated_millis.get(&session.native_session_id).copied();
        if updated_at.is_some_and(recently_updated)
            && opencode_turn_active(&connection, &session.native_session_id)
        {
            session.status = "running".to_string();
        }
    }
    Ok(sessions)
}

/// A session whose newest assistant message is still waiting on tool calls is
/// mid-turn. Anything else — a plain stop, a length cutoff, an error — is done.
fn opencode_turn_active(connection: &Connection, native_session_id: &str) -> bool {
    connection
        .query_row(
            "SELECT json_extract(data, '$.finish'), json_extract(data, '$.time.completed')
             FROM message
             WHERE session_id = ?1 AND json_extract(data, '$.role') = 'assistant'
             ORDER BY time_created DESC
             LIMIT 1",
            [native_session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                ))
            },
        )
        .map(|(finish, completed)| {
            completed.is_none() || finish.as_deref() == Some(OPENCODE_MID_TURN_FINISH)
        })
        .unwrap_or(false)
}

/// A transcript that stopped mid-turn and then went quiet belongs to a session
/// nobody is driving any more, not to a live one. The shared scan applies the
/// same window to file-backed providers.
fn recently_updated(updated_at_millis: i64) -> bool {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default();
    (0..=OPENCODE_ACTIVE_WINDOW_MS).contains(&(now - updated_at_millis))
}

pub(crate) fn opencode_messages_for_project(
    project: &Project,
    native_session_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let database = opencode_database();
    anyhow::ensure!(database.is_file(), "OpenCode database was not found");
    let connection = readonly_database(&database)?;
    let directory = connection.query_row(
        "SELECT directory FROM session WHERE id = ?1",
        [native_session_id],
        |row| row.get::<_, String>(0),
    );
    match directory {
        Ok(directory) => anyhow::ensure!(
            cwd_matches(&directory, &project.path),
            "OpenCode session was not found in this project"
        ),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            anyhow::bail!("OpenCode session was not found")
        }
        Err(error) => return Err(error.into()),
    }
    opencode_history_messages(&connection, native_session_id, after)
}

fn opencode_history_messages(
    connection: &Connection,
    native_session_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let mut statement = connection.prepare(
        "SELECT m.id, m.time_created, m.data, p.id, p.time_created, p.data
         FROM message m
         JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?1
         ORDER BY m.time_created, p.time_created, p.id
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![native_session_id, MAX_MESSAGES as i64 * 4], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut messages = Vec::new();
    // One assistant message spans several part rows, and the turn marker belongs
    // after the last of them, so it is held until the message id changes.
    let mut pending_turn: Option<SessionMessage> = None;
    for row in rows.flatten() {
        let (message_id, message_time, message_json, part_id, part_time, part_json) = row;
        if pending_turn
            .as_ref()
            .is_some_and(|turn| turn.id != format!("{message_id}:turn"))
        {
            messages.extend(pending_turn.take());
        }
        let Ok(message_data) = serde_json::from_str::<Value>(&message_json) else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<Value>(&part_json) else {
            continue;
        };
        let role = string(&message_data["role"]).unwrap_or_else(|| "assistant".to_string());
        let timestamp = unix_millis_rfc3339(if part_time > 0 {
            part_time
        } else {
            message_time
        });
        if after.is_some_and(|cursor| timestamp.as_str() < cursor) {
            continue;
        }
        match part["type"].as_str() {
            Some("text") => {
                let text = string(&part["text"]).unwrap_or_default();
                if !text.trim().is_empty() {
                    messages.push(SessionMessage {
                        id: part_id,
                        timestamp,
                        role,
                        text,
                        kind: "message".to_string(),
                        meta: None,
                        duration_ms: None,
                    });
                }
            }
            Some("reasoning") => {
                let text = string(&part["text"]).unwrap_or_default();
                if !text.trim().is_empty() {
                    messages.push(SessionMessage {
                        id: part_id,
                        timestamp,
                        role: "assistant".to_string(),
                        text,
                        kind: "reasoning".to_string(),
                        meta: None,
                        duration_ms: None,
                    });
                }
            }
            Some("tool") => {
                let state = &part["state"];
                let tool = string(&part["tool"]).unwrap_or_else(|| "OpenCode tool".to_string());
                let display = string(&state["title"]).unwrap_or_else(|| tool.clone());
                let status = string(&state["status"]).unwrap_or_else(|| "completed".to_string());
                let call_id = string(&part["callID"]).unwrap_or_else(|| part_id.clone());
                let output = string(&state["output"])
                    .or_else(|| string(&state["error"]))
                    .unwrap_or_default();
                messages.push(SessionMessage {
                    id: part_id,
                    timestamp,
                    role: "assistant".to_string(),
                    text: output.clone(),
                    kind: "tool".to_string(),
                    meta: Some(json!({
                        "call_id":call_id,
                        "tool":tool,
                        "display":display,
                        "status":status,
                        "input":state.get("input"),
                        "output":output,
                        "raw":part,
                    })),
                    duration_ms: None,
                });
            }
            Some("patch") => {
                let changes = part["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|path| json!({"path":path,"kind":"edit"}))
                    .collect::<Vec<_>>();
                if !changes.is_empty() {
                    messages.push(SessionMessage {
                        id: part_id,
                        timestamp,
                        role: "assistant".to_string(),
                        text: String::new(),
                        kind: "file_change".to_string(),
                        meta: Some(json!({"changes":changes,"raw":part})),
                        duration_ms: None,
                    });
                }
            }
            _ => {
                let _ = message_id;
            }
        }
        if let Some(turn) = opencode_turn_marker(&message_data, &message_id, message_time)
            .filter(|turn| after.is_none_or(|cursor| turn.timestamp.as_str() >= cursor))
        {
            pending_turn = Some(turn);
        }
        if messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    messages.extend(pending_turn);
    Ok(messages)
}

/// The turn marker for an assistant message that stopped for good.
///
/// OpenCode records when each assistant step finished and why, so unlike the
/// other file-backed harnesses it can report both the boundary and the time the
/// turn took.
fn opencode_turn_marker(
    message_data: &Value,
    message_id: &str,
    message_time: i64,
) -> Option<SessionMessage> {
    if message_data["role"].as_str() != Some("assistant") {
        return None;
    }
    let completed = message_data["time"]["completed"].as_i64()?;
    if message_data["finish"].as_str() == Some(OPENCODE_MID_TURN_FINISH) {
        return None;
    }
    let created = message_data["time"]["created"]
        .as_i64()
        .unwrap_or(message_time);
    Some(SessionMessage {
        id: format!("{message_id}:turn"),
        timestamp: unix_millis_rfc3339(completed),
        role: "assistant".to_string(),
        text: String::new(),
        kind: "turn_completed".to_string(),
        meta: string(&message_data["finish"]).map(|finish| json!({ "stop_reason": finish })),
        duration_ms: Some((completed - created).max(0)),
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use uuid::Uuid;

    use super::*;
    use crate::sessions::test_project;

    #[test]
    fn indexes_and_reads_opencode_database_sessions() {
        let root = std::env::temp_dir().join(format!("codesk-opencode-{}", Uuid::new_v4()));
        let project_path = root.join("repo");
        fs::create_dir_all(&project_path).unwrap();
        let database = root.join("opencode.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    time_archived INTEGER
                );
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    data TEXT NOT NULL
                );",
            )
            .unwrap();
        let cwd = project_path.to_string_lossy().into_owned();
        connection
            .execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                params![
                    "ses_opencode",
                    cwd,
                    "Inspect OpenCode support",
                    1_786_840_000_000_i64,
                    1_786_840_003_000_i64
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
                params![
                    "msg_user",
                    "ses_opencode",
                    1_786_840_000_000_i64,
                    json!({"role":"user"}).to_string()
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
                params![
                    "msg_assistant",
                    "ses_opencode",
                    1_786_840_001_000_i64,
                    json!({"role":"assistant"}).to_string()
                ],
            )
            .unwrap();
        let parts = [
            (
                "part_user",
                "msg_user",
                1_786_840_000_100_i64,
                json!({"type":"text","text":"Please inspect OpenCode"}),
            ),
            (
                "part_reasoning",
                "msg_assistant",
                1_786_840_001_100_i64,
                json!({"type":"reasoning","text":"Checking the adapter"}),
            ),
            (
                "part_tool",
                "msg_assistant",
                1_786_840_002_000_i64,
                json!({"type":"tool","tool":"read","callID":"call_1","state":{"status":"completed","title":"Read package.json","input":{"filePath":"package.json"},"output":"{\"name\":\"codesk\"}"}}),
            ),
            (
                "part_patch",
                "msg_assistant",
                1_786_840_002_500_i64,
                json!({"type":"patch","files":["src/App.tsx"]}),
            ),
            (
                "part_text",
                "msg_assistant",
                1_786_840_003_000_i64,
                json!({"type":"text","text":"OpenCode is supported."}),
            ),
        ];
        for (id, message_id, time_created, data) in parts {
            connection
                .execute(
                    "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        id,
                        message_id,
                        "ses_opencode",
                        time_created,
                        data.to_string()
                    ],
                )
                .unwrap();
        }
        drop(connection);

        let project = test_project(&project_path);
        let indexed = index_opencode_database(&project, &database, 10).unwrap();
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].provider, "opencode");
        assert_eq!(indexed[0].native_session_id, "ses_opencode");
        assert_eq!(indexed[0].title, "Inspect OpenCode support");

        let connection = readonly_database(&database).unwrap();
        let messages = opencode_history_messages(&connection, "ses_opencode", None).unwrap();
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text, "Please inspect OpenCode");
        assert!(messages.iter().any(|message| message.kind == "reasoning"));
        assert!(messages.iter().any(|message| {
            message.kind == "tool"
                && message
                    .meta
                    .as_ref()
                    .is_some_and(|meta| meta["display"] == "Read package.json")
        }));
        assert!(messages.iter().any(|message| message.kind == "file_change"));
        assert!(
            messages
                .iter()
                .any(|message| message.text == "OpenCode is supported.")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
