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
    model::{
        CreateWorktreeRequest, GitContext, MergeWorktreeRequest, MergeWorktreeResult, Project,
        Worktree, WorktreeStatus,
    },
};

pub async fn detect_repo(path: &Path) -> Option<String> {
    git(path, ["rev-parse", "--show-toplevel"])
        .await
        .ok()
        .map(|value| value.trim().to_string())
}

pub async fn git_context(path: &Path) -> GitContext {
    let current_branch = git(path, ["branch", "--show-current"])
        .await
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let revision = if current_branch.is_none() {
        git(path, ["rev-parse", "--short", "HEAD"])
            .await
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    } else {
        None
    };
    let available = current_branch.is_some() || revision.is_some();
    let detached = available && current_branch.is_none();
    let branch = current_branch.or(revision);
    let dirty = git(path, ["status", "--porcelain"])
        .await
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    GitContext {
        branch,
        available,
        detached,
        dirty,
    }
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
    // Projects can outlive their original discovery metadata (for example, a
    // folder may become a Git repository after it was registered). Resolve the
    // repository at the point where a worktree is requested and repair stale
    // metadata so historical projects can still fork safely.
    let repo_root = detect_repo(Path::new(&project.path))
        .await
        .context("project is not a Git repository")?;
    if project.repo_root.as_deref() != Some(repo_root.as_str()) {
        db.update_project_repo_root(&project.id, Some(&repo_root))?;
    }
    let id = Uuid::new_v4().to_string();
    let short = &id[..8];
    let branch = request
        .branch
        .clone()
        .unwrap_or_else(|| format!("codesk/{short}"));
    let requested_base = request.base_ref.clone().unwrap_or_else(|| "HEAD".into());
    let base = if requested_base == "HEAD" {
        git(Path::new(&project.path), ["branch", "--show-current"])
            .await
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(requested_base)
    } else {
        requested_base
    };
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
        .current_dir(&repo_root)
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

pub async fn merge(
    db: &Db,
    item: &Worktree,
    project: &Project,
    request: &MergeWorktreeRequest,
) -> Result<MergeWorktreeResult> {
    anyhow::ensure!(
        item.ownership == "managed",
        "Codesk only merges managed worktrees"
    );
    anyhow::ensure!(item.status != "removed", "worktree has been removed");
    anyhow::ensure!(
        !db.worktree_has_active_runs(&item.id)?,
        "worktree is still used by an active run"
    );

    let source_path = PathBuf::from(&item.path);
    let target_path = PathBuf::from(&project.path);
    anyhow::ensure!(
        common_git_dir(&source_path).await? == common_git_dir(&target_path).await?,
        "worktree and project checkout are not from the same repository"
    );

    let source_branch = item
        .branch
        .clone()
        .context("worktree does not have a mergeable branch")?;
    let target_branch = request
        .target_ref
        .clone()
        .or_else(|| item.base_ref.clone())
        .context("worktree does not have a merge target")?
        .trim_start_matches("refs/heads/")
        .to_string();
    anyhow::ensure!(
        target_branch != "HEAD" && !target_branch.is_empty(),
        "select a branch checkout as the merge target"
    );
    anyhow::ensure!(
        source_branch != target_branch,
        "source and target branches are the same"
    );

    let checked_out = git(&target_path, ["branch", "--show-current"]).await?;
    anyhow::ensure!(
        checked_out.trim() == target_branch,
        "project checkout is on '{}', expected '{}'",
        checked_out.trim(),
        target_branch
    );
    anyhow::ensure!(
        git(&source_path, ["status", "--porcelain"])
            .await?
            .trim()
            .is_empty(),
        "worktree has uncommitted changes; ask the agent to commit them before merging"
    );
    anyhow::ensure!(
        git(&target_path, ["status", "--porcelain"])
            .await?
            .trim()
            .is_empty(),
        "project checkout has uncommitted changes; commit or stash them before merging"
    );

    let before = git(&target_path, ["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    let output = Command::new("git")
        .current_dir(&target_path)
        .args(["merge", "--no-edit", &source_branch])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    if !output.status.success() {
        let _ = git(&target_path, ["merge", "--abort"]).await;
        anyhow::bail!(
            "merge failed and was aborted: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }
    let after = git(&target_path, ["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    let commit = git(&target_path, ["rev-parse", "--short", "HEAD"])
        .await?
        .trim()
        .to_string();
    let summary = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(MergeWorktreeResult {
        worktree_id: item.id.clone(),
        source_branch,
        target_branch,
        commit,
        changed: before != after,
        summary,
    })
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

async fn common_git_dir(path: &Path) -> Result<PathBuf> {
    let value = git(path, ["rev-parse", "--git-common-dir"]).await?;
    let common = PathBuf::from(value.trim());
    let absolute = if common.is_absolute() {
        common
    } else {
        path.join(common)
    };
    Ok(tokio::fs::canonicalize(absolute).await?)
}
