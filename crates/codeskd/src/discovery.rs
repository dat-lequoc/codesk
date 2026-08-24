use std::{
    collections::HashMap,
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use tokio::{io::AsyncReadExt, process::Command};
use uuid::Uuid;

use crate::{
    db::Db,
    model::{
        DiscoveredAgent, DiscoveredProject, FileContent, FileEntry, FileListing, Project,
        TmuxControl,
    },
    providers,
    tmux::{self, TmuxManager},
    worktrees,
};

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    ".cache",
    ".venv",
    "venv",
    "dist",
    "build",
    "__pycache__",
];
const FILE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const IMAGE_PREVIEW_MAX_BYTES: u64 = 12 * 1024 * 1024;

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub async fn list_files(path: Option<&str>) -> Result<FileListing> {
    let home = home_dir();
    let requested = requested_path(path, &home);
    let root = tokio::fs::canonicalize(&requested)
        .await
        .with_context(|| format!("open {}", requested.display()))?;
    anyhow::ensure!(root.is_dir(), "path is not a directory");
    let mut reader = tokio::fs::read_dir(&root).await?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" || name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let child = entry.path();
        entries.push(FileEntry {
            name,
            path: child.to_string_lossy().into_owned(),
            is_dir: true,
            is_git: child.join(".git").exists(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(FileListing {
        current_path: root.to_string_lossy().into_owned(),
        parent_path: root
            .parent()
            .filter(|parent| *parent != root)
            .map(|parent| parent.to_string_lossy().into_owned()),
        home_path: home.to_string_lossy().into_owned(),
        entries,
    })
}

pub async fn read_file(path: Option<&str>) -> Result<FileContent> {
    let home = home_dir();
    let requested = requested_path(path, &home);
    let canonical = tokio::fs::canonicalize(&requested)
        .await
        .with_context(|| format!("open {}", requested.display()))?;
    let metadata = tokio::fs::metadata(&canonical).await?;
    anyhow::ensure!(metadata.is_file(), "path is not a file");

    let name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical.to_string_lossy().into_owned());
    let mut signature = Vec::new();
    tokio::fs::File::open(&canonical)
        .await?
        .take(16)
        .read_to_end(&mut signature)
        .await?;
    if let Some(mime_type) = preview_image_mime(&signature) {
        anyhow::ensure!(
            metadata.len() <= IMAGE_PREVIEW_MAX_BYTES,
            "image preview is limited to 12 MB"
        );
        let bytes = tokio::fs::read(&canonical).await?;
        return Ok(FileContent {
            name,
            path: canonical.to_string_lossy().into_owned(),
            content: String::new(),
            mime_type: Some(mime_type.to_string()),
            data_url: Some(format!("data:{mime_type};base64,{}", BASE64.encode(bytes))),
            size: metadata.len(),
            truncated: false,
        });
    }

    let mut bytes = Vec::new();
    tokio::fs::File::open(&canonical)
        .await?
        .take(FILE_PREVIEW_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    anyhow::ensure!(
        !bytes.iter().take(8_192).any(|byte| *byte == 0),
        "binary files cannot be previewed"
    );
    let truncated = bytes.len() as u64 > FILE_PREVIEW_MAX_BYTES;
    if truncated {
        bytes.truncate(FILE_PREVIEW_MAX_BYTES as usize);
    }
    Ok(FileContent {
        name,
        path: canonical.to_string_lossy().into_owned(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        mime_type: None,
        data_url: None,
        size: metadata.len(),
        truncated,
    })
}

fn preview_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn requested_path(path: Option<&str>, home: &std::path::Path) -> PathBuf {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return home.to_path_buf();
    };
    if path == "~" {
        return home.to_path_buf();
    }
    if let Some(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        home.join(path)
    }
}

pub async fn discover_projects(
    db: &Db,
    path: &str,
    max_depth: usize,
    register: bool,
) -> Result<Vec<DiscoveredProject>> {
    let root = tokio::fs::canonicalize(path)
        .await
        .with_context(|| format!("open {path}"))?;
    anyhow::ensure!(root.is_dir(), "path is not a directory");
    let mut candidates = Vec::new();
    let mut stack = vec![(root.clone(), 0usize)];
    let mut seen = HashSet::new();
    while let Some((current, depth)) = stack.pop() {
        if current.join(".git").exists() {
            let canonical = current.to_string_lossy().into_owned();
            if seen.insert(canonical) {
                candidates.push(current);
            }
            continue;
        }
        if depth >= max_depth.min(5) {
            continue;
        }
        let mut reader = match tokio::fs::read_dir(&current).await {
            Ok(value) => value,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = reader.next_entry().await {
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            stack.push((entry.path(), depth + 1));
        }
    }
    if candidates.is_empty() {
        candidates.push(root);
    }
    candidates.sort();
    let mut result = Vec::new();
    for candidate in candidates {
        let path = candidate.to_string_lossy().into_owned();
        let repo_root = worktrees::detect_repo(&candidate).await;
        let existing = db.project_by_path(&path)?;
        let registered_project_id = if let Some(project) = existing {
            if register {
                db.register_project(&project.id)?;
            }
            Some(project.id)
        } else if register {
            let project = Project {
                id: Uuid::new_v4().to_string(),
                name: candidate
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&path)
                    .to_string(),
                path: path.clone(),
                repo_root: repo_root.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            db.create_project(&project)?;
            Some(project.id)
        } else {
            None
        };
        result.push(DiscoveredProject {
            name: candidate
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&path)
                .to_string(),
            path,
            repo_root,
            registered_project_id,
        });
    }
    Ok(result)
}

#[derive(Clone, Debug)]
struct ProcessCandidate {
    pid: u32,
    ppid: u32,
    pgid: i32,
    tty: Option<String>,
    command: String,
    provider: &'static str,
    managed_run_id: Option<String>,
}

pub async fn discover_agents(db: &Db, data_root: &Path) -> Result<Vec<DiscoveredAgent>> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,pgid=,tty=,command="])
        .output()
        .await?;
    anyhow::ensure!(output.status.success(), "ps failed");
    let managed = db
        .runs()?
        .into_iter()
        .filter_map(|run| {
            run.pid
                .map(|pid| (pid, run.process_group_id.unwrap_or(pid as i32), run.id))
        })
        .collect::<Vec<_>>();
    let mut parents = HashMap::new();
    let mut candidates = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 {
            continue;
        }
        let Some(pid) = fields[0].parse::<u32>().ok() else {
            continue;
        };
        let Some(ppid) = fields[1].parse::<u32>().ok() else {
            continue;
        };
        parents.insert(pid, ppid);
        let Some(pgid) = fields[2].parse::<i32>().ok() else {
            continue;
        };
        let tty = match tmux::normalize_tty(fields[3]).as_str() {
            "" | "?" | "??" => None,
            value => Some(value.to_string()),
        };
        let command = fields[4..].join(" ");
        // `tmux … pi` classifies as the inner provider because the wrapper
        // argv still contains the harness name. The wrapper is not the agent.
        if is_tmux_launch_wrapper(&command) {
            continue;
        }
        let provider = classify_agent(&command);
        let Some(provider) = provider else { continue };
        let managed_run_id = managed
            .iter()
            .find(|(managed_pid, managed_pgid, _)| *managed_pid == pid || *managed_pgid == pgid)
            .map(|(_, _, id)| id.clone());
        if managed_run_id.is_none()
            && (tty.is_none() || !is_interactive_agent_command(provider, &command))
        {
            continue;
        }
        candidates.push(ProcessCandidate {
            pid,
            ppid,
            pgid,
            tty,
            command,
            provider,
            managed_run_id,
        });
    }
    let details = process_details(
        &candidates
            .iter()
            .map(|candidate| (candidate.pid, candidate.provider))
            .collect::<Vec<_>>(),
    )
    .await;
    let direct_session_ids = candidates
        .iter()
        .filter_map(|candidate| {
            let (_, transcript_path) = details.get(&candidate.pid).cloned().unwrap_or_default();
            transcript_path
                .as_deref()
                .and_then(|path| transcript_session_id(path, candidate.provider))
                .or_else(|| command_session_id(&candidate.command, candidate.provider))
                .map(|session_id| (candidate.pid, (candidate.provider.to_string(), session_id)))
        })
        .collect::<HashMap<_, _>>();
    let extra_sockets = tmux_sockets_from_pids(
        &candidates
            .iter()
            .map(|candidate| candidate.pid)
            .collect::<Vec<_>>(),
    )
    .await;
    let tmux = TmuxManager::new(data_root.to_path_buf());
    let panes = tmux
        .panes_with_extra(&extra_sockets)
        .await
        .unwrap_or_default();
    let mut agents = Vec::new();
    for (root, members) in provider_process_roots(&candidates, &parents) {
        let pid = root.pid;
        let provider = root.provider;
        let (root_cwd, root_transcript) = details.get(&pid).cloned().unwrap_or_default();
        let cwd = root_cwd.or_else(|| {
            members
                .iter()
                .find_map(|member| details.get(&member.pid).and_then(|value| value.0.clone()))
        });
        let mut transcript_path = root_transcript.or_else(|| {
            members
                .iter()
                .find_map(|member| details.get(&member.pid).and_then(|value| value.1.clone()))
        });
        let mut native_session_id = direct_session_ids
            .get(&pid)
            .map(|(_, session_id)| session_id.clone())
            .or_else(|| {
                members.iter().find_map(|member| {
                    direct_session_ids
                        .get(&member.pid)
                        .map(|(_, session_id)| session_id.clone())
                })
            })
            .or_else(|| inherited_session_id(pid, provider, &parents, &direct_session_ids));
        let managed_run_id = root.managed_run_id.clone().or_else(|| {
            members
                .iter()
                .find_map(|member| member.managed_run_id.clone())
        });
        let pane = pane_for_process(root, &members, &parents, &panes);
        if std::env::var_os("CODESK_DEBUG_DISCOVERY").is_some() {
            eprintln!(
                "discovery: pid={pid} provider={provider} tty={:?} member_ttys={:?} panes={:?} matched={:?}",
                root.tty,
                members
                    .iter()
                    .map(|member| member.tty.clone())
                    .collect::<Vec<_>>(),
                panes
                    .iter()
                    .map(|pane| (pane.session_name.clone(), pane.tty.clone(), pane.pane_pid))
                    .collect::<Vec<_>>(),
                pane.map(|pane| pane.session_name.clone()),
            );
        }
        // Linux reports a vanished cwd as `path (deleted)`. There is nothing
        // left to attach to or register as a project.
        if cwd.as_deref().is_some_and(is_deleted_cwd) {
            continue;
        }
        let mut tmux_controlled = false;
        let mut model = None;
        let mut effort = None;
        if let Some(pane) = pane {
            // A terminal-driven harness only reports its live model and effort on
            // its own status line, so read it from the pane we already resolved.
            // The status line lives on the visible screen; a short tail keeps
            // this per-pane capture cheap during discovery scans.
            if let Ok(screen) = tmux.capture_text_tail(pane, 40).await {
                if let Some(status) = providers::parse_terminal_status(provider, &screen) {
                    model = status.model;
                    effort = status.effort;
                }
            }
            let mut existing = pane
                .control_id
                .as_deref()
                .and_then(|id| db.tmux_control(id).ok().flatten())
                .or_else(|| {
                    db.tmux_control_for_pane(pane.socket_path.as_deref(), &pane.pane_id)
                        .ok()
                        .flatten()
                });
            // A pane outlives the harness that used to occupy it, and tmux recycles
            // pane ids, so a control row can still describe the conversation of a
            // harness that has since been replaced. Identity recorded for another
            // provider - or a transcript this provider would never write - must not
            // be lent to the harness running there now.
            if let Some(control) = existing.as_mut().filter(|control| {
                control.provider != provider
                    || control
                        .transcript_path
                        .as_deref()
                        .is_some_and(|path| !transcript_matches(path, provider))
            }) {
                control.native_session_id = None;
                control.transcript_path = None;
                control.run_id = None;
                let _ = db.clear_tmux_control_identity(&control.id);
            }
            if let Some(control) = existing.as_ref() {
                native_session_id = native_session_id.or_else(|| control.native_session_id.clone());
                transcript_path = transcript_path.or_else(|| control.transcript_path.clone());
            }
            if pane.controlled || pane.owned || existing.is_some() {
                let now = chrono::Utc::now().to_rfc3339();
                let mut control = existing.unwrap_or_else(|| TmuxControl {
                    id: pane
                        .control_id
                        .clone()
                        .unwrap_or_else(|| Uuid::new_v4().to_string()),
                    project_id: None,
                    run_id: managed_run_id.clone(),
                    provider: provider.to_string(),
                    native_session_id: native_session_id.clone(),
                    transcript_path: transcript_path.clone(),
                    source_pid: pid,
                    source_pgid: root.pgid,
                    cwd: cwd.clone().unwrap_or_else(|| pane.current_path.clone()),
                    original_command: root.command.clone(),
                    socket_path: pane.socket_path.clone(),
                    pane_id: Some(pane.pane_id.clone()),
                    session_name: Some(pane.session_name.clone()),
                    access_command: Some(tmux::access_command(
                        pane.socket_path.as_deref().map(Path::new),
                        &pane.session_name,
                    )),
                    owned: pane.owned,
                    enabled: true,
                    status: "active".to_string(),
                    error: None,
                    queue_state: "ready".to_string(),
                    queue_state_at: now.clone(),
                    created_at: now.clone(),
                    updated_at: now,
                });
                control.run_id = control.run_id.or(managed_run_id.clone());
                control.provider = provider.to_string();
                control.native_session_id = native_session_id.clone().or(control.native_session_id);
                control.transcript_path = transcript_path.clone().or(control.transcript_path);
                control.source_pid = pid;
                control.source_pgid = root.pgid;
                control.cwd = cwd.clone().unwrap_or_else(|| pane.current_path.clone());
                control.socket_path = pane.socket_path.clone();
                control.pane_id = Some(pane.pane_id.clone());
                control.session_name = Some(pane.session_name.clone());
                control.access_command = Some(tmux::access_command(
                    pane.socket_path.as_deref().map(Path::new),
                    &pane.session_name,
                ));
                control.owned = pane.owned;
                control.enabled = true;
                control.status = "active".to_string();
                control.error = None;
                control.updated_at = chrono::Utc::now().to_rfc3339();
                db.upsert_tmux_control(&control)?;
                if let (Some(run_id), Some(session_id)) = (
                    control.run_id.as_deref(),
                    control.native_session_id.as_deref(),
                ) {
                    let _ = db.set_provider_session(run_id, session_id);
                }
                tmux_controlled = true;
            } else {
                let _ = remember_detected_tmux(
                    db,
                    pane,
                    provider,
                    pid,
                    root.pgid,
                    cwd.as_deref(),
                    &root.command,
                    native_session_id.as_deref(),
                    transcript_path.as_deref(),
                    managed_run_id.as_deref(),
                );
            }
        }
        agents.push(DiscoveredAgent {
            id: format!("external-{pid}"),
            provider: provider.to_string(),
            pid,
            process_group_id: root.pgid,
            cwd,
            command: root.command.clone(),
            managed_run_id,
            native_session_id,
            transcript_path,
            tty: root.tty.clone(),
            tmux_pane_id: pane.map(|pane| pane.pane_id.clone()),
            tmux_session_name: pane.map(|pane| pane.session_name.clone()),
            tmux_access_command: pane.map(|pane| {
                tmux::access_command(
                    pane.socket_path.as_deref().map(Path::new),
                    &pane.session_name,
                )
            }),
            tmux_controlled,
            model,
            effort,
            tmux_owned: pane.is_some_and(|pane| pane.owned),
        });
    }
    agents.sort_by_key(|item| item.pid);
    Ok(agents)
}

fn provider_process_roots<'a>(
    candidates: &'a [ProcessCandidate],
    parents: &HashMap<u32, u32>,
) -> Vec<(&'a ProcessCandidate, Vec<&'a ProcessCandidate>)> {
    let mut groups: HashMap<(String, String), Vec<&ProcessCandidate>> = HashMap::new();
    for candidate in candidates {
        let terminal = candidate
            .tty
            .clone()
            .unwrap_or_else(|| format!("pgid:{}", candidate.pgid));
        groups
            .entry((candidate.provider.to_string(), terminal))
            .or_default()
            .push(candidate);
    }
    let mut result = Vec::new();
    for members in groups.into_values() {
        let member_pids = members
            .iter()
            .map(|member| member.pid)
            .collect::<HashSet<_>>();
        let roots = members
            .iter()
            .copied()
            .filter(|member| {
                let mut current = member.ppid;
                for _ in 0..64 {
                    if member_pids.contains(&current) {
                        return false;
                    }
                    if current <= 1 {
                        break;
                    }
                    let Some(parent) = parents.get(&current) else {
                        break;
                    };
                    current = *parent;
                }
                true
            })
            .collect::<Vec<_>>();
        for root in roots {
            let descendants = members
                .iter()
                .copied()
                .filter(|member| {
                    member.pid == root.pid || is_descendant_of(member.pid, root.pid, parents)
                })
                .collect();
            result.push((root, descendants));
        }
    }
    result.sort_by_key(|(root, _)| root.pid);
    result
}

fn is_descendant_of(pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = pid;
    for _ in 0..64 {
        let Some(parent) = parents.get(&current) else {
            return false;
        };
        if *parent == ancestor {
            return true;
        }
        if *parent <= 1 || *parent == current {
            return false;
        }
        current = *parent;
    }
    false
}

fn inherited_session_id(
    pid: u32,
    provider: &str,
    parents: &HashMap<u32, u32>,
    direct: &HashMap<u32, (String, String)>,
) -> Option<String> {
    let mut current = pid;
    for _ in 0..64 {
        current = *parents.get(&current)?;
        if current <= 1 {
            return None;
        }
        if let Some((ancestor_provider, session_id)) = direct.get(&current) {
            if ancestor_provider == provider {
                return Some(session_id.clone());
            }
        }
    }
    None
}

type ProcessDetails = (Option<String>, Option<String>);

async fn process_details(processes: &[(u32, &str)]) -> HashMap<u32, ProcessDetails> {
    let mut result = HashMap::new();
    #[cfg(target_os = "linux")]
    {
        for (pid, provider) in processes {
            let cwd = tokio::fs::read_link(format!("/proc/{pid}/cwd"))
                .await
                .ok()
                .map(|path| path.to_string_lossy().into_owned());
            let mut transcript = None;
            if let Ok(mut entries) = tokio::fs::read_dir(format!("/proc/{pid}/fd")).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    let Ok(path) = tokio::fs::read_link(entry.path()).await else {
                        continue;
                    };
                    let value = path.to_string_lossy();
                    if transcript_matches(&value, provider) {
                        transcript = Some(value.into_owned());
                        break;
                    }
                }
            }
            result.insert(*pid, (cwd, transcript));
        }
        return result;
    }
    #[cfg(target_os = "macos")]
    {
        if processes.is_empty() {
            return result;
        }
        let providers = processes.iter().copied().collect::<HashMap<_, _>>();
        let pid_list = processes
            .iter()
            .map(|(pid, _)| pid.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let output = Command::new("lsof")
            .args(["-nP", "-a", "-p", &pid_list, "-Fpcfn"])
            .output()
            .await;
        let Ok(output) = output else { return result };
        let mut current_pid = None;
        let mut current_fd = "";
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            match line.as_bytes().first().copied() {
                Some(b'p') => {
                    current_pid = line[1..].parse::<u32>().ok();
                    current_fd = "";
                    if let Some(pid) = current_pid {
                        result.entry(pid).or_default();
                    }
                }
                Some(b'f') => current_fd = &line[1..],
                Some(b'n') => {
                    let Some(pid) = current_pid else { continue };
                    let path = &line[1..];
                    let entry = result.entry(pid).or_default();
                    if current_fd == "cwd" {
                        entry.0 = Some(path.to_string());
                    } else if entry.1.is_none()
                        && providers
                            .get(&pid)
                            .is_some_and(|provider| transcript_matches(path, provider))
                    {
                        entry.1 = Some(path.to_string());
                    }
                }
                _ => {}
            }
        }
        return result;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = processes;
        result
    }
}

fn transcript_matches(path: &str, provider: &str) -> bool {
    providers::get(provider).is_some_and(|adapter| adapter.transcript_matches(path))
}

fn transcript_session_id(path: &str, provider: &str) -> Option<String> {
    providers::get(provider).and_then(|adapter| adapter.transcript_session_id(path))
}

fn command_session_id(command: &str, provider: &str) -> Option<String> {
    providers::get(provider).and_then(|adapter| adapter.command_session_id(command))
}

fn remember_detected_tmux(
    db: &Db,
    pane: &tmux::TmuxPane,
    provider: &str,
    pid: u32,
    pgid: i32,
    cwd: Option<&str>,
    command: &str,
    native_session_id: Option<&str>,
    transcript_path: Option<&str>,
    managed_run_id: Option<&str>,
) -> Result<()> {
    let existing = pane
        .control_id
        .as_deref()
        .and_then(|id| db.tmux_control(id).ok().flatten())
        .or_else(|| {
            db.tmux_control_for_pane(pane.socket_path.as_deref(), &pane.pane_id)
                .ok()
                .flatten()
        })
        .or_else(|| db.tmux_control_for_pid(pid).ok().flatten());
    if existing.as_ref().is_some_and(|control| control.enabled) {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let access = tmux::access_command(
        pane.socket_path.as_deref().map(Path::new),
        &pane.session_name,
    );
    let mut control = existing.unwrap_or_else(|| TmuxControl {
        id: Uuid::new_v4().to_string(),
        project_id: None,
        run_id: managed_run_id.map(str::to_string),
        provider: provider.to_string(),
        native_session_id: native_session_id.map(str::to_string),
        transcript_path: transcript_path.map(str::to_string),
        source_pid: pid,
        source_pgid: pgid,
        cwd: cwd.unwrap_or(&pane.current_path).to_string(),
        original_command: command.to_string(),
        socket_path: pane.socket_path.clone(),
        pane_id: Some(pane.pane_id.clone()),
        session_name: Some(pane.session_name.clone()),
        access_command: Some(access.clone()),
        owned: pane.owned,
        enabled: false,
        status: "detected".to_string(),
        error: None,
        queue_state: "ready".to_string(),
        queue_state_at: now.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
    });
    control.native_session_id = native_session_id
        .map(str::to_string)
        .or(control.native_session_id);
    control.transcript_path = transcript_path
        .map(str::to_string)
        .or(control.transcript_path);
    control.session_name = Some(pane.session_name.clone());
    control.access_command = Some(access);
    control.socket_path = pane.socket_path.clone();
    control.pane_id = Some(pane.pane_id.clone());
    control.source_pid = pid;
    control.source_pgid = pgid;
    control.status = "detected".to_string();
    control.enabled = false;
    control.updated_at = now;
    db.upsert_tmux_control(&control)?;
    Ok(())
}

fn pane_for_process<'a>(
    root: &ProcessCandidate,
    members: &[&ProcessCandidate],
    parents: &HashMap<u32, u32>,
    panes: &'a [tmux::TmuxPane],
) -> Option<&'a tmux::TmuxPane> {
    let mut ttys = Vec::new();
    for candidate in std::iter::once(root).chain(members.iter().copied()) {
        if let Some(tty) = candidate.tty.as_deref() {
            if !ttys.iter().any(|existing| *existing == tty) {
                ttys.push(tty);
            }
        }
    }
    for tty in ttys {
        if let Some(pane) = panes.iter().find(|pane| pane.tty == tty) {
            return Some(pane);
        }
    }
    let mut current = root.pid;
    for _ in 0..64 {
        if let Some(pane) = panes.iter().find(|pane| pane.pane_pid == current) {
            return Some(pane);
        }
        match parents.get(&current).copied() {
            Some(parent) if parent > 1 && parent != current => current = parent,
            _ => break,
        }
    }
    None
}

// Only the Linux discovery path reads /proc environ; keep it compiling (and
// unit-tested) on macOS too.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn tmux_socket_from_environ(bytes: &[u8]) -> Option<PathBuf> {
    for entry in bytes.split(|byte| *byte == 0) {
        let Ok(text) = std::str::from_utf8(entry) else {
            continue;
        };
        let Some(value) = text.strip_prefix("TMUX=") else {
            continue;
        };
        let socket = value.split(',').next().filter(|item| !item.is_empty())?;
        return Some(PathBuf::from(socket));
    }
    None
}

pub(crate) async fn tmux_sockets_from_pids(pids: &[u32]) -> Vec<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let mut sockets = Vec::new();
        for pid in pids {
            let Ok(bytes) = tokio::fs::read(format!("/proc/{pid}/environ")).await else {
                continue;
            };
            if let Some(path) = tmux_socket_from_environ(&bytes) {
                if !sockets.contains(&path) {
                    sockets.push(path);
                }
            }
        }
        sockets
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pids;
        Vec::new()
    }
}

fn is_tmux_launch_wrapper(command: &str) -> bool {
    let first = command.split_whitespace().next().unwrap_or("");
    let basename = first.rsplit('/').next().unwrap_or(first);
    basename == "tmux"
}

fn is_deleted_cwd(cwd: &str) -> bool {
    cwd.ends_with(" (deleted)")
}

fn classify_agent(command: &str) -> Option<&'static str> {
    providers::all()
        .into_iter()
        .find(|adapter| adapter.matches_command(command))
        .map(|adapter| adapter.descriptor().id)
}

fn is_interactive_agent_command(provider: &str, command: &str) -> bool {
    let lower = command.to_lowercase();
    match provider {
        "codex" => !lower.contains(" app-server") && !lower.contains(" codex exec"),
        "kiro" => !lower.contains(" acp"),
        "opencode" => !lower.contains(" acp") && !lower.contains(" opencode run"),
        "dsh" => !lower.contains(" web"),
        "claude" => !lower.contains("--print") && !lower.contains(" -p "),
        "agy" => !lower.contains("--print"),
        "pi" => !lower.contains("--mode rpc"),
        _ => true,
    }
}

pub fn signal_external(pid: u32, pgid: i32, signal: i32) -> Result<()> {
    anyhow::ensure!(pid > 1 && pgid > 1, "refusing unsafe process target");
    let result = unsafe { libc::kill(-pgid, signal) };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

pub fn process_group_alive(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn expands_home_and_relative_browser_paths() {
        let home = PathBuf::from("/home/me");
        assert_eq!(requested_path(None, &home), home);
        assert_eq!(requested_path(Some(""), &home), home);
        assert_eq!(requested_path(Some("~"), &home), home);
        assert_eq!(
            requested_path(Some("~/thinkling"), &home),
            home.join("thinkling")
        );
        assert_eq!(
            requested_path(Some("thinkling/pi-agi"), &home),
            home.join("thinkling/pi-agi")
        );
        assert_eq!(
            requested_path(Some("/srv/repos"), &home),
            PathBuf::from("/srv/repos")
        );
    }

    #[test]
    fn extracts_native_session_ids_from_transcript_paths() {
        assert_eq!(
            transcript_session_id(
                "/home/me/.codex/sessions/2026/08/14/rollout-2026-08-14T00-00-00-019ff788-c44a-7e23-a9fa-8733e15a3990.jsonl",
                "codex"
            )
            .as_deref(),
            Some("019ff788-c44a-7e23-a9fa-8733e15a3990")
        );
        assert_eq!(
            transcript_session_id(
                "/home/me/.pi/agent/sessions/--repo--/2026-08-14T00-00-00Z_019ff8c1-bca1-74f2-b3bf-78cb908a9994.jsonl",
                "pi"
            )
            .as_deref(),
            Some("019ff8c1-bca1-74f2-b3bf-78cb908a9994")
        );
        assert_eq!(
            transcript_session_id(
                "/home/me/.dsh/sessions/--repo--/session-dsh-1/session.jsonl.zstd",
                "dsh"
            )
            .as_deref(),
            Some("session-dsh-1")
        );
        assert!(transcript_matches(
            "/home/me/.dsh/sessions/--repo--/session-dsh-1/session.jsonl.zstd",
            "dsh"
        ));
    }

    #[test]
    fn matches_a_tmux_pane_by_child_tty_or_ancestor_pid() {
        let pane = crate::tmux::TmuxPane {
            socket_path: None,
            pane_id: "%3".into(),
            session_name: "work".into(),
            tty: "pts/3".into(),
            pane_pid: 40,
            dead: false,
            in_mode: false,
            current_command: "zsh".into(),
            current_path: "/repo".into(),
            controlled: false,
            control_id: None,
            owned: false,
        };
        let root = ProcessCandidate {
            pid: 50,
            ppid: 40,
            pgid: 50,
            tty: Some("pts/9".into()),
            command: "dsh".into(),
            provider: "dsh",
            managed_run_id: None,
        };
        let child = ProcessCandidate {
            pid: 51,
            ppid: 50,
            pgid: 50,
            tty: Some("pts/3".into()),
            command: "dsh-worker".into(),
            provider: "dsh",
            managed_run_id: None,
        };
        let parents = HashMap::from([(50, 40), (51, 50), (40, 1)]);
        assert_eq!(
            pane_for_process(&root, &[&child], &parents, &[pane.clone()])
                .map(|item| item.pane_id.as_str()),
            Some("%3")
        );
        assert_eq!(
            pane_for_process(&root, &[], &parents, std::slice::from_ref(&pane))
                .map(|item| item.pane_id.as_str()),
            Some("%3")
        );
    }

    #[test]
    fn reads_tmux_socket_path_from_process_environment() {
        assert_eq!(
            tmux_socket_from_environ(b"HOME=/root\0TMUX=/tmp/tmux-0/work,1234,0\0"),
            Some(PathBuf::from("/tmp/tmux-0/work"))
        );
        assert_eq!(tmux_socket_from_environ(b"PATH=/bin\0"), None);
    }

    #[test]
    fn classifies_deepseek_harness_processes() {
        assert_eq!(
            classify_agent("/opt/homebrew/bin/dsh web --port 0"),
            Some("dsh")
        );
        assert_eq!(
            classify_agent("node /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web"),
            Some("dsh")
        );
    }

    #[test]
    fn skips_tmux_binaries_that_only_launch_an_agent() {
        assert!(is_tmux_launch_wrapper(
            "tmux -S /tmp/tmux-0/default new-session -d -s pi pi --model opus"
        ));
        assert!(is_tmux_launch_wrapper(
            "/usr/bin/tmux new-session kiro-cli chat"
        ));
        assert!(!is_tmux_launch_wrapper("pi --model opus"));
        assert!(!is_tmux_launch_wrapper("/usr/local/bin/kiro-cli chat"));
        // A harness invoked *from* a tmux session still has its own argv.
        assert!(!is_tmux_launch_wrapper("kiro-cli chat"));
    }

    #[test]
    fn skips_working_directories_linux_marks_deleted() {
        assert!(is_deleted_cwd("/root/.docker/my-plugins (deleted)"));
        assert!(!is_deleted_cwd("/root/.docker/my-plugins"));
        assert!(!is_deleted_cwd("/"));
    }

    #[test]
    fn excludes_headless_provider_transports_from_interactive_discovery() {
        assert!(!is_interactive_agent_command("codex", "codex app-server"));
        assert!(!is_interactive_agent_command("kiro", "kiro-cli acp"));
        assert!(!is_interactive_agent_command("pi", "pi --mode rpc"));
        assert!(is_interactive_agent_command("codex", "codex --yolo"));
        assert!(is_interactive_agent_command("kiro", "kiro-cli chat"));
    }

    #[test]
    fn collapses_provider_descendants_on_the_same_terminal() {
        let parents = HashMap::from([(20, 10), (30, 20)]);
        let candidates = vec![
            ProcessCandidate {
                pid: 10,
                ppid: 1,
                pgid: 10,
                tty: Some("ttys001".into()),
                command: "kiro-cli chat".into(),
                provider: "kiro",
                managed_run_id: None,
            },
            ProcessCandidate {
                pid: 20,
                ppid: 10,
                pgid: 10,
                tty: Some("ttys001".into()),
                command: "kiro-cli-chat".into(),
                provider: "kiro",
                managed_run_id: None,
            },
            ProcessCandidate {
                pid: 30,
                ppid: 20,
                pgid: 10,
                tty: Some("ttys001".into()),
                command: "kiro-cli-chat".into(),
                provider: "kiro",
                managed_run_id: None,
            },
        ];
        let roots = provider_process_roots(&candidates, &parents);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].0.pid, 10);
        assert_eq!(roots[0].1.len(), 3);
    }

    #[test]
    fn classifies_and_correlates_antigravity_processes() {
        let session = "1cbe7f1c-229a-4271-bc20-dc9d46433d96";
        assert_eq!(
            classify_agent(&format!(
                "/opt/homebrew/bin/agy --conversation {session} --print hello"
            )),
            Some("agy")
        );
        assert_eq!(
            classify_agent("node /opt/antigravity-cli/index.js --print hello"),
            Some("agy")
        );
        assert_eq!(
            command_session_id(
                &format!("agy --conversation={session} --print hello"),
                "agy"
            )
            .as_deref(),
            Some(session)
        );
        let transcript = format!(
            "/home/me/.gemini/antigravity-cli/brain/{session}/.system_generated/logs/transcript.jsonl"
        );
        assert!(transcript_matches(&transcript, "agy"));
        assert_eq!(
            transcript_session_id(&transcript, "agy").as_deref(),
            Some(session)
        );
    }

    #[test]
    fn classifies_and_correlates_opencode_processes() {
        let session = "ses_1234567890abcdef";
        assert_eq!(
            classify_agent("/Users/me/.local/bin/opencode acp --cwd /repo"),
            Some("opencode")
        );
        assert_eq!(
            classify_agent("bun /opt/opencode/bin/opencode run hello"),
            Some("opencode")
        );
        assert_eq!(
            command_session_id(
                &format!("opencode run --session {session} continue"),
                "opencode"
            )
            .as_deref(),
            Some(session)
        );
        assert_eq!(
            command_session_id(&format!("opencode -s={session}"), "opencode").as_deref(),
            Some(session)
        );
        assert_eq!(
            command_session_id(&format!("opencode --session={session}"), "opencode").as_deref(),
            Some(session)
        );
    }

    #[test]
    fn correlates_kiro_resume_processes() {
        let session = "5feafb8f-cffe-4c25-a6c7-18b4084d5b5d";
        assert_eq!(
            command_session_id(&format!("codex resume {session} --yolo"), "codex").as_deref(),
            Some(session)
        );
        assert_eq!(
            command_session_id(&format!("/usr/bin/codex resume {session}"), "codex").as_deref(),
            Some(session)
        );
        assert_eq!(
            command_session_id(&format!("kiro-cli --resume-id {session}"), "kiro").as_deref(),
            Some(session)
        );
        assert_eq!(
            command_session_id(
                &format!("/usr/local/bin/kiro-cli-chat chat --resume-id={session}"),
                "kiro"
            )
            .as_deref(),
            Some(session)
        );

        let parents = HashMap::from([(44056, 44050), (44050, 44030), (44030, 44002)]);
        let direct = HashMap::from([(44002, ("kiro".to_string(), session.to_string()))]);
        assert_eq!(
            inherited_session_id(44056, "kiro", &parents, &direct).as_deref(),
            Some(session)
        );
    }

    #[tokio::test]
    async fn reads_text_files_for_preview() {
        let root = std::env::temp_dir().join(format!("codeskd-preview-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("result.json");
        tokio::fs::write(&path, b"{\"ok\":true}\n").await.unwrap();
        let preview = read_file(path.to_str()).await.unwrap();
        assert_eq!(preview.name, "result.json");
        assert_eq!(preview.content, "{\"ok\":true}\n");
        assert!(preview.data_url.is_none());
        assert!(!preview.truncated);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn encodes_supported_images_for_preview() {
        let root = std::env::temp_dir().join(format!("codeskd-image-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("screenshot.png");
        tokio::fs::write(&path, b"\x89PNG\r\n\x1a\n").await.unwrap();
        let preview = read_file(path.to_str()).await.unwrap();
        assert_eq!(preview.mime_type.as_deref(), Some("image/png"));
        assert_eq!(
            preview.data_url.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgo=")
        );
        assert!(preview.content.is_empty());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn detects_image_mime_from_bytes_instead_of_extension() {
        let root = std::env::temp_dir().join(format!("codeskd-image-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("mislabeled.png");
        tokio::fs::write(&path, b"\xff\xd8\xff\xe0JFIF")
            .await
            .unwrap();
        let preview = read_file(path.to_str()).await.unwrap();
        assert_eq!(preview.mime_type.as_deref(), Some("image/jpeg"));
        assert!(
            preview
                .data_url
                .as_deref()
                .is_some_and(|value| value.starts_with("data:image/jpeg;base64,"))
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
}
