use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::{
    db::Db,
    model::{DiscoveredAgent, Project, ProviderSession, Run, SessionMessage, TmuxControl},
    providers, tmux,
};

mod agy;
mod claude;
mod codex;
mod dsh;
mod kiro;
mod opencode;
mod pi;

pub(crate) use agy::index_agy;
pub(crate) use claude::index_claude;
pub(crate) use codex::{codex_messages_for_project, index_codex};
pub(crate) use dsh::index_dsh;
pub(crate) use kiro::index_kiro;
pub(crate) use opencode::{index_opencode, opencode_messages_for_project};
pub(crate) use pi::index_pi;

use agy::{agy_transcript_path, agy_workspace_paths, parse_agy_messages};
use claude::{claude_project_directories, claude_user_text};
use codex::{codex_rollout_matches_project, codex_rollout_path, parse_codex_history_event};
use dsh::{dsh_project_directory, dsh_session_files, dsh_turn_active, dsh_values, parse_dsh_messages};

const MAX_SESSIONS_PER_PROVIDER: usize = 50;
/// Newest indexed sessions checked when a discovered process has to be matched to
/// a conversation by transcript activity instead of by an open file descriptor.
const ACTIVE_SESSION_SCAN_LIMIT: usize = 12;
/// A live turn keeps writing to its transcript, one record per step. A transcript
/// that stops mid-turn and then goes quiet for longer than this belongs to a
/// conversation nobody is driving any more — interrupted, or closed while a tool
/// call was still pending — and must not compete with the live one for a process.
const ACTIVE_TRANSCRIPT_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_INDEX_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_STREAM_BYTES: u64 = 256 * 1024;
const MAX_MESSAGES: usize = 4000;
const STATUS_SCAN_CHUNK_BYTES: usize = 64 * 1024;
const MAX_STATUS_RECORD_BYTES: usize = 512 * 1024;
const MAX_TURN_ACTIVE_CACHE_ENTRIES: usize = 512;

/// Memoized turn-active answers keyed by transcript path, valid while the file's
/// length and modification time are unchanged.
type TurnActiveCache = HashMap<PathBuf, ((u64, std::time::Duration), bool)>;
static TURN_ACTIVE_CACHE: std::sync::OnceLock<std::sync::Mutex<TurnActiveCache>> =
    std::sync::OnceLock::new();

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
        providers::require(&provider)?.session_messages(
            &project,
            &native_session_id,
            after.as_deref(),
        )
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
    for adapter in providers::all() {
        result.extend(adapter.index_sessions(project, session_limit)?);
    }
    let mut seen = HashSet::new();
    result.retain(|session| {
        seen.insert((session.provider.clone(), session.native_session_id.clone()))
    });

    for agent in agents.iter().filter(|agent| {
        (agent.managed_run_id.is_none() || agent.tmux_controlled)
            && agent
                .cwd
                .as_deref()
                .is_some_and(|cwd| cwd_matches(cwd, &project.path))
    }) {
        let native_id = agent
            .native_session_id
            .clone()
            .filter(|native_id| {
                result.iter().any(|item| {
                    item.provider == agent.provider && &item.native_session_id == native_id
                })
            })
            .or_else(|| {
                unique_live_session_id(project, &agent.provider, &result)
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
        // A provider session must map to one coherent live writer. If stale or
        // duplicate panes reference the same native session, never combine the
        // PID from one agent with the tmux metadata from another.
        if session.pid.is_some() {
            continue;
        }
        session.pid = Some(agent.pid);
        session.managed_run_id = agent.managed_run_id.clone();
        session.model = agent.model.clone();
        session.effort = agent.effort.clone();
        session.tmux_name = agent.tmux_session_name.clone();
        session.tmux_access_command = agent.tmux_access_command.clone();
        session.tmux_controlled = agent.tmux_controlled;
        session.tmux_owned = agent.tmux_owned;
        session.input_available = agent.tmux_controlled;
        session.input_transport = agent.tmux_controlled.then(|| "tmux".to_string());
        let transcript_path = agent
            .transcript_path
            .as_deref()
            .map(PathBuf::from)
            .or_else(|| source_path(project, &agent.provider, native_id).ok());
        if transcript_path.as_deref().is_some_and(|path| {
            providers::get(&agent.provider)
                .is_some_and(|adapter| adapter.transcript_turn_active(path))
        }) {
            session.status = "running".to_string();
        }
    }
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    result.truncate(session_limit);
    Ok(result)
}

/// Attach a remembered pane name / access command after the live process is gone.
/// Environment reads these fields; without this, a detached Codex chat looks like
/// it never had tmux.
pub fn apply_remembered_tmux(
    sessions: &mut [ProviderSession],
    controls: &[TmuxControl],
    runs: &[Run],
) {
    for session in sessions.iter_mut() {
        if session.tmux_name.is_some() {
            continue;
        }
        if let Some(control) = controls.iter().find(|control| {
            control.provider == session.provider
                && control.native_session_id.as_deref() == Some(session.native_session_id.as_str())
                && control.session_name.is_some()
        }) {
            session.tmux_name = control.session_name.clone();
            session.tmux_access_command = remembered_access_command(control);
            session.tmux_owned = control.owned;
            continue;
        }
        if let Some(run) = runs.iter().find(|run| {
            run.provider == session.provider
                && run.project_id == session.project_id
                && run.provider_session_id.as_deref() == Some(session.native_session_id.as_str())
                && run.tmux_name.is_some()
        }) {
            session.tmux_name = run.tmux_name.clone();
            session.tmux_access_command = run.tmux_access_command.clone().or_else(|| {
                run.tmux_name
                    .as_deref()
                    .map(|name| tmux::access_command(None, name))
            });
            session.tmux_owned = true;
        }
    }
}

fn remembered_access_command(control: &TmuxControl) -> Option<String> {
    control.access_command.clone().or_else(|| {
        control
            .session_name
            .as_deref()
            .map(|name| tmux::access_command(control.socket_path.as_deref().map(Path::new), name))
    })
}

/// Keep a detected pane tied to the conversation it was overlaid on, so
/// Environment still has the attach command after the process exits.
pub fn bind_detected_tmux_sessions(db: &Db, sessions: &[ProviderSession]) -> Result<()> {
    let controls = db.tmux_controls()?;
    for session in sessions {
        let Some(pid) = session.pid else {
            continue;
        };
        let Some(control) = controls.iter().find(|control| {
            control.source_pid == pid
                && control.provider == session.provider
                && (control.native_session_id.is_none()
                    || control.native_session_id.as_deref()
                        == Some(session.native_session_id.as_str()))
        }) else {
            continue;
        };
        let access = session
            .tmux_access_command
            .clone()
            .or_else(|| remembered_access_command(control));
        if control.native_session_id.as_deref() == Some(session.native_session_id.as_str())
            && control.session_name.is_some()
            && control.access_command.is_some()
        {
            continue;
        }
        let mut updated = control.clone();
        updated.native_session_id = Some(session.native_session_id.clone());
        if updated.session_name.is_none() {
            updated.session_name = session.tmux_name.clone();
        }
        if updated.access_command.is_none() {
            updated.access_command = access;
        }
        updated.updated_at = chrono::Utc::now().to_rfc3339();
        db.upsert_tmux_control(&updated)?;
    }
    Ok(())
}

/// Resolves the conversation a discovered process is working on when the process
/// itself does not say. Harnesses differ here: Codex keeps its rollout file open,
/// so `lsof` alone identifies the session, while Kiro appends to its transcript
/// and closes it again, leaving no file descriptor to follow.
///
/// Prefer the unique in-progress turn. After the turn ends the process is still
/// sitting in tmux, so the unique recently written transcript is the live pane.
/// Ambiguity is never guessed away: two recent transcripts attribute nothing.
fn unique_live_session_id(
    project: &Project,
    provider: &str,
    indexed: &[ProviderSession],
) -> Result<Option<String>> {
    let Some(adapter) = providers::get(provider) else {
        return Ok(None);
    };
    let cutoff = SystemTime::now()
        .checked_sub(ACTIVE_TRANSCRIPT_WINDOW)
        .unwrap_or(UNIX_EPOCH);
    let mut candidates = indexed
        .iter()
        .filter(|session| session.provider == provider)
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    candidates.truncate(ACTIVE_SESSION_SCAN_LIMIT);
    let mut recent_active = Vec::new();
    let mut recent_idle = Vec::new();
    for session in candidates {
        let Ok(path) = source_path(project, provider, &session.native_session_id) else {
            continue;
        };
        let writing = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| modified >= cutoff);
        if !writing {
            continue;
        }
        if adapter.transcript_turn_active(&path) {
            recent_active.push(session.native_session_id.clone());
        } else {
            recent_idle.push(session.native_session_id.clone());
        }
    }
    Ok(attribute_discovered_session_id(
        &recent_active,
        &recent_idle,
    ))
}

fn attribute_discovered_session_id(
    recent_active: &[String],
    recent_idle: &[String],
) -> Option<String> {
    match recent_active {
        [id] => Some(id.clone()),
        [] => match recent_idle {
            [id] => Some(id.clone()),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn transcript_turn_active(path: &Path, provider: &str) -> bool {
    // The tmux supervisor asks this for every controlled session on every tick,
    // and a transcript only changes when the harness writes to it. Memoize on
    // length plus modification time so a quiet session costs one `stat` instead
    // of an open, a reverse tail scan, and several JSON parses.
    let fingerprint = fs::metadata(path).ok().and_then(|metadata| {
        Some((
            metadata.len(),
            metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?,
        ))
    });
    let cache = TURN_ACTIVE_CACHE.get_or_init(Default::default);
    if let Some(fingerprint) = fingerprint {
        if let Some((cached_fingerprint, active)) =
            cache.lock().ok().and_then(|cache| cache.get(path).copied())
        {
            if cached_fingerprint == fingerprint {
                return active;
            }
        }
    }
    let active = scan_transcript_turn_active(path, provider);
    if let (Some(fingerprint), Ok(mut cache)) = (fingerprint, cache.lock()) {
        if cache.len() > MAX_TURN_ACTIVE_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), (fingerprint, active));
    }
    active
}

fn scan_transcript_turn_active(path: &Path, provider: &str) -> bool {
    if provider == "dsh" {
        return dsh_turn_active(path);
    }
    latest_jsonl_status(path, |value| match provider {
        "codex" => {
            let event = string(&value["payload"]["type"]);
            if value["type"] == "event_msg"
                && matches!(event.as_deref(), Some("task_complete" | "turn_aborted"))
            {
                Some(false)
            } else if value["type"] == "event_msg" && event.as_deref() == Some("task_started")
                || value["type"] == "response_item"
                    && value["payload"]["type"] == "message"
                    && value["payload"]["role"] == "user"
            {
                Some(true)
            } else {
                None
            }
        }
        "pi" => {
            if value["type"] != "message" {
                return None;
            }
            let role = string(&value["message"]["role"]).unwrap_or_default();
            if role == "user" || role == "toolResult" {
                Some(true)
            } else if role == "assistant" {
                let reason = string(&value["message"]["stopReason"])
                    .or_else(|| string(&value["message"]["rawStopReason"]));
                Some(!matches!(
                    reason.as_deref(),
                    Some("stop" | "end_turn" | "completed")
                ))
            } else {
                None
            }
        }
        "claude" => {
            if value["type"] == "user" {
                Some(true)
            } else if value["type"] == "assistant" {
                let reason = string(&value["message"]["stop_reason"]);
                Some(!matches!(
                    reason.as_deref(),
                    Some("end_turn" | "stop_sequence")
                ))
            } else if value["type"] == "system" && value["subtype"] == "turn_duration" {
                Some(false)
            } else {
                None
            }
        }
        "kiro" => match value["kind"].as_str() {
            Some("Prompt") | Some("ToolResults") => Some(true),
            // Kiro appends one AssistantMessage per step, so the tail of a live
            // turn is an assistant record far more often than a prompt or a tool
            // result. Only a record that stops asking for tools ends the turn.
            Some("AssistantMessage") => Some(
                value["data"]["content"]
                    .as_array()
                    .is_some_and(|content| content.iter().any(|item| item["kind"] == "toolUse")),
            ),
            _ => None,
        },
        "agy" => {
            let source = value["source"].as_str().unwrap_or_default();
            let kind = value["type"].as_str().unwrap_or_default();
            let status = value["status"].as_str().unwrap_or_default();
            if source == "USER_EXPLICIT" && kind == "USER_INPUT" {
                Some(true)
            } else if source == "MODEL"
                && kind == "PLANNER_RESPONSE"
                && status == "DONE"
                && value["content"]
                    .as_str()
                    .is_some_and(|content| !content.trim().is_empty())
            {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    })
    .unwrap_or(false)
}

fn latest_jsonl_status(
    path: &Path,
    mut classify: impl FnMut(&Value) -> Option<bool>,
) -> Option<bool> {
    let mut file = File::open(path).ok()?;
    let mut position = file.seek(SeekFrom::End(0)).ok()?;
    let mut chunk = vec![0; STATUS_SCAN_CHUNK_BYTES];
    let mut reversed_record = Vec::new();
    let mut oversized = false;

    let mut finish_record = |reversed_record: &mut Vec<u8>, oversized: &mut bool| {
        if *oversized || reversed_record.is_empty() {
            reversed_record.clear();
            *oversized = false;
            return None;
        }
        reversed_record.reverse();
        let result = serde_json::from_slice::<Value>(reversed_record)
            .ok()
            .and_then(|value| classify(&value));
        reversed_record.clear();
        *oversized = false;
        result
    };

    while position > 0 {
        let size = position.min(STATUS_SCAN_CHUNK_BYTES as u64) as usize;
        position -= size as u64;
        file.seek(SeekFrom::Start(position)).ok()?;
        file.read_exact(&mut chunk[..size]).ok()?;
        for &byte in chunk[..size].iter().rev() {
            if byte == b'\n' {
                if let Some(status) = finish_record(&mut reversed_record, &mut oversized) {
                    return Some(status);
                }
            } else if !oversized {
                if reversed_record.len() < MAX_STATUS_RECORD_BYTES {
                    reversed_record.push(byte);
                } else {
                    reversed_record.clear();
                    oversized = true;
                }
            }
        }
    }
    finish_record(&mut reversed_record, &mut oversized)
}

fn cwd_matches(cwd: &str, project_path: &str) -> bool {
    Path::new(cwd) == Path::new(project_path)
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

pub(crate) fn source_path(project: &Project, provider: &str, native_id: &str) -> Result<PathBuf> {
    source_path_from_home(&home_dir(), project, provider, native_id)
}

pub(crate) fn file_messages_for_project(
    project: &Project,
    provider: &str,
    native_id: &str,
    after: Option<&str>,
) -> Result<Vec<SessionMessage>> {
    let path = source_path(project, provider, native_id)?;
    parse_messages(&path, provider, after)
}

fn source_path_from_home(
    home: &Path,
    project: &Project,
    provider: &str,
    native_id: &str,
) -> Result<PathBuf> {
    if provider == "codex" {
        let codex_root = home.join(".codex");
        let path = codex_rollout_path(&codex_root, native_id)?
            .context("Codex rollout path was not found")?;
        anyhow::ensure!(
            path.is_file() && codex_rollout_matches_project(&path, project)?,
            "Codex transcript was not found in this project"
        );
        return Ok(path);
    }
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
    let directories = match provider {
        "pi" => vec![home.join(".pi/agent/sessions").join(format!(
            "--{}--",
            project.path.trim_matches('/').replace('/', "-")
        ))],
        "claude" => claude_project_directories(home, &project.path),
        "kiro" => vec![home.join(".kiro/sessions/cli")],
        "dsh" => vec![home.join(".dsh/sessions")],
        _ => anyhow::bail!("unsupported provider"),
    };
    if provider == "claude" {
        for directory in &directories {
            let path = directory.join(format!("{native_id}.jsonl"));
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    if provider == "kiro" {
        let path = directories[0].join(format!("{native_id}.jsonl"));
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
    for directory in directories {
        if !directory.is_dir() {
            continue;
        }
        for entry in fs::read_dir(directory)?.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
                && path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|stem| {
                        stem == native_id || stem.ends_with(&format!("_{native_id}"))
                    })
            {
                return Ok(path);
            }
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
    if provider == "kiro" {
        return crate::providers::kiro::messages(
            path,
            after,
            MAX_TRANSCRIPT_BYTES,
            MAX_STREAM_BYTES,
            MAX_MESSAGES,
        );
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
fn test_project(path: &Path) -> Project {
    Project {
        id: "project-1".into(),
        name: "project".into(),
        path: path.to_string_lossy().into_owned(),
        repo_root: None,
        created_at: "2026-08-13T00:00:00Z".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::json;

    use super::*;

    #[test]
    fn remembers_tmux_access_after_the_process_detaches() {
        let mut sessions = vec![ProviderSession {
            id: "codex:session-1".into(),
            provider: "codex".into(),
            native_session_id: "session-1".into(),
            project_id: "project-1".into(),
            cwd: "/dev".into(),
            title: "plugin supervisor".into(),
            created_at: "2026-08-23T00:00:00Z".into(),
            updated_at: "2026-08-23T00:00:00Z".into(),
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
        let control = TmuxControl {
            id: "detected-1".into(),
            project_id: Some("project-1".into()),
            run_id: None,
            provider: "codex".into(),
            native_session_id: Some("session-1".into()),
            transcript_path: None,
            source_pid: 99,
            source_pgid: 99,
            cwd: "/dev".into(),
            original_command: "codex --yolo".into(),
            socket_path: None,
            pane_id: Some("%3".into()),
            session_name: Some("work".into()),
            access_command: Some("tmux attach-session -t work".into()),
            owned: false,
            enabled: false,
            status: "detected".into(),
            error: None,
            queue_state: "ready".into(),
            queue_state_at: "2026-08-23T00:00:00Z".into(),
            created_at: "2026-08-23T00:00:00Z".into(),
            updated_at: "2026-08-23T00:00:00Z".into(),
        };
        apply_remembered_tmux(&mut sessions, &[control], &[]);
        assert_eq!(sessions[0].tmux_name.as_deref(), Some("work"));
        assert_eq!(
            sessions[0].tmux_access_command.as_deref(),
            Some("tmux attach-session -t work")
        );
    }

    #[test]
    fn synthesizes_an_access_command_from_a_remembered_session_name() {
        let mut sessions = vec![ProviderSession {
            id: "codex:session-1".into(),
            provider: "codex".into(),
            native_session_id: "session-1".into(),
            project_id: "project-1".into(),
            cwd: "/dev".into(),
            title: "plugin supervisor".into(),
            created_at: "2026-08-23T00:00:00Z".into(),
            updated_at: "2026-08-23T00:00:00Z".into(),
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
        let control = TmuxControl {
            id: "detected-1".into(),
            project_id: Some("project-1".into()),
            run_id: None,
            provider: "codex".into(),
            native_session_id: Some("session-1".into()),
            transcript_path: None,
            source_pid: 99,
            source_pgid: 99,
            cwd: "/dev".into(),
            original_command: "codex --yolo".into(),
            socket_path: None,
            pane_id: Some("%3".into()),
            session_name: Some("dev".into()),
            access_command: None,
            owned: false,
            enabled: false,
            status: "detected".into(),
            error: None,
            queue_state: "ready".into(),
            queue_state_at: "2026-08-23T00:00:00Z".into(),
            created_at: "2026-08-23T00:00:00Z".into(),
            updated_at: "2026-08-23T00:00:00Z".into(),
        };
        apply_remembered_tmux(&mut sessions, &[control], &[]);
        assert_eq!(sessions[0].tmux_name.as_deref(), Some("dev"));
        assert_eq!(
            sessions[0].tmux_access_command.as_deref(),
            Some("tmux attach-session -t dev")
        );
    }

    #[test]
    fn attributes_a_live_pane_to_the_unique_recent_idle_transcript() {
        assert_eq!(
            attribute_discovered_session_id(&[], &["session-1".into()]).as_deref(),
            Some("session-1")
        );
        assert_eq!(
            attribute_discovered_session_id(&["running".into()], &["idle".into()]).as_deref(),
            Some("running")
        );
        assert_eq!(
            attribute_discovered_session_id(&[], &["a".into(), "b".into()]),
            None
        );
        assert_eq!(
            attribute_discovered_session_id(&["a".into(), "b".into()], &["c".into()]),
            None
        );
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
    fn a_kiro_turn_stays_active_until_the_assistant_stops_calling_tools() {
        let root = std::env::temp_dir().join(format!("codesk-kiro-turn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let append = |record: &Value| {
            fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap()
                .write_all(format!("{record}\n").as_bytes())
                .unwrap();
        };
        let prompt = json!({"version":"v1","kind":"Prompt","data":{
            "message_id":"1",
            "content":[{"kind":"text","data":"check the sidebar"}]
        }});
        // Kiro writes one AssistantMessage per tool-calling step, so this record
        // is what the tail of a live turn looks like nearly all of the time.
        let tool_step = json!({"version":"v1","kind":"AssistantMessage","data":{
            "message_id":"2",
            "content":[
                {"kind":"thinking","data":{"text":"reading the file"}},
                {"kind":"text","data":""},
                {"kind":"toolUse","data":{"toolUseId":"toolu_1","name":"shell","input":{"command":"ls"}}}
            ]
        }});
        let tool_results = json!({"version":"v1","kind":"ToolResults","data":{
            "message_id":"3",
            "results":{"toolu_1":{"status":"success"}}
        }});
        let answer = json!({"version":"v1","kind":"AssistantMessage","data":{
            "message_id":"4",
            "content":[{"kind":"text","data":"done"}]
        }});

        fs::write(&path, format!("{prompt}\n")).unwrap();
        assert!(transcript_turn_active(&path, "kiro"));
        append(&tool_step);
        assert!(
            transcript_turn_active(&path, "kiro"),
            "an assistant record that requests a tool is mid-turn"
        );
        append(&tool_results);
        assert!(transcript_turn_active(&path, "kiro"));
        append(&answer);
        assert!(!transcript_turn_active(&path, "kiro"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_codex_active_turn_before_an_oversized_record() {
        let root =
            std::env::temp_dir().join(format!("codesk-large-status-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let started = json!({"type":"event_msg","payload":{"type":"task_started"}});
        let oversized = json!({
            "type":"response_item",
            "payload":{
                "type":"custom_tool_call_output",
                "output":"x".repeat(MAX_STATUS_RECORD_BYTES + STATUS_SCAN_CHUNK_BYTES)
            }
        });
        fs::write(&path, format!("{started}\n{oversized}\n")).unwrap();

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
}
