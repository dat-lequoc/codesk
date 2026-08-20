use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EventCodec {
    Default,
    Acp,
    Dsh,
    Antigravity,
}
pub(crate) fn normalize_with_codec(
    codec: EventCodec,
    provider: &str,
    channel: &str,
    line: &str,
) -> (String, Option<String>, Value, Option<Value>, Option<String>) {
    let Ok(raw) = serde_json::from_str::<Value>(line) else {
        return (
            if channel == "stderr" {
                "stderr"
            } else {
                "output"
            }
            .into(),
            None,
            json!({"text":line}),
            None,
            None,
        );
    };
    if codec == EventCodec::Acp {
        return normalize_acp(provider, raw);
    }
    if codec == EventCodec::Dsh {
        return normalize_dsh(raw);
    }
    if codec == EventCodec::Antigravity {
        return normalize_agy(raw);
    }
    let event_type = raw
        .get("method")
        .or_else(|| raw.get("type"))
        .and_then(Value::as_str)
        .unwrap_or(if raw.get("id").is_some() {
            "rpc.response"
        } else {
            "event"
        })
        .to_string();
    let session_id = raw
        .pointer("/sessionId")
        .or_else(|| raw.pointer("/result/thread/id"))
        .or_else(|| raw.pointer("/params/thread/id"))
        .or_else(|| raw.pointer("/params/threadId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let text = extract_text(&raw).unwrap_or_else(|| {
        if provider == "codex" || event_type == "rpc.response" {
            String::new()
        } else {
            raw.to_string()
        }
    });
    let kind = if event_type == "codesk.input.ack" {
        if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
            "input.accepted"
        } else {
            "input.rejected"
        }
    } else if event_type == "codesk.control.ack" {
        if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
            "control.acknowledged"
        } else {
            "control.rejected"
        }
    } else if event_type == "codesk.session" {
        "thread.session"
    } else if event_type == "codesk.queue" {
        match raw.get("action").and_then(Value::as_str) {
            Some("added") => "queue.added",
            Some("started") => "queue.started",
            Some("paused") => "queue.paused",
            Some("removed") => "queue.removed",
            Some("failed") => "queue.failed",
            _ => "queue.updated",
        }
    } else if event_type == "rpc.response" {
        if raw.get("error").is_some() {
            "run.error"
        } else {
            "provider.response"
        }
    } else if event_type.contains("requestApproval") {
        "approval.required"
    } else if event_type.contains("requestUserInput") {
        "input.required"
    } else if event_type == "turn/started" {
        "turn.started"
    } else if event_type == "turn/completed" {
        "turn.completed"
    } else if event_type == "item/agentMessage/delta" {
        "assistant.message"
    } else if matches!(
        event_type.as_str(),
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta"
    ) {
        "reasoning.message"
    } else if matches!(
        event_type.as_str(),
        "item/commandExecution/outputDelta"
            | "item/commandExecution/terminalInteraction"
            | "item/fileChange/outputDelta"
    ) {
        "tool.output"
    } else if event_type == "item/completed"
        && raw.pointer("/params/item/type").and_then(Value::as_str) == Some("userMessage")
    {
        "user.message"
    } else if event_type == "item/completed"
        && raw.pointer("/params/item/type").and_then(Value::as_str) == Some("agentMessage")
    {
        "assistant.message"
    } else if event_type.contains("fileChange") {
        "file.change"
    } else if event_type.contains("commandExecution") || event_type.contains("tool") {
        "tool.output"
    } else if event_type.contains("error") {
        "run.error"
    } else if event_type.contains("assistant") || event_type.contains("message") {
        "assistant.message"
    } else {
        "agent.event"
    };
    (
        kind.into(),
        Some(format!("{provider}.{event_type}")),
        json!({
            "text":text,
            "rpc_id":raw.get("id"),
            "method":raw.get("method"),
            "turn_id":raw.pointer("/params/turnId")
                .or_else(|| raw.pointer("/params/turn/id"))
                .or_else(|| raw.pointer("/result/turn/id")),
            "item_id":raw.pointer("/params/itemId")
                .or_else(|| raw.pointer("/params/item/id")),
            "request_id":raw.get("requestId").or_else(|| raw.pointer("/params/requestId")),
            "action":raw.get("action"),
            "queue_id":raw.get("queueId"),
            "pending":raw.get("pending"),
            "last_turn_id":raw.get("lastTurnId"),
        }),
        Some(raw),
        session_id,
    )
}

fn normalize_agy(raw: Value) -> (String, Option<String>, Value, Option<Value>, Option<String>) {
    let event_type = raw.get("event").and_then(Value::as_str).unwrap_or("event");
    let session_id = raw
        .get("conversation_id")
        .or_else(|| raw.pointer("/step_update/conversation_id"))
        .or_else(|| raw.pointer("/result/conversation_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if event_type == "init" {
        return (
            "thread.session".to_string(),
            Some("agy.init".to_string()),
            json!({
                "text":"",
                "cwd":raw.pointer("/init/cwd"),
                "permission_mode":raw.pointer("/init/permission_mode"),
            }),
            Some(raw),
            session_id,
        );
    }
    if event_type == "result" {
        let result = raw.get("result").unwrap_or(&Value::Null);
        let usage = result.get("usage").unwrap_or(&Value::Null);
        return (
            if result.get("status").and_then(Value::as_str) == Some("SUCCESS") {
                "usage.updated"
            } else {
                "run.error"
            }
            .to_string(),
            Some("agy.result".to_string()),
            json!({
                "text":if result.get("status").and_then(Value::as_str) == Some("SUCCESS") { "" } else { result.get("response").and_then(Value::as_str).unwrap_or("Antigravity turn failed") },
                "status":result.get("status"),
                "duration_seconds":result.get("duration_seconds"),
                "num_turns":result.get("num_turns"),
                "input_tokens":usage.get("input_tokens"),
                "output_tokens":usage.get("output_tokens"),
                "thinking_tokens":usage.get("thinking_tokens"),
                "cache_read_tokens":usage.get("cache_read_tokens"),
                "total_tokens":usage.get("total_tokens"),
            }),
            Some(raw),
            session_id,
        );
    }

    let step = raw.get("step_update").unwrap_or(&Value::Null);
    let step_type = step
        .get("step_type")
        .and_then(Value::as_str)
        .unwrap_or("step_update");
    let step_index = step.get("step_index").and_then(Value::as_u64);
    let state = step.get("state").and_then(Value::as_str).unwrap_or("");
    let tool = step.get("tool_info").unwrap_or(&Value::Null);
    let tool_name = tool
        .get("name")
        .or_else(|| step.get("tool_name"))
        .and_then(Value::as_str)
        .unwrap_or("Antigravity tool");
    let parameters = tool.get("parameters").unwrap_or(&Value::Null);
    let output = tool.get("output").unwrap_or(&Value::Null);
    let path = agy_tool_path(parameters);
    let file_change = agy_file_tool(tool_name) && path.is_some();
    let text = if step_type == "agent_response" {
        step.get("text_delta")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else if step_type.contains("thinking") || step_type.contains("reasoning") {
        step.get("text_delta")
            .or_else(|| step.get("thinking"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        agy_value_text(output)
    };
    let tool_title = parameters
        .get("CommandLine")
        .or_else(|| parameters.get("command"))
        .or_else(|| parameters.get("path"))
        .and_then(Value::as_str)
        .unwrap_or(tool_name);
    let kind = if step_type == "agent_response" {
        "assistant.message"
    } else if step_type.contains("thinking") || step_type.contains("reasoning") {
        "reasoning.message"
    } else if step_type == "tool" && file_change {
        "file.change"
    } else if step_type == "tool" {
        "tool.output"
    } else {
        "agent.event"
    };
    let changes = path
        .map(|path| vec![json!({"path":path,"kind":agy_change_kind(tool_name)})])
        .unwrap_or_default();
    (
        kind.to_string(),
        Some(format!("agy.{event_type}/{step_type}")),
        json!({
            "text":text,
            "item_id":step_index.map(|index| format!("agy-step-{index}")),
            "sequence":step_index,
            "tool_title":if step_type == "tool" { Some(tool_title) } else { None },
            "tool_kind":if step_type == "tool" { Some(tool_name) } else { None },
            "tool_status":if step_type == "tool" { Some(if state == "DONE" { "completed" } else if state == "ERROR" || state == "FAILED" { "failed" } else { "in_progress" }) } else { None },
            "raw_input":if step_type == "tool" { Some(parameters) } else { None },
            "raw_output":if step_type == "tool" { Some(output) } else { None },
            "changes":changes,
        }),
        Some(raw),
        session_id,
    )
}

fn agy_value_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        value => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn agy_file_tool(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "write", "edit", "replace", "patch", "delete", "move", "rename",
    ]
    .iter()
    .any(|candidate| name.contains(candidate))
}

fn agy_change_kind(name: &str) -> &'static str {
    let name = name.to_ascii_lowercase();
    if name.contains("delete") {
        "delete"
    } else if name.contains("move") || name.contains("rename") {
        "move"
    } else {
        "edit"
    }
}

fn agy_tool_path(parameters: &Value) -> Option<String> {
    [
        "path",
        "Path",
        "file_path",
        "FilePath",
        "AbsolutePath",
        "TargetFile",
        "TargetPath",
    ]
    .into_iter()
    .find_map(|key| {
        parameters
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn normalize_dsh(raw: Value) -> (String, Option<String>, Value, Option<Value>, Option<String>) {
    let base_type = raw.get("type").and_then(Value::as_str).unwrap_or("event");
    let session_id = raw
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    if base_type != "dsh.event" {
        let kind = match base_type {
            "codesk.input.ack" => {
                if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
                    "input.accepted"
                } else {
                    "input.rejected"
                }
            }
            "codesk.control.ack" => {
                if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
                    "control.acknowledged"
                } else {
                    "control.rejected"
                }
            }
            "codesk.session" => "thread.session",
            "codesk.usage" => "usage.updated",
            "codesk.queue" => match raw.get("action").and_then(Value::as_str) {
                Some("added") => "queue.added",
                Some("started") => "queue.started",
                Some("paused") => "queue.paused",
                Some("removed") => "queue.removed",
                Some("failed") => "queue.failed",
                _ => "queue.updated",
            },
            _ => "agent.event",
        };
        let usage = raw.get("usage").unwrap_or(&Value::Null);
        let tokens = usage.get("tokenUsage").unwrap_or(&Value::Null);
        let pressure = usage.get("contextPressure").unwrap_or(&Value::Null);
        let projected = pressure
            .get("projectedTokens")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        let context_window = pressure
            .get("contextWindow")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        let context_percentage = if context_window > 0.0 {
            Some(projected * 100.0 / context_window)
        } else {
            None
        };
        return (
            kind.to_string(),
            Some(format!("dsh.{base_type}")),
            json!({
                "text":raw.get("message").and_then(Value::as_str).unwrap_or(""),
                "request_id":raw.get("requestId"),
                "action":raw.get("action"),
                "queue_id":raw.get("queueId"),
                "pending":raw.get("pending"),
                "last_turn_id":raw.get("lastTurnId"),
                "token_usage":tokens,
                "context_pressure":pressure,
                "context_breakdown":usage.get("contextBreakdown"),
                "session_stats":usage.get("sessionStats"),
                "uncached_input_tokens":tokens.get("uncachedInputTokens"),
                "output_tokens":tokens.get("outputTokens"),
                "cache_read_tokens":tokens.get("cacheReadTokens"),
                "cache_write_tokens":tokens.get("cacheWriteTokens"),
                "pressure_tokens":pressure.get("pressureTokens"),
                "projected_tokens":pressure.get("projectedTokens"),
                "context_window":pressure.get("contextWindow"),
                "context_usage_percentage":context_percentage,
                "context_size":pressure.get("contextWindow"),
            }),
            Some(raw),
            session_id,
        );
    }

    let event = raw.get("event").unwrap_or(&Value::Null);
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("event");
    let data = event.get("data").unwrap_or(&Value::Null);
    let view = raw.pointer("/view/view").unwrap_or(&Value::Null);
    let chunk_type = data.pointer("/chunk/type").and_then(Value::as_str);
    let tool_kind = view
        .get("kind")
        .or_else(|| view.get("card"))
        .and_then(Value::as_str)
        .or_else(|| data.get("name").and_then(Value::as_str));
    let file_change = matches!(
        tool_kind,
        Some("edit" | "write" | "delete" | "move" | "patch" | "str_replace_editor")
    );
    let kind = match event_type {
        "turn/start" => "turn.started",
        "turn/end" => "turn.completed",
        "user/message" => "user.message",
        "assistant/chunk" if chunk_type == Some("text-delta") => "assistant.message",
        "assistant/chunk" if chunk_type == Some("reasoning-delta") => "reasoning.message",
        "tool/call" | "tool/result" if file_change => "file.change",
        "tool/call" | "tool/result" => "tool.output",
        _ => "agent.event",
    };
    let text = match event_type {
        "user/message" => dsh_content_text(data.get("content").unwrap_or(&Value::Null)),
        "assistant/chunk" => data
            .pointer("/chunk/text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "tool/result" => dsh_tool_result_text(data),
        "tool/call" => view
            .get("title")
            .or_else(|| data.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "session/title" => data
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    };
    let seq = event.get("seq").and_then(Value::as_u64);
    let turn_id = if event_type == "user/message" {
        seq.map(|value| value.to_string())
    } else {
        data.get("turn")
            .and_then(Value::as_u64)
            .map(|value| value.to_string())
    };
    let block = data.pointer("/chunk/index").and_then(Value::as_u64);
    let item_id = match event_type {
        "assistant/chunk" => Some(format!(
            "dsh-{}-{}-{}",
            data.get("turn").and_then(Value::as_u64).unwrap_or_default(),
            data.get("step").and_then(Value::as_u64).unwrap_or_default(),
            block.unwrap_or_default(),
        )),
        "tool/call" => data
            .get("callId")
            .and_then(Value::as_str)
            .map(str::to_string),
        "tool/result" => data
            .pointer("/message/source/callId")
            .and_then(Value::as_str)
            .map(str::to_string),
        _ => seq.map(|value| format!("dsh-{value}")),
    };
    let locations = view.get("locations").cloned().unwrap_or_else(|| json!([]));
    let changes = if file_change {
        locations
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|location| location.get("path").and_then(Value::as_str))
            .map(|path| json!({"path":path,"kind":tool_kind.unwrap_or("edit")}))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    (
        kind.to_string(),
        Some(format!("dsh.{event_type}")),
        json!({
            "text":text,
            "turn_id":turn_id,
            "item_id":item_id,
            "sequence":seq,
            "tool_title":view.get("title").or_else(|| data.get("name")),
            "tool_kind":tool_kind,
            "tool_status":if event_type == "tool/call" { Some("in_progress") } else if event_type == "tool/result" { Some(if data.pointer("/message/content/0/isError").and_then(Value::as_bool) == Some(true) { "failed" } else { "completed" }) } else { None },
            "locations":locations,
            "raw_input":data.get("arguments"),
            "raw_output":data.get("message"),
            "changes":changes,
            "stop_reason":data.pointer("/reason/kind"),
        }),
        Some(raw),
        session_id,
    )
}

fn dsh_content_text(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn dsh_tool_result_text(data: &Value) -> String {
    data.pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_acp(
    provider: &str,
    raw: Value,
) -> (String, Option<String>, Value, Option<Value>, Option<String>) {
    let provider_name = if provider == "opencode" {
        "OpenCode"
    } else {
        "Kiro"
    };
    let method = raw.get("method").and_then(Value::as_str);
    let base_event_type = method
        .or_else(|| raw.get("type").and_then(Value::as_str))
        .unwrap_or(if raw.get("id").is_some() {
            "rpc.response"
        } else {
            "event"
        });
    let update = raw.pointer("/params/update");
    let update_type = update
        .and_then(|value| value.get("sessionUpdate"))
        .and_then(Value::as_str);
    let event_type = if let Some(update_type) = update_type {
        format!("{base_event_type}/{update_type}")
    } else {
        base_event_type.to_string()
    };
    let session_id = raw
        .pointer("/sessionId")
        .or_else(|| raw.pointer("/result/sessionId"))
        .or_else(|| raw.pointer("/params/sessionId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_kind = update
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str);
    let kind = match base_event_type {
        "codesk.input.ack" => {
            if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
                "input.accepted"
            } else {
                "input.rejected"
            }
        }
        "codesk.control.ack" => {
            if raw.get("accepted").and_then(Value::as_bool) == Some(true) {
                "control.acknowledged"
            } else {
                "control.rejected"
            }
        }
        "codesk.session" => "thread.session",
        "codesk.user" => "user.message",
        "codesk.turn" => match raw.get("action").and_then(Value::as_str) {
            Some("started") => "turn.started",
            Some("completed") => "turn.completed",
            _ => "agent.event",
        },
        "codesk.usage" => "usage.updated",
        "codesk.request.resolved" => "provider.response",
        "codesk.queue" => match raw.get("action").and_then(Value::as_str) {
            Some("added") => "queue.added",
            Some("started") => "queue.started",
            Some("paused") => "queue.paused",
            Some("removed") => "queue.removed",
            Some("failed") => "queue.failed",
            _ => "queue.updated",
        },
        "session/request_permission" => "approval.required",
        "session/update" | "_kiro.dev/session/update" => match update_type {
            Some("user_message_chunk") => "user.message",
            Some("agent_message_chunk") => "assistant.message",
            Some("agent_thought_chunk") => "reasoning.message",
            Some("tool_call") | Some("tool_call_update") | Some("tool_call_chunk") => {
                if matches!(tool_kind, Some("edit") | Some("delete") | Some("move")) {
                    "file.change"
                } else {
                    "tool.output"
                }
            }
            Some("plan") => "reasoning.message",
            Some("usage_update") => "usage.updated",
            Some("available_commands_update") => "commands.updated",
            _ => "agent.event",
        },
        "_kiro.dev/commands/available" => "commands.updated",
        "_kiro.dev/metadata" | "_kiro.dev/subagent/list_update" => "agent.event",
        "rpc.response" if raw.get("error").is_some() => "run.error",
        "rpc.response" => "provider.response",
        _ if base_event_type.contains("error") => "run.error",
        _ => "agent.event",
    };
    let text = if base_event_type == "codesk.turn" {
        raw.pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else if let Some(text) = raw.get("message").and_then(Value::as_str) {
        text.to_string()
    } else if base_event_type == "session/request_permission" {
        raw.pointer("/params/toolCall/title")
            .and_then(Value::as_str)
            .map(|title| format!("{provider_name} wants to {title}"))
            .unwrap_or_else(|| format!("{provider_name} requests permission to use a tool"))
    } else if let Some(update) = update {
        kiro_update_text(update)
    } else {
        String::new()
    };
    let item_id = update
        .and_then(|value| value.get("messageId"))
        .or_else(|| update.and_then(|value| value.get("toolCallId")))
        .or_else(|| raw.get("turnId"))
        .or_else(|| raw.pointer("/params/sessionId"));
    let changes = update.map(kiro_changes).unwrap_or_default();
    let payload = json!({
        "text":text,
        "rpc_id":if base_event_type == "session/request_permission" { raw.get("id") } else { None },
        "method":raw.get("method"),
        "turn_id":raw.get("turnId"),
        "item_id":item_id,
        "request_id":raw.get("requestId"),
        "action":raw.get("action"),
        "queue_id":raw.get("queueId"),
        "pending":raw.get("pending"),
        "tool_title":update.and_then(|value| value.get("title")),
        "tool_kind":update.and_then(|value| value.get("kind")),
        "tool_status":update.and_then(|value| value.get("status")),
        "locations":update.and_then(|value| value.get("locations")),
        "raw_input":update.and_then(|value| value.get("rawInput")),
        "raw_output":update.and_then(|value| value.get("rawOutput")),
        "changes":changes,
        "permission_options":raw.pointer("/params/options"),
        "commands":raw.pointer("/params/commands")
            .or_else(|| update.and_then(|value| value.get("availableCommands"))),
        "context_usage_percentage":raw.pointer("/usage/contextUsagePercentage")
            .or_else(|| raw.pointer("/params/contextUsagePercentage"))
            .or_else(|| update.and_then(|value| value.get("used"))),
        "context_size":update.and_then(|value| value.get("size")),
        "metering_usage":raw.pointer("/usage/meteringUsage")
            .or_else(|| raw.pointer("/params/meteringUsage")),
        "cost":update.and_then(|value| value.get("cost")),
        "effort":raw.pointer("/usage/effort").or_else(|| raw.pointer("/params/effort")),
        "turn_duration_ms":raw.pointer("/usage/turnDurationMs")
            .or_else(|| raw.pointer("/params/turnDurationMs")),
        "stop_reason":raw.get("stopReason"),
    });
    (
        kind.to_string(),
        Some(format!("{provider}.{event_type}")),
        payload,
        Some(raw),
        session_id,
    )
}

fn kiro_update_text(update: &Value) -> String {
    if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
        return text.to_string();
    }
    if update.get("sessionUpdate").and_then(Value::as_str) == Some("plan") {
        return update["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if let Some(items) = update.pointer("/rawOutput/items").and_then(Value::as_array) {
        let text = items
            .iter()
            .filter_map(|item| item.get("Text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return text;
        }
    }
    if let Some(content) = update.get("content").and_then(Value::as_array) {
        let text = content
            .iter()
            .filter_map(|item| item.pointer("/content/text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return text;
        }
    }
    update
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn kiro_changes(update: &Value) -> Vec<Value> {
    let mut changes = update
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("diff"))
        .filter_map(|item| {
            let path = item.get("path")?.as_str()?;
            let old = item.get("oldText").and_then(Value::as_str).unwrap_or("");
            let new = item.get("newText").and_then(Value::as_str).unwrap_or("");
            Some(json!({
                "path":path,
                "kind":"edit",
                "diff":format!("--- {path}\n+++ {path}\n@@\n-{old}\n+{new}"),
            }))
        })
        .collect::<Vec<_>>();
    if changes.is_empty()
        && matches!(
            update.get("kind").and_then(Value::as_str),
            Some("edit") | Some("delete") | Some("move")
        )
    {
        changes.extend(
            update
                .get("locations")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|location| location.get("path").and_then(Value::as_str))
                .map(|path| json!({"path":path,"kind":update.get("kind")})),
        );
    }
    changes
}

fn extract_text(value: &Value) -> Option<String> {
    for pointer in [
        "/text",
        "/message",
        "/error/message",
        "/result",
        "/params/delta",
        "/params/reason",
        "/params/questions",
        "/params/command",
        "/params/item/text",
        "/params/item/content",
        "/delta/text",
        "/message/text",
        "/item/text",
        "/content",
    ] {
        match value.pointer(pointer) {
            Some(Value::String(text)) => return Some(text.clone()),
            Some(Value::Array(items)) => {
                let text = items
                    .iter()
                    .filter_map(|item| {
                        item.get("text")
                            .or_else(|| item.get("question"))
                            .or_else(|| item.get("label"))
                            .and_then(Value::as_str)
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    return Some(text);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::{
        model::StartRunRequest,
        providers::{build, normalize_line, status_from_event, support::find_executable},
    };

    #[test]
    fn normalizes_current_codex_request_and_message_shapes() {
        let (kind, _, payload, _, _) = normalize_line(
            "codex",
            "stdout",
            r#"{"id":"ask-1","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","isBlocking":true,"questions":[{"id":"scope","header":"Scope","question":"Which scope?"}]}}"#,
        );
        assert_eq!(kind, "input.required");
        assert_eq!(payload["text"], "Which scope?");
        assert_eq!(payload["rpc_id"], "ask-1");

        let (kind, _, payload, _, _) = normalize_line(
            "codex",
            "stdout",
            r#"{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"agent-1","type":"agentMessage","text":"Done"}}}"#,
        );
        assert_eq!(kind, "assistant.message");
        assert_eq!(payload["text"], "Done");
        assert_eq!(payload["item_id"], "agent-1");
    }

    #[test]
    fn suppresses_raw_json_for_unrendered_codex_notifications() {
        let (kind, _, payload, _, _) = normalize_line(
            "codex",
            "stdout",
            r#"{"method":"thread/status/changed","params":{"threadId":"thread-1","status":{"type":"idle"}}}"#,
        );
        assert_eq!(kind, "agent.event");
        assert_eq!(payload["text"], "");
    }

    #[test]
    fn normalizes_kiro_assistant_chunks_and_tool_updates() {
        let (kind, provider_type, payload, raw, session) = normalize_line(
            "kiro",
            "stdout",
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","messageId":"message-1","content":{"type":"text","text":"Hello from Kiro"}}}}"#,
        );
        assert_eq!(kind, "assistant.message");
        assert_eq!(
            provider_type.as_deref(),
            Some("kiro.session/update/agent_message_chunk")
        );
        assert_eq!(payload["text"], "Hello from Kiro");
        assert_eq!(session.as_deref(), Some("session-1"));
        assert_eq!(raw.unwrap()["params"]["update"]["messageId"], "message-1");

        let (kind, _, payload, _, _) = normalize_line(
            "kiro",
            "stdout",
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"tool_call_update","toolCallId":"tool-1","title":"Read package.json","kind":"read","status":"completed","rawOutput":{"items":[{"Text":"{\"name\":\"codesk\"}"}]}}}}"#,
        );
        assert_eq!(kind, "tool.output");
        assert_eq!(payload["tool_title"], "Read package.json");
        assert_eq!(payload["tool_status"], "completed");
        assert_eq!(payload["text"], "{\"name\":\"codesk\"}");
    }

    #[test]
    fn normalizes_kiro_permission_usage_and_status_events() {
        let (kind, _, payload, _, session) = normalize_line(
            "kiro",
            "stdout",
            r#"{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"session-1","toolCall":{"title":"Edit src/App.tsx"},"options":[{"optionId":"allow_once","name":"Allow once"}]}}"#,
        );
        assert_eq!(kind, "approval.required");
        assert_eq!(payload["rpc_id"], 42);
        assert_eq!(payload["text"], "Kiro wants to Edit src/App.tsx");
        assert_eq!(payload["permission_options"][0]["optionId"], "allow_once");
        assert_eq!(session.as_deref(), Some("session-1"));

        let (kind, _, payload, _, _) = normalize_line(
            "kiro",
            "stdout",
            &json!({
                "method":"_kiro.dev/metadata",
                "params":{
                    "sessionId":"session-1",
                    "contextUsagePercentage":12.5,
                    "meteringUsage":[{"value":0.2,"unit":"credit"}],
                    "turnDurationMs":1234,
                    "effort":"low"
                }
            })
            .to_string(),
        );
        assert_eq!(kind, "agent.event");
        assert_eq!(payload["context_usage_percentage"], 12.5);
        assert_eq!(payload["metering_usage"][0]["unit"], "credit");
        assert_eq!(payload["turn_duration_ms"], 1234);

        assert_eq!(
            status_from_event(
                "kiro",
                Some(&json!({"type":"codesk.turn","action":"started"}))
            ),
            Some("running")
        );
        assert_eq!(
            status_from_event(
                "kiro",
                Some(&json!({"type":"codesk.turn","action":"completed"}))
            ),
            Some("waiting_for_input")
        );
    }

    #[test]
    fn normalizes_kiro_available_slash_commands() {
        let (kind, provider_type, payload, _, session) = normalize_line(
            "kiro",
            "stdout",
            r#"{"jsonrpc":"2.0","method":"_kiro.dev/commands/available","params":{"sessionId":"session-1","commands":[{"name":"/usage","description":"Show billing and usage information","meta":{"inputType":"panel"}},{"name":"/model","description":"Select or list available models","meta":{"inputType":"selection"}},{"name":"/effort","description":"Set thinking effort for this session","meta":{"inputType":"selection"}},{"name":"/compact","description":"Compact conversation history"}]}}"#,
        );
        assert_eq!(kind, "commands.updated");
        assert_eq!(
            provider_type.as_deref(),
            Some("kiro._kiro.dev/commands/available")
        );
        assert_eq!(session.as_deref(), Some("session-1"));
        assert_eq!(payload["commands"].as_array().unwrap().len(), 4);
        assert_eq!(payload["commands"][0]["name"], "/usage");
        assert_eq!(payload["commands"][1]["meta"]["inputType"], "selection");
    }

    #[test]
    fn builds_and_normalizes_opencode_acp_sessions() {
        if find_executable("opencode").is_some() {
            let request = StartRunRequest {
                project_id: "project-1".into(),
                title: None,
                prompt: "hello from Codesk".into(),
                provider: "opencode".into(),
                model: Some("opencode/big-pickle".into()),
                workspace_mode: "current_checkout".into(),
                worktree_id: None,
                base_ref: None,
                branch: None,
                parent_run_id: None,
                command: None,
                args: Vec::new(),
                operation: Some("fork".into()),
                resume_session_id: Some("ses_source".into()),
                last_turn_id: None,
            };
            let spec = build(&request, "codesk-session", "/tmp/codesk-project").unwrap();
            assert_eq!(spec.args, ["acp", "--cwd", "/tmp/codesk-project"]);
            assert_eq!(spec.session_id.as_deref(), Some("ses_source"));
        }

        let (kind, provider_type, payload, _, session) = normalize_line(
            "opencode",
            "stdout",
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_1","update":{"sessionUpdate":"agent_message_chunk","messageId":"msg_1","content":{"type":"text","text":"Hello from OpenCode"}}}}"#,
        );
        assert_eq!(kind, "assistant.message");
        assert_eq!(
            provider_type.as_deref(),
            Some("opencode.session/update/agent_message_chunk")
        );
        assert_eq!(payload["text"], "Hello from OpenCode");
        assert_eq!(session.as_deref(), Some("ses_1"));

        let (kind, _, payload, _, _) = normalize_line(
            "opencode",
            "stdout",
            r#"{"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"sessionId":"ses_1","toolCall":{"title":"Edit src/App.tsx"},"options":[{"optionId":"allow_once","name":"Allow once"}]}}"#,
        );
        assert_eq!(kind, "approval.required");
        assert_eq!(payload["text"], "OpenCode wants to Edit src/App.tsx");
        assert_eq!(
            status_from_event(
                "opencode",
                Some(&json!({"type":"codesk.turn","action":"completed"}))
            ),
            Some("waiting_for_input")
        );
    }

    #[test]
    fn normalizes_dsh_messages_tools_usage_and_status() {
        let (kind, provider_type, payload, _, session) = normalize_line(
            "dsh",
            "stdout",
            &json!({
                "type":"dsh.event",
                "sessionId":"session-dsh-1",
                "event":{
                    "type":"assistant/chunk",
                    "seq":12,
                    "data":{"turn":1,"step":1,"chunk":{"type":"text-delta","index":0,"text":"Hello"}}
                }
            }).to_string(),
        );
        assert_eq!(kind, "assistant.message");
        assert_eq!(provider_type.as_deref(), Some("dsh.assistant/chunk"));
        assert_eq!(payload["text"], "Hello");
        assert_eq!(payload["item_id"], "dsh-1-1-0");
        assert_eq!(session.as_deref(), Some("session-dsh-1"));

        let (kind, _, payload, _, _) = normalize_line(
            "dsh",
            "stdout",
            &json!({
                "type":"dsh.event",
                "sessionId":"session-dsh-1",
                "event":{"type":"tool/call","seq":14,"data":{"callId":"call-1","name":"read","arguments":"{\"file_path\":\"package.json\"}"}},
                "view":{"for":"call","view":{"card":"generic","title":"Read package.json","kind":"read","locations":[{"path":"package.json","line":1}]}}
            }).to_string(),
        );
        assert_eq!(kind, "tool.output");
        assert_eq!(payload["tool_title"], "Read package.json");
        assert_eq!(payload["tool_kind"], "read");
        assert_eq!(payload["locations"][0]["path"], "package.json");

        let (kind, _, payload, _, _) = normalize_line(
            "dsh",
            "stdout",
            &json!({
                "type":"codesk.usage",
                "provider":"dsh",
                "sessionId":"session-dsh-1",
                "usage":{
                    "tokenUsage":{"uncachedInputTokens":100,"outputTokens":20,"cacheReadTokens":50,"cacheWriteTokens":5},
                    "contextPressure":{"pressureTokens":90,"projectedTokens":120,"contextWindow":1000}
                }
            }).to_string(),
        );
        assert_eq!(kind, "usage.updated");
        assert_eq!(payload["uncached_input_tokens"], 100);
        assert_eq!(payload["context_usage_percentage"], 12.0);

        assert_eq!(
            status_from_event(
                "dsh",
                Some(&json!({"type":"dsh.event","event":{"type":"turn/start"}}))
            ),
            Some("running")
        );
        assert_eq!(
            status_from_event(
                "dsh",
                Some(&json!({"type":"dsh.event","event":{"type":"turn/end"}}))
            ),
            Some("waiting_for_input")
        );
    }

    #[test]
    fn builds_antigravity_new_and_resume_commands() {
        if find_executable("agy").is_none() {
            return;
        }
        let request = |operation: Option<&str>, resume_session_id: Option<&str>| StartRunRequest {
            project_id: "project-1".into(),
            title: None,
            prompt: "hello from Codesk".into(),
            provider: "agy".into(),
            model: Some("gemini-3.1-pro".into()),
            workspace_mode: "current_checkout".into(),
            worktree_id: None,
            base_ref: None,
            branch: None,
            parent_run_id: None,
            command: None,
            args: Vec::new(),
            operation: operation.map(str::to_string),
            resume_session_id: resume_session_id.map(str::to_string),
            last_turn_id: None,
        };
        let new = build(
            &request(None, None),
            "codesk-session",
            "/tmp/codesk-project",
        )
        .unwrap();
        assert!(
            new.args
                .windows(2)
                .any(|args| args == ["--add-dir", "/tmp/codesk-project"])
        );
        assert!(
            new.args
                .windows(2)
                .any(|args| args == ["--print", "hello from Codesk"])
        );
        assert!(
            new.args
                .windows(2)
                .any(|args| args == ["--output-format", "stream-json"])
        );
        assert!(
            new.args
                .contains(&"--dangerously-skip-permissions".to_string())
        );
        let resumed = build(
            &request(Some("resume"), Some("1cbe7f1c-229a-4271-bc20-dc9d46433d96")),
            "codesk-session",
            "/tmp/codesk-project",
        )
        .unwrap();
        assert!(
            resumed
                .args
                .windows(2)
                .any(|args| { args == ["--conversation", "1cbe7f1c-229a-4271-bc20-dc9d46433d96"] })
        );
        assert_eq!(
            resumed.session_id.as_deref(),
            Some("1cbe7f1c-229a-4271-bc20-dc9d46433d96")
        );
        assert!(
            build(
                &request(Some("fork"), Some("1cbe7f1c-229a-4271-bc20-dc9d46433d96")),
                "codesk-session",
                "/tmp/codesk-project"
            )
            .is_err()
        );
    }

    #[test]
    fn normalizes_antigravity_session_text_tools_and_usage() {
        let (kind, provider_type, payload, _, session) = normalize_line(
            "agy",
            "stdout",
            r#"{"event":"init","conversation_id":"conversation-1","init":{"cwd":"/tmp/project","permission_mode":"always-proceed"}}"#,
        );
        assert_eq!(kind, "thread.session");
        assert_eq!(provider_type.as_deref(), Some("agy.init"));
        assert_eq!(payload["cwd"], "/tmp/project");
        assert_eq!(session.as_deref(), Some("conversation-1"));

        let (kind, _, payload, _, _) = normalize_line(
            "agy",
            "stdout",
            r#"{"event":"step_update","step_update":{"conversation_id":"conversation-1","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"AGY_STREAM_OK"}}"#,
        );
        assert_eq!(kind, "assistant.message");
        assert_eq!(payload["text"], "AGY_STREAM_OK");
        assert_eq!(payload["item_id"], "agy-step-2");

        let (kind, _, payload, _, _) = normalize_line(
            "agy",
            "stdout",
            r#"{"event":"step_update","step_update":{"conversation_id":"conversation-1","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"printf AGY_TOOL_OK"},"output":"AGY_TOOL_OK"}}}"#,
        );
        assert_eq!(kind, "tool.output");
        assert_eq!(payload["tool_title"], "printf AGY_TOOL_OK");
        assert_eq!(payload["tool_kind"], "run_command");
        assert_eq!(payload["tool_status"], "completed");
        assert_eq!(payload["text"], "AGY_TOOL_OK");

        let (kind, provider_type, payload, _, session) = normalize_line(
            "agy",
            "stdout",
            r#"{"event":"result","result":{"conversation_id":"conversation-1","status":"SUCCESS","response":"done","duration_seconds":4.19,"num_turns":1,"usage":{"input_tokens":24551,"output_tokens":731,"thinking_tokens":609,"cache_read_tokens":16297,"total_tokens":25282}}}"#,
        );
        assert_eq!(kind, "usage.updated");
        assert_eq!(provider_type.as_deref(), Some("agy.result"));
        assert_eq!(payload["input_tokens"], 24551);
        assert_eq!(payload["thinking_tokens"], 609);
        assert_eq!(payload["duration_seconds"], 4.19);
        assert_eq!(session.as_deref(), Some("conversation-1"));
    }
}
