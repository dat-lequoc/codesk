use std::{collections::HashMap, collections::HashSet, path::PathBuf};

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use tokio::{io::AsyncReadExt, process::Command};
use uuid::Uuid;

use crate::{
    db::Db,
    model::{DiscoveredAgent, DiscoveredProject, FileContent, FileEntry, FileListing, Project},
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

pub async fn discover_agents(db: &Db) -> Result<Vec<DiscoveredAgent>> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,pgid=,command="])
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
        let mut fields = line
            .trim()
            .splitn(4, char::is_whitespace)
            .filter(|part| !part.is_empty());
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = fields
            .next()
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            continue;
        };
        parents.insert(pid, ppid);
        let Some(pgid) = fields
            .next()
            .and_then(|value| value.trim().parse::<i32>().ok())
        else {
            continue;
        };
        let command = fields.next().unwrap_or("").trim().to_string();
        let provider = classify_agent(&command);
        let Some(provider) = provider else { continue };
        let managed_run_id = managed
            .iter()
            .find(|(managed_pid, managed_pgid, _)| *managed_pid == pid || *managed_pgid == pgid)
            .map(|(_, _, id)| id.clone());
        candidates.push((pid, pgid, command, provider, managed_run_id));
    }
    let panes = tmux_panes().await;
    let details = process_details(
        &candidates
            .iter()
            .map(|(pid, _, _, provider, _)| (*pid, *provider))
            .collect::<Vec<_>>(),
    )
    .await;
    let mut agents = Vec::new();
    for (pid, pgid, command, provider, managed_run_id) in candidates {
        let (cwd, transcript_path) = details.get(&pid).cloned().unwrap_or_default();
        let native_session_id = transcript_path
            .as_deref()
            .and_then(|path| transcript_session_id(path, provider))
            .or_else(|| command_session_id(&command, provider));
        agents.push(DiscoveredAgent {
            id: format!("external-{pid}"),
            provider: provider.to_string(),
            pid,
            process_group_id: pgid,
            cwd,
            command,
            managed_run_id,
            native_session_id,
            transcript_path,
            tmux_pane: tmux_pane_for(pid, &parents, &panes),
        });
    }
    agents.sort_by_key(|item| item.pid);
    Ok(agents)
}

async fn tmux_panes() -> Vec<(String, u32)> {
    let Ok(output) = Command::new(tmux_executable())
        .args(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"])
        .output()
        .await
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let (pane, pid) = line.split_once('\t')?;
            Some((pane.to_string(), pid.parse().ok()?))
        })
        .collect()
}

fn tmux_executable() -> PathBuf {
    if let Some(configured) = std::env::var_os("CODESK_TMUX_BINARY") {
        return PathBuf::from(configured);
    }
    [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
    .unwrap_or_else(|| PathBuf::from("tmux"))
}

fn tmux_pane_for(pid: u32, parents: &HashMap<u32, u32>, panes: &[(String, u32)]) -> Option<String> {
    let pane_by_pid = panes
        .iter()
        .map(|(pane, pane_pid)| (*pane_pid, pane))
        .collect::<HashMap<_, _>>();
    let mut current = pid;
    let mut seen = HashSet::new();
    while current > 1 && seen.insert(current) {
        if let Some(pane) = pane_by_pid.get(&current) {
            return Some((*pane).clone());
        }
        current = *parents.get(&current)?;
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
    match provider {
        "dsh" => path.ends_with("/session.jsonl.zstd") && path.contains("/.dsh/sessions/"),
        "agy" => {
            path.ends_with("/.system_generated/logs/transcript.jsonl")
                && path.contains("/.gemini/antigravity-cli/brain/")
        }
        _ => {
            path.ends_with(".jsonl")
                && match provider {
                    "codex" => path.contains("/.codex/sessions/"),
                    "pi" => path.contains("/.pi/agent/sessions/"),
                    "claude" => path.contains("/.claude/projects/"),
                    "kiro" => path.contains("/.kiro/sessions/cli/"),
                    _ => false,
                }
        }
    }
}

fn transcript_session_id(path: &str, provider: &str) -> Option<String> {
    if provider == "dsh" {
        return PathBuf::from(path)
            .parent()?
            .file_name()?
            .to_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    if provider == "agy" {
        let id = PathBuf::from(path)
            .parent()?
            .parent()?
            .parent()?
            .file_name()?
            .to_str()?
            .to_string();
        return Uuid::parse_str(&id).ok().map(|_| id);
    }
    let stem = PathBuf::from(path).file_stem()?.to_str()?.to_string();
    match provider {
        "codex" => stem
            .get(stem.len().checked_sub(36)?..)
            .filter(|value| Uuid::parse_str(value).is_ok())
            .map(str::to_string),
        "pi" => stem
            .rsplit_once('_')
            .map(|(_, id)| id)
            .filter(|value| Uuid::parse_str(value).is_ok())
            .map(str::to_string),
        "claude" => Uuid::parse_str(&stem).ok().map(|_| stem),
        "kiro" => Uuid::parse_str(&stem).ok().map(|_| stem),
        _ => None,
    }
}

fn command_session_id(command: &str, provider: &str) -> Option<String> {
    if provider != "agy" {
        return None;
    }
    let tokens = command
        .split_whitespace()
        .map(|token| token.trim_matches(['\'', '"']))
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let candidate = if *token == "--conversation" {
            tokens.get(index + 1).copied()
        } else {
            token.strip_prefix("--conversation=")
        };
        if let Some(candidate) = candidate {
            let candidate = candidate.trim_matches(['\'', '"']);
            if Uuid::parse_str(candidate).is_ok() {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn classify_agent(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    let tokens = lower
        .split(|character: char| character.is_whitespace() || character == '/')
        .collect::<Vec<_>>();
    if tokens.iter().any(|token| *token == "codex") {
        Some("codex")
    } else if tokens.iter().any(|token| *token == "claude") {
        Some("claude")
    } else if tokens.iter().any(|token| *token == "pi") && !lower.contains("pip") {
        Some("pi")
    } else if tokens.iter().any(|token| *token == "kiro-cli") || lower.contains("kiro-cli") {
        Some("kiro")
    } else if tokens.iter().any(|token| *token == "dsh") || lower.contains("@deepseek-ai/dsh") {
        Some("dsh")
    } else if tokens.iter().any(|token| *token == "agy") || lower.contains("antigravity-cli") {
        Some("agy")
    } else {
        None
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

pub fn external_process_alive(pid: u32) -> bool {
    pid > 1 && unsafe { libc::kill(pid as i32, 0) } == 0
}

pub async fn send_external_input(agent: &DiscoveredAgent, message: &str) -> Result<()> {
    anyhow::ensure!(
        external_process_alive(agent.pid),
        "agent process is no longer running"
    );
    let pane = agent
        .tmux_pane
        .as_deref()
        .context("this live session is not attached to a tmux pane")?;
    anyhow::ensure!(!message.trim().is_empty(), "message is required");
    let typed = Command::new(tmux_executable())
        .args(["send-keys", "-t", pane, "-l", "--", message])
        .status()
        .await?;
    anyhow::ensure!(typed.success(), "tmux could not write to the live session");
    let submitted = Command::new(tmux_executable())
        .args(["send-keys", "-t", pane, "Enter"])
        .status()
        .await?;
    anyhow::ensure!(
        submitted.success(),
        "tmux could not submit the live message"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
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
    fn resolves_the_nearest_tmux_pane_from_process_ancestry() {
        let parents = HashMap::from([(450, 420), (420, 300), (300, 1), (900, 800)]);
        let panes = vec![("%1".to_string(), 300), ("%2".to_string(), 800)];
        assert_eq!(tmux_pane_for(450, &parents, &panes).as_deref(), Some("%1"));
        assert_eq!(tmux_pane_for(900, &parents, &panes).as_deref(), Some("%2"));
        assert_eq!(tmux_pane_for(999, &parents, &panes), None);
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
