use std::{
    collections::VecDeque, fs::OpenOptions as StdOpenOptions, path::Path, process::ExitStatus,
    time::Duration,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::Command,
};

use crate::model::RunnerSpec;

#[derive(Debug, Clone)]
struct Submission {
    request_id: String,
    message: String,
    queue_id: Option<String>,
}

#[derive(Clone)]
struct DshClient {
    base: String,
    http: reqwest::Client,
}

impl DshClient {
    fn new(base: String) -> Result<Self> {
        Ok(Self {
            base,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?,
        })
    }

    async fn call(&self, method: &str, payload: Value) -> Result<Value> {
        let rpc_id = uuid::Uuid::new_v4().to_string();
        let response = self
            .http
            .post(format!("{}/api/{method}", self.base))
            .json(&json!({
                "type":"client-request",
                "rpcId":rpc_id,
                "method":method,
                "payload":payload,
            }))
            .send()
            .await
            .with_context(|| format!("call DSH {method}"))?;
        let status = response.status();
        let value = response
            .json::<Value>()
            .await
            .with_context(|| format!("decode DSH {method} response"))?;
        anyhow::ensure!(
            status.is_success(),
            "DSH {method} returned HTTP {status}: {value}"
        );
        anyhow::ensure!(
            value.get("rpcId").and_then(Value::as_str) == Some(rpc_id.as_str()),
            "DSH {method} returned a mismatched rpc id"
        );
        let result = value.get("result").context("DSH response has no result")?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            let error = result.get("error").cloned().unwrap_or(Value::Null);
            anyhow::bail!("DSH {method} failed: {error}");
        }
        Ok(result.get("value").cloned().unwrap_or(Value::Null))
    }

    async fn history(&self, session_id: &str) -> Result<Value> {
        self.call(
            "session.history",
            json!({"sessionId":session_id,"maxMessages":200}),
        )
        .await
    }
}

pub async fn run(spec: &RunnerSpec) -> Result<ExitStatus> {
    let run_dir = Path::new(&spec.run_dir);
    let socket_path = Path::new(&spec.input_socket);
    let _ = tokio::fs::remove_file(socket_path).await;
    let listener = UnixListener::bind(socket_path)?;
    let mut log = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stdout.log"))
        .await?;
    let stderr = StdOpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stderr.log"))?;
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::from(stderr));
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::signal(libc::SIGHUP, libc::SIG_DFL);
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("spawn {} web host", spec.command))?;
    let stdout = child.stdout.take().context("DSH web stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let first_line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
        .await
        .context("DSH web host did not publish its URL")??
        .context("DSH web host exited before publishing its URL")?;
    let base = first_line
        .trim()
        .strip_prefix("dsh web: ")
        .filter(|url| url.starts_with("http://127.0.0.1:"))
        .context("DSH web host published an invalid loopback URL")?
        .trim_end_matches('/')
        .to_string();
    let client = DshClient::new(base)?;
    let mut session_id = attach_session(&client, spec).await?;
    maybe_select_model(&client, &session_id, spec.model.as_deref()).await?;
    let mut next_seq = history_next_seq(&client.history(&session_id).await?);
    write_synthetic(
        &mut log,
        json!({"type":"codesk.session","provider":"dsh","sessionId":session_id}),
    )
    .await?;

    let initial = Submission {
        request_id: uuid::Uuid::new_v4().to_string(),
        message: spec.prompt.clone(),
        queue_id: None,
    };
    let mut turn_active = false;
    let mut current_turn = None::<u64>;
    start_submission(
        &client,
        &session_id,
        initial,
        true,
        &mut turn_active,
        &mut log,
    )
    .await?;
    let mut queued = VecDeque::<Submission>::new();
    tokio::fs::write(run_dir.join("ready"), format!("{}\n", std::process::id())).await?;
    let mut stdout_open = true;

    loop {
        let poll_delay = if turn_active {
            Duration::from_millis(140)
        } else {
            Duration::from_secs(60 * 60)
        };
        tokio::select! {
            status = child.wait() => {
                let _ = tokio::fs::remove_file(socket_path).await;
                return status.context("wait for DSH web host");
            }
            line = lines.next_line(), if stdout_open => {
                match line? {
                    Some(line) if !line.trim().is_empty() => {
                        append_stderr(run_dir, &format!("DSH web: {line}")).await?;
                    }
                    Some(_) => {}
                    None => stdout_open = false,
                }
            }
            _ = tokio::time::sleep(poll_delay) => {
                let history = client.history(&session_id).await?;
                let outcome = append_history(
                    &mut log,
                    &session_id,
                    &history,
                    &mut next_seq,
                    &mut current_turn,
                ).await?;
                if outcome.started {
                    turn_active = true;
                }
                if let Some(completed) = outcome.completed {
                    turn_active = false;
                    current_turn = None;
                    if completed {
                        start_next_queued(
                            &client,
                            &session_id,
                            &mut queued,
                            &mut turn_active,
                            &mut log,
                        ).await?;
                    } else if !queued.is_empty() {
                        write_queue_event(
                            &mut log,
                            "paused",
                            queued.front(),
                            queued.len(),
                            Some(json!({"message":"the DSH turn did not complete normally"})),
                        ).await?;
                    }
                }
            }
            accepted = listener.accept() => {
                let (mut socket, _) = accepted?;
                for command in read_commands(&mut socket).await? {
                    let request_id = command.get("requestId").cloned();
                    let action = command.get("type").cloned();
                    let control = matches!(
                        command.get("type").and_then(Value::as_str),
                        Some("interrupt" | "queueStart" | "queueRemove")
                    );
                    if let Err(error) = handle_command(
                        command,
                        &client,
                        spec,
                        &mut session_id,
                        &mut next_seq,
                        &mut turn_active,
                        &mut queued,
                        &mut log,
                    ).await {
                        write_synthetic(
                            &mut log,
                            json!({
                                "type":if control { "codesk.control.ack" } else { "codesk.input.ack" },
                                "requestId":request_id,
                                "action":action,
                                "accepted":false,
                                "error":{"message":error.to_string()},
                            }),
                        ).await?;
                    }
                }
            }
        }
    }
}

async fn attach_session(client: &DshClient, spec: &RunnerSpec) -> Result<String> {
    match spec.operation.as_deref() {
        Some("resume") => {
            let source = spec
                .resume_session_id
                .as_deref()
                .context("resume session is required")?;
            let value = client
                .call("session.create", json!({"sessionId":source,"cwd":spec.cwd}))
                .await?;
            value["sessionId"]
                .as_str()
                .map(str::to_string)
                .context("DSH did not return a resumed session id")
        }
        Some("fork") => {
            let source = spec
                .resume_session_id
                .as_deref()
                .context("fork source session is required")?;
            let mut payload = json!({"sessionId":source});
            if let Some(at_seq) = spec
                .last_turn_id
                .as_deref()
                .and_then(|value| value.parse::<u64>().ok())
            {
                payload["atSeq"] = json!(at_seq);
            }
            let value = client.call("session.fork", payload).await?;
            value["sessionId"]
                .as_str()
                .map(str::to_string)
                .context("DSH did not return a forked session id")
        }
        _ => {
            let requested = format!("session-{}", spec.run_id);
            let value = client
                .call(
                    "session.create",
                    json!({"sessionId":requested,"cwd":spec.cwd}),
                )
                .await?;
            value["sessionId"]
                .as_str()
                .map(str::to_string)
                .context("DSH did not return a session id")
        }
    }
}

async fn maybe_select_model(
    client: &DshClient,
    session_id: &str,
    requested: Option<&str>,
) -> Result<()> {
    let Some(requested) = requested.filter(|value| !value.trim().is_empty()) else {
        return Ok(());
    };
    let models = client
        .call("session.models", json!({"sessionId":session_id}))
        .await?;
    let provider = models["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|group| {
            group["models"]
                .as_array()
                .is_some_and(|items| items.iter().any(|model| model["id"] == requested))
        })
        .and_then(|group| group["id"].as_str())
        .or_else(|| models.pointer("/current/provider").and_then(Value::as_str))
        .context("DSH did not expose a provider for the selected model")?;
    client
        .call(
            "session.selectModel",
            json!({"sessionId":session_id,"provider":provider,"model":requested}),
        )
        .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    command: Value,
    client: &DshClient,
    spec: &RunnerSpec,
    session_id: &mut String,
    next_seq: &mut u64,
    turn_active: &mut bool,
    queued: &mut VecDeque<Submission>,
    log: &mut tokio::fs::File,
) -> Result<()> {
    let request_id = command
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    match command.get("type").and_then(Value::as_str) {
        Some("submit") => {
            let message = command
                .get("message")
                .and_then(Value::as_str)
                .context("submit message is required")?;
            if message.trim() == "/usage" {
                write_usage(log, client, session_id).await?;
                write_input_ack(log, &request_id, "usage", None).await?;
                return Ok(());
            }
            let requested = command
                .get("delivery")
                .and_then(Value::as_str)
                .unwrap_or("auto");
            let delivery = if requested == "auto" {
                if *turn_active { "steer" } else { "start" }
            } else {
                requested
            };
            match delivery {
                "start" => {
                    anyhow::ensure!(!*turn_active, "a DSH turn is already active");
                    start_submission(
                        client,
                        session_id,
                        Submission {
                            request_id,
                            message: message.to_string(),
                            queue_id: None,
                        },
                        false,
                        turn_active,
                        log,
                    )
                    .await?;
                }
                "steer" => {
                    if *turn_active {
                        client
                            .call(
                                "session.prompt",
                                json!({
                                    "sessionId":session_id,
                                    "mode":"steer",
                                    "content":[{"type":"text","text":message}],
                                }),
                            )
                            .await?;
                        write_input_ack(log, &request_id, "steer", None).await?;
                    } else {
                        start_submission(
                            client,
                            session_id,
                            Submission {
                                request_id,
                                message: message.to_string(),
                                queue_id: None,
                            },
                            false,
                            turn_active,
                            log,
                        )
                        .await?;
                    }
                }
                "queue" => {
                    let submission = Submission {
                        request_id: request_id.clone(),
                        message: message.to_string(),
                        queue_id: Some(uuid::Uuid::new_v4().to_string()),
                    };
                    queued.push_back(submission.clone());
                    write_input_ack(log, &request_id, "queue", None).await?;
                    write_queue_event(log, "added", Some(&submission), queued.len(), None).await?;
                    if !*turn_active {
                        start_next_queued(client, session_id, queued, turn_active, log).await?;
                    }
                }
                "fork" => {
                    anyhow::ensure!(
                        !*turn_active,
                        "interrupt the active DSH turn before forking"
                    );
                    anyhow::ensure!(queued.is_empty(), "remove queued prompts before forking");
                    let previous = command.get("lastTurnId").and_then(Value::as_str);
                    let next_session = if let Some(at_seq) =
                        previous.and_then(|value| value.parse::<u64>().ok())
                    {
                        client
                            .call(
                                "session.fork",
                                json!({"sessionId":session_id,"atSeq":at_seq}),
                            )
                            .await?
                    } else {
                        client
                            .call(
                                "session.create",
                                json!({
                                    "sessionId":format!("session-{}", uuid::Uuid::new_v4()),
                                    "cwd":spec.cwd,
                                }),
                            )
                            .await?
                    };
                    *session_id = next_session["sessionId"]
                        .as_str()
                        .context("DSH did not return the branch session id")?
                        .to_string();
                    maybe_select_model(client, session_id, spec.model.as_deref()).await?;
                    *next_seq = history_next_seq(&client.history(session_id).await?);
                    write_synthetic(
                        log,
                        json!({
                            "type":"codesk.session",
                            "provider":"dsh",
                            "sessionId":session_id,
                            "action":"rewind",
                            "lastTurnId":previous,
                        }),
                    )
                    .await?;
                    start_submission(
                        client,
                        session_id,
                        Submission {
                            request_id,
                            message: message.to_string(),
                            queue_id: None,
                        },
                        false,
                        turn_active,
                        log,
                    )
                    .await?;
                }
                value => anyhow::bail!("unsupported DSH input delivery: {value}"),
            }
        }
        Some("interrupt") => {
            anyhow::ensure!(*turn_active, "there is no active DSH turn to interrupt");
            client
                .call("session.cancel", json!({"sessionId":session_id}))
                .await?;
            *turn_active = false;
            write_control_ack(log, &request_id, "interrupt", None).await?;
            write_synthetic(
                log,
                json!({
                    "type":"dsh.event",
                    "sessionId":session_id,
                    "event":{
                        "type":"turn/end",
                        "data":{"reason":{"kind":"cancelled"}}
                    },
                    "view":null,
                }),
            )
            .await?;
            if !queued.is_empty() {
                write_queue_event(
                    log,
                    "paused",
                    queued.front(),
                    queued.len(),
                    Some(json!({"message":"the active DSH turn was cancelled"})),
                )
                .await?;
            }
        }
        Some("queueStart") => {
            anyhow::ensure!(!*turn_active, "there is an active DSH turn");
            anyhow::ensure!(!queued.is_empty(), "the DSH queue is empty");
            start_next_queued(client, session_id, queued, turn_active, log).await?;
            write_control_ack(log, &request_id, "queueStart", None).await?;
        }
        Some("queueRemove") => {
            let queue_id = command
                .get("queueId")
                .and_then(Value::as_str)
                .context("queueId is required")?;
            let index = queued
                .iter()
                .position(|item| item.queue_id.as_deref() == Some(queue_id))
                .context("queued prompt not found")?;
            let removed = queued.remove(index).context("queued prompt disappeared")?;
            write_queue_event(log, "removed", Some(&removed), queued.len(), None).await?;
            write_control_ack(log, &request_id, "queueRemove", None).await?;
        }
        Some(value) => anyhow::bail!("unsupported DSH bridge command: {value}"),
        None => anyhow::bail!("DSH bridge command type is required"),
    }
    Ok(())
}

async fn start_submission(
    client: &DshClient,
    session_id: &str,
    submission: Submission,
    initial: bool,
    turn_active: &mut bool,
    log: &mut tokio::fs::File,
) -> Result<()> {
    if submission.message.trim() == "/usage" {
        if initial {
            write_synthetic(
                log,
                json!({
                    "type":"dsh.event",
                    "sessionId":session_id,
                    "event":{"type":"turn/start","data":{}},
                    "view":null,
                }),
            )
            .await?;
        }
        write_usage(log, client, session_id).await?;
        if !initial {
            write_input_ack(log, &submission.request_id, "usage", None).await?;
        }
        if initial {
            write_synthetic(
                log,
                json!({
                    "type":"dsh.event",
                    "sessionId":session_id,
                    "event":{"type":"turn/end","data":{"reason":{"kind":"command"}}},
                    "view":null,
                }),
            )
            .await?;
        }
        return Ok(());
    }
    let response = client
        .call(
            "session.prompt",
            json!({
                "sessionId":session_id,
                "mode":"queue",
                "content":[{"type":"text","text":submission.message}],
            }),
        )
        .await?;
    if let Some(command) = response.get("command") {
        write_synthetic(
            log,
            json!({
                "type":"codesk.command",
                "provider":"dsh",
                "sessionId":session_id,
                "message":command.get("text").and_then(Value::as_str).unwrap_or("Command completed"),
                "command":submission.message,
            }),
        )
        .await?;
        if !initial {
            write_input_ack(log, &submission.request_id, "command", None).await?;
        } else {
            write_synthetic(
                log,
                json!({
                    "type":"dsh.event",
                    "sessionId":session_id,
                    "event":{"type":"turn/end","data":{"reason":{"kind":"command"}}},
                    "view":null,
                }),
            )
            .await?;
        }
        return Ok(());
    }
    *turn_active = true;
    if submission.queue_id.is_some() {
        write_queue_event(log, "started", Some(&submission), 0, None).await?;
    } else if !initial {
        write_input_ack(log, &submission.request_id, "start", None).await?;
    }
    Ok(())
}

async fn start_next_queued(
    client: &DshClient,
    session_id: &str,
    queued: &mut VecDeque<Submission>,
    turn_active: &mut bool,
    log: &mut tokio::fs::File,
) -> Result<()> {
    let Some(submission) = queued.pop_front() else {
        return Ok(());
    };
    match start_submission(
        client,
        session_id,
        submission.clone(),
        false,
        turn_active,
        log,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) => {
            queued.push_front(submission.clone());
            write_queue_event(
                log,
                "failed",
                Some(&submission),
                queued.len(),
                Some(json!({"message":error.to_string()})),
            )
            .await
        }
    }
}

#[derive(Default)]
struct HistoryOutcome {
    started: bool,
    completed: Option<bool>,
}

async fn append_history(
    log: &mut tokio::fs::File,
    session_id: &str,
    history: &Value,
    next_seq: &mut u64,
    current_turn: &mut Option<u64>,
) -> Result<HistoryOutcome> {
    let mut outcome = HistoryOutcome::default();
    let mut entries = history["events"].as_array().cloned().unwrap_or_default();
    entries.sort_by_key(|entry| entry.pointer("/event/seq").and_then(Value::as_u64));
    for entry in entries {
        let Some(seq) = entry.pointer("/event/seq").and_then(Value::as_u64) else {
            continue;
        };
        if seq < *next_seq {
            continue;
        }
        *next_seq = seq.saturating_add(1);
        let event = &entry["event"];
        let event_type = event["type"].as_str().unwrap_or_default();
        if event_type == "turn/start" {
            *current_turn = event.pointer("/data/turn").and_then(Value::as_u64);
            outcome.started = true;
        }
        if event_type == "turn/end" {
            let completed =
                event.pointer("/data/reason/kind").and_then(Value::as_str) == Some("completed");
            outcome.completed = Some(completed);
        }
        if significant_event(event) {
            write_synthetic(
                log,
                json!({
                    "type":"dsh.event",
                    "sessionId":session_id,
                    "event":event,
                    "view":entry.get("view"),
                    "turn":current_turn,
                }),
            )
            .await?;
        }
    }
    Ok(outcome)
}

fn significant_event(event: &Value) -> bool {
    match event["type"].as_str().unwrap_or_default() {
        "turn/start" | "turn/end" | "tool/call" | "tool/result" | "session/title" => true,
        "user/message" => {
            event.pointer("/data/source/kind").and_then(Value::as_str) == Some("user")
        }
        "assistant/chunk" => matches!(
            event.pointer("/data/chunk/type").and_then(Value::as_str),
            Some("text-delta" | "reasoning-delta")
        ),
        _ => false,
    }
}

fn history_next_seq(history: &Value) -> u64 {
    history["events"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.pointer("/event/seq").and_then(Value::as_u64))
        .max()
        .map(|seq| seq.saturating_add(1))
        .unwrap_or(0)
}

async fn write_usage(
    log: &mut tokio::fs::File,
    client: &DshClient,
    session_id: &str,
) -> Result<()> {
    let history = client.history(session_id).await?;
    let values = history
        .pointer("/projections/values")
        .cloned()
        .unwrap_or_else(|| json!({}));
    write_synthetic(
        log,
        json!({
            "type":"codesk.usage",
            "provider":"dsh",
            "sessionId":session_id,
            "message":"DeepSeek Harness session usage",
            "usage":{
                "tokenUsage":values.get("tokenUsage"),
                "contextPressure":values.get("contextPressure"),
                "contextBreakdown":values.get("contextBreakdown"),
                "sessionStats":values.get("sessionStats"),
            },
        }),
    )
    .await
}

async fn write_queue_event(
    log: &mut tokio::fs::File,
    action: &str,
    submission: Option<&Submission>,
    pending: usize,
    error: Option<Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.queue",
            "provider":"dsh",
            "action":action,
            "queueId":submission.and_then(|item| item.queue_id.as_deref()),
            "requestId":submission.map(|item| item.request_id.as_str()),
            "message":submission.map(|item| item.message.as_str()),
            "pending":pending,
            "error":error,
        }),
    )
    .await
}

async fn write_input_ack(
    log: &mut tokio::fs::File,
    request_id: &str,
    delivery: &str,
    error: Option<Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.input.ack",
            "provider":"dsh",
            "requestId":request_id,
            "delivery":delivery,
            "accepted":error.is_none(),
            "error":error,
        }),
    )
    .await
}

async fn write_control_ack(
    log: &mut tokio::fs::File,
    request_id: &str,
    action: &str,
    error: Option<Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.control.ack",
            "provider":"dsh",
            "requestId":request_id,
            "action":action,
            "accepted":error.is_none(),
            "error":error,
        }),
    )
    .await
}

async fn read_commands(socket: &mut UnixStream) -> Result<Vec<Value>> {
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await?;
    String::from_utf8(bytes)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

async fn write_synthetic(log: &mut tokio::fs::File, value: Value) -> Result<()> {
    log.write_all(serde_json::to_string(&value)?.as_bytes())
        .await?;
    log.write_all(b"\n").await?;
    log.flush().await?;
    Ok(())
}

async fn append_stderr(run_dir: &Path, line: &str) -> Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stderr.log"))
        .await?;
    file.write_all(line.as_bytes()).await?;
    file.write_all(b"\n").await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{history_next_seq, significant_event};

    #[test]
    fn filters_dsh_history_to_visible_events() {
        assert!(significant_event(
            &json!({"type":"turn/start","data":{"turn":1}})
        ));
        assert!(significant_event(&json!({
            "type":"user/message",
            "data":{"source":{"kind":"user"}}
        })));
        assert!(!significant_event(&json!({
            "type":"user/message",
            "data":{"source":{"kind":"plugin"}}
        })));
        assert!(significant_event(&json!({
            "type":"assistant/chunk",
            "data":{"chunk":{"type":"text-delta","text":"hello"}}
        })));
        assert!(!significant_event(&json!({
            "type":"assistant/chunk",
            "data":{"chunk":{"type":"usage"}}
        })));
    }

    #[test]
    fn starts_after_the_latest_dsh_history_sequence() {
        let history = json!({"events":[
            {"event":{"seq":3}},
            {"event":{"seq":9}}
        ]});
        assert_eq!(history_next_seq(&history), 10);
    }
}
