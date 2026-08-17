use anyhow::Result;

use crate::model::StartRunRequest;

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Shell;
pub(crate) static ADAPTER: Shell = Shell;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "shell",
    name: "Custom command",
    binary: None,
    structured_output: false,
    live_input: true,
    resume: false,
    fork: false,
    native_interrupt: false,
    queued_input: false,
    turn_rewind: false,
    provider_responses: false,
    runner: RunnerKind::Stdio,
    limitations: &["Resume and fork require provider-specific configuration"],
};

impl ProviderAdapter for Shell {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }
    fn build(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<support::CommandSpec> {
        Ok(support::CommandSpec {
            command: request
                .command
                .clone()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("command is required for shell provider"))?,
            args: request.args.clone(),
            session_id: None,
        })
    }
    fn encode_input(
        &self,
        message: &str,
        _request_id: &str,
        _delivery: &str,
        _last_turn_id: Option<&str>,
    ) -> Result<String> {
        Ok(message.to_string())
    }
}
