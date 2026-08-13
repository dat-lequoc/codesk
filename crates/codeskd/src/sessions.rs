use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;

use crate::model::{DiscoveredAgent, Project, ProviderSession, SessionMessage};

const MAX_SESSIONS_PER_PROVIDER: usize = 50;
const MAX_CODEX_CANDIDATES: usize = 1500;
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_INDEX_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MESSAGES: usize = 4000;

pub async fn list(project: &Project, agents: &[DiscoveredAgent]) -> Result<Vec<ProviderSession>> {
    let project = project.clone();
    let agents = agents.to_vec();
    tokio::task::spawn_blocking(move || list_sync(&project, &agents)).await?
}

pub async fn messages(
    project: &Project,
    provider: &str,
    native_session_id: &str,
) -> Result<Vec<SessionMessage>> {
    let project = project.clone();
    let provider = provider.to_string();
    let native_session_id = native_session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let sessions = list_sync(&project, &[])?;
        let item = sessions
            .into_iter()
            .find(|item| item.provider == provider && item.native_session_id == native_session_id)
            .context("provider session not found in this project")?;
        if item.provider == "codex" {
            return codex_messages(&item.native_session_id);
        }
        let path = source_path(&project, &item.provider, &item.native_session_id)?;
        parse_messages(&path, &item.provider)
    })
    .await?
}

fn list_sync(project: &Project, agents: &[DiscoveredAgent]) -> Result<Vec<ProviderSession>> {
    let mut result = Vec::new();
    result.extend(index_pi(project)?);
    result.extend(index_codex(project)?);
    result.extend(index_claude(project)?);
    let mut seen = HashSet::new();
    result.retain(|session| {
        seen.insert((session.provider.clone(), session.native_session_id.clone()))
    });

    for provider in ["codex", "pi", "claude"] {
        let live = agents.iter().find(|agent| {
            agent.provider == provider
                && agent.managed_run_id.is_none()
                && agent
                    .cwd
                    .as_deref()
                    .is_some_and(|cwd| cwd_matches(cwd, &project.path))
        });
        if let Some(agent) = live {
            if let Some(newest) = result
                .iter_mut()
                .filter(|item| item.provider == provider)
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at))
            {
                newest.status = "running".to_string();
                newest.pid = Some(agent.pid);
            }
        }
    }
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(result)
}

fn cwd_matches(cwd: &str, project_path: &str) -> bool {
    cwd == project_path
        || cwd
            .strip_prefix(project_path)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn index_pi(project: &Project) -> Result<Vec<ProviderSession>> {
    let directory = home_dir().join(".pi/agent/sessions").join(format!(
        "--{}--",
        project.path.trim_matches('/').replace('/', "-")
    ));
    index_directory(project, "pi", &directory)
}

fn index_claude(project: &Project) -> Result<Vec<ProviderSession>> {
    let directory = home_dir().join(".claude/projects").join(format!(
        "-{}",
        project.path.trim_start_matches('/').replace('/', "-")
    ));
    index_directory(project, "claude", &directory)
}

fn index_directory(
    project: &Project,
    provider: &str,
    directory: &Path,
) -> Result<Vec<ProviderSession>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = jsonl_files(directory, false)?;
    sort_recent(&mut files);
    files.truncate(MAX_SESSIONS_PER_PROVIDER);
    Ok(files
        .into_iter()
        .filter_map(|path| index_file(project, provider, &path).transpose())
        .collect::<Result<Vec<_>>>()?)
}

fn index_codex(project: &Project) -> Result<Vec<ProviderSession>> {
    let codex_root = home_dir().join(".codex");
    let mut sessions = index_codex_database(project, &codex_root).unwrap_or_default();
    if sessions.len() >= MAX_SESSIONS_PER_PROVIDER {
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
            if sessions.len() >= MAX_SESSIONS_PER_PROVIDER {
                break;
            }
        }
    }
    Ok(sessions)
}

fn index_codex_database(project: &Project, codex_root: &Path) -> Result<Vec<ProviderSession>> {
    let Some(path) = newest_numbered_database(codex_root, "state_") else {
        return Ok(Vec::new());
    };
    let connection = readonly_database(&path)?;
    let mut statement = connection.prepare(
        "SELECT id, cwd, title, first_user_message, created_at, updated_at
         FROM threads
         WHERE archived = 0
           AND (cwd = ?1 OR substr(cwd, 1, length(?1) + 1) = ?1 || '/')
         ORDER BY updated_at DESC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(
        params![project.path, MAX_SESSIONS_PER_PROVIDER as i64],
        |row| {
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
            })
        },
    )?;
    let mut sessions = rows.filter_map(|row| row.ok()).collect::<Vec<_>>();
    enrich_codex_titles(codex_root, &mut sessions);
    sessions.retain(|session| !session.title.is_empty());
    Ok(sessions)
}

fn enrich_codex_titles(codex_root: &Path, sessions: &mut [ProviderSession]) {
    let Some(path) = newest_numbered_database(codex_root, "thread_history_") else {
        return;
    };
    let Ok(connection) = readonly_database(&path) else {
        return;
    };
    let Ok(mut statement) = connection.prepare(
        "SELECT item_json
         FROM thread_items
         WHERE thread_id = ?1 AND item_type = 'userMessage'
         ORDER BY rollout_ordinal DESC, created_at_ms DESC
         LIMIT 20",
    ) else {
        return;
    };
    for session in sessions {
        let Ok(rows) =
            statement.query_map([&session.native_session_id], |row| row.get::<_, String>(0))
        else {
            continue;
        };
        for row in rows.flatten() {
            let Ok(value) = serde_json::from_str::<Value>(&row) else {
                continue;
            };
            let title = meaningful_user_text(text_content(&value["content"]));
            if !title.is_empty() {
                session.title = truncate_title(&title);
                break;
            }
        }
    }
}

fn codex_messages(native_session_id: &str) -> Result<Vec<SessionMessage>> {
    let codex_root = home_dir().join(".codex");
    if let Some(path) = codex_rollout_path(&codex_root, native_session_id)? {
        if path.is_file() {
            return parse_messages(&path, "codex");
        }
    }
    codex_history_messages(&codex_root, native_session_id)
}

fn codex_rollout_path(codex_root: &Path, native_session_id: &str) -> Result<Option<PathBuf>> {
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
            messages.push(item);
        }
    }
    Ok(messages)
}

fn readonly_database(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {} read-only", path.display()))
}

fn newest_numbered_database(root: &Path, prefix: &str) -> Option<PathBuf> {
    let mut paths = fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix) && name.ends_with(".sqlite"))
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| fs::metadata(path).and_then(|value| value.modified()).ok());
    paths.pop()
}

fn index_file(project: &Project, provider: &str, path: &Path) -> Result<Option<ProviderSession>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let metadata = file.metadata()?;
    let mut native_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string();
    let mut cwd = String::new();
    let mut created_at = String::new();
    let modified_at = modified_rfc3339(&metadata);
    let mut latest_event_at = String::new();
    let mut title = String::new();
    scan_index_reader(
        BufReader::new((&mut file).take(MAX_INDEX_BYTES)),
        provider,
        &mut native_id,
        &mut cwd,
        &mut created_at,
        &mut latest_event_at,
        &mut title,
    );
    if !cwd.is_empty() && !cwd_matches(&cwd, &project.path) {
        return Ok(None);
    }
    if metadata.len() > MAX_INDEX_BYTES {
        let tail_start = metadata.len().saturating_sub(MAX_INDEX_TAIL_BYTES);
        file.seek(SeekFrom::Start(tail_start))?;
        let mut reader = BufReader::new(file.take(MAX_INDEX_TAIL_BYTES));
        if tail_start > 0 {
            let mut partial_line = String::new();
            let _ = reader.read_line(&mut partial_line);
        }
        scan_index_reader(
            reader,
            provider,
            &mut native_id,
            &mut cwd,
            &mut created_at,
            &mut latest_event_at,
            &mut title,
        );
    }
    if cwd.is_empty() || !cwd_matches(&cwd, &project.path) {
        return Ok(None);
    }
    if created_at.is_empty() {
        created_at = modified_at.clone();
    }
    if title.is_empty() {
        return Ok(None);
    }
    Ok(Some(ProviderSession {
        id: format!("{provider}:{native_id}"),
        provider: provider.to_string(),
        native_session_id: native_id,
        project_id: project.id.clone(),
        cwd,
        title: truncate_title(&title),
        created_at,
        updated_at: latest_rfc3339(&modified_at, &latest_event_at),
        status: "idle".to_string(),
        pid: None,
    }))
}

fn scan_index_reader<R: BufRead>(
    reader: R,
    provider: &str,
    native_id: &mut String,
    cwd: &mut String,
    created_at: &mut String,
    latest_event_at: &mut String,
    title: &mut String,
) {
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(timestamp) = string(&value["timestamp"]) {
            *latest_event_at = latest_rfc3339(latest_event_at, &timestamp);
        }
        let candidate = match provider {
            "pi" => {
                if value["type"] == "session" {
                    *native_id = string(&value["id"]).unwrap_or_else(|| native_id.clone());
                    *cwd = string(&value["cwd"]).unwrap_or_default();
                    *created_at = string(&value["timestamp"]).unwrap_or_default();
                    String::new()
                } else if value["type"] == "message" && value["message"]["role"] == "user" {
                    meaningful_user_text(text_content(&value["message"]["content"]))
                } else {
                    String::new()
                }
            }
            "claude" => {
                *cwd = string(&value["cwd"]).unwrap_or_else(|| cwd.clone());
                *native_id = string(&value["sessionId"]).unwrap_or_else(|| native_id.clone());
                if created_at.is_empty() {
                    *created_at = string(&value["timestamp"]).unwrap_or_default();
                }
                if value["type"] == "user" {
                    meaningful_user_text(claude_user_text(&value["message"]["content"]))
                } else {
                    String::new()
                }
            }
            "codex" => {
                if value["type"] == "session_meta" {
                    *native_id = string(&value["payload"]["session_id"])
                        .unwrap_or_else(|| native_id.clone());
                    *cwd = string(&value["payload"]["cwd"]).unwrap_or_default();
                    *created_at = string(&value["timestamp"]).unwrap_or_default();
                    String::new()
                } else if value["type"] == "response_item"
                    && value["payload"]["type"] == "message"
                    && value["payload"]["role"] == "user"
                {
                    meaningful_user_text(text_content(&value["payload"]["content"]))
                } else {
                    String::new()
                }
            }
            _ => String::new(),
        };
        if !candidate.is_empty() {
            *title = candidate;
        }
    }
}

fn source_path(project: &Project, provider: &str, native_id: &str) -> Result<PathBuf> {
    let candidates = match provider {
        "pi" => {
            let directory = home_dir().join(".pi/agent/sessions").join(format!(
                "--{}--",
                project.path.trim_matches('/').replace('/', "-")
            ));
            jsonl_files(&directory, false)?
        }
        "claude" => {
            let directory = home_dir().join(".claude/projects").join(format!(
                "-{}",
                project.path.trim_start_matches('/').replace('/', "-")
            ));
            jsonl_files(&directory, false)?
        }
        "codex" => jsonl_files(&home_dir().join(".codex/sessions"), true)?,
        _ => anyhow::bail!("unsupported provider"),
    };
    for path in candidates {
        if let Some(item) = index_file(project, provider, &path)? {
            if item.native_session_id == native_id {
                return Ok(path);
            }
        }
    }
    anyhow::bail!("provider session file not found")
}

fn parse_messages(path: &Path, provider: &str) -> Result<Vec<SessionMessage>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file).take(MAX_TRANSCRIPT_BYTES);
    let mut messages = Vec::new();
    for (line_number, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let parsed = match provider {
            "pi" if value["type"] == "message" => {
                let role = string(&value["message"]["role"]).unwrap_or_default();
                if role != "user" && role != "assistant" {
                    None
                } else {
                    message(
                        &value,
                        line_number,
                        &role,
                        text_content(&value["message"]["content"]),
                    )
                }
            }
            "claude" if value["type"] == "user" || value["type"] == "assistant" => {
                let role = string(&value["message"]["role"])
                    .unwrap_or_else(|| string(&value["type"]).unwrap_or_default());
                let text = if role == "user" {
                    claude_user_text(&value["message"]["content"])
                } else {
                    text_content(&value["message"]["content"])
                };
                message(&value, line_number, &role, text)
            }
            "codex"
                if value["type"] == "response_item" && value["payload"]["type"] == "message" =>
            {
                let role = string(&value["payload"]["role"]).unwrap_or_default();
                if role != "user" && role != "assistant" {
                    None
                } else {
                    message(
                        &value,
                        line_number,
                        &role,
                        text_content(&value["payload"]["content"]),
                    )
                }
            }
            _ => None,
        };
        if let Some(item) = parsed {
            messages.push(item);
        }
        if messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    Ok(messages)
}

fn message(value: &Value, line_number: usize, role: &str, text: String) -> Option<SessionMessage> {
    let text = if role == "user" {
        meaningful_user_text(text)
    } else {
        text.trim().to_string()
    };
    if text.is_empty() {
        return None;
    }
    Some(SessionMessage {
        id: string(&value["id"])
            .or_else(|| string(&value["uuid"]))
            .or_else(|| string(&value["payload"]["id"]))
            .unwrap_or_else(|| line_number.to_string()),
        timestamp: string(&value["timestamp"]).unwrap_or_default(),
        role: role.to_string(),
        text,
    })
}

fn text_content(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                if matches!(kind, "text" | "input_text" | "output_text") {
                    item.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn claude_user_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn meaningful_user_text(text: String) -> String {
    let compact = text
        .lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with('/')
                && !line.starts_with('#')
                && !line.starts_with("<INSTRUCTIONS")
                && !line.starts_with("<environment_context")
                && !line.starts_with("<codex_internal_context")
                && !line.starts_with("<skills_instructions")
                && !line.starts_with("<permissions instructions")
        })
        .collect::<Vec<_>>()
        .join(" ");
    if compact.contains("@/home/") && compact.contains("RTK.md")
        || compact.contains("Continue working toward the active thread goal")
        || compact.starts_with("You are /root")
    {
        String::new()
    } else {
        compact.trim_start_matches(['›', '>', ' ']).to_string()
    }
}

fn truncate_title(title: &str) -> String {
    let compact = title.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(100).collect()
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}
fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn modified_rfc3339(metadata: &fs::Metadata) -> String {
    let millis = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_default()
        .to_rfc3339()
}

fn unix_seconds_rfc3339(seconds: i64) -> String {
    chrono::DateTime::from_timestamp(seconds, 0)
        .unwrap_or_default()
        .to_rfc3339()
}

fn unix_millis_rfc3339(millis: i64) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_default()
        .to_rfc3339()
}

fn latest_rfc3339(left: &str, right: &str) -> String {
    match (
        chrono::DateTime::parse_from_rfc3339(left),
        chrono::DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left_time), Ok(right_time)) if right_time > left_time => right.to_string(),
        (Ok(_), _) => left.to_string(),
        (_, Ok(_)) => right.to_string(),
        _ => left.max(right).to_string(),
    }
}

fn sort_recent(paths: &mut [PathBuf]) {
    paths.sort_by_key(|path| fs::metadata(path).and_then(|value| value.modified()).ok());
    paths.reverse();
}

fn jsonl_files(root: &Path, recursive: bool) -> Result<Vec<PathBuf>> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && recursive {
                directories.push(path);
            } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                files.push(path);
            }
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_project(path: &Path) -> Project {
        Project {
            id: "project-1".into(),
            name: "project".into(),
            path: path.to_string_lossy().into_owned(),
            repo_root: None,
            created_at: "2026-08-13T00:00:00Z".into(),
        }
    }

    #[test]
    fn extracts_only_conversation_text() {
        let content = serde_json::json!([
            {"type":"thinking","thinking":"secret"},
            {"type":"text","text":"visible"},
            {"type":"tool_use","name":"bash"}
        ]);
        assert_eq!(text_content(&content), "visible");
    }

    #[test]
    fn skips_command_noise_for_titles() {
        assert_eq!(
            meaningful_user_text("/model\n\nBuild the app".into()),
            "Build the app"
        );
    }

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
        drop(connection);

        let sessions = index_codex_database(&test_project(&project_path), &root).unwrap();
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

        let messages = codex_history_messages(&root, "thread-1").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text, "Hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].text, "Hi");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uses_latest_meaningful_codex_history_prompt_as_title() {
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
        }];

        enrich_codex_titles(&root, &mut sessions);

        assert_eq!(sessions[0].title, "Explain this codebase");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn indexes_latest_prompt_from_large_jsonl_tail() {
        let root = std::env::temp_dir().join(format!("codesk-tail-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let project = test_project(&root);
        let path = root.join("session.jsonl");
        let session = serde_json::json!({
            "timestamp":"2026-08-13T20:00:00Z", "type":"session",
            "id":"pi-session", "cwd":root.to_string_lossy()
        });
        let first = serde_json::json!({
            "timestamp":"2026-08-13T20:01:00Z", "type":"message",
            "message":{"role":"user","content":[{"type":"text","text":"First request"}]}
        });
        let last = serde_json::json!({
            "timestamp":"2026-08-13T21:07:27Z", "type":"message",
            "message":{"role":"user","content":[{"type":"text","text":"Explain this codebase"}]}
        });
        let padding =
            serde_json::json!({"type":"padding","value":"x".repeat(MAX_INDEX_BYTES as usize)});
        fs::write(&path, format!("{session}\n{first}\n{padding}\n{last}\n")).unwrap();

        let indexed = index_file(&project, "pi", &path).unwrap().unwrap();

        assert_eq!(indexed.title, "Explain this codebase");
        assert_eq!(indexed.native_session_id, "pi-session");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compares_rfc3339_activity_across_offsets() {
        assert_eq!(
            latest_rfc3339("2026-08-13T22:00:00+02:00", "2026-08-13T20:01:00Z"),
            "2026-08-13T20:01:00Z"
        );
    }
}
