use std::path::{Path, PathBuf};

use anyhow::Result;
use uuid::Uuid;

use crate::{
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Claude;
pub(crate) static ADAPTER: Claude = Claude;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "claude",
    name: "Claude Code",
    binary: Some("claude"),
    structured_output: true,
    live_input: false,
    resume: true,
    fork: true,
    native_interrupt: false,
    queued_input: false,
    turn_rewind: false,
    provider_responses: false,
    runner: RunnerKind::Stdio,
    limitations: &[
        "Active print-mode sessions cannot accept live steering; use resume or fork after completion",
    ],
};

impl ProviderAdapter for Claude {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }
    fn build(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<support::CommandSpec> {
        let mut args = vec![
            "--print".into(),
            "--verbose".into(),
            "--output-format".into(),
            "stream-json".into(),
        ];
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            args.extend([
                "--resume".into(),
                support::require_resume_session(request)?.into(),
            ]);
            if request.operation.as_deref() == Some("fork") {
                args.push("--fork-session".into());
            }
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        args.push(request.prompt.clone());
        Ok(support::CommandSpec {
            command: support::provider_command("claude")?,
            args,
            session_id: request.resume_session_id.clone(),
        })
    }
    fn build_terminal(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        let mut args = Vec::new();
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            args.extend([
                "--resume".into(),
                support::require_resume_session(request)?.into(),
            ]);
            if request.operation.as_deref() == Some("fork") {
                args.push("--fork-session".into());
            }
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("claude")?,
            args,
            session_id: request.resume_session_id.clone(),
        }))
    }
    fn matches_command(&self, command: &str) -> bool {
        support::command_tokens(&command.to_lowercase()).contains(&"claude")
    }
    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with(".jsonl") && path.contains("/.claude/projects/")
    }
    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let stem = PathBuf::from(path).file_stem()?.to_str()?.to_string();
        Uuid::parse_str(&stem).ok().map(|_| stem)
    }
    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_claude(project, limit)
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
