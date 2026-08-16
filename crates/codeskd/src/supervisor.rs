use std::{io::SeekFrom, path::PathBuf, process::Stdio, time::Duration};

use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
    sync::broadcast,
};
use uuid::Uuid;

use crate::{
    adapters,
    db::Db,
    model::{Event, Run, RunnerExit, RunnerSpec, StartRunRequest},
    worktrees,
};

#[derive(Clone)]
pub struct Supervisor {
    pub db: Db,
    pub data_root: PathBuf,
    pub events: broadcast::Sender<Event>,
}

impl Supervisor {
    pub fn new(db: Db, data_root: PathBuf) -> Self {
        let (events, _) = broadcast::channel(2048);
        Self {
            db,
            data_root,
            events,
        }
    }

    pub async fn recover(&self) -> Result<()> {
        for run in self.db.runs()?.into_iter().filter(|run| {
            [
                "queued",
                "starting",
                "running",
                "waiting_for_input",
                "interrupting",
            ]
            .contains(&run.status.as_str())
        }) {
            if run.process_group_id.is_some_and(process_alive)
                || self
                    .data_root
                    .join("runs")
                    .join(&run.id)
                    .join("exit.json")
                    .exists()
            {
                self.attach(run)
            } else {
                self.db.update_run_status(&run.id, "orphaned")?;
            }
        }
        Ok(())
    }

    pub async fn start(&self, request: StartRunRequest) -> Result<Run> {
        let project = self
            .db
            .project(&request.project_id)?
            .context("project not found")?;
        let (cwd, worktree_id) = match request.workspace_mode.as_str() {
            "current_checkout" => (project.path.clone(), None),
            "existing_worktree" => {
                let id = request
                    .worktree_id
                    .as_deref()
                    .context("worktree_id is required")?;
                let item = self.db.worktree(id)?.context("worktree not found")?;
                anyhow::ensure!(
                    item.project_id == project.id,
                    "worktree belongs to another project"
                );
                (item.path, Some(item.id))
            }
            "managed_worktree" => {
                let item = worktrees::create(
                    &self.db,
                    &self.data_root,
                    &project,
                    &crate::model::CreateWorktreeRequest {
                        base_ref: request.base_ref.clone(),
                        branch: request.branch.clone(),
                    },
                )
                .await?;
                (item.path, Some(item.id))
            }
            value => anyhow::bail!("unsupported workspace mode: {value}"),
        };
        let id = Uuid::new_v4().to_string();
        let spec = adapters::build(&request, &id, &cwd)?;
        let created = Utc::now().to_rfc3339();
        let title = request
            .title
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| request.prompt.chars().take(70).collect());
        let mut run = Run {
            id: id.clone(),
            project_id: project.id,
            worktree_id,
            parent_run_id: request.parent_run_id.clone(),
            provider: request.provider.clone(),
            provider_session_id: spec.session_id.clone(),
            title,
            prompt: request.prompt.clone(),
            model: request.model.clone(),
            cwd,
            command: spec.command.clone(),
            args: spec.args.clone(),
            status: "starting".into(),
            pid: None,
            process_group_id: None,
            created_at: created,
            started_at: None,
            finished_at: None,
            exit_code: None,
            terminating_signal: None,
        };
        self.db.create_run(&run)?;
        self.emit(
            &id,
            "run.created",
            None,
            None,
            json!({"title":run.title,"cwd":run.cwd}),
            None,
        )?;
        let run_dir = self.data_root.join("runs").join(&id);
        tokio::fs::create_dir_all(&run_dir).await?;
        let runner_spec = RunnerSpec {
            run_id: id.clone(),
            provider: run.provider.clone(),
            cwd: run.cwd.clone(),
            command: run.command.clone(),
            args: run.args.clone(),
            run_dir: run_dir.to_string_lossy().into_owned(),
            input_socket: input_socket(&id).to_string_lossy().into_owned(),
            prompt: request.prompt.clone(),
            model: request.model.clone(),
            operation: request.operation.clone(),
            resume_session_id: request.resume_session_id.clone(),
            last_turn_id: request.last_turn_id.clone(),
        };
        let spec_path = run_dir.join("runner.json");
        tokio::fs::write(&spec_path, serde_json::to_vec_pretty(&runner_spec)?).await?;
        let executable = std::env::current_exe()?;
        let bootstrap_log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(run_dir.join("runner-bootstrap.log"))?;
        let bootstrap_error = bootstrap_log.try_clone()?;
        let mut command = Command::new(executable);
        command
            .arg("__runner")
            .arg(&spec_path)
            .current_dir(&run.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::from(bootstrap_log))
            .stderr(Stdio::from(bootstrap_error))
            .kill_on_drop(false);
        #[cfg(unix)]
        {
            command.process_group(0);
        }
        let child = command.spawn().context("spawn durable runner")?;
        let pid = child.id().context("runner has no pid")?;
        let pgid = pid as i32;
        let ready_path = run_dir.join("ready");
        let mut runner_ready = false;
        for _ in 0..500 {
            if ready_path.exists() {
                runner_ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        if !runner_ready {
            let _ = unsafe { libc::kill(-pgid, libc::SIGKILL) };
            self.db
                .finish_run(&id, "failed", None, None, &Utc::now().to_rfc3339())?;
            let details = tokio::fs::read_to_string(run_dir.join("runner-bootstrap.log"))
                .await
                .unwrap_or_default();
            anyhow::bail!("durable runner did not become ready: {}", details.trim());
        }
        let started = Utc::now().to_rfc3339();
        self.db.update_run_started(&id, pid, pgid, &started)?;
        run.pid = Some(pid);
        run.process_group_id = Some(pgid);
        run.status = "running".into();
        run.started_at = Some(started);
        self.emit(
            &id,
            "run.started",
            None,
            None,
            json!({"pid":pid,"process_group_id":pgid,"durable_runner":true}),
            None,
        )?;
        if let Some(message) = adapters::encode_initial_prompt(&run.provider, &run.prompt) {
            self.write_input(&id, &message).await?;
            self.emit(
                &id,
                "input.accepted",
                Some("initial_prompt"),
                None,
                json!({"message":run.prompt}),
                None,
            )?;
        }
        self.attach(run.clone());
        Ok(run)
    }

    fn attach(&self, run: Run) {
        self.tail(run.clone(), "stdout");
        self.tail(run.clone(), "stderr");
        let this = self.clone();
        tokio::spawn(async move {
            this.poll_completion(run).await;
        });
    }

    fn tail(&self, run: Run, channel: &'static str) {
        let this = self.clone();
        tokio::spawn(async move {
            let path = this
                .data_root
                .join("runs")
                .join(&run.id)
                .join(format!("{channel}.log"));
            loop {
                let offset = this.db.stream_offset(&run.id, channel).unwrap_or(0);
                if let Ok(mut file) = tokio::fs::OpenOptions::new().read(true).open(&path).await {
                    if file.seek(SeekFrom::Start(offset)).await.is_ok() {
                        let mut reader = BufReader::new(file);
                        let mut line = String::new();
                        loop {
                            line.clear();
                            match reader.read_line(&mut line).await {
                                Ok(0) => break,
                                Ok(_) => {
                                    let position = reader.stream_position().await.unwrap_or(offset);
                                    let text = line.trim_end_matches(['\r', '\n']);
                                    if !text.is_empty() {
                                        let (kind, provider_type, payload, raw, session) =
                                            adapters::normalize_line(&run.provider, channel, text);
                                        if let Some(session) = session {
                                            let _ = this.db.set_provider_session(&run.id, &session);
                                        }
                                        if let Some(status) =
                                            adapters::status_from_event(&run.provider, raw.as_ref())
                                        {
                                            let _ = this.db.update_run_status(&run.id, status);
                                        }
                                        let _ = this.emit(
                                            &run.id,
                                            &kind,
                                            provider_type.as_deref(),
                                            Some(channel),
                                            payload,
                                            raw,
                                        );
                                    }
                                    let _ = this.db.set_stream_offset(&run.id, channel, position);
                                }
                                Err(_) => break,
                            }
                        }
                    }
                }
                if is_terminal(this.db.run(&run.id).ok().flatten().as_ref()) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(180)).await;
            }
        });
    }

    async fn poll_completion(&self, run: Run) {
        let exit_path = self.data_root.join("runs").join(&run.id).join("exit.json");
        loop {
            if let Ok(bytes) = tokio::fs::read(&exit_path).await {
                if let Ok(result) = serde_json::from_slice::<RunnerExit>(&bytes) {
                    let (status, signal_name) = match result.signal {
                        Some(libc::SIGINT) => ("interrupted", Some("SIGINT")),
                        Some(libc::SIGKILL) => ("killed", Some("SIGKILL")),
                        Some(libc::SIGTERM) => ("interrupted", Some("SIGTERM")),
                        Some(_) => ("failed", Some("SIGNAL")),
                        None if result.exit_code == Some(0) => ("completed", None),
                        None if result.exit_code == Some(130) => ("interrupted", Some("SIGINT")),
                        None if result.exit_code == Some(143) => ("interrupted", Some("SIGTERM")),
                        None => ("failed", None),
                    };
                    let _ = self.db.finish_run(
                        &run.id,
                        status,
                        result.exit_code,
                        signal_name,
                        &result.finished_at,
                    );
                    let _ = self.emit(
                        &run.id,
                        &format!("run.{status}"),
                        None,
                        None,
                        json!({"exit_code":result.exit_code,"signal":result.signal}),
                        None,
                    );
                    break;
                }
            }
            if !run.process_group_id.is_some_and(process_alive) {
                if !is_terminal(self.db.run(&run.id).ok().flatten().as_ref()) {
                    let _ = self.db.finish_run(
                        &run.id,
                        "orphaned",
                        None,
                        None,
                        &Utc::now().to_rfc3339(),
                    );
                    let _ = self.emit(
                        &run.id,
                        "run.orphaned",
                        None,
                        None,
                        json!({"reason":"runner exited without metadata"}),
                        None,
                    );
                }
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        let _ = tokio::fs::remove_file(input_socket(&run.id)).await;
    }

    pub async fn input(
        &self,
        run_id: &str,
        message: &str,
        request_id: Option<&str>,
        delivery: &str,
        last_turn_id: Option<&str>,
    ) -> Result<()> {
        let run = self.db.run(run_id)?.context("run not found")?;
        let request_id = request_id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let encoded =
            adapters::encode_input(&run.provider, message, &request_id, delivery, last_turn_id)?;
        self.write_input(run_id, &encoded).await?;
        self.emit(
            run_id,
            "input.submitted",
            Some(delivery),
            None,
            json!({"message":message,"request_id":request_id,"delivery":delivery,"last_turn_id":last_turn_id}),
            None,
        )?;
        Ok(())
    }

    pub async fn start_queued(&self, run_id: &str) -> Result<()> {
        let run = self.db.run(run_id)?.context("run not found")?;
        anyhow::ensure!(
            matches!(run.provider.as_str(), "codex" | "kiro" | "dsh"),
            "queued turns are not supported for this provider"
        );
        let request_id = Uuid::new_v4().to_string();
        self.write_input(
            run_id,
            &json!({"type":"queueStart","requestId":request_id}).to_string(),
        )
        .await?;
        self.emit(
            run_id,
            "queue.start.submitted",
            Some(run.provider.as_str()),
            None,
            json!({"request_id":request_id}),
            None,
        )?;
        Ok(())
    }

    pub async fn remove_queued(&self, run_id: &str, queue_id: &str) -> Result<()> {
        let run = self.db.run(run_id)?.context("run not found")?;
        anyhow::ensure!(
            matches!(run.provider.as_str(), "codex" | "kiro" | "dsh"),
            "queued turns are not supported for this provider"
        );
        let request_id = Uuid::new_v4().to_string();
        self.write_input(
            run_id,
            &json!({"type":"queueRemove","requestId":request_id,"queueId":queue_id}).to_string(),
        )
        .await?;
        self.emit(
            run_id,
            "queue.remove.submitted",
            Some(run.provider.as_str()),
            None,
            json!({"request_id":request_id,"queue_id":queue_id}),
            None,
        )?;
        Ok(())
    }

    pub async fn provider_response(
        &self,
        run_id: &str,
        rpc_id: serde_json::Value,
        result: serde_json::Value,
    ) -> Result<()> {
        let run = self.db.run(run_id)?.context("run not found")?;
        anyhow::ensure!(
            matches!(run.provider.as_str(), "codex" | "kiro"),
            "provider responses are not supported for this provider"
        );
        self.write_input(
            run_id,
            &json!({"type":"respond","rpcId":rpc_id,"result":result}).to_string(),
        )
        .await?;
        self.emit(
            run_id,
            "provider.response.submitted",
            Some(run.provider.as_str()),
            None,
            json!({"rpc_id":rpc_id}),
            None,
        )?;
        Ok(())
    }

    pub async fn interrupt(&self, run_id: &str) -> Result<()> {
        let run = self.db.run(run_id)?.context("run not found")?;
        if !matches!(run.provider.as_str(), "codex" | "kiro" | "dsh") {
            return self
                .signal(run_id, libc::SIGINT, "interrupt", "interrupting")
                .await;
        }
        let request_id = Uuid::new_v4().to_string();
        self.write_input(
            run_id,
            &json!({"type":"interrupt","requestId":request_id}).to_string(),
        )
        .await?;
        self.db.update_run_status(run_id, "interrupting")?;
        self.emit(
            run_id,
            "control.submitted",
            Some(match run.provider.as_str() {
                "kiro" => "kiro.session/cancel",
                "dsh" => "dsh.session.cancel",
                _ => "codex.turn/interrupt",
            }),
            None,
            json!({"action":"interrupt","request_id":request_id}),
            None,
        )?;
        Ok(())
    }

    async fn write_input(&self, run_id: &str, message: &str) -> Result<()> {
        let socket = input_socket(run_id);
        let mut stream = UnixStream::connect(socket)
            .await
            .context("run is not accepting live input")?;
        stream.write_all(message.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.shutdown().await?;
        Ok(())
    }
    pub async fn signal(&self, run_id: &str, signal: i32, name: &str, status: &str) -> Result<()> {
        let pgid = self
            .db
            .run(run_id)?
            .and_then(|run| run.process_group_id)
            .context("run is not active")?;
        if signal == libc::SIGKILL {
            self.db.finish_run(
                run_id,
                "killed",
                None,
                Some("SIGKILL"),
                &Utc::now().to_rfc3339(),
            )?;
        }
        let result = unsafe { libc::kill(-pgid, signal) };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if signal != libc::SIGKILL {
            self.db.update_run_status(run_id, status)?;
        }
        self.emit(
            run_id,
            "control.acknowledged",
            None,
            None,
            json!({"action":name,"signal":signal}),
            None,
        )?;
        Ok(())
    }
    fn emit(
        &self,
        run_id: &str,
        kind: &str,
        provider_type: Option<&str>,
        channel: Option<&str>,
        payload: serde_json::Value,
        raw: Option<serde_json::Value>,
    ) -> Result<Event> {
        let event = self.db.append_event(
            run_id,
            kind,
            provider_type,
            channel,
            &payload,
            raw.as_ref(),
            &Utc::now().to_rfc3339(),
        )?;
        let _ = self.events.send(event.clone());
        Ok(event)
    }
    pub async fn active_count(&self) -> usize {
        self.db
            .runs()
            .unwrap_or_default()
            .into_iter()
            .filter(|run| !is_terminal(Some(run)))
            .count()
    }
}

fn process_alive(pgid: i32) -> bool {
    if pgid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
fn input_socket(run_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("codesk-{run_id}.sock"))
}
fn is_terminal(run: Option<impl std::borrow::Borrow<Run>>) -> bool {
    run.map(|value| {
        matches!(
            value.borrow().status.as_str(),
            "completed" | "failed" | "interrupted" | "killed" | "orphaned"
        )
    })
    .unwrap_or(true)
}
