use std::{
    collections::{BTreeMap, HashMap},
    io::SeekFrom,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
    sync::{Notify, broadcast},
};
use uuid::Uuid;

use crate::{
    db::Db,
    model::{
        Event, ExternalQueuedInput, Project, Run, RunnerExit, RunnerSpec, StartRunRequest,
        TmuxControl, Worktree,
    },
    providers,
    tmux::{TmuxManager, TmuxPane},
    worktrees,
};

/// Cadence used while a runner is actively producing output.
const PUMP_ACTIVE_INTERVAL: Duration = Duration::from_millis(90);
/// Ceiling the pump backs off to once a runner goes quiet.
const PUMP_IDLE_INTERVAL: Duration = Duration::from_millis(2_000);
/// Cap on the unterminated remainder reported after a runner exits.
const MAX_TAIL_FLUSH_BYTES: u64 = 64 * 1024;

/// One runner log channel, with its reader and byte offset retained between
/// drains so a quiet tick costs a single `read` rather than a fresh open, seek,
/// and offset lookup.
struct ChannelPump {
    channel: &'static str,
    path: PathBuf,
    reader: Option<BufReader<tokio::fs::File>>,
    offset: u64,
}

impl ChannelPump {
    fn new(run_dir: &Path, channel: &'static str, offset: u64) -> Self {
        Self {
            channel,
            path: run_dir.join(format!("{channel}.log")),
            reader: None,
            offset,
        }
    }
}

/// How an attached runner stopped.
enum RunOutcome {
    Exited {
        status: &'static str,
        signal_name: Option<&'static str>,
        exit_code: Option<i32>,
        signal: Option<i32>,
        finished_at: String,
    },
    /// The runner's process group is gone but it never wrote exit metadata.
    Orphaned,
}

#[derive(Clone)]
pub struct Supervisor {
    pub db: Db,
    pub data_root: PathBuf,
    pub events: broadcast::Sender<Event>,
    pub tmux: TmuxManager,
    /// One waker per attached run, so submitting input can pull its pump out of
    /// idle backoff immediately instead of waiting for the next tick.
    wakeups: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
}

impl Supervisor {
    pub fn new(db: Db, data_root: PathBuf) -> Self {
        let (events, _) = broadcast::channel(2048);
        Self {
            db,
            tmux: TmuxManager::new(data_root.clone()),
            data_root,
            events,
            wakeups: Arc::default(),
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
            if run.input_transport.as_deref() == Some("tmux") {
                if self.db.tmux_control_for_run(&run.id)?.is_none() {
                    self.db.update_run_status(&run.id, "orphaned")?;
                }
                continue;
            }
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
        if request.operation.as_deref() == Some("resume") {
            if let Some(session_id) = request.resume_session_id.as_deref() {
                let already_active = self.db.tmux_controls()?.into_iter().any(|control| {
                    control.enabled
                        && control.status == "active"
                        && control.provider == request.provider
                        && control.native_session_id.as_deref() == Some(session_id)
                });
                anyhow::ensure!(
                    !already_active,
                    "this provider session already has an active tmux writer; send input to the existing session"
                );
            }
        }
        let project = self
            .db
            .project(&request.project_id)?
            .context("project not found")?;
        let (cwd, worktree) = match request.workspace_mode.as_str() {
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
                anyhow::ensure!(item.status != "removed", "worktree has been removed");
                (item.path.clone(), Some(item))
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
                (item.path.clone(), Some(item))
            }
            value => anyhow::bail!("unsupported workspace mode: {value}"),
        };
        let worktree_id = worktree.as_ref().map(|item| item.id.clone());
        let execution_prompt = worktree
            .as_ref()
            .map(|item| workspace_prompt(&request.prompt, &project, item))
            .unwrap_or_else(|| request.prompt.clone());
        let environment = workspace_environment(&project, worktree.as_ref());
        let id = Uuid::new_v4().to_string();
        let mut execution_request = request.clone();
        execution_request.prompt = execution_prompt.clone();
        let terminal_spec =
            if std::env::var("CODESK_RUN_TRANSPORT").is_ok_and(|value| value == "structured") {
                None
            } else {
                providers::build_terminal(&execution_request, &id, &cwd)?
            };
        let spec = match terminal_spec.as_ref() {
            Some(spec) => providers::support::CommandSpec {
                command: spec.command.clone(),
                args: spec.args.clone(),
                session_id: spec.session_id.clone(),
            },
            None => providers::build(&execution_request, &id, &cwd)?,
        };
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
            input_transport: terminal_spec.as_ref().map(|_| "tmux".to_string()),
            tmux_name: None,
            tmux_access_command: None,
        };
        self.db.create_run(&run)?;
        self.emit(
            &id,
            "run.created",
            None,
            None,
            json!({"title":run.title,"cwd":run.cwd,"workspace_mode":request.workspace_mode,"worktree_id":run.worktree_id}),
            None,
        )?;
        if terminal_spec.is_some() {
            let control_id = Uuid::new_v4().to_string();
            let launch = match self
                .tmux
                .launch(
                    &run.provider,
                    &run.cwd,
                    &run.command,
                    &run.args,
                    &control_id,
                    Some(&environment),
                    providers::keep_terminal_parent_shell(&run.provider),
                )
                .await
            {
                Ok(launch) => launch,
                Err(error) => {
                    self.db
                        .finish_run(&id, "failed", None, None, &Utc::now().to_rfc3339())?;
                    return Err(error);
                }
            };
            let started = Utc::now().to_rfc3339();
            self.db.update_run_tmux(
                &id,
                launch.pane.pane_pid,
                &launch.pane.session_name,
                &launch.access_command,
                &started,
            )?;
            run.pid = Some(launch.pane.pane_pid);
            run.process_group_id = Some(launch.pane.pane_pid as i32);
            run.status = "running".into();
            run.started_at = Some(started.clone());
            run.tmux_name = Some(launch.pane.session_name.clone());
            run.tmux_access_command = Some(launch.access_command.clone());
            let now = Utc::now().to_rfc3339();
            self.db.upsert_tmux_control(&TmuxControl {
                id: control_id,
                project_id: Some(run.project_id.clone()),
                run_id: Some(run.id.clone()),
                provider: run.provider.clone(),
                native_session_id: run.provider_session_id.clone(),
                transcript_path: None,
                source_pid: launch.pane.pane_pid,
                source_pgid: launch.pane.pane_pid as i32,
                cwd: run.cwd.clone(),
                original_command: std::iter::once(run.command.as_str())
                    .chain(run.args.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                socket_path: launch.pane.socket_path.clone(),
                pane_id: Some(launch.pane.pane_id.clone()),
                session_name: Some(launch.pane.session_name.clone()),
                access_command: Some(launch.access_command.clone()),
                owned: true,
                enabled: true,
                status: "active".to_string(),
                error: None,
                queue_state: if run.prompt.trim().is_empty() {
                    "ready"
                } else {
                    "awaiting_start"
                }
                .to_string(),
                queue_state_at: now.clone(),
                created_at: now.clone(),
                updated_at: now,
            })?;
            self.emit(
                &id,
                "run.started",
                Some("tmux"),
                None,
                json!({"pid":launch.pane.pane_pid,"tmux_name":launch.pane.session_name,"access_command":launch.access_command}),
                None,
            )?;
            if !run.prompt.trim().is_empty() {
                let tmux = self.tmux.clone();
                let pane = launch.pane;
                let prompt = execution_prompt.clone();
                let provider = run.provider.clone();
                tokio::spawn(async move {
                    for _ in 0..120 {
                        let current = tmux
                            .pane(pane.socket_path.as_deref(), &pane.pane_id)
                            .await
                            .ok()
                            .flatten();
                        if let Some(current) = current {
                            let screen = tmux.capture_text(&current).await.unwrap_or_default();
                            if providers::terminal_ready(&provider, &screen) {
                                let _ = tmux.send_prompt(&current, &prompt).await;
                                return;
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                });
            }
            return Ok(run);
        }
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
            prompt: execution_prompt.clone(),
            model: request.model.clone(),
            operation: request.operation.clone(),
            resume_session_id: request.resume_session_id.clone(),
            last_turn_id: request.last_turn_id.clone(),
            env: environment,
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
            .envs(&runner_spec.env)
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
        if let Some(message) = providers::encode_initial_prompt(&run.provider, &execution_prompt) {
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
        let this = self.clone();
        tokio::spawn(async move {
            this.pump(run).await;
        });
    }

    /// Drain the runner's stdout and stderr logs, watch for runner exit, and
    /// finalize the run — all from one task on one adaptive timer.
    ///
    /// This replaces three independent pollers (stdout at 180ms, stderr at
    /// 180ms, exit detection at 250ms) that each re-opened a file and re-queried
    /// SQLite on every tick whether or not anything had happened. The merged
    /// loop keeps both readers open, holds stream offsets in memory, and
    /// persists an offset once per drain instead of once per line. While output
    /// keeps arriving it polls at `PUMP_ACTIVE_INTERVAL`, which is faster than
    /// the old cadence; once both channels go quiet it backs off geometrically
    /// to `PUMP_IDLE_INTERVAL`. Submitting input wakes it immediately, so the
    /// backoff never delays a turn the user just started.
    async fn pump(&self, run: Run) {
        let run_dir = self.data_root.join("runs").join(&run.id);
        let wakeup = self.wakeup(&run.id);
        let mut channels = [
            ChannelPump::new(
                &run_dir,
                "stdout",
                self.db.stream_offset(&run.id, "stdout").unwrap_or(0),
            ),
            ChannelPump::new(
                &run_dir,
                "stderr",
                self.db.stream_offset(&run.id, "stderr").unwrap_or(0),
            ),
        ];
        let exit_path = run_dir.join("exit.json");
        let mut interval = PUMP_ACTIVE_INTERVAL;
        loop {
            let mut progressed = false;
            for channel in channels.iter_mut() {
                progressed |= self.drain(&run, channel).await;
            }
            if let Some(outcome) = self.runner_outcome(&run, &exit_path).await {
                // Consume whatever the runner wrote between the last drain and
                // its exit before reporting the run as finished.
                for channel in channels.iter_mut() {
                    while self.drain(&run, channel).await {}
                    self.flush_tail(&run, channel).await;
                }
                self.finish(&run, outcome);
                break;
            }
            interval = if progressed {
                PUMP_ACTIVE_INTERVAL
            } else {
                (interval * 2).min(PUMP_IDLE_INTERVAL)
            };
            // Checked on every tick, not only quiet ones: a run made terminal
            // elsewhere while its runner keeps writing must still release the
            // pump rather than being held open by its own output.
            if is_terminal(self.db.run(&run.id).ok().flatten().as_ref()) {
                break;
            }
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = wakeup.notified() => interval = PUMP_ACTIVE_INTERVAL,
            }
        }
        self.wakeups.lock().unwrap().remove(&run.id);
        let _ = tokio::fs::remove_file(input_socket(&run.id)).await;
    }

    /// Consume every complete line currently available on one channel, keeping
    /// the reader and byte offset across calls. Returns whether the runner had
    /// written anything since the previous drain.
    async fn drain(&self, run: &Run, channel: &mut ChannelPump) -> bool {
        if channel.reader.is_none() {
            let Ok(mut file) = tokio::fs::OpenOptions::new()
                .read(true)
                .open(&channel.path)
                .await
            else {
                return false;
            };
            if file.seek(SeekFrom::Start(channel.offset)).await.is_err() {
                return false;
            }
            channel.reader = Some(BufReader::new(file));
        }
        let Some(reader) = channel.reader.as_mut() else {
            return false;
        };
        let mut line = String::new();
        let mut consumed = false;
        let mut mid_write = false;
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(_) => {
                    if !line.ends_with('\n') {
                        // The runner is mid-write. Reopen from the last complete
                        // line on the next drain rather than parsing a fragment.
                        channel.reader = None;
                        mid_write = true;
                        break;
                    }
                    channel.offset += line.len() as u64;
                    consumed = true;
                    let text = line.trim_end_matches(['\r', '\n']);
                    if text.is_empty() {
                        continue;
                    }
                    let (kind, provider_type, payload, raw, session) =
                        providers::normalize_line(&run.provider, channel.channel, text);
                    if let Some(session) = session {
                        let _ = self.db.set_provider_session(&run.id, &session);
                    }
                    if let Some(status) = providers::status_from_event(&run.provider, raw.as_ref())
                    {
                        let _ = self.db.update_run_status(&run.id, status);
                    }
                    let _ = self.emit(
                        &run.id,
                        &kind,
                        provider_type.as_deref(),
                        Some(channel.channel),
                        payload,
                        raw,
                    );
                }
                Err(_) => {
                    channel.reader = None;
                    break;
                }
            }
        }
        if consumed {
            // One offset write per drain instead of one per streamed line.
            let _ = self
                .db
                .set_stream_offset(&run.id, channel.channel, channel.offset);
        }
        consumed || mid_write
    }

    /// Emit a final line the runner left without a trailing newline.
    ///
    /// [`Self::drain`] deliberately stops at the last complete line, because
    /// before the runner exits a fragment only means a write is in progress.
    /// Once it has exited the fragment is all there will ever be — typically a
    /// panic message on stderr — so it is reported rather than discarded.
    async fn flush_tail(&self, run: &Run, channel: &mut ChannelPump) {
        channel.reader = None;
        let Ok(mut file) = tokio::fs::OpenOptions::new()
            .read(true)
            .open(&channel.path)
            .await
        else {
            return;
        };
        if file.seek(SeekFrom::Start(channel.offset)).await.is_err() {
            return;
        }
        let mut rest = String::new();
        if file
            .take(MAX_TAIL_FLUSH_BYTES)
            .read_to_string(&mut rest)
            .await
            .is_err()
        {
            return;
        }
        channel.offset += rest.len() as u64;
        let text = rest.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            return;
        }
        let (kind, provider_type, payload, raw, session) =
            providers::normalize_line(&run.provider, channel.channel, text);
        if let Some(session) = session {
            let _ = self.db.set_provider_session(&run.id, &session);
        }
        let _ = self.emit(
            &run.id,
            &kind,
            provider_type.as_deref(),
            Some(channel.channel),
            payload,
            raw,
        );
        let _ = self
            .db
            .set_stream_offset(&run.id, channel.channel, channel.offset);
    }

    /// Detect that a runner has finished, preferring the metadata it writes on
    /// exit and falling back to process-group liveness.
    async fn runner_outcome(&self, run: &Run, exit_path: &Path) -> Option<RunOutcome> {
        if let Ok(bytes) = tokio::fs::read(exit_path).await {
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
                return Some(RunOutcome::Exited {
                    status,
                    signal_name,
                    exit_code: result.exit_code,
                    signal: result.signal,
                    finished_at: result.finished_at,
                });
            }
        }
        (!run.process_group_id.is_some_and(process_alive)).then_some(RunOutcome::Orphaned)
    }

    fn finish(&self, run: &Run, outcome: RunOutcome) {
        match outcome {
            RunOutcome::Exited {
                status,
                signal_name,
                exit_code,
                signal,
                finished_at,
            } => {
                let _ = self
                    .db
                    .finish_run(&run.id, status, exit_code, signal_name, &finished_at);
                let _ = self.emit(
                    &run.id,
                    &format!("run.{status}"),
                    None,
                    None,
                    json!({"exit_code":exit_code,"signal":signal}),
                    None,
                );
            }
            RunOutcome::Orphaned => {
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
            }
        }
    }

    fn wakeup(&self, run_id: &str) -> Arc<Notify> {
        self.wakeups
            .lock()
            .unwrap()
            .entry(run_id.to_string())
            .or_default()
            .clone()
    }

    /// Pull a run's pump out of idle backoff so input the user just submitted is
    /// streamed back at the active cadence.
    pub(crate) fn wake(&self, run_id: &str) {
        if let Some(notify) = self.wakeups.lock().unwrap().get(run_id) {
            notify.notify_one();
        }
    }

    /// Read a terminal-driven harness's model catalog by opening its picker,
    /// paging through it, and dismissing it again. Kiro shows only eight rows at
    /// a time and exposes no non-interactive listing, so paging is the only way
    /// to see the full catalog from a tmux-controlled session.
    pub async fn provider_models(&self, run_id: &str) -> Result<Vec<Value>> {
        let run = self.db.run(run_id)?.context("run not found")?;
        anyhow::ensure!(
            run.provider == "kiro",
            "model discovery is only implemented for Kiro terminals"
        );
        let control = self
            .db
            .tmux_control_for_run(run_id)?
            .context("this run is not attached to a tmux pane")?;
        let pane = self.tmux_pane(&control).await?;
        let screen = self.tmux.capture_text(&pane).await?;
        anyhow::ensure!(
            providers::terminal_ready(&run.provider, &screen),
            "the harness is busy; wait for the current turn to finish"
        );
        self.tmux.send_prompt(&pane, "/model").await?;
        let mut models: Vec<Value> = Vec::new();
        let mut expected = None;
        let mut unchanged = 0;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let screen = self.tmux.capture_text(&pane).await.unwrap_or_default();
            let page = providers::parse_model_page(&run.provider, &screen);
            let before = models.len();
            for model in page.models {
                let id = model.get("id").and_then(Value::as_str).unwrap_or_default();
                match models
                    .iter_mut()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                {
                    // Keep the row that carried the `[active]` marker.
                    Some(existing) if model["active"] == Value::Bool(true) => *existing = model,
                    Some(_) => {}
                    None => models.push(model),
                }
            }
            // The picker only scrolls once the cursor crosses the visible rows,
            // so trust its own remainder count rather than an idle-page guess.
            if expected.is_none() {
                if let Some(more) = page.more {
                    expected = Some(models.len() + more);
                }
            }
            match expected {
                Some(total) if models.len() >= total => break,
                None if models.len() == before && !models.is_empty() => {
                    unchanged += 1;
                    if unchanged >= 3 {
                        break;
                    }
                }
                _ => unchanged = 0,
            }
            self.tmux.send_key(&pane, "Down").await?;
        }
        self.tmux.send_key(&pane, "Escape").await?;
        anyhow::ensure!(!models.is_empty(), "the model picker returned no models");
        Ok(models)
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
        if let Some(control) = self.db.tmux_control_for_run(run_id)? {
            if delivery == "queue" {
                let item = ExternalQueuedInput {
                    id: Uuid::new_v4().to_string(),
                    pid: control.source_pid,
                    project_id: run.project_id.clone(),
                    session_id: control.native_session_id.clone(),
                    message: message.to_string(),
                    title: Some(run.title.clone()),
                    created_at: Utc::now().to_rfc3339(),
                    status: "queued".to_string(),
                    error: None,
                    run: None,
                };
                self.db.enqueue_tmux_input(&control.id, &item)?;
                self.emit(
                    run_id,
                    "queue.added",
                    Some("tmux"),
                    None,
                    json!({"queue_id":item.id,"text":message}),
                    None,
                )?;
                return Ok(());
            }
            let pane = self.tmux_pane(&control).await?;
            self.tmux.send_prompt(&pane, message).await?;
            if let Some(close_key) = providers::terminal_overlay_command(&run.provider, message) {
                // The harness paints this command in its own terminal UI and
                // writes nothing to the transcript. Capture the panel, report it
                // as a run event, then dismiss it so the pane stays steerable.
                self.emit(
                    run_id,
                    "input.submitted",
                    Some("steer"),
                    None,
                    json!({"message":message,"delivery":"steer"}),
                    None,
                )?;
                let tmux = self.tmux.clone();
                let provider = run.provider.clone();
                let events = self.events.clone();
                let db = self.db.clone();
                let run_id = run_id.to_string();
                let message = message.to_string();
                tokio::spawn(async move {
                    let mut usage = None;
                    for _ in 0..40 {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        let screen = tmux.capture_text(&pane).await.unwrap_or_default();
                        if let Some(parsed) = providers::parse_terminal_usage(&provider, &screen) {
                            usage = Some(parsed);
                            break;
                        }
                    }
                    let _ = tmux.send_key(&pane, close_key).await;
                    let payload = match usage {
                        Some(usage) => usage,
                        None => json!({
                            "source":"terminal",
                            "error":format!("{message} produced no readable terminal output"),
                        }),
                    };
                    let event = db.append_event(
                        &run_id,
                        "usage.updated",
                        Some("kiro.usage"),
                        Some("tmux"),
                        &payload,
                        None,
                        &Utc::now().to_rfc3339(),
                    );
                    if let Ok(event) = event {
                        let _ = events.send(event);
                    }
                });
                return Ok(());
            }
            self.db
                .update_tmux_queue_state(&control.id, "awaiting_start")?;
            self.emit(
                run_id,
                "input.submitted",
                Some("steer"),
                None,
                json!({"message":message,"delivery":"steer"}),
                None,
            )?;
            return Ok(());
        }
        let request_id = request_id
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let encoded =
            providers::encode_input(&run.provider, message, &request_id, delivery, last_turn_id)?;
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
        if let Some(control) = self.db.tmux_control_for_run(run_id)? {
            self.db.update_tmux_queue_state(&control.id, "ready")?;
            return Ok(());
        }
        anyhow::ensure!(
            providers::require(&run.provider)?.descriptor().queued_input,
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
        if let Some(control) = self.db.tmux_control_for_run(run_id)? {
            anyhow::ensure!(
                self.db.delete_tmux_queue(&control.id, queue_id)?,
                "queued message not found or already sending"
            );
            self.emit(
                run_id,
                "queue.removed",
                Some("tmux"),
                None,
                json!({"queue_id":queue_id}),
                None,
            )?;
            return Ok(());
        }
        anyhow::ensure!(
            providers::require(&run.provider)?.descriptor().queued_input,
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
            providers::require(&run.provider)?
                .descriptor()
                .provider_responses,
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
        if let Some(control) = self.db.tmux_control_for_run(run_id)? {
            let pane = self.tmux_pane(&control).await?;
            self.tmux.interrupt(&pane).await?;
            self.db.update_run_status(run_id, "interrupting")?;
            self.emit(
                run_id,
                "control.submitted",
                Some("tmux.send-keys"),
                None,
                json!({"action":"interrupt"}),
                None,
            )?;
            return Ok(());
        }
        let adapter = providers::require(&run.provider)?;
        if !adapter.descriptor().native_interrupt {
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
            Some(adapter.interrupt_event_type()),
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
        // The response to this input is what the user is waiting for, so bring
        // the run's pump back to its active cadence immediately.
        self.wake(run_id);
        Ok(())
    }
    pub async fn signal(&self, run_id: &str, signal: i32, name: &str, status: &str) -> Result<()> {
        if let Some(control) = self.db.tmux_control_for_run(run_id)? {
            let pane = self.tmux_pane(&control).await?;
            self.tmux.kill_pane(&pane).await?;
            let terminal_status = if signal == libc::SIGKILL {
                "killed"
            } else {
                "interrupted"
            };
            self.db.finish_run(
                run_id,
                terminal_status,
                None,
                Some(if signal == libc::SIGKILL {
                    "SIGKILL"
                } else {
                    "SIGTERM"
                }),
                &Utc::now().to_rfc3339(),
            )?;
            self.db
                .update_tmux_control_status(&control.id, "dead", None)?;
            self.emit(
                run_id,
                &format!("run.{terminal_status}"),
                Some("tmux"),
                None,
                json!({"action":name,"signal":signal}),
                None,
            )?;
            return Ok(());
        }
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

    async fn tmux_pane(&self, control: &TmuxControl) -> Result<TmuxPane> {
        let pane_id = control
            .pane_id
            .as_deref()
            .context("tmux pane is unavailable")?;
        self.tmux
            .pane(control.socket_path.as_deref(), pane_id)
            .await?
            .context("tmux pane is no longer available")
    }
    pub(crate) fn emit(
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

fn workspace_environment(
    project: &Project,
    worktree: Option<&Worktree>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::from([
        ("CODESK_PROJECT_PATH".into(), project.path.clone()),
        (
            "CODESK_WORKSPACE_MODE".into(),
            if worktree.is_some() {
                "managed_worktree".into()
            } else {
                "current_checkout".into()
            },
        ),
    ]);
    if let Some(item) = worktree {
        environment.insert("CODESK_WORKTREE_ID".into(), item.id.clone());
        environment.insert("CODESK_WORKTREE_PATH".into(), item.path.clone());
        if let Some(branch) = item.branch.clone() {
            environment.insert("CODESK_WORKTREE_BRANCH".into(), branch);
        }
        if let Some(base_ref) = item.base_ref.clone() {
            environment.insert("CODESK_MERGE_TARGET".into(), base_ref);
        }
    }
    environment
}

fn workspace_prompt(prompt: &str, project: &Project, worktree: &Worktree) -> String {
    let context = json!({
        "mode": "managed_worktree",
        "project_checkout": project.path,
        "worktree_path": worktree.path,
        "worktree_branch": worktree.branch,
        "merge_target": worktree.base_ref,
        "environment_variables": [
            "CODESK_PROJECT_PATH",
            "CODESK_WORKTREE_ID",
            "CODESK_WORKTREE_PATH",
            "CODESK_WORKTREE_BRANCH",
            "CODESK_MERGE_TARGET"
        ],
        "merge_instructions": [
            "Work only in the managed worktree unless the user explicitly asks to merge.",
            "When asked to merge, first commit all intended worktree changes.",
            "Refuse to merge if the project checkout has uncommitted changes; never clean, reset, stash, or overwrite them automatically.",
            "Merge with: git -C \"$CODESK_PROJECT_PATH\" merge --no-edit \"$CODESK_WORKTREE_BRANCH\"",
            "If Git reports conflicts, run git -C \"$CODESK_PROJECT_PATH\" merge --abort and report the conflict instead of resolving it without permission."
        ]
    });
    format!(
        "<environment_context>\n{}\n</environment_context>\n\n{}",
        serde_json::to_string_pretty(&context).unwrap_or_else(|_| context.to_string()),
        prompt
    )
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
