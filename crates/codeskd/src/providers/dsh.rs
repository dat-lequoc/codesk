use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::Value;

use crate::{
    event_codec,
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Dsh;
pub(crate) static ADAPTER: Dsh = Dsh;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "dsh",
    name: "DeepSeek Harness",
    binary: Some("dsh"),
    structured_output: true,
    live_input: true,
    resume: true,
    fork: true,
    native_interrupt: true,
    queued_input: true,
    turn_rewind: false,
    provider_responses: false,
    runner: RunnerKind::DshWeb,
    limitations: &[
        "Codesk starts a private loopback DSH web host for durable resume, fork, steer, and queue support",
    ],
};

impl ProviderAdapter for Dsh {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }
    fn build(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<support::CommandSpec> {
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            support::require_resume_session(request)?;
        }
        Ok(support::CommandSpec {
            command: support::provider_command("dsh")?,
            args: vec![
                "web".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "0".into(),
            ],
            session_id: request.resume_session_id.clone(),
        })
    }
    fn build_terminal(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        let mut args = vec!["--profile".into(), "tui".into()];
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            args.extend([
                "--resume".into(),
                support::require_resume_session(request)?.into(),
            ]);
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("dsh")?,
            args,
            session_id: request.resume_session_id.clone(),
        }))
    }
    fn encode_input(
        &self,
        message: &str,
        request_id: &str,
        delivery: &str,
        last_turn_id: Option<&str>,
    ) -> Result<String> {
        support::submit_input(message, request_id, delivery, true, last_turn_id, "DSH")
    }
    fn event_codec(&self) -> event_codec::EventCodec {
        event_codec::EventCodec::Dsh
    }
    fn status_from_event(&self, raw: Option<&Value>) -> Option<&'static str> {
        let raw = raw?;
        if raw.get("type").and_then(Value::as_str) != Some("dsh.event") {
            return None;
        }
        match raw.pointer("/event/type").and_then(Value::as_str) {
            Some("turn/start") => Some("running"),
            Some("turn/end") => Some("waiting_for_input"),
            _ => None,
        }
    }
    fn interrupt_event_type(&self) -> &'static str {
        "dsh.session.cancel"
    }
    fn matches_command(&self, command: &str) -> bool {
        let lower = command.to_lowercase();
        support::command_tokens(&lower).contains(&"dsh")
            || lower.contains("@deepseek-ai/dsh")
            || lower.contains("deepseek-harness")
    }
    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with("/session.jsonl.zstd") && path.contains("/.dsh/sessions/")
    }
    fn transcript_session_id(&self, path: &str) -> Option<String> {
        PathBuf::from(path)
            .parent()?
            .file_name()?
            .to_str()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }
    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_dsh(project, limit)
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
