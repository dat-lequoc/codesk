use std::{
    collections::{HashMap, VecDeque},
    fs::OpenOptions as StdOpenOptions,
    path::Path,
    process::ExitStatus,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    net::{UnixListener, UnixStream},
    process::{ChildStdout, Command},
};

use crate::model::RunnerSpec;

#[derive(Debug)]
enum PendingRequest {
    Input {
        request_id: String,
        action: String,
    },
    QueuedTurn {
        submission: QueuedSubmission,
    },
    Interrupt {
        request_id: String,
    },
    Rewind {
        request_id: String,
        message: String,
        last_turn_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct QueuedSubmission {
    queue_id: String,
    request_id: String,
    message: String,
}

pub async fn run(spec: &RunnerSpec) -> Result<ExitStatus> {
    let run_dir = Path::new(&spec.run_dir);
    let socket_path = Path::new(&spec.input_socket);
    let _ = tokio::fs::remove_file(socket_path).await;
    let listener = UnixListener::bind(socket_path)?;
    let stderr = StdOpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stderr.log"))?;
    let mut log = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stdout.log"))
        .await?;
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(std::process::Stdio::piped())
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
        .with_context(|| format!("spawn {} app-server", spec.command))?;
    let mut stdin = child
        .stdin
        .take()
        .context("Codex app-server stdin unavailable")?;
    let stdout = child
        .stdout
        .take()
        .context("Codex app-server stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut next_id = 1_u64;

    let initialize = rpc_request(
        &mut stdin,
        &mut next_id,
        "initialize",
        json!({
            "clientInfo": {"name":"codesk","title":"Codesk","version":env!("CARGO_PKG_VERSION")},
            "capabilities": {"experimentalApi":true}
        }),
    )
    .await?;
    wait_for_response(&mut lines, &mut log, initialize).await?;
    write_rpc(&mut stdin, &json!({"method":"initialized"})).await?;

    let method = match spec.operation.as_deref() {
        Some("resume") => "thread/resume",
        Some("fork") => "thread/fork",
        _ => "thread/start",
    };
    let mut params = match method {
        "thread/start" => json!({"cwd":spec.cwd,"historyMode":"paginated"}),
        "thread/resume" => json!({
            "threadId":spec.resume_session_id.as_deref().context("resume session is required")?,
            "cwd":spec.cwd,
        }),
        "thread/fork" => json!({
            "threadId":spec.resume_session_id.as_deref().context("fork source session is required")?,
            "cwd":spec.cwd,
            "lastTurnId":spec.last_turn_id,
        }),
        _ => unreachable!(),
    };
    if let Some(model) = spec.model.as_deref() {
        params["model"] = Value::String(model.to_string());
    }
    let thread_request = rpc_request(&mut stdin, &mut next_id, method, params).await?;
    let thread_response = wait_for_response(&mut lines, &mut log, thread_request).await?;
    let mut thread_id = response_result(&thread_response)?
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .context("Codex app-server did not return a thread id")?
        .to_string();
    write_synthetic(
        &mut log,
        json!({"type":"codesk.session","sessionId":thread_id}),
    )
    .await?;

    let initial_turn = start_turn(&mut stdin, &mut next_id, &thread_id, &spec.prompt, None).await?;
    let initial_response = wait_for_response(&mut lines, &mut log, initial_turn).await?;
    let mut active_turn_id = response_result(&initial_response)?
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(str::to_string);
    tokio::fs::write(run_dir.join("ready"), format!("{}\n", std::process::id())).await?;

    let mut pending = HashMap::<u64, PendingRequest>::new();
    let mut queued = VecDeque::<QueuedSubmission>::new();
    let mut completed_turns = HashMap::<String, String>::new();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                append_line(&mut log, &line).await?;
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    match method {
                        "turn/started" => {
                            active_turn_id = message.pointer("/params/turn/id")
                                .or_else(|| message.pointer("/params/turnId"))
                                .and_then(Value::as_str)
                                .filter(|turn_id| !completed_turns.contains_key(*turn_id))
                                .map(str::to_string);
                        }
                        "turn/completed" => {
                            let status = message.pointer("/params/turn/status")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            if let Some(turn_id) = message.pointer("/params/turn/id")
                                .or_else(|| message.pointer("/params/turnId"))
                                .and_then(Value::as_str)
                            {
                                completed_turns.insert(turn_id.to_string(), status.to_string());
                            }
                            active_turn_id = None;
                            if status == "completed" {
                                start_next_queued(
                                    &mut stdin,
                                    &mut next_id,
                                    &thread_id,
                                    &mut queued,
                                    &mut pending,
                                    &mut log,
                                ).await?;
                            } else if !queued.is_empty() {
                                write_queue_event(
                                    &mut log,
                                    "paused",
                                    queued.front(),
                                    queued.len(),
                                    Some(json!({"turnStatus":status})),
                                ).await?;
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                let Some(id) = message.get("id").and_then(Value::as_u64) else { continue };
                let Some(request) = pending.remove(&id) else { continue };
                let error = message.get("error").cloned();
                match request {
                    PendingRequest::Input { request_id, action } => {
                        let completed_status = message.pointer("/result/turn/id")
                            .or_else(|| message.pointer("/result/turnId"))
                            .and_then(Value::as_str)
                            .and_then(|turn_id| completed_turns.get(turn_id))
                            .cloned();
                        if error.is_none()
                            && let Some(turn_id) = message.pointer("/result/turn/id")
                                .or_else(|| message.pointer("/result/turnId"))
                                .and_then(Value::as_str)
                                .filter(|turn_id| !completed_turns.contains_key(*turn_id))
                        {
                            active_turn_id = Some(turn_id.to_string());
                        }
                        write_input_ack(&mut log, &request_id, &action, error).await?;
                        if matches!(action.as_str(), "start" | "fork") {
                            if completed_status.as_deref() == Some("completed") {
                                start_next_queued(
                                    &mut stdin,
                                    &mut next_id,
                                    &thread_id,
                                    &mut queued,
                                    &mut pending,
                                    &mut log,
                                ).await?;
                            } else if completed_status.is_some() && !queued.is_empty() {
                                write_queue_event(
                                    &mut log,
                                    "paused",
                                    queued.front(),
                                    queued.len(),
                                    Some(json!({"turnStatus":completed_status})),
                                ).await?;
                            }
                        }
                    }
                    PendingRequest::QueuedTurn { submission } => {
                        if let Some(error) = error {
                            queued.push_front(submission.clone());
                            write_queue_event(
                                &mut log,
                                "failed",
                                Some(&submission),
                                queued.len(),
                                Some(error),
                            ).await?;
                        } else {
                            if let Some(turn_id) = message.pointer("/result/turn/id")
                                .or_else(|| message.pointer("/result/turnId"))
                                .and_then(Value::as_str)
                                .filter(|turn_id| !completed_turns.contains_key(*turn_id))
                            {
                                active_turn_id = Some(turn_id.to_string());
                            }
                            write_queue_event(
                                &mut log,
                                "started",
                                Some(&submission),
                                queued.len(),
                                None,
                            ).await?;
                            if let Some(status) = message.pointer("/result/turn/id")
                                .or_else(|| message.pointer("/result/turnId"))
                                .and_then(Value::as_str)
                                .and_then(|turn_id| completed_turns.get(turn_id))
                            {
                                if status == "completed" {
                                    start_next_queued(
                                        &mut stdin,
                                        &mut next_id,
                                        &thread_id,
                                        &mut queued,
                                        &mut pending,
                                        &mut log,
                                    ).await?;
                                } else if !queued.is_empty() {
                                    write_queue_event(
                                        &mut log,
                                        "paused",
                                        queued.front(),
                                        queued.len(),
                                        Some(json!({"turnStatus":status})),
                                    ).await?;
                                }
                            }
                        }
                    }
                    PendingRequest::Interrupt { request_id } => {
                        write_control_ack(&mut log, &request_id, "interrupt", error).await?;
                    }
                    PendingRequest::Rewind { request_id, message: user_message, last_turn_id } => {
                        if let Some(error) = error {
                            write_input_ack(&mut log, &request_id, "fork", Some(error)).await?;
                            continue;
                        }
                        let Some(next_thread_id) = message.pointer("/result/thread/id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                        else {
                            write_input_ack(
                                &mut log,
                                &request_id,
                                "fork",
                                Some(json!({"message":"fork response did not include a thread id"})),
                            )
                            .await?;
                            continue;
                        };
                        thread_id = next_thread_id;
                        active_turn_id = None;
                        write_synthetic(
                            &mut log,
                            json!({"type":"codesk.session","sessionId":thread_id,"action":"rewind","lastTurnId":last_turn_id}),
                        )
                        .await?;
                        let turn_request = start_turn(
                            &mut stdin,
                            &mut next_id,
                            &thread_id,
                            &user_message,
                            Some(&request_id),
                        )
                        .await?;
                        pending.insert(turn_request, PendingRequest::Input {
                            request_id,
                            action: "fork".to_string(),
                        });
                    }
                }
            }
            accepted = listener.accept() => {
                let (mut socket, _) = accepted?;
                let commands = read_commands(&mut socket).await?;
                for command in commands {
                    let request_id = command.get("requestId").cloned();
                    let action = command.get("type").cloned();
                    let control = matches!(
                        command.get("type").and_then(Value::as_str),
                        Some("interrupt" | "queueStart" | "queueRemove")
                    );
                    if let Err(error) = handle_command(
                        command,
                        &mut stdin,
                        &mut next_id,
                        &thread_id,
                        active_turn_id.as_deref(),
                        &mut pending,
                        &mut queued,
                        &mut log,
                        spec,
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
    let _ = tokio::fs::remove_file(socket_path).await;
    child.wait().await.context("wait for Codex app-server")
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    command: Value,
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    thread_id: &str,
    active_turn_id: Option<&str>,
    pending: &mut HashMap<u64, PendingRequest>,
    queued: &mut VecDeque<QueuedSubmission>,
    log: &mut tokio::fs::File,
    spec: &RunnerSpec,
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
            let requested = command
                .get("delivery")
                .and_then(Value::as_str)
                .unwrap_or("auto");
            let delivery = if requested == "auto" {
                if active_turn_id.is_some() {
                    "steer"
                } else if has_turn_start_pending(pending) {
                    "queue"
                } else {
                    "start"
                }
            } else {
                requested
            };
            match delivery {
                "start" => {
                    anyhow::ensure!(
                        active_turn_id.is_none() && !has_turn_start_pending(pending),
                        "a Codex turn is already active or starting"
                    );
                    let id =
                        start_turn(stdin, next_id, thread_id, message, Some(&request_id)).await?;
                    pending.insert(
                        id,
                        PendingRequest::Input {
                            request_id,
                            action: "start".to_string(),
                        },
                    );
                }
                "steer" => {
                    let turn_id =
                        active_turn_id.context("there is no active Codex turn to steer")?;
                    let id = rpc_request(
                        stdin,
                        next_id,
                        "turn/steer",
                        json!({
                            "threadId":thread_id,
                            "clientUserMessageId":request_id,
                            "input":[{"type":"text","text":message}],
                            "expectedTurnId":turn_id,
                        }),
                    )
                    .await?;
                    pending.insert(
                        id,
                        PendingRequest::Input {
                            request_id,
                            action: "steer".to_string(),
                        },
                    );
                }
                "queue" => {
                    let submission = QueuedSubmission {
                        queue_id: uuid::Uuid::new_v4().to_string(),
                        request_id: request_id.clone(),
                        message: message.to_string(),
                    };
                    queued.push_back(submission.clone());
                    write_input_ack(log, &request_id, "queue", None).await?;
                    write_queue_event(log, "added", Some(&submission), queued.len(), None).await?;
                    if active_turn_id.is_none() && !has_turn_start_pending(pending) {
                        start_next_queued(stdin, next_id, thread_id, queued, pending, log).await?;
                    }
                }
                value => anyhow::bail!("unsupported input delivery: {value}"),
            }
        }
        Some("interrupt") => {
            let Some(turn_id) = active_turn_id else {
                write_control_ack(
                    log,
                    &request_id,
                    "interrupt",
                    Some(json!({"message":"there is no active Codex turn to interrupt"})),
                )
                .await?;
                return Ok(());
            };
            let id = rpc_request(
                stdin,
                next_id,
                "turn/interrupt",
                json!({"threadId":thread_id,"turnId":turn_id}),
            )
            .await?;
            pending.insert(id, PendingRequest::Interrupt { request_id });
        }
        Some("rewind") => {
            anyhow::ensure!(
                active_turn_id.is_none(),
                "interrupt the active turn before rewinding"
            );
            anyhow::ensure!(
                !has_turn_start_pending(pending),
                "wait for the starting turn before rewinding"
            );
            anyhow::ensure!(queued.is_empty(), "remove queued prompts before rewinding");
            let message = command
                .get("message")
                .and_then(Value::as_str)
                .context("rewind message is required")?;
            let last_turn_id = command.get("lastTurnId").and_then(Value::as_str);
            let (method, mut params) = if let Some(last_turn_id) = last_turn_id {
                (
                    "thread/fork",
                    json!({"threadId":thread_id,"lastTurnId":last_turn_id,"cwd":spec.cwd}),
                )
            } else {
                (
                    "thread/start",
                    json!({"cwd":spec.cwd,"historyMode":"paginated"}),
                )
            };
            if let Some(model) = spec.model.as_deref() {
                params["model"] = Value::String(model.to_string());
            }
            let id = rpc_request(stdin, next_id, method, params).await?;
            pending.insert(
                id,
                PendingRequest::Rewind {
                    request_id,
                    message: message.to_string(),
                    last_turn_id: last_turn_id.map(str::to_string),
                },
            );
        }
        Some("queueStart") => {
            anyhow::ensure!(active_turn_id.is_none(), "there is an active Codex turn");
            anyhow::ensure!(
                !has_turn_start_pending(pending),
                "a Codex turn is already starting"
            );
            anyhow::ensure!(!queued.is_empty(), "the Codex queue is empty");
            start_next_queued(stdin, next_id, thread_id, queued, pending, log).await?;
            write_control_ack(log, &request_id, "queueStart", None).await?;
        }
        Some("queueRemove") => {
            let queue_id = command
                .get("queueId")
                .and_then(Value::as_str)
                .context("queueId is required")?;
            let index = queued
                .iter()
                .position(|item| item.queue_id == queue_id)
                .context("queued prompt not found")?;
            let removed = queued.remove(index).context("queued prompt disappeared")?;
            write_queue_event(log, "removed", Some(&removed), queued.len(), None).await?;
            write_control_ack(log, &request_id, "queueRemove", None).await?;
        }
        Some("respond") => {
            let rpc_id = command.get("rpcId").context("rpcId is required")?;
            let result = command.get("result").cloned().unwrap_or_else(|| json!({}));
            write_rpc(stdin, &json!({"id":rpc_id,"result":result})).await?;
        }
        Some(value) => anyhow::bail!("unsupported Codex bridge command: {value}"),
        None => anyhow::bail!("Codex bridge command type is required"),
    }
    Ok(())
}

fn has_turn_start_pending(pending: &HashMap<u64, PendingRequest>) -> bool {
    pending.values().any(|request| match request {
        PendingRequest::QueuedTurn { .. } | PendingRequest::Rewind { .. } => true,
        PendingRequest::Input { action, .. } => matches!(action.as_str(), "start" | "fork"),
        PendingRequest::Interrupt { .. } => false,
    })
}

async fn start_next_queued(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    thread_id: &str,
    queued: &mut VecDeque<QueuedSubmission>,
    pending: &mut HashMap<u64, PendingRequest>,
    log: &mut tokio::fs::File,
) -> Result<()> {
    if has_turn_start_pending(pending) {
        return Ok(());
    }
    let Some(submission) = queued.pop_front() else {
        return Ok(());
    };
    match start_turn(
        stdin,
        next_id,
        thread_id,
        &submission.message,
        Some(&submission.request_id),
    )
    .await
    {
        Ok(id) => {
            pending.insert(id, PendingRequest::QueuedTurn { submission });
        }
        Err(error) => {
            queued.push_front(submission.clone());
            write_queue_event(
                log,
                "failed",
                Some(&submission),
                queued.len(),
                Some(json!({"message":error.to_string()})),
            )
            .await?;
        }
    }
    Ok(())
}

async fn write_queue_event(
    log: &mut tokio::fs::File,
    action: &str,
    submission: Option<&QueuedSubmission>,
    pending: usize,
    error: Option<Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.queue",
            "action":action,
            "queueId":submission.map(|item| item.queue_id.as_str()),
            "requestId":submission.map(|item| item.request_id.as_str()),
            "message":submission.map(|item| item.message.as_str()),
            "pending":pending,
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

async fn start_turn(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    thread_id: &str,
    message: &str,
    request_id: Option<&str>,
) -> Result<u64> {
    rpc_request(
        stdin,
        next_id,
        "turn/start",
        turn_params(thread_id, message, request_id),
    )
    .await
}

fn turn_params(thread_id: &str, message: &str, request_id: Option<&str>) -> Value {
    let mut params = json!({
        "threadId":thread_id,
        "input":[{"type":"text","text":message}],
    });
    if let Some(request_id) = request_id {
        params["clientUserMessageId"] = Value::String(request_id.to_string());
    }
    params
}

async fn rpc_request(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    method: &str,
    params: Value,
) -> Result<u64> {
    let id = *next_id;
    *next_id += 1;
    write_rpc(stdin, &json!({"method":method,"id":id,"params":params})).await?;
    Ok(id)
}

async fn write_rpc(stdin: &mut tokio::process::ChildStdin, message: &Value) -> Result<()> {
    stdin
        .write_all(serde_json::to_string(message)?.as_bytes())
        .await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await?;
    Ok(())
}

async fn wait_for_response(
    lines: &mut Lines<BufReader<ChildStdout>>,
    log: &mut tokio::fs::File,
    expected_id: u64,
) -> Result<Value> {
    while let Some(line) = lines.next_line().await? {
        append_line(log, &line).await?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_u64) == Some(expected_id) {
            response_result(&value)?;
            return Ok(value);
        }
    }
    anyhow::bail!("Codex app-server exited before responding to request {expected_id}")
}

fn response_result(response: &Value) -> Result<&Value> {
    if let Some(error) = response.get("error") {
        anyhow::bail!("Codex app-server request failed: {error}")
    }
    response
        .get("result")
        .context("Codex app-server response did not include a result")
}

async fn append_line(log: &mut tokio::fs::File, line: &str) -> Result<()> {
    log.write_all(line.as_bytes()).await?;
    log.write_all(b"\n").await?;
    log.flush().await?;
    Ok(())
}

async fn write_synthetic(log: &mut tokio::fs::File, value: Value) -> Result<()> {
    append_line(log, &serde_json::to_string(&value)?).await
}

async fn write_input_ack(
    log: &mut tokio::fs::File,
    request_id: &str,
    action: &str,
    error: Option<Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.input.ack",
            "requestId":request_id,
            "action":action,
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
            "requestId":request_id,
            "action":action,
            "accepted":error.is_none(),
            "error":error,
        }),
    )
    .await
}
