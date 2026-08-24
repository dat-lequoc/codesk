use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Codex;
pub(crate) static ADAPTER: Codex = Codex;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "codex",
    name: "Codex",
    binary: Some("codex"),
    structured_output: true,
    live_input: true,
    resume: true,
    fork: true,
    native_interrupt: true,
    queued_input: true,
    turn_rewind: true,
    provider_responses: true,
    runner: RunnerKind::CodexAppServer,
    limitations: &[
        "Esc-Esc style rewind creates a source-preserving thread fork; it does not revert files already changed in the workspace",
    ],
};

impl ProviderAdapter for Codex {
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
            command: support::provider_command("codex")?,
            args: vec!["app-server".into()],
            session_id: request.resume_session_id.clone(),
        })
    }

    fn build_terminal(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        let mut args = match request.operation.as_deref() {
            Some("resume") => vec![
                "resume".into(),
                support::require_resume_session(request)?.into(),
            ],
            Some("fork") => vec![
                "fork".into(),
                support::require_resume_session(request)?.into(),
            ],
            _ => Vec::new(),
        };
        args.push("--yolo".into());
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("codex")?,
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
        match delivery {
            "auto" | "steer" | "queue" => Ok(json!({"type":"submit","message":message,"requestId":request_id,"delivery":delivery}).to_string()),
            "fork" => Ok(json!({"type":"rewind","message":message,"requestId":request_id,"lastTurnId":last_turn_id}).to_string()),
            value => anyhow::bail!("unsupported Codex input delivery: {value}"),
        }
    }

    fn status_from_event(&self, raw: Option<&Value>) -> Option<&'static str> {
        let raw = raw?;
        match raw.get("method").and_then(Value::as_str) {
            Some("turn/started") => Some("running"),
            Some("turn/completed") => Some("waiting_for_input"),
            _ if raw.get("type").and_then(Value::as_str) == Some("codesk.control.ack")
                && raw.get("accepted").and_then(Value::as_bool) == Some(false) =>
            {
                Some("waiting_for_input")
            }
            _ => None,
        }
    }

    fn interrupt_event_type(&self) -> &'static str {
        "codex.turn/interrupt"
    }

    fn matches_command(&self, command: &str) -> bool {
        support::command_tokens(&command.to_lowercase()).contains(&"codex")
    }

    fn command_session_id(&self, command: &str) -> Option<String> {
        let tokens = support::command_tokens(command);
        for (index, token) in tokens.iter().enumerate() {
            if !matches!(*token, "resume" | "fork" | "--resume") {
                continue;
            }
            let value = tokens.get(index + 1)?;
            if Uuid::parse_str(value).is_ok() {
                return Some((*value).to_string());
            }
        }
        None
    }

    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with(".jsonl") && path.contains("/.codex/sessions/")
    }

    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let stem = PathBuf::from(path).file_stem()?.to_str()?.to_string();
        stem.get(stem.len().checked_sub(36)?..)
            .filter(|value| Uuid::parse_str(value).is_ok())
            .map(str::to_string)
    }

    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_codex(project, limit)
    }

    fn session_messages(
        &self,
        project: &Project,
        native_session_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<SessionMessage>> {
        sessions::codex_messages_for_project(project, native_session_id, after)
    }

    fn transcript_turn_active(&self, path: &Path) -> bool {
        sessions::transcript_turn_active(path, DESCRIPTOR.id)
    }
}
