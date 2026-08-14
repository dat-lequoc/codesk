use std::{collections::HashSet, path::PathBuf};

use anyhow::{Context, Result};
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    db::Db,
    model::{DiscoveredAgent, DiscoveredProject, FileEntry, FileListing, Project},
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
        .args(["-axo", "pid=,pgid=,command="])
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
    let mut agents = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line
            .trim()
            .splitn(3, char::is_whitespace)
            .filter(|part| !part.is_empty());
        let Some(pid) = fields.next().and_then(|value| value.parse::<u32>().ok()) else {
            continue;
        };
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
        let cwd = process_cwd(pid).await;
        let transcript_path = process_transcript(pid, provider).await;
        let native_session_id = transcript_path
            .as_deref()
            .and_then(|path| transcript_session_id(path, provider));
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
        });
    }
    agents.sort_by_key(|item| item.pid);
    Ok(agents)
}

async fn process_transcript(pid: u32, provider: &str) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let mut entries = tokio::fs::read_dir(format!("/proc/{pid}/fd")).await.ok()?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(path) = tokio::fs::read_link(entry.path()).await else {
                continue;
            };
            let value = path.to_string_lossy();
            if transcript_matches(&value, provider) {
                return Some(value.into_owned());
            }
        }
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-a", "-p", &pid.to_string(), "-Fn"])
            .output()
            .await
            .ok()?;
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix('n'))
            .find(|path| transcript_matches(path, provider))
            .map(str::to_string);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (pid, provider);
        None
    }
}

fn transcript_matches(path: &str, provider: &str) -> bool {
    path.ends_with(".jsonl")
        && match provider {
            "codex" => path.contains("/.codex/sessions/"),
            "pi" => path.contains("/.pi/agent/sessions/"),
            "claude" => path.contains("/.claude/projects/"),
            _ => false,
        }
}

fn transcript_session_id(path: &str, provider: &str) -> Option<String> {
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
        _ => None,
    }
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
    } else {
        None
    }
}

async fn process_cwd(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        return tokio::fs::read_link(format!("/proc/{pid}/cwd"))
            .await
            .ok()
            .map(|path| path.to_string_lossy().into_owned());
    }
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
            .await
            .ok()?;
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|line| line.strip_prefix('n').map(str::to_string));
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
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
    }
}
