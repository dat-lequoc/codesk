use anyhow::Result;

use crate::{model::RunnerSpec, providers::RunnerKind};

pub(crate) mod acp;
pub(crate) mod codex_app_server;
pub(crate) mod dsh_web;
pub(crate) mod stdio;

pub(crate) async fn run(kind: RunnerKind, spec: &RunnerSpec) -> Result<std::process::ExitStatus> {
    match kind {
        RunnerKind::Stdio => stdio::run(spec).await,
        RunnerKind::Acp => acp::run(spec).await,
        RunnerKind::CodexAppServer => codex_app_server::run(spec).await,
        RunnerKind::DshWeb => dsh_web::run(spec).await,
    }
}
