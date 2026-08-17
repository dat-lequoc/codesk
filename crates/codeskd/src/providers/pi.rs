use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::json;
use uuid::Uuid;

use crate::{
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Pi;
pub(crate) static ADAPTER: Pi = Pi;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "pi",
    name: "Pi",
    binary: Some("pi"),
    structured_output: true,
    live_input: true,
    resume: true,
    fork: true,
    native_interrupt: false,
    queued_input: false,
    turn_rewind: false,
    provider_responses: false,
    runner: RunnerKind::Stdio,
    limitations: &[],
};

impl ProviderAdapter for Pi {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }

    fn build(
        &self,
        request: &StartRunRequest,
        session_key: &str,
        _cwd: &str,
    ) -> Result<support::CommandSpec> {
        let mut args = vec!["--mode".into(), "rpc".into()];
        let selected_session = request.resume_session_id.as_deref().unwrap_or(session_key);
        match request.operation.as_deref() {
            Some("resume") => args.extend(["--session".into(), selected_session.into()]),
            Some("fork") => args.extend([
                "--fork".into(),
                selected_session.into(),
                "--session-id".into(),
                session_key.into(),
            ]),
            _ => args.extend(["--session-id".into(), session_key.into()]),
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(support::CommandSpec {
            command: support::provider_command("pi")?,
            args,
            session_id: Some(if request.operation.as_deref() == Some("resume") {
                selected_session.into()
            } else {
                session_key.into()
            }),
        })
    }

    fn build_terminal(
        &self,
        request: &StartRunRequest,
        session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        let selected_session = request.resume_session_id.as_deref().unwrap_or(session_key);
        let mut args = match request.operation.as_deref() {
            Some("resume") => vec!["--session".into(), selected_session.into()],
            Some("fork") => vec![
                "--fork".into(),
                selected_session.into(),
                "--session-id".into(),
                session_key.into(),
            ],
            _ => vec!["--session-id".into(), session_key.into()],
        };
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("pi")?,
            args,
            session_id: Some(if request.operation.as_deref() == Some("resume") {
                selected_session.into()
            } else {
                session_key.into()
            }),
        }))
    }

    fn encode_initial_prompt(&self, prompt: &str) -> Option<String> {
        Some(json!({"id":Uuid::new_v4().to_string(),"type":"prompt","message":prompt}).to_string())
    }

    fn encode_input(
        &self,
        message: &str,
        _request_id: &str,
        _delivery: &str,
        _last_turn_id: Option<&str>,
    ) -> Result<String> {
        Ok(json!({"id":Uuid::new_v4().to_string(),"type":"steer","message":message}).to_string())
    }

    fn matches_command(&self, command: &str) -> bool {
        let lower = command.to_lowercase();
        support::command_tokens(&lower).contains(&"pi") && !lower.contains("pip")
    }

    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with(".jsonl") && path.contains("/.pi/agent/sessions/")
    }

    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let stem = PathBuf::from(path).file_stem()?.to_str()?.to_string();
        stem.rsplit_once('_')
            .map(|(_, id)| id)
            .filter(|value| Uuid::parse_str(value).is_ok())
            .map(str::to_string)
    }

    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_pi(project, limit)
    }
    fn session_messages(
        &self,
        project: &Project,
        native_session_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<SessionMessage>> {
        sessions::file_messages_for_project(project, DESCRIPTOR.id, native_session_id, after)
    }
    fn transcript_turn_active(&self, path: &Path) -> bool {
        sessions::transcript_turn_active(path, DESCRIPTOR.id)
    }
}
