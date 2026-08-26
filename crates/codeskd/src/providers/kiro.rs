use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

use anyhow::{Context, Result};
use serde_json::{Map, Value, json};

use crate::{
    event_codec,
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{
    EffortLevel, ModelControl, ModelPage, ProviderAdapter, ProviderDescriptor, RunnerKind,
    TerminalStatus, support,
};

pub(crate) struct Kiro;
pub(crate) static ADAPTER: Kiro = Kiro;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "kiro",
    name: "Kiro CLI",
    binary: Some("kiro-cli"),
    structured_output: true,
    live_input: true,
    resume: true,
    fork: false,
    native_interrupt: true,
    queued_input: true,
    turn_rewind: false,
    provider_responses: true,
    runner: RunnerKind::Acp,
    limitations: &[
        "Kiro ACP does not expose mid-turn steering; messages sent during an active turn are queued by Codesk",
    ],
};

impl ProviderAdapter for Kiro {
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
        anyhow::ensure!(
            request.operation.as_deref() != Some("fork"),
            "Kiro ACP does not expose a safe fork operation"
        );
        let mut args = vec!["acp".into()];
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(support::CommandSpec {
            command: support::provider_command("kiro-cli")?,
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
        anyhow::ensure!(
            request.operation.as_deref() != Some("fork"),
            "Kiro CLI does not expose a safe fork operation"
        );
        let mut args = vec!["chat".into()];
        if request.operation.as_deref() == Some("resume") {
            args.extend([
                "--resume-id".into(),
                support::require_resume_session(request)?.into(),
            ]);
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("kiro-cli")?,
            args,
            session_id: request.resume_session_id.clone(),
        }))
    }

    fn keep_terminal_parent_shell(&self) -> bool {
        true
    }

    fn terminal_ready(&self, screen: &str) -> bool {
        screen.contains("kiro_default")
            || screen.contains("ask a question or describe a task")
            || screen.contains("Type /usage")
    }

    fn terminal_overlay_command(&self, message: &str) -> Option<&'static str> {
        // `/usage` and `/context` render a full-screen panel that Kiro closes
        // with Escape; neither writes anything to the session transcript.
        matches!(message.trim(), "/usage" | "/context").then_some("Escape")
    }

    fn parse_terminal_usage(&self, screen: &str) -> Option<Value> {
        parse_usage_screen(screen)
    }

    fn parse_terminal_status(&self, screen: &str) -> Option<TerminalStatus> {
        parse_status_line(screen)
    }

    fn parse_model_page(&self, screen: &str) -> ModelPage {
        parse_model_page(screen)
    }

    fn effort_levels(&self) -> &'static [EffortLevel] {
        &EFFORT_LEVELS
    }

    fn model_control(&self) -> Option<ModelControl> {
        Some(ModelControl::Command)
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
        "kiro.session/cancel"
    }

    fn acp_agent_name(&self) -> &'static str {
        "Kiro"
    }

    fn matches_command(&self, command: &str) -> bool {
        command.to_lowercase().contains("kiro-cli")
    }

    fn command_session_id(&self, command: &str) -> Option<String> {
        support::option_value(command, "--resume-id", None)
            .filter(|value| uuid::Uuid::parse_str(value).is_ok())
    }

    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with(".jsonl") && path.contains("/.kiro/sessions/cli/")
    }

    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let stem = Path::new(path).file_stem()?.to_str()?.to_string();
        uuid::Uuid::parse_str(&stem).ok().map(|_| stem)
    }

    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_kiro(project, limit)
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

const PROMPT_LOOKBACK_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug)]
struct HistoryState {
    turn_seconds: Option<i64>,
    turn_offset: u64,
    fallback_seconds: i64,
}

impl HistoryState {
    fn new(fallback_seconds: i64) -> Self {
        Self {
            turn_seconds: None,
            turn_offset: 0,
            fallback_seconds,
        }
    }

    fn timestamp(&mut self, data: &Value, line_offset: u64, item_index: usize) -> String {
        if let Some(seconds) = data
            .pointer("/meta/timestamp")
            .and_then(Value::as_i64)
            .or_else(|| data.get("timestamp").and_then(Value::as_i64))
        {
            self.turn_seconds = Some(seconds);
            self.turn_offset = line_offset;
        }
        let Some(seconds) = self.turn_seconds.or(Some(self.fallback_seconds)) else {
            return String::new();
        };
        if seconds <= 0 {
            return String::new();
        }
        let nanos = line_offset
            .saturating_sub(self.turn_offset)
            .saturating_add(item_index as u64)
            .min(999_999_999) as u32;
        chrono::DateTime::from_timestamp(seconds, nanos)
            .map(|value| value.to_rfc3339())
            .unwrap_or_default()
    }
}

/// Kiro renders `/usage` as a terminal panel, not a transcript entry. Parse the
/// captured pane so a tmux-controlled run still reports usage to the UI.
pub(crate) fn parse_usage_screen(screen: &str) -> Option<Value> {
    let start = screen.rfind("Estimated Usage")?;
    let panel = &screen[start..];
    let mut plan = None;
    let mut resets_on = None;
    let mut credits_used = None;
    let mut credits_included = None;
    let mut percent = None;
    for line in panel.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Estimated Usage") {
            for part in rest
                .split('|')
                .map(str::trim)
                .filter(|part| !part.is_empty())
            {
                if let Some(date) = part.strip_prefix("resets on ") {
                    resets_on = Some(date.trim().to_string());
                } else {
                    plan = Some(part.to_string());
                }
            }
        }
        if let Some(rest) = line.strip_prefix("Credits (") {
            let inner = rest.split(')').next().unwrap_or_default();
            let mut numbers = inner
                .split_whitespace()
                .filter_map(|token| token.replace(',', "").parse::<f64>().ok());
            credits_used = numbers.next();
            credits_included = numbers.next();
        }
        if percent.is_none() {
            if let Some(token) = line
                .split_whitespace()
                .find(|token| token.ends_with('%') && token.len() > 1)
            {
                percent = token.trim_end_matches('%').parse::<f64>().ok();
            }
        }
    }
    let used = credits_used?;
    let mut payload = json!({
        "source": "terminal",
        "metering_usage": [{"unit":"credit","unitPlural":"credits","value":used}],
    });
    let map = payload.as_object_mut()?;
    if let Some(plan) = plan {
        map.insert("plan".into(), Value::String(plan));
    }
    if let Some(resets_on) = resets_on {
        map.insert("resets_on".into(), Value::String(resets_on));
    }
    if let Some(included) = credits_included {
        map.insert("credits_included".into(), json!(included));
    }
    if let Some(percent) = percent {
        map.insert("plan_usage_percentage".into(), json!(percent));
    }
    Some(payload)
}

/// Kiro names its reasoning levels the same way on the status line and in
/// `/effort`, so the picker shows the harness's own wording.
pub(crate) static EFFORT_LEVELS: [EffortLevel; 5] = [
    EffortLevel {
        id: "low",
        label: "low",
    },
    EffortLevel {
        id: "medium",
        label: "medium",
    },
    EffortLevel {
        id: "high",
        label: "high",
    },
    EffortLevel {
        id: "xhigh",
        label: "xhigh",
    },
    EffortLevel {
        id: "max",
        label: "max",
    },
];

/// Kiro paints a persistent status line above the composer, for example
/// `trusted · claude-opus-5 · xhigh · ◔ 4%    ~/proj/codesk · (main)`.
/// It is the only place a terminal-driven session reports its live model.
pub(crate) fn parse_status_line(screen: &str) -> Option<TerminalStatus> {
    for line in screen.lines().rev() {
        if !line.contains('·') {
            continue;
        }
        let fields = line
            .split('·')
            // The trailing `cwd · (branch)` segment is separated from the state
            // fields by a run of padding spaces.
            .map(|field| field.split("  ").next().unwrap_or_default().trim())
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        let Some(effort_index) = fields
            .iter()
            .position(|field| EFFORT_LEVELS.iter().any(|level| level.id == *field))
        else {
            continue;
        };
        if effort_index == 0 {
            continue;
        }
        let model = fields[effort_index - 1];
        if model.contains(' ') || model.is_empty() {
            continue;
        }
        let context_percentage = fields.get(effort_index + 1).and_then(|field| {
            field
                .trim_start_matches(|character: char| !character.is_ascii_digit())
                .trim_end_matches('%')
                .parse::<f64>()
                .ok()
        });
        return Some(TerminalStatus {
            model: Some(model.to_string()),
            effort: Some(fields[effort_index].to_string()),
            agent: (effort_index >= 2).then(|| fields[0].to_string()),
            context_percentage,
        });
    }
    None
}

/// Parse one page of Kiro's `/model` picker. Rows look like
/// `❯ claude-opus-5        2.20x credits    Claude Opus 5 … [active]`.
pub(crate) fn parse_model_page(screen: &str) -> ModelPage {
    let mut models = Vec::new();
    // Kiro shows eight rows and reports the remainder as `(+11 more)`.
    let more = screen.lines().find_map(|line| {
        let line = line.trim();
        line.strip_prefix("(+")?
            .strip_suffix("more)")?
            .trim()
            .parse::<usize>()
            .ok()
    });
    for line in screen.lines() {
        let row = line.trim_start_matches(['❯', ' ']).trim_end();
        let Some(credits_at) = row.find("x credits") else {
            continue;
        };
        let mut head = row[..credits_at].split_whitespace();
        let Some(id) = head.next() else { continue };
        let multiplier = head.next_back().and_then(|value| value.parse::<f64>().ok());
        let description = row[credits_at + "x credits".len()..].trim();
        let active = description.ends_with("[active]");
        // Codesk runs detached panes at tmux's default 80 columns, so Kiro
        // truncates the description and the `[active]` marker may be cut off.
        // The live model is read from the status line instead.
        let description = description
            .trim_end_matches("[active]")
            .trim()
            .trim_end_matches(['.', '\u{2026}'])
            .trim();
        models.push(json!({
            "id": id,
            "description": description,
            "credit_multiplier": multiplier,
            "active": active,
        }));
    }
    ModelPage { models, more }
}

pub(crate) fn messages(
    path: &Path,
    after: Option<&str>,
    transcript_bytes: u64,
    stream_bytes: u64,
    max_messages: usize,
) -> Result<Vec<SessionMessage>> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let metadata = file.metadata()?;
    let length = metadata.len();
    let fallback_seconds = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default();
    let tail_bytes = if after.is_some() {
        stream_bytes
    } else {
        transcript_bytes
    };
    let target_start = length.saturating_sub(tail_bytes);
    let (start, prompt_aligned) = prompt_aligned_start(&mut file, target_start)?;
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::new(file.take(length.saturating_sub(start)));
    let mut absolute_offset = start;
    if start > 0 && !prompt_aligned {
        let mut partial = String::new();
        absolute_offset = absolute_offset.saturating_add(reader.read_line(&mut partial)? as u64);
    }

    let mut state = HistoryState::new(fallback_seconds);
    let mut result = Vec::new();
    let mut line = String::new();
    let mut line_number = 0_usize;
    loop {
        line.clear();
        let line_offset = absolute_offset;
        let bytes = reader.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        absolute_offset = absolute_offset.saturating_add(bytes as u64);
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            line_number += 1;
            continue;
        };
        for message in parse_history_line(&value, line_number, line_offset, &mut state) {
            if after.is_none_or(|cursor| message.timestamp.as_str() >= cursor) {
                result.push(message);
            }
        }
        if result.len() >= max_messages {
            break;
        }
        line_number += 1;
    }
    Ok(result)
}

fn prompt_aligned_start(file: &mut File, target_start: u64) -> Result<(u64, bool)> {
    if target_start == 0 {
        return Ok((0, true));
    }
    let search_start = target_start.saturating_sub(PROMPT_LOOKBACK_BYTES);
    let mut bytes = vec![0; target_start.saturating_sub(search_start) as usize];
    file.seek(SeekFrom::Start(search_start))?;
    file.read_exact(&mut bytes)?;
    let needle = b"\"kind\":\"Prompt\"";
    let Some(match_offset) = bytes
        .windows(needle.len())
        .rposition(|window| window == needle)
    else {
        return Ok((target_start, false));
    };
    let line_offset = bytes[..match_offset]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|offset| offset + 1)
        .unwrap_or_default();
    Ok((search_start + line_offset as u64, true))
}

fn parse_history_line(
    value: &Value,
    line_number: usize,
    line_offset: u64,
    state: &mut HistoryState,
) -> Vec<SessionMessage> {
    let kind = value["kind"].as_str().unwrap_or_default();
    let data = &value["data"];
    let message_id = string(&data["message_id"]).unwrap_or_else(|| line_number.to_string());
    let mut result = Vec::new();
    match kind {
        "Prompt" => {
            let text = data["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["data"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let timestamp = state.timestamp(data, line_offset, 0);
            if !text.trim().is_empty() {
                result.push(SessionMessage {
                    id: message_id,
                    timestamp,
                    role: "user".to_string(),
                    text,
                    kind: "message".to_string(),
                    meta: None,
                    duration_ms: None,
                });
            }
        }
        "AssistantMessage" => {
            for (index, item) in data["content"].as_array().into_iter().flatten().enumerate() {
                match item["kind"].as_str() {
                    Some("text") => {
                        if let Some(text) =
                            item["data"].as_str().filter(|text| !text.trim().is_empty())
                        {
                            result.push(SessionMessage {
                                id: format!("{message_id}:text:{index}"),
                                timestamp: state.timestamp(data, line_offset, index),
                                role: "assistant".to_string(),
                                text: text.to_string(),
                                kind: "message".to_string(),
                                meta: None,
                                duration_ms: None,
                            });
                        }
                    }
                    Some("toolUse") => {
                        let tool_data = nested_data(item);
                        let tool =
                            string(&tool_data["name"]).unwrap_or_else(|| "Kiro tool".to_string());
                        let call_id = string(&tool_data["toolUseId"]);
                        let input = tool_data.get("input").cloned().unwrap_or(Value::Null);
                        let display = tool_display(&tool, &input);
                        let changes = tool_changes(&tool, &input);
                        let mut meta = Map::from_iter([
                            ("tool".to_string(), Value::String(tool.clone())),
                            ("display".to_string(), Value::String(display)),
                            ("input".to_string(), input),
                            ("status".to_string(), Value::String("running".to_string())),
                            ("raw".to_string(), item.clone()),
                        ]);
                        if let Some(call_id) = call_id {
                            meta.insert("call_id".to_string(), Value::String(call_id));
                        }
                        if !changes.is_empty() {
                            meta.insert("changes".to_string(), Value::Array(changes));
                        }
                        result.push(SessionMessage {
                            id: format!("{message_id}:tool:{index}"),
                            timestamp: state.timestamp(data, line_offset, index),
                            role: "assistant".to_string(),
                            text: String::new(),
                            kind: if meta.contains_key("changes") {
                                "file_change"
                            } else {
                                "tool"
                            }
                            .to_string(),
                            meta: Some(Value::Object(meta)),
                            duration_ms: None,
                        });
                    }
                    _ => {}
                }
            }
            // Kiro appends one AssistantMessage per step and writes nothing when
            // the turn ends, so the step that stops asking for tools is the
            // boundary. Only Prompt records carry a real clock, so the turn's
            // length is not something this transcript can honestly report.
            let content = data["content"].as_array();
            let asked_for_a_tool =
                content.is_some_and(|items| items.iter().any(|item| item["kind"] == "toolUse"));
            if !asked_for_a_tool {
                result.push(SessionMessage {
                    id: format!("{message_id}:turn"),
                    timestamp: state.timestamp(data, line_offset, content.map_or(0, Vec::len)),
                    role: "assistant".to_string(),
                    text: String::new(),
                    kind: "turn_completed".to_string(),
                    meta: None,
                    duration_ms: None,
                });
            }
        }
        "ToolResults" => {
            for (index, item) in data["content"].as_array().into_iter().flatten().enumerate() {
                let tool_data = nested_data(item);
                let call_id = string(&tool_data["toolUseId"]);
                let output = content_output(&tool_data["content"]);
                let status = string(&tool_data["status"]).unwrap_or_default();
                let failed = matches!(status.as_str(), "error" | "failed" | "failure");
                let mut meta = Map::from_iter([
                    ("output".to_string(), output.clone()),
                    (
                        "status".to_string(),
                        Value::String(if failed { "failed" } else { "completed" }.to_string()),
                    ),
                    ("raw".to_string(), item.clone()),
                ]);
                if let Some(call_id) = call_id {
                    meta.insert("call_id".to_string(), Value::String(call_id));
                }
                result.push(SessionMessage {
                    id: format!("{message_id}:result:{index}"),
                    timestamp: state.timestamp(data, line_offset, index),
                    role: "assistant".to_string(),
                    text: output.as_str().unwrap_or_default().to_string(),
                    kind: "tool_output".to_string(),
                    meta: Some(Value::Object(meta)),
                    duration_ms: None,
                });
            }
        }
        _ => {}
    }
    result
}

fn nested_data(value: &Value) -> &Value {
    value
        .get("data")
        .filter(|data| data.is_object())
        .unwrap_or(value)
}

fn content_output(content: &Value) -> Value {
    let values = content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("data").cloned())
        .collect::<Vec<_>>();
    match values.len() {
        0 => Value::Null,
        1 => values.into_iter().next().unwrap_or(Value::Null),
        _ => Value::Array(values),
    }
}

fn tool_display(tool: &str, input: &Value) -> String {
    input
        .get("__tool_use_purpose")
        .or_else(|| input.get("tool_use_purpose"))
        .or_else(|| input.get("command"))
        .or_else(|| input.get("path"))
        .or_else(|| input.get("pattern"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(tool)
        .to_string()
}

fn tool_changes(tool: &str, input: &Value) -> Vec<Value> {
    if tool != "write" {
        return Vec::new();
    }
    input
        .get("path")
        .and_then(Value::as_str)
        .map(|path| {
            vec![json!({
                "path":path,
                "kind":input.get("command").and_then(Value::as_str).unwrap_or("edit"),
            })]
        })
        .unwrap_or_default()
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use serde_json::json;
    use uuid::Uuid;

    use super::{
        ADAPTER, HistoryState, messages, parse_history_line, parse_model_page, parse_status_line,
        parse_usage_screen,
    };
    use crate::providers::ProviderAdapter;

    #[test]
    fn reads_the_live_model_and_effort_from_the_status_line() {
        // Verbatim status line from a real kiro-cli pane.
        let screen = "  KIRO_E2E_OK\n\u{25b8} Credits: 0.28 \u{2022} Time: 2s\n────────\ntrusted \u{b7} claude-sonnet-5 \u{b7} high \u{b7} \u{25d4} 4%                    ~/proj/codesk \u{b7} (main)\n ask a question or describe a task \u{21b5}\n";
        let status = parse_status_line(screen).expect("status line should parse");
        assert_eq!(status.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(status.effort.as_deref(), Some("high"));
        assert_eq!(status.agent.as_deref(), Some("trusted"));
        assert_eq!(status.context_percentage, Some(4.0));
    }

    #[test]
    fn ignores_conversation_text_that_merely_contains_separators() {
        assert!(parse_status_line("a \u{b7} b \u{b7} c\n").is_none());
    }

    #[test]
    fn parses_a_page_of_the_model_picker_and_marks_the_active_model() {
        // Verbatim rows from a real `/model` picker.
        let screen = "Select model:   type to search\n\u{276f} auto                 1.00x credits    Models chosen by task for optimal usage and consistent quality\n  claude-opus-5        2.20x credits    Claude Opus 5 model with 1M context window [active]\n  gpt-5.6-luna         0.10x credits    Experimental preview of OpenAI GPT 5.6 Luna with 272k context window\n(+11 more)\n esc to close \u{b7} \u{2191}\u{2193} to navigate \u{b7} \u{21b5} to select\n";
        let page = parse_model_page(screen);
        assert_eq!(page.more, Some(11));
        let models = page.models;
        assert_eq!(models.len(), 3);
        assert_eq!(models[0]["id"], "auto");
        assert_eq!(models[0]["credit_multiplier"], json!(1.0));
        assert_eq!(models[0]["active"], json!(false));
        assert_eq!(models[1]["id"], "claude-opus-5");
        assert_eq!(models[1]["active"], json!(true));
        assert_eq!(
            models[1]["description"],
            "Claude Opus 5 model with 1M context window"
        );
        assert_eq!(models[2]["credit_multiplier"], json!(0.1));

        // At tmux's default 80 columns Kiro truncates the description.
        let narrow =
            "  claude-opus-5        2.20x credits    Claude Opus 5 model with 1M context...\n";
        let truncated = parse_model_page(narrow).models;
        assert_eq!(truncated[0]["id"], "claude-opus-5");
        assert_eq!(
            truncated[0]["description"],
            "Claude Opus 5 model with 1M context"
        );
    }

    #[test]
    fn parses_the_kiro_usage_panel_from_a_captured_pane() {
        // Verbatim capture of `/usage` from a real kiro-cli pane.
        let screen = "  Reply with exactly KIRO_USAGE_UI_OK and nothing else.\n\n  KIRO_USAGE_UI_OK\n\n\u{25b8} Credits: 0.28 \u{2022} Time: 4s\n\n────────────────────────\n /usage\n────────────────────────\n Estimated Usage | resets on 2026-09-01 | KIRO PRO+\n Credits (1596.69 of 2000 covered in plan)\n\n ██████████████████████████████████████████████████ 79.8%\n\n Additional credits\n────────────────────────\n esc to close                       Tab to switch to /context\n";
        let usage = parse_usage_screen(screen).expect("usage panel should parse");
        assert_eq!(usage["plan"], "KIRO PRO+");
        assert_eq!(usage["resets_on"], "2026-09-01");
        assert_eq!(usage["credits_included"], json!(2000.0));
        assert_eq!(usage["plan_usage_percentage"], json!(79.8));
        assert_eq!(usage["metering_usage"][0]["value"], json!(1596.69));
        assert_eq!(usage["metering_usage"][0]["unitPlural"], "credits");
    }

    #[test]
    fn ignores_a_pane_without_a_usage_panel() {
        assert!(parse_usage_screen("kiro_default\n> ask a question").is_none());
    }

    #[test]
    fn recognizes_terminal_only_commands() {
        assert_eq!(ADAPTER.terminal_overlay_command("/usage"), Some("Escape"));
        assert_eq!(
            ADAPTER.terminal_overlay_command(" /context "),
            Some("Escape")
        );
        assert_eq!(ADAPTER.terminal_overlay_command("/compact"), None);
        assert_eq!(ADAPTER.terminal_overlay_command("hello"), None);
    }

    #[test]
    fn kiro_terminal_keeps_a_parent_shell() {
        assert!(ADAPTER.keep_terminal_parent_shell());
    }

    #[test]
    fn detects_the_ready_kiro_terminal() {
        assert!(ADAPTER.terminal_ready("kiro_default · claude-opus-5 · xhigh"));
        assert!(!ADAPTER.terminal_ready("An early release of Kiro CLI V3"));
    }

    #[test]
    fn parses_real_kiro_tool_calls_and_results() {
        let mut state = HistoryState::new(0);
        let prompt = parse_history_line(
            &json!({
                "kind":"Prompt",
                "data":{
                    "message_id":"prompt-1",
                    "content":[{"kind":"text","data":"Read package.json"}],
                    "meta":{"timestamp":1786837344_i64}
                }
            }),
            0,
            100,
            &mut state,
        );
        let assistant = parse_history_line(
            &json!({
                "kind":"AssistantMessage",
                "data":{
                    "message_id":"assistant-1",
                    "content":[
                        {"kind":"text","data":"Checking it now."},
                        {"kind":"toolUse","data":{"toolUseId":"tool-1","name":"shell","input":{"command":"cat package.json"}}}
                    ]
                }
            }),
            1,
            220,
            &mut state,
        );
        let result = parse_history_line(
            &json!({
                "kind":"ToolResults",
                "data":{
                    "message_id":"result-1",
                    "content":[{"kind":"toolResult","data":{"toolUseId":"tool-1","status":"success","content":[{"kind":"json","data":{"stdout":r#"{"name":"codesk"}"#,"stderr":""}}]}}]
                }
            }),
            2,
            440,
            &mut state,
        );

        assert_eq!(prompt[0].text, "Read package.json");
        assert_eq!(assistant[1].kind, "tool");
        assert_eq!(assistant[1].meta.as_ref().unwrap()["tool"], "shell");
        assert_eq!(assistant[1].meta.as_ref().unwrap()["call_id"], "tool-1");
        assert_eq!(
            assistant[1].meta.as_ref().unwrap()["input"]["command"],
            "cat package.json"
        );
        assert_eq!(result[0].meta.as_ref().unwrap()["call_id"], "tool-1");
        assert_eq!(
            result[0].meta.as_ref().unwrap()["output"]["stdout"],
            "{\"name\":\"codesk\"}"
        );
        assert!(assistant[0].timestamp > prompt[0].timestamp);
        assert!(result[0].timestamp > assistant[1].timestamp);
    }

    #[test]
    fn incremental_read_keeps_the_complete_final_assistant_message() {
        let path = fixture_path();
        let final_text =
            "Final result\n\n".to_string() + &"All requested work is complete. ".repeat(120);
        let values = [
            json!({"version":"v1","kind":"Prompt","data":{"message_id":"prompt","content":[{"kind":"text","data":"Finish the task"}],"meta":{"timestamp":1786912345_i64}}}),
            json!({"version":"v1","kind":"AssistantMessage","data":{"message_id":"assistant-tool","content":[{"kind":"toolUse","data":{"toolUseId":"tool-1","name":"shell","input":{"command":"true"}}}]}}),
            json!({"version":"v1","kind":"ToolResults","data":{"message_id":"result","content":[{"kind":"toolResult","data":{"toolUseId":"tool-1","status":"success","content":[{"kind":"json","data":{"stdout":"ok","stderr":""}}]}}]}}),
            json!({"version":"v1","kind":"AssistantMessage","data":{"message_id":"assistant-final","content":[{"kind":"text","data":final_text}]}}),
        ];
        fs::write(
            &path,
            values
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let full = messages(&path, None, 8 * 1024 * 1024, 256 * 1024, 4000).unwrap();
        let cursor = full
            .iter()
            .find(|message| message.kind == "tool_output")
            .unwrap()
            .timestamp
            .clone();
        let incremental =
            messages(&path, Some(&cursor), 8 * 1024 * 1024, 256 * 1024, 4000).unwrap();
        let final_message = incremental
            .iter()
            .find(|message| message.id == "assistant-final:text:0")
            .unwrap();
        assert_eq!(
            final_message.text.len(),
            "Final result\n\n".len() + "All requested work is complete. ".len() * 120
        );
        assert!(
            final_message
                .text
                .ends_with("All requested work is complete. ")
        );
        fs::remove_file(path).unwrap();
    }

    fn fixture_path() -> PathBuf {
        std::env::temp_dir().join(format!("codesk-kiro-history-{}.jsonl", Uuid::new_v4()))
    }
}
