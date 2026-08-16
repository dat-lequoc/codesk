use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result};
#[cfg(test)]
use rusqlite::params_from_iter;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::model::{DiscoveredAgent, Project, ProviderSession, SessionMessage};

const MAX_SESSIONS_PER_PROVIDER: usize = 50;
const MAX_CODEX_CANDIDATES: usize = 1500;
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_INDEX_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_STREAM_BYTES: u64 = 256 * 1024;
const MAX_MESSAGES: usize = 4000;
const MAX_STATUS_BYTES: u64 = 256 * 1024;

pub async fn list(
    project: &Project,
    agents: &[DiscoveredAgent],
    limit: Option<usize>,
) -> Result<Vec<ProviderSession>> {
    let project = project.clone();
    let agents = agents.to_vec();
    tokio::task::spawn_blocking(move || list_sync(&project, &agents, limit)).await?
}

pub async fn messages(
    project: &Project,
    provider: &str,
    native_session_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let project = project.clone();
    let provider = provider.to_string();
    let native_session_id = native_session_id.to_string();
    let after = after.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        if provider == "codex" {
            return codex_messages_for_project(&project, &native_session_id, after.as_deref());
        }
        let path = source_path(&project, &provider, &native_session_id)?;
        parse_messages(&path, &provider, after.as_deref())
    })
    .await?
}

fn list_sync(
    project: &Project,
    agents: &[DiscoveredAgent],
    limit: Option<usize>,
) -> Result<Vec<ProviderSession>> {
    let session_limit = limit.unwrap_or(MAX_SESSIONS_PER_PROVIDER).clamp(1, 150);
    let mut result = Vec::new();
    result.extend(index_pi(project, session_limit)?);
    result.extend(index_codex(project, session_limit)?);
    result.extend(index_claude(project, session_limit)?);
    result.extend(index_kiro(project, session_limit)?);
    result.extend(index_dsh(project, session_limit)?);
    result.extend(index_agy(project, session_limit)?);
    let mut seen = HashSet::new();
    result.retain(|session| {
        seen.insert((session.provider.clone(), session.native_session_id.clone()))
    });

    for agent in agents.iter().filter(|agent| {
        agent.managed_run_id.is_none()
            && agent
                .cwd
                .as_deref()
                .is_some_and(|cwd| cwd_matches(cwd, &project.path))
    }) {
        let native_id = agent.native_session_id.clone().or_else(|| {
            unique_active_session_id(project, &agent.provider, &result)
                .ok()
                .flatten()
        });
        let Some(native_id) = native_id.as_deref() else {
            continue;
        };
        let Some(session) = result
            .iter_mut()
            .find(|item| item.provider == agent.provider && item.native_session_id == native_id)
        else {
            continue;
        };
        session.pid = Some(agent.pid);
        session.input_available = agent.tmux_pane.is_some();
        session.input_transport = agent.tmux_pane.as_ref().map(|_| "tmux".to_string());
        if agent
            .transcript_path
            .as_deref()
            .is_some_and(|path| transcript_turn_active(Path::new(path), &agent.provider))
        {
            session.status = "running".to_string();
        }
    }
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    result.truncate(session_limit);
    Ok(result)
}

fn unique_active_session_id(
    project: &Project,
    provider: &str,
    indexed: &[ProviderSession],
) -> Result<Option<String>> {
    let mut candidates = match provider {
        "pi" => jsonl_files(
            &home_dir().join(".pi/agent/sessions").join(format!(
                "--{}--",
                project.path.trim_matches('/').replace('/', "-")
            )),
            false,
        )?,
        "claude" => jsonl_files(
            &home_dir().join(".claude/projects").join(format!(
                "-{}",
                project.path.trim_start_matches('/').replace('/', "-")
            )),
            false,
        )?,
        _ => return Ok(None),
    };
    sort_recent(&mut candidates);
    candidates.truncate(12);
    let active = candidates
        .into_iter()
        .filter(|path| transcript_turn_active(path, provider))
        .filter_map(|path| index_file(project, provider, &path).ok().flatten())
        .filter(|session| {
            indexed.iter().any(|item| {
                item.provider == provider && item.native_session_id == session.native_session_id
            })
        })
        .map(|session| session.native_session_id)
        .collect::<Vec<_>>();
    Ok((active.len() == 1).then(|| active[0].clone()))
}

pub(crate) fn transcript_turn_active(path: &Path, provider: &str) -> bool {
    if provider == "dsh" {
        return dsh_values(path, MAX_TRANSCRIPT_BYTES)
            .map(|values| {
                values
                    .into_iter()
                    .fold(false, |active, value| match value["type"].as_str() {
                        Some("turn/start") => true,
                        Some("turn/end") => false,
                        _ => active,
                    })
            })
            .unwrap_or(false);
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let start = metadata.len().saturating_sub(MAX_STATUS_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut reader = BufReader::new(file.take(MAX_STATUS_BYTES));
    if start > 0 {
        let mut partial = String::new();
        let _ = reader.read_line(&mut partial);
    }
    let mut active = false;
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match provider {
            "codex" => {
                let event = string(&value["payload"]["type"]);
                if value["type"] == "event_msg"
                    && matches!(event.as_deref(), Some("task_complete" | "turn_aborted"))
                {
                    active = false;
                } else if value["type"] == "event_msg" && event.as_deref() == Some("task_started")
                    || value["type"] == "response_item"
                        && value["payload"]["type"] == "message"
                        && value["payload"]["role"] == "user"
                {
                    active = true;
                }
            }
            "pi" => {
                if value["type"] != "message" {
                    continue;
                }
                let role = string(&value["message"]["role"]).unwrap_or_default();
                if role == "user" || role == "toolResult" {
                    active = true;
                } else if role == "assistant" {
                    let reason = string(&value["message"]["stopReason"])
                        .or_else(|| string(&value["message"]["rawStopReason"]));
                    active = !matches!(reason.as_deref(), Some("stop" | "end_turn" | "completed"));
                }
            }
            "claude" => {
                if value["type"] == "user" {
                    active = true;
                } else if value["type"] == "assistant" {
                    let reason = string(&value["message"]["stop_reason"]);
                    active = !matches!(reason.as_deref(), Some("end_turn" | "stop_sequence"));
                } else if value["type"] == "system" && value["subtype"] == "turn_duration" {
                    active = false;
                }
            }
            "kiro" => match value["kind"].as_str() {
                Some("Prompt") | Some("ToolResults") => active = true,
                Some("AssistantMessage") => active = false,
                _ => {}
            },
            "agy" => {
                let source = value["source"].as_str().unwrap_or_default();
                let kind = value["type"].as_str().unwrap_or_default();
                let status = value["status"].as_str().unwrap_or_default();
                if source == "USER_EXPLICIT" && kind == "USER_INPUT" {
                    active = true;
                } else if source == "MODEL"
                    && kind == "PLANNER_RESPONSE"
                    && status == "DONE"
                    && value["content"]
                        .as_str()
                        .is_some_and(|content| !content.trim().is_empty())
                {
                    active = false;
                }
            }
            _ => {}
        }
    }
    active
}

fn cwd_matches(cwd: &str, project_path: &str) -> bool {
    Path::new(cwd) == Path::new(project_path)
}

fn index_pi(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let directory = home_dir().join(".pi/agent/sessions").join(format!(
        "--{}--",
        project.path.trim_matches('/').replace('/', "-")
    ));
    index_directory(project, "pi", &directory, limit)
}

fn index_claude(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let directory = home_dir().join(".claude/projects").join(format!(
        "-{}",
        project.path.trim_start_matches('/').replace('/', "-")
    ));
    index_directory(project, "claude", &directory, limit)
}

fn index_kiro(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let directory = home_dir().join(".kiro/sessions/cli");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = fs::read_dir(directory)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    sort_recent(&mut files);
    files.truncate(limit);
    files
        .into_iter()
        .filter_map(|path| index_kiro_file(project, &path).transpose())
        .collect()
}

fn index_kiro_file(project: &Project, path: &Path) -> Result<Option<ProviderSession>> {
    let metadata = fs::metadata(path)?;
    let bytes = fs::read(path)?;
    let Ok(value) =
        serde_json::from_slice::<Value>(&bytes[..bytes.len().min(MAX_INDEX_BYTES as usize)])
    else {
        return Ok(None);
    };
    let cwd = string(&value["cwd"]).unwrap_or_default();
    if cwd.is_empty() || !cwd_matches(&cwd, &project.path) {
        return Ok(None);
    }
    let native_id = string(&value["session_id"])
        .or_else(|| string(&value["sessionId"]))
        .unwrap_or_default();
    let title = truncate_title(&string(&value["title"]).unwrap_or_default());
    if native_id.is_empty() || title.is_empty() {
        return Ok(None);
    }
    let modified_at = modified_rfc3339(&metadata);
    let created_at = string(&value["created_at"]).unwrap_or_else(|| modified_at.clone());
    let updated_at = string(&value["updated_at"]).unwrap_or_else(|| modified_at.clone());
    Ok(Some(ProviderSession {
        id: format!("kiro:{native_id}"),
        provider: "kiro".to_string(),
        native_session_id: native_id,
        project_id: project.id.clone(),
        cwd,
        title,
        created_at,
        updated_at,
        status: "idle".to_string(),
        pid: None,
        input_available: false,
        input_transport: None,
    }))
}

fn index_dsh(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
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

fn dsh_project_directory(home: &Path, project_path: &str) -> PathBuf {
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

fn dsh_session_files(home: &Path) -> Result<Vec<PathBuf>> {
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
        input_available: false,
        input_transport: None,
    }))
}

fn index_agy(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
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
                            input_available: false,
                            input_transport: None,
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
                    input_available: false,
                    input_transport: None,
                });
                seen.insert(native_id.to_string());
            }
        }
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions.truncate(limit);
    Ok(sessions)
}

fn agy_transcript_path(home: &Path, native_id: &str) -> PathBuf {
    home.join(".gemini/antigravity-cli/brain")
        .join(native_id)
        .join(".system_generated/logs/transcript.jsonl")
}

fn agy_workspace_paths(value: &str) -> Vec<String> {
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

fn index_directory(
    project: &Project,
    provider: &str,
    directory: &Path,
    limit: usize,
) -> Result<Vec<ProviderSession>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = jsonl_files(directory, false)?;
    sort_recent(&mut files);
    files.truncate(limit);
    Ok(files
        .into_iter()
        .filter_map(|path| index_file(project, provider, &path).transpose())
        .collect::<Result<Vec<_>>>()?)
}

fn index_codex(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let codex_root = home_dir().join(".codex");
    let database_available = newest_numbered_database(&codex_root, "state_").is_some();
    let mut sessions = index_codex_database(project, &codex_root, limit).unwrap_or_default();
    // The state database is Codex's authoritative thread index.  When it has
    // rows for this project, do not fall through to the legacy rollout scan:
    // large homes can contain thousands of multi-megabyte transcripts, and
    // scanning them on every navigation request makes the daemon appear hung.
    // The rollout fallback remains available for installations without a
    // usable database (or projects that predate the index entirely).
    if sessions.len() >= limit || (database_available && !sessions.is_empty()) {
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
            input_available: false,
            input_transport: None,
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

fn codex_messages_for_project(
    project: &Project,
    native_session_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let codex_root = home_dir().join(".codex");
    if let Some(path) = codex_rollout_path(&codex_root, native_session_id)? {
        if path.is_file() && codex_rollout_matches_project(&path, project)? {
            return parse_messages(&path, "codex", after);
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

fn codex_rollout_matches_project(path: &Path, project: &Project) -> Result<bool> {
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
        input_available: false,
        input_transport: None,
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
        if !candidate.is_empty() && title.is_empty() {
            *title = candidate;
        }
    }
}

fn source_path(project: &Project, provider: &str, native_id: &str) -> Result<PathBuf> {
    source_path_from_home(&home_dir(), project, provider, native_id)
}

fn source_path_from_home(
    home: &Path,
    project: &Project,
    provider: &str,
    native_id: &str,
) -> Result<PathBuf> {
    if provider == "agy" {
        let path = agy_transcript_path(home, native_id);
        anyhow::ensure!(path.is_file(), "provider session file not found");
        let root = home.join(".gemini/antigravity-cli");
        let mut workspaces = Vec::new();
        let summary_db = root.join("conversation_summaries.db");
        if summary_db.is_file() {
            if let Ok(connection) = readonly_database(&summary_db) {
                if let Ok(value) = connection.query_row(
                    "SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?1",
                    [native_id],
                    |row| row.get::<_, String>(0),
                ) {
                    workspaces.extend(agy_workspace_paths(&value));
                }
            }
        }
        let recent_path = root.join("cache/last_conversations.json");
        if recent_path.is_file() {
            if let Ok(value) = serde_json::from_slice::<Value>(&fs::read(&recent_path)?) {
                workspaces.extend(
                    value
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter(|(_, value)| value.as_str() == Some(native_id))
                        .map(|(cwd, _)| cwd.to_string()),
                );
            }
        }
        anyhow::ensure!(
            workspaces.iter().any(|cwd| cwd_matches(cwd, &project.path)),
            "provider session file not found in this project"
        );
        return Ok(path);
    }
    let directory = match provider {
        "pi" => home.join(".pi/agent/sessions").join(format!(
            "--{}--",
            project.path.trim_matches('/').replace('/', "-")
        )),
        "claude" => home.join(".claude/projects").join(format!(
            "-{}",
            project.path.trim_start_matches('/').replace('/', "-")
        )),
        "kiro" => home.join(".kiro/sessions/cli"),
        "dsh" => home.join(".dsh/sessions"),
        _ => anyhow::bail!("unsupported provider"),
    };
    if provider == "claude" {
        let path = directory.join(format!("{native_id}.jsonl"));
        if path.is_file() {
            return Ok(path);
        }
    }
    if provider == "kiro" {
        let path = directory.join(format!("{native_id}.jsonl"));
        if path.is_file() {
            return Ok(path);
        }
    }
    if provider == "dsh" {
        let direct = dsh_project_directory(home, &project.path)
            .join(native_id)
            .join("session.jsonl.zstd");
        let candidates = if direct.is_file() {
            vec![direct]
        } else {
            dsh_session_files(home)?
        };
        for path in candidates {
            if path
                .parent()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                == Some(native_id)
            {
                let values = dsh_values(&path, MAX_INDEX_BYTES)?;
                if values.iter().any(|value| {
                    value["type"] == "session"
                        && string(&value["cwd"]).is_some_and(|cwd| cwd_matches(&cwd, &project.path))
                }) {
                    return Ok(path);
                }
            }
        }
        anyhow::bail!("provider session file not found")
    }
    for entry in fs::read_dir(directory)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem == native_id || stem.ends_with(&format!("_{native_id}")))
        {
            return Ok(path);
        }
    }
    anyhow::bail!("provider session file not found")
}

fn parse_messages(path: &Path, provider: &str, after: Option<&str>) -> Result<Vec<SessionMessage>> {
    if provider == "dsh" {
        return parse_dsh_messages(path, after);
    }
    if provider == "agy" {
        return parse_agy_messages(path, after);
    }
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
    let mut codex_turn_started: Option<String> = None;
    for (line_number, line) in reader.lines().map_while(Result::ok).enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if provider == "kiro" {
            for item in parse_kiro_history_line(&value, line_number) {
                if after.is_none_or(|cursor| item.timestamp.as_str() >= cursor) {
                    messages.push(item);
                }
            }
            if messages.len() >= MAX_MESSAGES {
                break;
            }
            continue;
        }
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
            if after.is_none_or(|cursor| item.timestamp.as_str() >= cursor) {
                messages.push(item);
            }
        }
        if provider == "codex" {
            parse_codex_history_event(
                &value,
                line_number,
                &mut messages,
                after,
                &mut codex_turn_started,
            );
        }
        if messages.len() >= MAX_MESSAGES {
            break;
        }
    }
    Ok(messages)
}

fn parse_kiro_history_line(value: &Value, line_number: usize) -> Vec<SessionMessage> {
    let kind = value["kind"].as_str().unwrap_or_default();
    let data = &value["data"];
    let timestamp = data["meta"]["timestamp"]
        .as_i64()
        .map(unix_seconds_rfc3339)
        .unwrap_or_default();
    let mut result = Vec::new();
    match kind {
        "Prompt" => {
            let text = data["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["data"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                result.push(SessionMessage {
                    id: string(&data["message_id"]).unwrap_or_else(|| line_number.to_string()),
                    timestamp,
                    role: "user".to_string(),
                    text,
                    kind: "message".to_string(),
                    meta: None,
                    duration_ms: None,
                });
            }
        }
        "AssistantMessage" => {
            let message_id = string(&data["message_id"]).unwrap_or_else(|| line_number.to_string());
            for (index, item) in data["content"].as_array().into_iter().flatten().enumerate() {
                match item["kind"].as_str() {
                    Some("text") => {
                        if let Some(text) =
                            item["data"].as_str().filter(|text| !text.trim().is_empty())
                        {
                            result.push(SessionMessage {
                                id: format!("{message_id}:text:{index}"),
                                timestamp: timestamp.clone(),
                                role: "assistant".to_string(),
                                text: text.to_string(),
                                kind: "message".to_string(),
                                meta: None,
                                duration_ms: None,
                            });
                        }
                    }
                    Some("toolUse") => {
                        let tool = string(&item["name"]).unwrap_or_else(|| "Kiro tool".to_string());
                        result.push(SessionMessage {
                            id: format!("{message_id}:tool:{index}"),
                            timestamp: timestamp.clone(),
                            role: "assistant".to_string(),
                            text: String::new(),
                            kind: "tool".to_string(),
                            meta: Some(json!({
                                "tool":tool,
                                "display":item["input"]["__tool_use_purpose"],
                                "command":item["input"],
                                "status":"completed",
                            })),
                            duration_ms: None,
                        });
                    }
                    _ => {}
                }
            }
        }
        "ToolResults" => {
            let text = data["content"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|item| item["content"].as_array().into_iter().flatten())
                .filter_map(|item| item["data"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            result.push(SessionMessage {
                id: string(&data["message_id"]).unwrap_or_else(|| line_number.to_string()),
                timestamp,
                role: "assistant".to_string(),
                text,
                kind: "tool_output".to_string(),
                meta: Some(json!({"tool":"Kiro tool result","status":"completed"})),
                duration_ms: None,
            });
        }
        _ => {}
    }
    result
}

fn parse_agy_messages(path: &Path, after: Option<&str>) -> Result<Vec<SessionMessage>> {
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

fn dsh_values(path: &Path, max_bytes: u64) -> Result<Vec<Value>> {
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

fn parse_dsh_messages(path: &Path, after: Option<&str>) -> Result<Vec<SessionMessage>> {
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
        kind: "message".to_string(),
        meta: None,
        duration_ms: None,
    })
}

fn parse_codex_history_event(
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

fn duration_between(start: &str, end: &str) -> Option<i64> {
    let start = chrono::DateTime::parse_from_rfc3339(start).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(end).ok()?;
    Some((end - start).num_milliseconds().max(0))
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
    use std::io::Write;

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
    fn project_scope_requires_the_exact_working_directory() {
        assert!(cwd_matches("/srv/project", "/srv/project"));
        assert!(cwd_matches("/srv/project/", "/srv/project"));
        assert!(!cwd_matches("/srv/project/subfolder", "/srv/project"));
        assert!(!cwd_matches("/srv/project-other", "/srv/project"));
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
    fn parses_kiro_prompt_assistant_and_tool_history() {
        let prompt = parse_kiro_history_line(
            &json!({
                "kind":"Prompt",
                "data":{
                    "message_id":"prompt-1",
                    "content":[{"kind":"text","data":"Read package.json"}],
                    "meta":{"timestamp":1786837344_i64}
                }
            }),
            0,
        );
        assert_eq!(prompt.len(), 1);
        assert_eq!(prompt[0].role, "user");
        assert_eq!(prompt[0].text, "Read package.json");

        let assistant = parse_kiro_history_line(
            &json!({
                "kind":"AssistantMessage",
                "data":{
                    "message_id":"assistant-1",
                    "content":[
                        {"kind":"text","data":"codesk"},
                        {"kind":"toolUse","name":"read","input":{"__tool_use_purpose":"Read package.json"}}
                    ],
                    "meta":{"timestamp":1786837348_i64}
                }
            }),
            1,
        );
        assert_eq!(assistant.len(), 2);
        assert_eq!(assistant[0].role, "assistant");
        assert_eq!(assistant[0].text, "codesk");
        assert_eq!(assistant[1].kind, "tool");
        assert_eq!(assistant[1].meta.as_ref().unwrap()["tool"], "read");

        let result = parse_kiro_history_line(
            &json!({
                "kind":"ToolResults",
                "data":{
                    "message_id":"tool-result-1",
                    "content":[{"content":[{"kind":"text","data":"{\"name\":\"codesk\"}"}]}],
                    "meta":{"timestamp":1786837348_i64}
                }
            }),
            2,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, "tool_output");
        assert!(result[0].text.contains("codesk"));
    }

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

    #[test]
    fn indexes_and_resolves_kiro_history_for_project() {
        let home =
            std::env::temp_dir().join(format!("codesk-kiro-history-{}", uuid::Uuid::new_v4()));
        let directory = home.join(".kiro/sessions/cli");
        fs::create_dir_all(&directory).unwrap();
        let native_id = "11111111-1111-4111-8111-111111111111";
        let metadata_path = directory.join(format!("{native_id}.json"));
        let transcript_path = directory.join(format!("{native_id}.jsonl"));
        let project_path = home.join("repo");
        fs::create_dir_all(&project_path).unwrap();
        fs::write(
            &metadata_path,
            json!({
                "session_id":native_id,
                "cwd":project_path,
                "created_at":"2026-08-16T08:00:00Z",
                "updated_at":"2026-08-16T08:01:00Z",
                "title":"Kiro test session"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(&transcript_path, "").unwrap();

        let session = index_kiro_file(&test_project(&project_path), &metadata_path)
            .unwrap()
            .unwrap();
        assert_eq!(session.provider, "kiro");
        assert_eq!(session.native_session_id, native_id);
        assert_eq!(
            source_path_from_home(&home, &test_project(&project_path), "kiro", native_id).unwrap(),
            transcript_path
        );
        fs::remove_dir_all(home).unwrap();
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
    fn reads_newest_messages_from_large_transcript_tail() {
        let root =
            std::env::temp_dir().join(format!("codesk-message-tail-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let old = serde_json::json!({
            "timestamp":"2026-08-13T20:00:00Z", "type":"message", "id":"old",
            "message":{"role":"user","content":[{"type":"text","text":"Old request"}]}
        });
        let padding = serde_json::json!({
            "type":"padding", "value":"x".repeat(MAX_TRANSCRIPT_BYTES as usize + 1024)
        });
        let newest = serde_json::json!({
            "timestamp":"2026-08-13T21:00:00Z", "type":"message", "id":"newest",
            "message":{"role":"assistant","content":[{"type":"text","text":"Newest answer"}]}
        });
        fs::write(&path, format!("{old}\n{padding}\n{newest}\n")).unwrap();

        let messages = parse_messages(&path, "pi", None).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "newest");
        assert_eq!(messages[0].text, "Newest answer");

        let messages = parse_messages(&path, "pi", Some("2026-08-13T20:30:00Z")).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "newest");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_pi_and_claude_transcripts_by_native_id() {
        let home =
            std::env::temp_dir().join(format!("codesk-source-path-{}", uuid::Uuid::new_v4()));
        let project_path = PathBuf::from("/home/me/thinkling/pi-agi");
        let project = test_project(&project_path);
        let pi_dir = home
            .join(".pi/agent/sessions")
            .join("--home-me-thinkling-pi-agi--");
        let claude_dir = home
            .join(".claude/projects")
            .join("-home-me-thinkling-pi-agi");
        fs::create_dir_all(&pi_dir).unwrap();
        fs::create_dir_all(&claude_dir).unwrap();
        let pi_path = pi_dir.join("2026-08-13T200000Z_pi-native.jsonl");
        let claude_path = claude_dir.join("claude-native.jsonl");
        fs::write(&pi_path, "").unwrap();
        fs::write(&claude_path, "").unwrap();

        assert_eq!(
            source_path_from_home(&home, &project, "pi", "pi-native").unwrap(),
            pi_path
        );
        assert_eq!(
            source_path_from_home(&home, &project, "claude", "claude-native").unwrap(),
            claude_path
        );
        fs::remove_dir_all(home).unwrap();
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
            input_available: false,
            input_transport: None,
        }];

        enrich_codex_titles(&root, &mut sessions);

        assert_eq!(sessions[0].title, "First request");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn indexes_first_prompt_even_when_jsonl_has_a_large_tail() {
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

        assert_eq!(indexed.title, "First request");
        assert_eq!(indexed.native_session_id, "pi-session");
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

        let messages = parse_messages(&path, "codex", None).unwrap();
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

    #[test]
    fn compares_rfc3339_activity_across_offsets() {
        assert_eq!(
            latest_rfc3339("2026-08-13T22:00:00+02:00", "2026-08-13T20:01:00Z"),
            "2026-08-13T20:01:00Z"
        );
    }

    #[test]
    fn detects_codex_active_and_completed_turns() {
        let root = std::env::temp_dir().join(format!("codesk-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\"}}\n"
            ),
        )
        .unwrap();
        assert!(transcript_turn_active(&path, "codex"));
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n")
            .unwrap();
        assert!(!transcript_turn_active(&path, "codex"));
        fs::remove_dir_all(root).unwrap();
    }

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

        let messages = parse_messages(&transcript, "agy", None).unwrap();
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
