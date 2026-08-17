use std::{env, fs, path::PathBuf};

use anyhow::Result;
use serde_json::json;

use crate::model::StartRunRequest;

pub(crate) struct CommandSpec {
    pub command: String,
    pub args: Vec<String>,
    pub session_id: Option<String>,
}

pub(crate) fn model(request: &StartRunRequest) -> Option<&str> {
    request
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
}

pub(crate) fn require_resume_session(request: &StartRunRequest) -> Result<&str> {
    request
        .resume_session_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("resume_session_id is required"))
}

pub(crate) fn submit_input(
    message: &str,
    request_id: &str,
    delivery: &str,
    allow_fork: bool,
    last_turn_id: Option<&str>,
    protocol: &str,
) -> Result<String> {
    match delivery {
        "auto" | "steer" | "queue" => Ok(json!({
            "type":"submit",
            "message":message,
            "requestId":request_id,
            "delivery":delivery,
        })
        .to_string()),
        "fork" if allow_fork => Ok(json!({
            "type":"submit",
            "message":message,
            "requestId":request_id,
            "delivery":"fork",
            "lastTurnId":last_turn_id,
        })
        .to_string()),
        value => anyhow::bail!("unsupported {protocol} input delivery: {value}"),
    }
}

pub(crate) fn command_tokens(command: &str) -> Vec<&str> {
    command
        .split(|character: char| character.is_whitespace() || character == '/')
        .map(|token| token.trim_matches(['\'', '"']))
        .filter(|token| !token.is_empty())
        .collect()
}

pub(crate) fn option_value(command: &str, long: &str, short: Option<&str>) -> Option<String> {
    let tokens = command
        .split_whitespace()
        .map(|token| token.trim_matches(['\'', '"']))
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if *token == long || short.is_some_and(|short| *token == short) {
            return tokens.get(index + 1).map(|value| (*value).to_string());
        }
        if let Some(value) = token.strip_prefix(&format!("{long}=")) {
            return Some(value.to_string());
        }
        if let Some(short) = short {
            if let Some(value) = token.strip_prefix(&format!("{short}=")) {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub(crate) fn find_executable(binary: &str) -> Option<String> {
    let mut directories = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        directories.extend([
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join(".bun/bin"),
            home.join(".local/share/pnpm"),
        ]);
        let node_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(node_versions) {
            let mut bins = entries
                .flatten()
                .map(|entry| entry.path().join("bin"))
                .collect::<Vec<_>>();
            bins.sort_by(|left, right| right.cmp(left));
            directories.extend(bins);
        }
    }
    directories
        .into_iter()
        .map(|directory| directory.join(binary))
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().into_owned())
}

pub(crate) fn provider_command(binary: &str) -> Result<String> {
    find_executable(binary).ok_or_else(|| anyhow::anyhow!("{binary} executable was not found"))
}
