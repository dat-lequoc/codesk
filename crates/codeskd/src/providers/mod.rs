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

/// One visible page of an interactive model picker. `more` is the harness's own
/// count of rows below the fold, which is the only reliable way to know when
/// paging is complete.
#[derive(Debug, Clone, Default)]
pub(crate) struct ModelPage {
    pub models: Vec<Value>,
    pub more: Option<usize>,
}

/// Live harness state read from a terminal status line.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TerminalStatus {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub agent: Option<String>,
    pub context_percentage: Option<f64>,
}

/// One reasoning level a harness accepts, carrying the label its own picker
/// shows so Codesk does not invent names the operator has never seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EffortLevel {
    pub id: &'static str,
    pub label: &'static str,
}

/// How a terminal-driven harness lets Codesk change its model and effort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelControl {
    /// `/model <id>` and `/effort <level>` accept an argument and apply
    /// immediately, and the catalog picker scrolls a few rows at a time.
    Command,
    /// A single `/model` picker walks a numbered model page into a numbered
    /// reasoning page, and a row is chosen by typing its number.
    NumberedPicker,
}

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

    fn keep_terminal_parent_shell(&self) -> bool {
        false
    }

    fn terminal_ready(&self, _screen: &str) -> bool {
        true
    }

    /// When `Some`, the tmux queue uses the visible pane instead of the
    /// transcript to decide whether the harness can accept the next prompt.
    /// `None` keeps the transcript-only gate used by Codex and the other
    /// adapters that do not implement a TUI ready check.
    fn terminal_input_blocked(&self, _screen: &str) -> Option<bool> {
        None
    }

    /// A key to send during pane startup before the composer is ready.
    /// Claude's first-run folder trust dialog is the current case: without
    /// dismissing it, the opening prompt is typed into the dialog.
    fn terminal_startup_key(&self, _screen: &str) -> Option<&'static str> {
        None
    }

    /// Whether the pane is showing a picker Codesk drives, which Escape walks
    /// back out of. An abandoned picker covers the composer, so it has to be
    /// closed before the pane takes a prompt again — but only a picker may be
    /// escaped, since the same key quits some startup dialogs.
    fn terminal_picker_open(&self, _screen: &str) -> bool {
        false
    }

    /// A command that the harness renders in its own terminal UI instead of the
    /// conversation transcript. Codesk captures the pane afterwards so the run
    /// still gets an event, and dismisses the overlay so the pane stays
    /// steerable. Returns the key that closes the overlay.
    fn terminal_overlay_command(&self, _message: &str) -> Option<&'static str> {
        None
    }

    /// Parse a captured terminal overlay into a usage payload.
    fn parse_terminal_usage(&self, _screen: &str) -> Option<Value> {
        None
    }

    /// Read the harness status line so Codesk can report the live model and
    /// effort for a session it drives through a terminal instead of a protocol.
    fn parse_terminal_status(&self, _screen: &str) -> Option<TerminalStatus> {
        None
    }

    /// Parse one visible page of the harness's interactive model picker.
    fn parse_model_page(&self, _screen: &str) -> ModelPage {
        ModelPage::default()
    }

    /// The reasoning levels this harness accepts, in the order it lists them.
    fn effort_levels(&self) -> &'static [EffortLevel] {
        &[]
    }

    /// `None` when Codesk can read the model but not change it.
    fn model_control(&self) -> Option<ModelControl> {
        None
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
                model_picker: adapter.model_control().is_some(),
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

pub(crate) fn keep_terminal_parent_shell(provider: &str) -> bool {
    get(provider).is_some_and(|adapter| adapter.keep_terminal_parent_shell())
}

pub(crate) fn terminal_ready(provider: &str, screen: &str) -> bool {
    get(provider).is_none_or(|adapter| adapter.terminal_ready(screen))
}

pub(crate) fn terminal_startup_key(provider: &str, screen: &str) -> Option<&'static str> {
    get(provider).and_then(|adapter| adapter.terminal_startup_key(screen))
}

pub(crate) fn terminal_picker_open(provider: &str, screen: &str) -> bool {
    get(provider).is_some_and(|adapter| adapter.terminal_picker_open(screen))
}

pub(crate) fn terminal_input_blocked(provider: &str, screen: &str) -> Option<bool> {
    get(provider).and_then(|adapter| adapter.terminal_input_blocked(screen))
}

pub(crate) fn gates_terminal_input(provider: &str) -> bool {
    get(provider).is_some_and(|adapter| adapter.terminal_input_blocked("").is_some())
}

pub(crate) fn terminal_overlay_command(provider: &str, message: &str) -> Option<&'static str> {
    get(provider).and_then(|adapter| adapter.terminal_overlay_command(message))
}

pub(crate) fn parse_terminal_usage(provider: &str, screen: &str) -> Option<Value> {
    get(provider).and_then(|adapter| adapter.parse_terminal_usage(screen))
}

pub(crate) fn parse_terminal_status(provider: &str, screen: &str) -> Option<TerminalStatus> {
    get(provider).and_then(|adapter| adapter.parse_terminal_status(screen))
}

pub(crate) fn parse_model_page(provider: &str, screen: &str) -> ModelPage {
    get(provider)
        .map(|adapter| adapter.parse_model_page(screen))
        .unwrap_or_default()
}

pub(crate) fn effort_levels(provider: &str) -> &'static [EffortLevel] {
    get(provider).map_or(&[], |adapter| adapter.effort_levels())
}

pub(crate) fn model_control(provider: &str) -> Option<ModelControl> {
    get(provider).and_then(|adapter| adapter.model_control())
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
