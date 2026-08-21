use std::{fs, path::Path};

use anyhow::Result;
use serde_json::Value;

use super::{
    MAX_INDEX_BYTES, cwd_matches, home_dir, modified_rfc3339, sort_recent, string, truncate_title,
};
use crate::model::{Project, ProviderSession};

pub(crate) fn index_kiro(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::sessions::{source_path_from_home, test_project};

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
}
