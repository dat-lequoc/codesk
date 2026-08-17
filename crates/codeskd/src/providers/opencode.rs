use anyhow::Result;
use serde_json::Value;

use crate::{
    event_codec,
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct OpenCode;
pub(crate) static ADAPTER: OpenCode = OpenCode;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "opencode",
    name: "OpenCode",
    binary: Some("opencode"),
    structured_output: true,
    live_input: true,
    resume: true,
    fork: true,
    native_interrupt: true,
    queued_input: true,
    turn_rewind: false,
    provider_responses: true,
    runner: RunnerKind::Acp,
    limitations: &[
        "OpenCode ACP does not expose mid-turn steering; messages sent during an active turn are queued by Codesk",
        "OpenCode can fork the current session, but ACP does not expose turn-level conversation backtracking",
    ],
};

impl ProviderAdapter for OpenCode {
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
        Ok(support::CommandSpec {
            command: support::provider_command("opencode")?,
            args: vec!["acp".into(), "--cwd".into(), cwd.into()],
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
                "--session".into(),
                support::require_resume_session(request)?.into(),
            ]);
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("opencode")?,
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
        support::submit_input(message, request_id, delivery, false, last_turn_id, "ACP")
    }
    fn event_codec(&self) -> event_codec::EventCodec {
        event_codec::EventCodec::Acp
    }
    fn status_from_event(&self, raw: Option<&Value>) -> Option<&'static str> {
        let raw = raw?;
        if raw.get("type").and_then(Value::as_str) != Some("codesk.turn") {
            return None;
        }
        match raw.get("action").and_then(Value::as_str) {
            Some("started") => Some("running"),
            Some("completed") => Some("waiting_for_input"),
            _ => None,
        }
    }
    fn interrupt_event_type(&self) -> &'static str {
        "opencode.session/cancel"
    }
    fn acp_model_config_id(&self) -> Option<&'static str> {
        Some("model")
    }
    fn matches_command(&self, command: &str) -> bool {
        support::command_tokens(&command.to_lowercase()).contains(&"opencode")
    }
    fn command_session_id(&self, command: &str) -> Option<String> {
        support::option_value(command, "--session", Some("-s"))
            .filter(|candidate| candidate.starts_with("ses_") && candidate.len() > 4)
    }
    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_opencode(project, limit)
    }
    fn session_messages(
        &self,
        project: &Project,
        native_session_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<SessionMessage>> {
        sessions::opencode_messages_for_project(project, native_session_id, after)
    }
}
