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

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

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
    ) -> Result<Vec<SessionMessage>> {
        sessions::file_messages_for_project(project, DESCRIPTOR.id, native_session_id, after)
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

    use super::{HistoryState, messages, parse_history_line};

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
