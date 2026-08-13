use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result};
use chrono::Utc;
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    db::Db,
    model::{CreateWorktreeRequest, Project, Worktree, WorktreeStatus},
};

pub async fn detect_repo(path: &Path) -> Option<String> {
    git(path, ["rev-parse", "--show-toplevel"])
        .await
        .ok()
        .map(|value| value.trim().to_string())
}

pub async fn status(item: &Worktree) -> Result<WorktreeStatus> {
    let path = PathBuf::from(&item.path);
    let summary = git(&path, ["status", "--short", "--branch"])
        .await
        .unwrap_or_else(|error| error.to_string());
    let diff_stat = git(&path, ["diff", "--stat"])
        .await
        .unwrap_or_else(|error| error.to_string());
    let dirty = summary.lines().skip(1).any(|line| !line.trim().is_empty());
    Ok(WorktreeStatus {
        worktree: item.clone(),
        dirty,
        summary,
        diff_stat,
    })
}

pub async fn create(
    db: &Db,
    data_root: &Path,
    project: &Project,
    request: &CreateWorktreeRequest,
) -> Result<Worktree> {
    let repo_root = project
        .repo_root
        .as_deref()
        .context("project is not a Git repository")?;
    let id = Uuid::new_v4().to_string();
    let short = &id[..8];
    let branch = request
        .branch
        .clone()
        .unwrap_or_else(|| format!("codesk/{short}"));
    let base = request.base_ref.clone().unwrap_or_else(|| "HEAD".into());
    let path = data_root.join("worktrees").join(&project.id).join(&id);
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    let mut item = Worktree {
        id: id.clone(),
        project_id: project.id.clone(),
        path: path.to_string_lossy().into_owned(),
        branch: Some(branch.clone()),
        base_ref: Some(base.clone()),
        ownership: "managed".into(),
        status: "creating".into(),
        created_at: Utc::now().to_rfc3339(),
    };
    db.create_worktree(&item)?;
    let output = Command::new("git")
        .current_dir(repo_root)
        .args(["worktree", "add", "-b", &branch, item.path.as_str(), &base])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !output.status.success() {
        db.update_worktree_status(&id, "failed")?;
        anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim())
    }
    item.status = "ready".into();
    db.update_worktree_status(&id, "ready")?;
    Ok(item)
}

pub async fn remove(db: &Db, item: &Worktree, force: bool) -> Result<()> {
    anyhow::ensure!(
        item.ownership == "managed",
        "Codesk only removes managed worktrees"
    );
    anyhow::ensure!(
        !db.worktree_has_active_runs(&item.id)?,
        "worktree is still used by an active run"
    );
    let path = PathBuf::from(&item.path);
    let common = git(&path, ["rev-parse", "--git-common-dir"])
        .await
        .context("worktree is unavailable")?;
    let common = PathBuf::from(common.trim());
    let repo = if common.is_absolute() {
        common.parent().unwrap_or(&common).to_path_buf()
    } else {
        path.join(common).parent().unwrap_or(&path).to_path_buf()
    };
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force")
    };
    args.push(&item.path);
    git(&repo, args).await?;
    db.update_worktree_status(&item.id, "removed")?;
    Ok(())
}

async fn git<I, S>(cwd: &Path, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let output = Command::new("git")
        .current_dir(cwd)
        .args(args)
        .output()
        .await?;
    if !output.status.success() {
        anyhow::bail!("{}", String::from_utf8_lossy(&output.stderr).trim())
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
