use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{Value, json};
use tokio::{
    io::AsyncWriteExt,
    net::UnixStream,
    process::Command,
    sync::{Notify, broadcast},
};
use uuid::Uuid;

use crate::{
    db::Db,
    model::{
        Event, ExternalQueuedInput, Project, Run, RunnerSpec, StartRunRequest, TmuxControl,
        Worktree,
    },
    providers::{self, ModelControl, TerminalStatus, codex},
    tmux::{TmuxManager, TmuxPane},
    worktrees,
};

#[derive(Clone)]
pub struct Supervisor {
    pub db: Db,
    pub data_root: PathBuf,
    pub events: broadcast::Sender<Event>,
    pub tmux: TmuxManager,
    /// One waker per attached run, so submitting input can pull its pump out of
    /// idle backoff immediately instead of waiting for the next tick.
    pub(crate) wakeups: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
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
                }) || resume_already_running(
                    &request.provider,
                    session_id,
                    process_command_lines(),
                );
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
                    // Each probe spawns two tmux subprocesses (list-panes and
                    // capture-pane), so back off geometrically instead of
                    // hammering a fixed 250ms: harnesses that start fast are
                    // still caught within ~100ms, slow ones cost a handful of
                    // probes instead of 120.
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
                    let mut delay = Duration::from_millis(100);
                    while tokio::time::Instant::now() < deadline {
                        let current = tmux
                            .pane(pane.socket_path.as_deref(), &pane.pane_id)
                            .await
                            .ok()
                            .flatten();
                        if let Some(current) = current {
                            let screen = tmux.capture_text(&current).await.unwrap_or_default();
                            if let Some(key) = providers::terminal_startup_key(&provider, &screen) {
                                let _ = tmux.send_key(&current, key).await;
                            } else if providers::terminal_ready(&provider, &screen) {
                                let _ = tmux.send_prompt(&current, &prompt).await;
                                return;
                            }
                        }
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(Duration::from_secs(2));
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
        let mut child = command.spawn().context("spawn durable runner")?;
        let pid = child.id().context("runner has no pid")?;
        let pgid = pid as i32;
        // The runner is detached (kill_on_drop is off, own process group), but
        // it is still our direct child: without a wait it stays a zombie in the
        // process table for as long as this daemon lives.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        let ready_path = run_dir.join("ready");
        let mut runner_ready = false;
        for _ in 0..500 {
            if tokio::fs::try_exists(&ready_path).await.unwrap_or(false) {
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

    pub(crate) fn wakeup(&self, run_id: &str) -> Arc<Notify> {
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

    /// A tmux-controlled run whose harness can be driven through its own model
    /// picker, with the pane confirmed idle so the keystrokes cannot land in a
    /// turn that is still running.
    async fn model_control_pane(
        &self,
        run_id: &str,
    ) -> Result<(Run, TmuxPane, ModelControl, TerminalStatus)> {
        let run = self.db.run(run_id)?.context("run not found")?;
        let control = providers::model_control(&run.provider).with_context(|| {
            format!("{} does not expose a model picker to Codesk", run.provider)
        })?;
        let tmux_control = self
            .db
            .tmux_control_for_run(run_id)?
            .context("this run is not attached to a tmux pane")?;
        let pane = self.tmux_pane(&tmux_control).await?;
        let mut screen = self.tmux.capture_text(&pane).await?;
        // An attempt that failed part-way leaves a picker covering the status
        // line, which would read as a busy harness forever.
        if providers::terminal_picker_open(&run.provider, &screen) {
            self.close_overlay(&run.provider, &pane).await;
            self.await_ready(&run.provider, &pane).await;
            screen = self.tmux.capture_text(&pane).await?;
        }
        anyhow::ensure!(
            providers::terminal_ready(&run.provider, &screen),
            "the harness is busy; wait for the current turn to finish"
        );
        // Read the live model from the same screen that proved the pane idle.
        // Once a picker is open the status line is covered, so this is the last
        // chance to see it.
        let status = providers::parse_terminal_status(&run.provider, &screen).unwrap_or_default();
        Ok((run, pane, control, status))
    }

    /// The model catalog, the reasoning levels, and what the session is running
    /// right now — everything the composer needs to offer a change.
    pub async fn provider_models(&self, run_id: &str) -> Result<Value> {
        let (run, pane, control, status) = self.model_control_pane(run_id).await?;
        let models = match control {
            ModelControl::Command => self.paged_catalog(&run.provider, &pane).await?,
            ModelControl::NumberedPicker => self.numbered_catalog(&run.provider, &pane).await?,
        };
        anyhow::ensure!(!models.is_empty(), "the model picker returned no models");
        let efforts = providers::effort_levels(&run.provider)
            .iter()
            .map(|level| json!({"id": level.id, "label": level.label}))
            .collect::<Vec<_>>();
        Ok(json!({
            "models": models,
            "efforts": efforts,
            "model": status.model,
            "effort": status.effort,
        }))
    }

    /// Read a catalog that only shows a few rows at a time by walking the
    /// picker down one row at a time. Kiro shows eight rows and exposes no
    /// non-interactive listing, so paging is the only way to see all of them.
    async fn paged_catalog(&self, provider: &str, pane: &TmuxPane) -> Result<Vec<Value>> {
        self.tmux.send_prompt(pane, "/model").await?;
        let mut models: Vec<Value> = Vec::new();
        let mut expected = None;
        let mut unchanged = 0;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let screen = self.tmux.capture_text(pane).await.unwrap_or_default();
            let page = providers::parse_model_page(provider, &screen);
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
            self.tmux.send_key(pane, "Down").await?;
        }
        self.tmux.send_key(pane, "Escape").await?;
        self.await_ready(provider, pane).await;
        Ok(models)
    }

    /// Read a catalog that fits on one page, then leave the picker as it was
    /// found. Codex's page lists every model at once, so it only has to be
    /// opened, read, and dismissed.
    async fn numbered_catalog(&self, provider: &str, pane: &TmuxPane) -> Result<Vec<Value>> {
        self.tmux.send_prompt(pane, "/model").await?;
        let mut models = Vec::new();
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let screen = self.tmux.capture_text(pane).await.unwrap_or_default();
            models = providers::parse_model_page(provider, &screen).models;
            if !models.is_empty() {
                break;
            }
        }
        self.tmux.send_key(pane, "Escape").await?;
        self.await_ready(provider, pane).await;
        Ok(models)
    }

    /// Wait for the composer to come back after a picker was dismissed. A pane
    /// that is still painting the closing overlay reads as a busy harness, and
    /// the next call would be refused for the wrong reason.
    async fn await_ready(&self, provider: &str, pane: &TmuxPane) {
        for _ in 0..25 {
            let screen = self.tmux.capture_text(pane).await.unwrap_or_default();
            if providers::terminal_ready(provider, &screen) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Change a terminal-driven harness's model, its reasoning effort, or both,
    /// then answer with what the harness itself reports afterwards rather than
    /// with what was asked for.
    pub async fn set_provider_model(
        &self,
        run_id: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<Value> {
        anyhow::ensure!(
            model.is_some() || effort.is_some(),
            "no model or effort was requested"
        );
        let (run, pane, control, live) = self.model_control_pane(run_id).await?;
        if let Some(effort) = effort {
            anyhow::ensure!(
                providers::effort_levels(&run.provider)
                    .iter()
                    .any(|level| level.id == effort),
                "{} does not offer the reasoning level {effort}",
                run.provider
            );
        }
        // A picker asks for a reasoning level with every model change and
        // offers the new model's default, so a model-only change would quietly
        // reset it. Ask for the level already in use instead.
        let effort = match (control, effort) {
            (ModelControl::NumberedPicker, None) => carried_effort(&run.provider, &live),
            _ => effort,
        };
        let walked = match control {
            ModelControl::Command => self.change_by_command(&pane, model, effort).await,
            ModelControl::NumberedPicker => self.change_by_picker(&pane, model, effort).await,
        };
        // A refused command or a half-walked picker leaves an overlay on
        // screen, and the next prompt would be typed into it.
        if let Err(error) = walked {
            self.close_overlay(&run.provider, &pane).await;
            return Err(error);
        }
        let status = self
            .settled_status(&run.provider, &pane, model, effort)
            .await;
        if !status_matches(&status, model, effort) {
            self.close_overlay(&run.provider, &pane).await;
            anyhow::bail!(
                "{} did not apply the change and still reports {} {}",
                run.provider,
                status.model.as_deref().unwrap_or("an unknown model"),
                status.effort.as_deref().unwrap_or_default()
            );
        }
        Ok(json!({"model": status.model, "effort": status.effort}))
    }

    /// Leave the pane steerable whatever happened. A picker can be three pages
    /// deep and each Escape only walks back one of them.
    async fn close_overlay(&self, provider: &str, pane: &TmuxPane) {
        for _ in 0..4 {
            let screen = self.tmux.capture_text(pane).await.unwrap_or_default();
            if !providers::terminal_picker_open(provider, &screen) {
                return;
            }
            let _ = self.tmux.send_key(pane, "Escape").await;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Kiro takes the new value as an argument and applies it immediately.
    async fn change_by_command(
        &self,
        pane: &TmuxPane,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<()> {
        for command in [
            model.map(|model| format!("/model {model}")),
            effort.map(|effort| format!("/effort {effort}")),
        ]
        .into_iter()
        .flatten()
        {
            self.tmux.send_prompt(pane, &command).await?;
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        Ok(())
    }

    /// Codex only exposes model and effort through one `/model` picker, and it
    /// always walks the model page into a reasoning page. An effort-only change
    /// therefore re-picks the model already in use, and a model-only change
    /// re-picks the reasoning level already in use.
    async fn change_by_picker(
        &self,
        pane: &TmuxPane,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<()> {
        self.tmux.send_prompt(pane, "/model").await?;
        let rows = self.picker_page(pane, codex::MODEL_HEADING).await?;
        let row = match model {
            Some(model) => codex::row_number(&rows, model)
                .with_context(|| format!("Codex does not offer the model {model}"))?,
            None => codex::unchanged_row(&rows)
                .context("the model picker does not mark the model in use")?,
        };
        self.pick_row(pane, &rows, row).await?;

        let rows = self.picker_page(pane, codex::REASONING_HEADING).await?;
        let Some(effort) = effort else {
            let row = codex::unchanged_row(&rows)
                .context("the reasoning picker does not mark the level in use")?;
            return self.pick_row(pane, &rows, row).await;
        };
        let label = codex::effort_label(effort)
            .with_context(|| format!("Codex does not offer the reasoning level {effort}"))?;
        if let Some(row) = codex::row_number(&rows, label) {
            return self.pick_row(pane, &rows, row).await;
        }
        // Max and Ultra live behind a submenu.
        let more = codex::more_reasoning_row(&rows)
            .with_context(|| format!("the reasoning picker does not list {label}"))?;
        self.pick_row(pane, &rows, more).await?;
        let rows = self.picker_page(pane, codex::ADVANCED_HEADING).await?;
        let row = codex::row_number(&rows, label)
            .with_context(|| format!("the reasoning picker does not list {label}"))?;
        self.pick_row(pane, &rows, row).await
    }

    async fn picker_page(&self, pane: &TmuxPane, heading: &str) -> Result<Vec<codex::PickerRow>> {
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let screen = self.tmux.capture_text(pane).await.unwrap_or_default();
            let rows = codex::parse_picker_page(&screen, heading);
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
        anyhow::bail!("the picker never showed its \"{heading}\" page")
    }

    /// Typing a row's number selects it outright. Rows past nine cannot be
    /// typed as one keystroke, so those are reached by walking the cursor.
    async fn pick_row(
        &self,
        pane: &TmuxPane,
        rows: &[codex::PickerRow],
        target: usize,
    ) -> Result<()> {
        if target <= 9 {
            return self.tmux.send_key(pane, &target.to_string()).await;
        }
        let cursor = codex::selected_row(rows).unwrap_or(1);
        let key = if target > cursor { "Down" } else { "Up" };
        for _ in 0..cursor.abs_diff(target) {
            self.tmux.send_key(pane, key).await?;
        }
        self.tmux.send_key(pane, "Enter").await
    }

    /// Wait for the harness's own status line to show the change.
    async fn settled_status(
        &self,
        provider: &str,
        pane: &TmuxPane,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> TerminalStatus {
        let mut status = TerminalStatus::default();
        for _ in 0..25 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let screen = self.tmux.capture_text(pane).await.unwrap_or_default();
            if let Some(current) = providers::parse_terminal_status(provider, &screen) {
                status = current;
                if status_matches(&status, model, effort) {
                    break;
                }
            }
        }
        status
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
        self.db.active_run_count().unwrap_or_default()
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

fn process_command_lines() -> Vec<String> {
    std::process::Command::new("ps")
        .args(["-ax", "-o", "args="])
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The reasoning level to re-affirm on the new model's page, which is the one
/// the session is on. A session that was never given a level reports `default`
/// rather than a level, and that is left to the picker's own cursor.
fn carried_effort<'a>(provider: &str, live: &'a TerminalStatus) -> Option<&'a str> {
    let effort = live.effort.as_deref()?;
    providers::effort_levels(provider)
        .iter()
        .any(|level| level.id == effort)
        .then_some(effort)
}

/// Whether the harness now reports the model and effort that were requested.
/// A value that was not requested is left alone and never has to match.
fn status_matches(status: &TerminalStatus, model: Option<&str>, effort: Option<&str>) -> bool {
    model.is_none_or(|model| status.model.as_deref() == Some(model))
        && effort.is_none_or(|effort| status.effort.as_deref() == Some(effort))
}

fn resume_already_running(
    provider: &str,
    session_id: &str,
    commands: impl IntoIterator<Item = impl AsRef<str>>,
) -> bool {
    commands.into_iter().any(|command| {
        let command = command.as_ref();
        providers::get(provider).is_some_and(|adapter| {
            adapter.matches_command(command)
                && adapter.command_session_id(command).as_deref() == Some(session_id)
        })
    })
}

pub(crate) fn process_alive(pgid: i32) -> bool {
    if pgid <= 0 {
        return false;
    }
    let result = unsafe { libc::kill(pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
pub(crate) fn input_socket(run_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("codesk-{run_id}.sock"))
}

#[cfg(test)]
mod tests {
    use super::resume_already_running;

    #[test]
    fn resume_sees_a_live_codex_command_line() {
        let session = "01a02d7b-fb6b-7693-92cf-1d548d170538";
        assert!(resume_already_running(
            "codex",
            session,
            [format!("/usr/bin/codex resume {session} --yolo")],
        ));
        assert!(!resume_already_running(
            "codex",
            session,
            ["codex resume 00000000-0000-0000-0000-000000000000 --yolo"],
        ));
    }
}
