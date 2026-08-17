use std::path::Path;

use anyhow::Result;
use serde_json::Value;

use crate::{
    event_codec,
    model::{AdapterCapability, Project, ProviderSession, SessionMessage, StartRunRequest},
};

pub(crate) mod agy;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod dsh;
pub(crate) mod kiro;
pub(crate) mod opencode;
pub(crate) mod pi;
pub(crate) mod shell;
pub(crate) mod support;

pub(crate) type NormalizedEvent = (String, Option<String>, Value, Option<Value>, Option<String>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RunnerKind {
    Stdio,
    Acp,
    CodexAppServer,
    DshWeb,
}

impl RunnerKind {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Acp => "acp",
            Self::CodexAppServer => "codex_app_server",
            Self::DshWeb => "dsh_web",
        }
    }
}

pub(crate) struct ProviderDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub binary: Option<&'static str>,
    pub structured_output: bool,
    pub live_input: bool,
    pub resume: bool,
    pub fork: bool,
    pub native_interrupt: bool,
    pub queued_input: bool,
    pub turn_rewind: bool,
    pub provider_responses: bool,
    pub runner: RunnerKind,
    pub limitations: &'static [&'static str],
}

pub(crate) trait ProviderAdapter: Sync {
    fn descriptor(&self) -> &'static ProviderDescriptor;

    fn build(
        &self,
        request: &StartRunRequest,
        session_key: &str,
        cwd: &str,
    ) -> Result<support::CommandSpec>;

    fn build_terminal(
        &self,
        _request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        Ok(None)
    }

    fn encode_initial_prompt(&self, _prompt: &str) -> Option<String> {
        None
    }

    fn encode_input(
        &self,
        _message: &str,
        _request_id: &str,
        _delivery: &str,
        _last_turn_id: Option<&str>,
    ) -> Result<String> {
        anyhow::bail!(
            "{} adapter does not support live steering yet",
            self.descriptor().id
        )
    }

    fn event_codec(&self) -> event_codec::EventCodec {
        event_codec::EventCodec::Default
    }

    fn normalize_line(&self, channel: &str, line: &str) -> NormalizedEvent {
        event_codec::normalize_with_codec(self.event_codec(), self.descriptor().id, channel, line)
    }

    fn status_from_event(&self, _raw: Option<&Value>) -> Option<&'static str> {
        None
    }

    fn interrupt_event_type(&self) -> &'static str {
        "provider.interrupt"
    }

    fn acp_agent_name(&self) -> &'static str {
        self.descriptor().name
    }

    fn acp_model_config_id(&self) -> Option<&'static str> {
        None
    }

    fn matches_command(&self, _command: &str) -> bool {
        false
    }

    fn command_session_id(&self, _command: &str) -> Option<String> {
        None
    }

    fn transcript_matches(&self, _path: &str) -> bool {
        false
    }

    fn transcript_session_id(&self, _path: &str) -> Option<String> {
        None
    }

    fn index_sessions(&self, _project: &Project, _limit: usize) -> Result<Vec<ProviderSession>> {
        Ok(Vec::new())
    }

    fn session_messages(
        &self,
        _project: &Project,
        _native_session_id: &str,
        _after: Option<&str>,
    ) -> Result<Vec<SessionMessage>> {
        anyhow::bail!("{} sessions are not indexed", self.descriptor().name)
    }

    fn transcript_turn_active(&self, path: &Path) -> bool {
        crate::sessions::transcript_turn_active(path, self.descriptor().id)
    }
}

pub(crate) fn all() -> [&'static dyn ProviderAdapter; 8] {
    [
        &codex::ADAPTER,
        &kiro::ADAPTER,
        &dsh::ADAPTER,
        &agy::ADAPTER,
        &pi::ADAPTER,
        &claude::ADAPTER,
        &opencode::ADAPTER,
        &shell::ADAPTER,
    ]
}

pub(crate) fn get(id: &str) -> Option<&'static dyn ProviderAdapter> {
    all()
        .into_iter()
        .find(|adapter| adapter.descriptor().id == id)
}

pub(crate) fn require(id: &str) -> Result<&'static dyn ProviderAdapter> {
    get(id).ok_or_else(|| anyhow::anyhow!("unsupported provider: {id}"))
}

pub(crate) fn capabilities() -> Vec<AdapterCapability> {
    all()
        .into_iter()
        .map(|adapter| {
            let descriptor = adapter.descriptor();
            let executable = descriptor.binary.and_then(support::find_executable);
            AdapterCapability {
                id: descriptor.id.into(),
                name: descriptor.name.into(),
                available: descriptor.binary.is_none() || executable.is_some(),
                executable,
                structured_output: descriptor.structured_output,
                live_input: descriptor.live_input,
                resume: descriptor.resume,
                fork: descriptor.fork,
                native_interrupt: descriptor.native_interrupt,
                queued_input: descriptor.queued_input,
                turn_rewind: descriptor.turn_rewind,
                provider_responses: descriptor.provider_responses,
                runner: descriptor.runner.as_str().into(),
                limitations: descriptor
                    .limitations
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
            }
        })
        .collect()
}

pub(crate) fn build(
    request: &StartRunRequest,
    session_key: &str,
    cwd: &str,
) -> Result<support::CommandSpec> {
    require(&request.provider)?.build(request, session_key, cwd)
}

pub(crate) fn build_terminal(
    request: &StartRunRequest,
    session_key: &str,
    cwd: &str,
) -> Result<Option<support::CommandSpec>> {
    require(&request.provider)?.build_terminal(request, session_key, cwd)
}

pub(crate) fn encode_initial_prompt(provider: &str, prompt: &str) -> Option<String> {
    get(provider).and_then(|adapter| adapter.encode_initial_prompt(prompt))
}

pub(crate) fn encode_input(
    provider: &str,
    message: &str,
    request_id: &str,
    delivery: &str,
    last_turn_id: Option<&str>,
) -> Result<String> {
    require(provider)?.encode_input(message, request_id, delivery, last_turn_id)
}

pub(crate) fn normalize_line(provider: &str, channel: &str, line: &str) -> NormalizedEvent {
    get(provider)
        .map(|adapter| adapter.normalize_line(channel, line))
        .unwrap_or_else(|| {
            event_codec::normalize_with_codec(
                event_codec::EventCodec::Default,
                provider,
                channel,
                line,
            )
        })
}

pub(crate) fn status_from_event(provider: &str, raw: Option<&Value>) -> Option<&'static str> {
    get(provider).and_then(|adapter| adapter.status_from_event(raw))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{RunnerKind, all, get};

    #[test]
    fn registry_ids_are_unique_and_resolvable() {
        let mut ids = HashSet::new();
        for adapter in all() {
            let descriptor = adapter.descriptor();
            assert!(
                ids.insert(descriptor.id),
                "duplicate provider {}",
                descriptor.id
            );
            assert!(get(descriptor.id).is_some());
            assert!(!descriptor.name.trim().is_empty());
            assert!(!descriptor.runner.as_str().is_empty());
        }
    }

    #[test]
    fn capabilities_and_transports_are_consistent() {
        for adapter in all() {
            let descriptor = adapter.descriptor();
            if descriptor.queued_input {
                assert!(descriptor.live_input);
            }
            if descriptor.turn_rewind {
                assert!(descriptor.fork);
            }
            match descriptor.runner {
                RunnerKind::CodexAppServer => assert_eq!(descriptor.id, "codex"),
                RunnerKind::DshWeb => assert_eq!(descriptor.id, "dsh"),
                RunnerKind::Acp => assert!(matches!(descriptor.id, "kiro" | "opencode")),
                RunnerKind::Stdio => {}
            }
        }
    }
}
