use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use anyhow::Result;
use serde_json::Value;

use super::{home_dir, index_directory};
use crate::model::{Project, ProviderSession};

pub(crate) fn index_claude(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    index_claude_from_home(&home_dir(), project, limit)
}

pub(super) fn claude_project_directories(home: &Path, project_path: &str) -> Vec<PathBuf> {
    let root = home.join(".claude/projects");
    let trimmed = project_path.trim_start_matches('/');
    let legacy = trimmed.replace('/', "-");
    let slug = trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let mut directories = vec![root.join(format!("-{slug}"))];
    if slug != legacy {
        directories.push(root.join(format!("-{legacy}")));
    }
    directories
}

fn index_claude_from_home(
    home: &Path,
    project: &Project,
    limit: usize,
) -> Result<Vec<ProviderSession>> {
    let mut sessions = Vec::new();
    for directory in claude_project_directories(home, &project.path) {
        sessions.extend(index_directory(project, "claude", &directory, limit)?);
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let mut seen = HashSet::new();
    sessions.retain(|session| seen.insert(session.native_session_id.clone()));
    sessions.truncate(limit);
    Ok(sessions)
}

pub(super) fn claude_user_text(value: &Value) -> String {
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::sessions::{source_path_from_home, test_project};

    #[test]
    fn discovers_claude_sessions_in_slugged_project_directory() {
        let home =
            std::env::temp_dir().join(format!("codesk-claude-slug-{}", uuid::Uuid::new_v4()));
        let project_path = PathBuf::from("/home/me/instant_context");
        let project = test_project(&project_path);
        let directory = home
            .join(".claude/projects")
            .join("-home-me-instant-context");
        fs::create_dir_all(&directory).unwrap();
        let transcript = directory.join("claude-refresh.jsonl");
        fs::write(
            &transcript,
            format!(
                "{}\n",
                serde_json::json!({
                    "sessionId":"claude-refresh",
                    "cwd":project_path,
                    "timestamp":"2026-08-16T15:00:00Z",
                    "type":"user",
                    "message":{"content":"new Claude session"}
                })
            ),
        )
        .unwrap();

        let sessions = index_claude_from_home(&home, &project, 10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_session_id, "claude-refresh");
        assert_eq!(sessions[0].title, "new Claude session");
        assert_eq!(
            source_path_from_home(&home, &project, "claude", "claude-refresh").unwrap(),
            transcript
        );
        fs::remove_dir_all(home).unwrap();
    }
}
