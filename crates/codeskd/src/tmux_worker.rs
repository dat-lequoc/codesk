use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use serde_json::json;

use crate::{
    AppState, cached_agents, discovery,
    discovery_cache::invalidate_discovery,
    model::{ProviderSession, Run, TmuxControl},
    providers, sessions, tmux,
};

/// Cadence used while at least one tmux session is under Codesk control.
const TMUX_WORKER_ACTIVE_INTERVAL: Duration = Duration::from_millis(350);
/// Cadence used when nothing is under control. Enabling control writes a row and
/// the next tick picks it up, so the only cost of the longer wait is how soon
/// after that a newly controlled pane starts being serviced.
const TMUX_WORKER_IDLE_INTERVAL: Duration = Duration::from_millis(2_000);
/// Attempts before a control stops trying to recover its session metadata.
///
/// Recovery can legitimately never succeed — a pane the user started outside
/// Codesk may have no provider transcript to find. Retrying it on every tick
/// forced a full `ps` process scan once a second for the life of the daemon, so
/// attempts back off and then stop. The control keeps working without the
/// metadata; only the recovery attempt is abandoned.
const RECOVERY_MAX_ATTEMPTS: u32 = 8;
const RECOVERY_FIRST_BACKOFF: Duration = Duration::from_secs(2);
const RECOVERY_MAX_BACKOFF: Duration = Duration::from_secs(300);

/// Retry state for one control's session-metadata recovery.
struct RecoveryBackoff {
    attempts: u32,
    next: Instant,
}

/// Resolve a control's pane from a snapshot already taken for this tick. Same
/// contract as [`control_pane`], without the per-control subprocess spawn.
fn control_pane_from(
    control: &TmuxControl,
    panes: &tmux::PaneSnapshot,
) -> anyhow::Result<tmux::TmuxPane> {
    let pane_id = control
        .pane_id
        .as_deref()
        .context("tmux pane is unavailable")?;
    panes
        .get(control.socket_path.as_deref(), pane_id)
        .cloned()
        .context("tmux pane is no longer available")
}

pub(crate) async fn tmux_control_worker(state: Arc<AppState>) {
    let mut last_recovery_scan = Instant::now()
        .checked_sub(Duration::from_secs(2))
        .unwrap_or_else(Instant::now);
    let mut recovery: HashMap<String, RecoveryBackoff> = HashMap::new();
    loop {
        let live = state
            .db
            .tmux_controls()
            .unwrap_or_default()
            .into_iter()
            // `enabled` is the user's intent and survives the pane, so it alone
            // does not mean there is work to do. Only the two statuses this loop
            // acts on below are actionable; `dead` and `failed` are terminal.
            // Including them kept a table full of finished controls in the fast
            // 350ms cadence forever, which is a measurable idle CPU cost.
            .filter(|control| {
                control.enabled && matches!(control.status.as_str(), "active" | "waiting_idle")
            })
            .collect::<Vec<_>>();
        if live.is_empty() {
            // Nothing is supervised, so skip the pane snapshot entirely and stop
            // waking several times a second just to re-read an empty table.
            recovery.clear();
            tokio::time::sleep(TMUX_WORKER_IDLE_INTERVAL).await;
            continue;
        }
        recovery.retain(|id, _| live.iter().any(|control| &control.id == id));
        let now = Instant::now();
        let recovery_due = |control: &TmuxControl, recovery: &HashMap<String, RecoveryBackoff>| {
            needs_metadata(control)
                && recovery
                    .get(&control.id)
                    .is_none_or(|entry| entry.attempts < RECOVERY_MAX_ATTEMPTS && entry.next <= now)
        };
        if last_recovery_scan.elapsed() >= Duration::from_secs(1)
            && live.iter().any(|control| recovery_due(control, &recovery))
        {
            let _ = cached_agents(&state, true).await;
            last_recovery_scan = Instant::now();
        }
        // One pane listing per distinct socket for the whole tick, shared by
        // every control below instead of spawning `tmux` once per control.
        let sockets = live
            .iter()
            .map(|control| control.socket_path.clone())
            .collect::<Vec<_>>();
        let panes = state.tmux.pane_snapshot(&sockets).await;
        let mut serviceable = false;
        for mut control in live {
            if recovery_due(&control, &recovery) {
                match recover_tmux_control_metadata(&state, &control).await {
                    Ok(Some(recovered)) => {
                        control = recovered;
                        recovery.remove(&control.id);
                    }
                    Ok(None) => defer_recovery(&mut recovery, &control.id, None),
                    Err(error) => defer_recovery(&mut recovery, &control.id, Some(&error)),
                }
            }
            let result = if control.status == "waiting_idle" {
                process_tmux_move(&state, &control).await
            } else if control.status == "active" {
                process_tmux_queue(&state, &control, &panes).await
            } else {
                Ok(())
            };
            if let Err(error) = result {
                let _ = state.db.update_tmux_control_status(
                    &control.id,
                    "failed",
                    Some(&error.to_string()),
                );
            }
            serviceable |= is_serviceable(&control);
        }
        // A control that cannot act needs nothing from this loop but liveness
        // detection, and noticing a closed pane a second later is harmless. Only
        // pay the fast cadence — a `tmux` process per socket per tick — when some
        // control can actually make progress on it.
        tokio::time::sleep(if serviceable {
            TMUX_WORKER_ACTIVE_INTERVAL
        } else {
            TMUX_WORKER_IDLE_INTERVAL
        })
        .await;
    }
}

/// Whether this control has work the fast cadence can actually advance.
///
/// `waiting_idle` runs a state machine with a sub-second threshold, so it always
/// qualifies. An `active` control only qualifies once it has a transcript to read
/// from: without one [`process_tmux_queue`] returns before doing anything, so
/// polling it three times a second only spawns `tmux` to no purpose.
fn is_serviceable(control: &TmuxControl) -> bool {
    match control.status.as_str() {
        "waiting_idle" => true,
        "active" => control.transcript_path.is_some(),
        _ => false,
    }
}

/// True when a control is active but still missing the metadata needed to read
/// its session.
fn needs_metadata(control: &TmuxControl) -> bool {
    control.status == "active"
        && (control.transcript_path.is_none() || control.native_session_id.is_none())
}

/// Record a failed recovery attempt and push the next one further out.
fn defer_recovery(
    recovery: &mut HashMap<String, RecoveryBackoff>,
    control_id: &str,
    error: Option<&anyhow::Error>,
) {
    let entry = recovery
        .entry(control_id.to_string())
        .or_insert_with(|| RecoveryBackoff {
            attempts: 0,
            next: Instant::now(),
        });
    entry.attempts += 1;
    let backoff = RECOVERY_FIRST_BACKOFF
        .saturating_mul(1 << entry.attempts.min(8))
        .min(RECOVERY_MAX_BACKOFF);
    entry.next = Instant::now() + backoff;
    if let Some(error) = error {
        tracing::warn!(
            control_id = %control_id,
            attempts = entry.attempts,
            %error,
            "tmux session metadata recovery is still pending"
        );
    }
    if entry.attempts == RECOVERY_MAX_ATTEMPTS {
        tracing::warn!(
            control_id = %control_id,
            attempts = entry.attempts,
            "giving up on tmux session metadata recovery; the control keeps running without it"
        );
    }
}

async fn recover_tmux_control_metadata(
    state: &AppState,
    control: &TmuxControl,
) -> anyhow::Result<Option<TmuxControl>> {
    let Some(project_id) = control.project_id.as_deref() else {
        return Ok(None);
    };
    let Some(project) = state.db.project(project_id)? else {
        return Ok(None);
    };
    let run = control
        .run_id
        .as_deref()
        .map(|run_id| state.db.run(run_id))
        .transpose()?
        .flatten();
    let indexed = sessions::list(&project, &[], Some(30)).await?;
    let Some(session) = select_recovered_tmux_session(control, run.as_ref(), &indexed) else {
        return Ok(None);
    };
    let transcript_path =
        sessions::source_path(&project, &control.provider, &session.native_session_id)?;
    let mut recovered = control.clone();
    recovered.native_session_id = Some(session.native_session_id.clone());
    recovered.transcript_path = Some(transcript_path.to_string_lossy().into_owned());
    recovered.updated_at = chrono::Utc::now().to_rfc3339();
    state.db.upsert_tmux_control(&recovered)?;
    if let Some(run_id) = recovered.run_id.as_deref() {
        state
            .db
            .set_provider_session(run_id, &session.native_session_id)?;
    }
    invalidate_discovery(state).await;
    Ok(Some(recovered))
}

fn select_recovered_tmux_session<'a>(
    control: &TmuxControl,
    run: Option<&Run>,
    indexed: &'a [ProviderSession],
) -> Option<&'a ProviderSession> {
    let mut candidates = indexed
        .iter()
        .filter(|session| session.provider == control.provider && session.cwd == control.cwd)
        .collect::<Vec<_>>();
    if let Some(native_session_id) = control.native_session_id.as_deref() {
        return candidates
            .into_iter()
            .find(|session| session.native_session_id == native_session_id);
    }

    let started_at = chrono::DateTime::parse_from_rfc3339(
        run.map(|run| run.created_at.as_str())
            .unwrap_or(control.created_at.as_str()),
    )
    .ok()?;
    let cutoff = started_at - chrono::Duration::seconds(15);
    candidates.retain(|session| {
        chrono::DateTime::parse_from_rfc3339(&session.updated_at)
            .is_ok_and(|updated_at| updated_at >= cutoff)
    });
    if let Some(run) = run {
        let title_matches = candidates
            .iter()
            .copied()
            .filter(|session| session.title.trim() == run.title.trim())
            .collect::<Vec<_>>();
        if title_matches.len() == 1 {
            return title_matches.into_iter().next();
        }
    }
    (candidates.len() == 1).then(|| candidates[0])
}

async fn process_tmux_move(state: &AppState, control: &TmuxControl) -> anyhow::Result<()> {
    if adopt_existing_tmux_for_move(state, control).await? {
        return Ok(());
    }
    let active = control_turn_active(control);
    if active {
        if control.queue_state != "active" {
            state.db.update_tmux_queue_state(&control.id, "active")?;
        }
        return Ok(());
    }
    if control.queue_state == "active" {
        state.db.update_tmux_queue_state(&control.id, "settling")?;
        return Ok(());
    }
    if control.queue_state != "settling" {
        state.db.update_tmux_queue_state(&control.id, "settling")?;
        return Ok(());
    }
    if control_state_age(control) < Duration::from_millis(1200) {
        return Ok(());
    }
    if discovery::process_group_alive(control.source_pgid) {
        discovery::signal_external(control.source_pid, control.source_pgid, libc::SIGTERM)?;
        for _ in 0..20 {
            if !discovery::process_group_alive(control.source_pgid) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        anyhow::ensure!(
            !discovery::process_group_alive(control.source_pgid),
            "the idle terminal process did not release after SIGTERM"
        );
    }
    let session_id = control
        .native_session_id
        .as_deref()
        .context("provider session id is unknown")?;
    let (command, args) = tmux::resume_command_from_original(
        &control.provider,
        &control.original_command,
        session_id,
    )?;
    let launch = state
        .tmux
        .launch(
            &control.provider,
            &control.cwd,
            &command,
            &args,
            &control.id,
            None,
            providers::keep_terminal_parent_shell(&control.provider),
        )
        .await?;
    state.db.update_tmux_control_location(
        &control.id,
        launch.pane.pane_pid,
        launch.pane.pane_pid as i32,
        launch.pane.socket_path.as_deref(),
        &launch.pane.pane_id,
        &launch.pane.session_name,
        &launch.access_command,
        control.transcript_path.as_deref(),
        control.native_session_id.as_deref(),
    )?;
    state.db.update_tmux_queue_state(&control.id, "ready")?;
    invalidate_discovery(state).await;
    Ok(())
}

async fn process_tmux_queue(
    state: &AppState,
    control: &TmuxControl,
    panes: &tmux::PaneSnapshot,
) -> anyhow::Result<()> {
    let pane = match control_pane_from(control, panes) {
        Ok(pane) => pane,
        Err(error) => {
            state
                .db
                .update_tmux_control_status(&control.id, "dead", Some(&error.to_string()))?;
            if let Some(run_id) = control.run_id.as_deref() {
                state.db.finish_run(
                    run_id,
                    "completed",
                    Some(0),
                    None,
                    &chrono::Utc::now().to_rfc3339(),
                )?;
            }
            return Ok(());
        }
    };
    if control.transcript_path.is_none() {
        return Ok(());
    }
    let active = control_turn_active(control);
    if let Some(run_id) = control.run_id.as_deref() {
        let _ = state.db.update_run_status(
            run_id,
            if active {
                "running"
            } else {
                "waiting_for_input"
            },
        );
    }
    match control.queue_state.as_str() {
        "awaiting_start" if active => {
            state.db.update_tmux_queue_state(&control.id, "active")?;
            return Ok(());
        }
        "awaiting_start" if control_state_age(control) >= Duration::from_secs(3) => {
            state.db.update_tmux_queue_state(&control.id, "settling")?;
            return Ok(());
        }
        "awaiting_start" => return Ok(()),
        "active" if active => return Ok(()),
        "active" => {
            state.db.update_tmux_queue_state(&control.id, "settling")?;
            return Ok(());
        }
        "settling" if active => {
            state.db.update_tmux_queue_state(&control.id, "active")?;
            return Ok(());
        }
        "settling" if control_state_age(control) < Duration::from_millis(750) => return Ok(()),
        "settling" => {
            state.db.update_tmux_queue_state(&control.id, "ready")?;
        }
        _ if active => return Ok(()),
        _ => {}
    }
    let Some(item) = state.db.next_tmux_queue(&control.id)? else {
        return Ok(());
    };
    if !state.db.mark_tmux_queue_sending(&control.id, &item.id)? {
        return Ok(());
    }
    match state.tmux.send_prompt(&pane, &item.message).await {
        Ok(()) => {
            state.db.finish_tmux_queue(&control.id, &item.id)?;
            if let Some(run_id) = control.run_id.as_deref() {
                let _ = state.supervisor.emit(
                    run_id,
                    "queue.started",
                    Some("tmux"),
                    None,
                    json!({"queue_id":item.id,"text":item.message}),
                    None,
                );
            }
            state
                .db
                .update_tmux_queue_state(&control.id, "awaiting_start")?;
        }
        Err(error) => {
            state
                .db
                .fail_tmux_queue(&control.id, &item.id, &error.to_string())?;
        }
    }
    Ok(())
}

/// If discovery later finds the process already lives in tmux, take that pane
/// instead of waiting to SIGTERM it. A missed socket/TTY match is what showed
/// Move on a session that was already in tmux; killing it after idle is worse.
async fn adopt_existing_tmux_for_move(
    state: &AppState,
    control: &TmuxControl,
) -> anyhow::Result<bool> {
    let agents = cached_agents(state, false).await.unwrap_or_default();
    let Some(agent) = agents
        .iter()
        .find(|agent| agent.pid == control.source_pid)
    else {
        return Ok(false);
    };
    let Some(pane_id) = agent.tmux_pane_id.as_deref() else {
        return Ok(false);
    };
    let panes = state.tmux.panes().await.unwrap_or_default();
    let Some(pane) = panes.into_iter().find(|pane| {
        pane.pane_id == pane_id
            && agent
                .tty
                .as_deref()
                .is_none_or(|tty| pane.tty == tty)
    }) else {
        return Ok(false);
    };
    state
        .tmux
        .enable_control(&pane, &control.id, &control.provider)
        .await?;
    let access =
        tmux::access_command(pane.socket_path.as_deref().map(Path::new), &pane.session_name);
    let now = chrono::Utc::now().to_rfc3339();
    state.db.upsert_tmux_control(&TmuxControl {
        id: control.id.clone(),
        project_id: control.project_id.clone(),
        run_id: control.run_id.clone(),
        provider: control.provider.clone(),
        native_session_id: agent
            .native_session_id
            .clone()
            .or_else(|| control.native_session_id.clone()),
        transcript_path: agent
            .transcript_path
            .clone()
            .or_else(|| control.transcript_path.clone()),
        source_pid: agent.pid,
        source_pgid: agent.process_group_id,
        cwd: agent
            .cwd
            .clone()
            .unwrap_or_else(|| control.cwd.clone()),
        original_command: control.original_command.clone(),
        socket_path: pane.socket_path.clone(),
        pane_id: Some(pane.pane_id.clone()),
        session_name: Some(pane.session_name.clone()),
        access_command: Some(access),
        owned: pane.owned,
        enabled: true,
        status: "active".into(),
        error: None,
        queue_state: "ready".into(),
        queue_state_at: now.clone(),
        created_at: control.created_at.clone(),
        updated_at: now,
    })?;
    state.db.update_tmux_queue_state(&control.id, "ready")?;
    invalidate_discovery(state).await;
    Ok(true)
}

fn control_turn_active(control: &TmuxControl) -> bool {
    control
        .transcript_path
        .as_deref()
        .map(std::path::Path::new)
        .is_some_and(|path| {
            providers::get(&control.provider)
                .is_some_and(|adapter| adapter.transcript_turn_active(path))
        })
}

fn control_state_age(control: &TmuxControl) -> Duration {
    chrono::DateTime::parse_from_rfc3339(&control.queue_state_at)
        .ok()
        .and_then(|value| {
            chrono::Utc::now()
                .signed_duration_since(value.with_timezone(&chrono::Utc))
                .to_std()
                .ok()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmux_control() -> TmuxControl {
        TmuxControl {
            id: "control-1".into(),
            project_id: Some("project-1".into()),
            run_id: Some("run-1".into()),
            provider: "codex".into(),
            native_session_id: None,
            transcript_path: None,
            source_pid: 42,
            source_pgid: 42,
            cwd: "/repo".into(),
            original_command: "codex --yolo".into(),
            socket_path: Some("/tmp/codesk.sock".into()),
            pane_id: Some("%0".into()),
            session_name: Some("codesk-codex-test".into()),
            access_command: Some("tmux attach-session -t codesk-codex-test".into()),
            owned: true,
            enabled: true,
            status: "active".into(),
            error: None,
            queue_state: "awaiting_start".into(),
            queue_state_at: "2026-08-17T00:00:00Z".into(),
            created_at: "2026-08-17T00:00:00Z".into(),
            updated_at: "2026-08-17T00:00:00Z".into(),
        }
    }

    fn run() -> Run {
        Run {
            id: "run-1".into(),
            project_id: "project-1".into(),
            worktree_id: None,
            parent_run_id: None,
            provider: "codex".into(),
            provider_session_id: None,
            title: "Reply exactly SSH_TMUX_OK".into(),
            prompt: "Reply exactly SSH_TMUX_OK".into(),
            model: None,
            cwd: "/repo".into(),
            command: "codex".into(),
            args: vec!["--yolo".into()],
            status: "running".into(),
            pid: Some(42),
            process_group_id: Some(42),
            created_at: "2026-08-17T00:00:00Z".into(),
            started_at: Some("2026-08-17T00:00:01Z".into()),
            finished_at: None,
            exit_code: None,
            terminating_signal: None,
            input_transport: Some("tmux".into()),
            tmux_name: Some("codesk-codex-test".into()),
            tmux_access_command: Some("tmux attach-session -t codesk-codex-test".into()),
        }
    }

    fn provider_session(id: &str, title: &str, updated_at: &str) -> ProviderSession {
        ProviderSession {
            id: format!("codex:{id}"),
            provider: "codex".into(),
            native_session_id: id.into(),
            project_id: "project-1".into(),
            cwd: "/repo".into(),
            title: title.into(),
            created_at: updated_at.into(),
            updated_at: updated_at.into(),
            status: "idle".into(),
            pid: None,
            managed_run_id: None,
            model: None,
            effort: None,
            input_available: false,
            input_transport: None,
            tmux_name: None,
            tmux_access_command: None,
            tmux_controlled: false,
            tmux_owned: false,
        }
    }

    #[test]
    fn external_writer_is_owned_for_the_full_process_group_lifetime() {
        let current_group = unsafe { libc::getpgrp() };
        assert!(discovery::process_group_alive(current_group));
        assert!(!discovery::process_group_alive(i32::MAX));
    }

    #[test]
    fn recovers_the_new_managed_tmux_session_by_title_and_start_time() {
        let sessions = vec![
            provider_session("old-session", "Different prompt", "2026-08-17T00:00:03Z"),
            provider_session(
                "new-session",
                "Reply exactly SSH_TMUX_OK",
                "2026-08-17T00:00:04Z",
            ),
        ];
        assert_eq!(
            select_recovered_tmux_session(&tmux_control(), Some(&run()), &sessions)
                .map(|session| session.native_session_id.as_str()),
            Some("new-session")
        );
    }

    #[test]
    fn refuses_an_ambiguous_managed_tmux_session_recovery() {
        let sessions = vec![
            provider_session(
                "session-a",
                "Reply exactly SSH_TMUX_OK",
                "2026-08-17T00:00:03Z",
            ),
            provider_session(
                "session-b",
                "Reply exactly SSH_TMUX_OK",
                "2026-08-17T00:00:04Z",
            ),
        ];
        assert!(select_recovered_tmux_session(&tmux_control(), Some(&run()), &sessions).is_none());
    }
}
