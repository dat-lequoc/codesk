use std::{
    collections::VecDeque, fs::OpenOptions as StdOpenOptions, path::Path, process::ExitStatus,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines},
    net::{UnixListener, UnixStream},
    process::{ChildStdout, Command},
};

use crate::model::RunnerSpec;

#[derive(Debug, Clone)]
struct Submission {
    request_id: String,
    message: String,
    queue_id: Option<String>,
}

#[derive(Debug)]
struct ActivePrompt {
    rpc_id: u64,
    turn_id: String,
    submission: Submission,
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
        .with_context(|| format!("spawn {} ACP agent", spec.command))?;
    let mut stdin = child.stdin.take().context("Kiro ACP stdin unavailable")?;
    let stdout = child.stdout.take().context("Kiro ACP stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();
    let mut next_id = 1_u64;

    let initialize = rpc_request(
        &mut stdin,
        &mut next_id,
        "initialize",
        json!({
            "protocolVersion":1,
            "clientCapabilities":{
                "fs":{"readTextFile":false,"writeTextFile":false},
                "terminal":false
            },
            "clientInfo":{
                "name":"codesk",
                "title":"Codesk",
                "version":env!("CARGO_PKG_VERSION")
            }
        }),
    )
    .await?;
    let initialize_response = wait_for_response(&mut lines, &mut log, initialize).await?;
    let initialize_result = response_result(&initialize_response)?;
    anyhow::ensure!(
        initialize_result["protocolVersion"].as_u64() == Some(1),
        "Kiro ACP protocol v1 is required"
    );

    let session_id = if spec.operation.as_deref() == Some("resume") {
        anyhow::ensure!(
            initialize_result
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                == Some(true),
            "this Kiro CLI does not support loading sessions"
        );
        let session_id = spec
            .resume_session_id
            .as_deref()
            .context("resume session is required")?
            .to_string();
        let request = rpc_request(
            &mut stdin,
            &mut next_id,
            "session/load",
            json!({"sessionId":session_id,"cwd":spec.cwd,"mcpServers":[]}),
        )
        .await?;
        wait_for_response(&mut lines, &mut log, request).await?;
        session_id
    } else {
        anyhow::ensure!(
            spec.operation.as_deref() != Some("fork"),
            "Kiro ACP does not expose a safe fork operation"
        );
        let request = rpc_request(
            &mut stdin,
            &mut next_id,
            "session/new",
            json!({"cwd":spec.cwd,"mcpServers":[]}),
        )
        .await?;
        let response = wait_for_response(&mut lines, &mut log, request).await?;
        response_result(&response)?["sessionId"]
            .as_str()
            .context("Kiro ACP did not return a session id")?
            .to_string()
    };
    write_synthetic(
        &mut log,
        json!({"type":"codesk.session","sessionId":session_id}),
    )
    .await?;

    let initial = Submission {
        request_id: uuid::Uuid::new_v4().to_string(),
        message: spec.prompt.clone(),
        queue_id: None,
    };
    let mut active = Some(
        start_submission(
            &mut stdin,
            &mut next_id,
            &session_id,
            initial,
            true,
            &mut log,
        )
        .await?,
    );
    let mut queued = VecDeque::<Submission>::new();
    let mut pending_permissions = Vec::<Value>::new();
    let mut latest_usage = None::<Value>;
    tokio::fs::write(run_dir.join("ready"), format!("{}\n", std::process::id())).await?;

    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                append_line(&mut log, &line).await?;
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if message.get("method").and_then(Value::as_str) == Some("_kiro.dev/metadata") {
                    latest_usage = message.get("params").cloned();
                }
                if message.get("method").and_then(Value::as_str) == Some("session/request_permission") {
                    if let Some(id) = message.get("id") {
                        pending_permissions.push(id.clone());
                    }
                    continue;
                }
                let Some(response_id) = message.get("id").and_then(Value::as_u64) else { continue };
                if active.as_ref().map(|prompt| prompt.rpc_id) != Some(response_id) {
                    continue;
                }
                let finished = active.take().context("Kiro prompt state disappeared")?;
                let error = message.get("error").cloned();
                let stop_reason = message.pointer("/result/stopReason")
                    .and_then(Value::as_str)
                    .unwrap_or(if error.is_some() { "error" } else { "end_turn" });
                if finished.submission.message.trim() == "/usage" {
                    write_usage(&mut log, &session_id, latest_usage.as_ref()).await?;
                }
                write_turn_completed(
                    &mut log,
                    &session_id,
                    &finished.turn_id,
                    stop_reason,
                    error.as_ref(),
                ).await?;
                if error.is_none() && stop_reason == "end_turn" {
                    active = start_next_queued(
                        &mut stdin,
                        &mut next_id,
                        &session_id,
                        &mut queued,
                        &mut log,
                    ).await?;
                } else if !queued.is_empty() {
                    write_queue_event(
                        &mut log,
                        "paused",
                        queued.front(),
                        queued.len(),
                        error.or_else(|| Some(json!({"stopReason":stop_reason}))),
                    ).await?;
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
                        &mut stdin,
                        &mut next_id,
                        &session_id,
                        &mut active,
                        &mut queued,
                        &mut pending_permissions,
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
    let _ = tokio::fs::remove_file(socket_path).await;
    child.wait().await.context("wait for Kiro ACP agent")
}

#[allow(clippy::too_many_arguments)]
async fn handle_command(
    command: Value,
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    session_id: &str,
    active: &mut Option<ActivePrompt>,
    queued: &mut VecDeque<Submission>,
    pending_permissions: &mut Vec<Value>,
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
            let requested = command
                .get("delivery")
                .and_then(Value::as_str)
                .unwrap_or("auto");
            let delivery = if requested == "auto" {
                if active.is_some() { "queue" } else { "start" }
            } else {
                requested
            };
            match delivery {
                "start" => {
                    anyhow::ensure!(active.is_none(), "a Kiro turn is already active");
                    *active = Some(
                        start_submission(
                            stdin,
                            next_id,
                            session_id,
                            Submission {
                                request_id,
                                message: message.to_string(),
                                queue_id: None,
                            },
                            false,
                            log,
                        )
                        .await?,
                    );
                }
                "steer" => {
                    anyhow::ensure!(
                        active.is_none(),
                        "Kiro ACP does not support mid-turn steering; use Queue"
                    );
                    *active = Some(
                        start_submission(
                            stdin,
                            next_id,
                            session_id,
                            Submission {
                                request_id,
                                message: message.to_string(),
                                queue_id: None,
                            },
                            false,
                            log,
                        )
                        .await?,
                    );
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
                    if active.is_none() {
                        *active =
                            start_next_queued(stdin, next_id, session_id, queued, log).await?;
                    }
                }
                value => anyhow::bail!("unsupported Kiro input delivery: {value}"),
            }
        }
        Some("interrupt") => {
            anyhow::ensure!(
                active.is_some(),
                "there is no active Kiro turn to interrupt"
            );
            for rpc_id in pending_permissions.drain(..) {
                write_rpc(
                    stdin,
                    &json!({
                        "jsonrpc":"2.0",
                        "id":rpc_id,
                        "result":{"outcome":{"outcome":"cancelled"}}
                    }),
                )
                .await?;
            }
            write_rpc(
                stdin,
                &json!({
                    "jsonrpc":"2.0",
                    "method":"session/cancel",
                    "params":{"sessionId":session_id}
                }),
            )
            .await?;
            write_control_ack(log, &request_id, "interrupt", None).await?;
        }
        Some("queueStart") => {
            anyhow::ensure!(active.is_none(), "there is an active Kiro turn");
            anyhow::ensure!(!queued.is_empty(), "the Kiro queue is empty");
            *active = start_next_queued(stdin, next_id, session_id, queued, log).await?;
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
        Some("respond") => {
            let rpc_id = command.get("rpcId").context("rpcId is required")?.clone();
            let result = command.get("result").cloned().unwrap_or_else(|| json!({}));
            write_rpc(stdin, &json!({"jsonrpc":"2.0","id":rpc_id,"result":result})).await?;
            pending_permissions.retain(|pending| pending != &rpc_id);
            write_synthetic(
                log,
                json!({"type":"codesk.request.resolved","requestId":rpc_id}),
            )
            .await?;
        }
        Some(value) => anyhow::bail!("unsupported Kiro bridge command: {value}"),
        None => anyhow::bail!("Kiro bridge command type is required"),
    }
    Ok(())
}

async fn start_submission(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    session_id: &str,
    submission: Submission,
    initial: bool,
    log: &mut tokio::fs::File,
) -> Result<ActivePrompt> {
    let turn_id = uuid::Uuid::new_v4().to_string();
    let rpc_id = rpc_request(
        stdin,
        next_id,
        "session/prompt",
        json!({
            "sessionId":session_id,
            "prompt":[{"type":"text","text":submission.message}]
        }),
    )
    .await?;
    if submission.queue_id.is_some() {
        write_queue_event(log, "started", Some(&submission), 0, None).await?;
    } else if !initial {
        write_input_ack(log, &submission.request_id, "start", None).await?;
    }
    write_synthetic(
        log,
        json!({
            "type":"codesk.user",
            "sessionId":session_id,
            "turnId":turn_id,
            "message":submission.message,
        }),
    )
    .await?;
    write_synthetic(
        log,
        json!({
            "type":"codesk.turn",
            "action":"started",
            "sessionId":session_id,
            "turnId":turn_id,
        }),
    )
    .await?;
    Ok(ActivePrompt {
        rpc_id,
        turn_id,
        submission,
    })
}

async fn start_next_queued(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    session_id: &str,
    queued: &mut VecDeque<Submission>,
    log: &mut tokio::fs::File,
) -> Result<Option<ActivePrompt>> {
    let Some(submission) = queued.pop_front() else {
        return Ok(None);
    };
    match start_submission(stdin, next_id, session_id, submission.clone(), false, log).await {
        Ok(active) => Ok(Some(active)),
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
            Ok(None)
        }
    }
}

async fn write_turn_completed(
    log: &mut tokio::fs::File,
    session_id: &str,
    turn_id: &str,
    stop_reason: &str,
    error: Option<&Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.turn",
            "action":"completed",
            "sessionId":session_id,
            "turnId":turn_id,
            "stopReason":stop_reason,
            "error":error,
        }),
    )
    .await
}

async fn write_usage(
    log: &mut tokio::fs::File,
    session_id: &str,
    usage: Option<&Value>,
) -> Result<()> {
    write_synthetic(
        log,
        json!({
            "type":"codesk.usage",
            "sessionId":session_id,
            "message":"Kiro session usage",
            "usage":usage,
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

async fn read_commands(socket: &mut UnixStream) -> Result<Vec<Value>> {
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await?;
    String::from_utf8(bytes)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).map_err(Into::into))
        .collect()
}

async fn rpc_request(
    stdin: &mut tokio::process::ChildStdin,
    next_id: &mut u64,
    method: &str,
    params: Value,
) -> Result<u64> {
    let id = *next_id;
    *next_id += 1;
    write_rpc(
        stdin,
        &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
    )
    .await?;
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
    anyhow::bail!("Kiro ACP exited before responding to request {expected_id}")
}

fn response_result(response: &Value) -> Result<&Value> {
    if let Some(error) = response.get("error") {
        anyhow::bail!("Kiro ACP request failed: {error}")
    }
    response
        .get("result")
        .context("Kiro ACP response did not include a result")
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
