use std::path::{Path, PathBuf};

use anyhow::Result;
use uuid::Uuid;

use crate::{
    event_codec,
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Antigravity;
pub(crate) static ADAPTER: Antigravity = Antigravity;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "agy",
    name: "Antigravity",
    binary: Some("agy"),
    structured_output: true,
    live_input: false,
    resume: true,
    fork: false,
    native_interrupt: false,
    queued_input: false,
    turn_rewind: false,
    provider_responses: false,
    runner: RunnerKind::Stdio,
    limitations: &[
        "Antigravity print-mode turns cannot be steered; follow-ups resume the same conversation in a new managed process",
        "Antigravity CLI does not expose a safe conversation fork operation",
    ],
};

impl ProviderAdapter for Antigravity {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }
    fn build(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        cwd: &str,
    ) -> Result<support::CommandSpec> {
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            support::require_resume_session(request)?;
        }
        anyhow::ensure!(
            request.operation.as_deref() != Some("fork"),
            "Antigravity CLI does not expose a safe fork operation"
        );
        let mut args = Vec::new();
        if let Some(session) = request.resume_session_id.as_deref() {
            args.extend(["--conversation".into(), session.into()]);
        }
        args.extend([
            "--add-dir".into(),
            cwd.into(),
            "--print".into(),
            request.prompt.clone(),
            "--output-format".into(),
            "stream-json".into(),
            "--dangerously-skip-permissions".into(),
        ]);
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(support::CommandSpec {
            command: support::provider_command("agy")?,
            args,
            session_id: request.resume_session_id.clone(),
        })
    }
    fn build_terminal(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        anyhow::ensure!(
            request.operation.as_deref() != Some("fork"),
            "Antigravity CLI does not expose a safe fork operation"
        );
        let mut args = Vec::new();
        if request.operation.as_deref() == Some("resume") {
            args.extend([
                "--conversation".into(),
                support::require_resume_session(request)?.into(),
            ]);
        }
        args.extend([
            "--add-dir".into(),
            cwd.into(),
            "--dangerously-skip-permissions".into(),
        ]);
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("agy")?,
            args,
            session_id: request.resume_session_id.clone(),
        }))
    }
    fn event_codec(&self) -> event_codec::EventCodec {
        event_codec::EventCodec::Antigravity
    }
    fn matches_command(&self, command: &str) -> bool {
        let lower = command.to_lowercase();
        support::command_tokens(&lower).contains(&"agy") || lower.contains("antigravity-cli")
    }
    fn command_session_id(&self, command: &str) -> Option<String> {
        support::option_value(command, "--conversation", None)
            .filter(|value| Uuid::parse_str(value).is_ok())
    }
    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with("/.system_generated/logs/transcript.jsonl")
            && path.contains("/.gemini/antigravity-cli/brain/")
    }
    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let id = PathBuf::from(path)
            .parent()?
            .parent()?
            .parent()?
            .file_name()?
            .to_str()?
            .to_string();
        Uuid::parse_str(&id).ok().map(|_| id)
    }
    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_agy(project, limit)
    }
    fn session_messages(
        &self,
        project: &Project,
        native_session_id: &str,
        after: Option<&str>,
        before: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<SessionMessage>> {
        sessions::file_messages_for_project(
            project,
            DESCRIPTOR.id,
            native_session_id,
            after,
            before,
            limit,
        )
    }
    fn transcript_turn_active(&self, path: &Path) -> bool {
        sessions::transcript_turn_active(path, DESCRIPTOR.id)
    }
}
