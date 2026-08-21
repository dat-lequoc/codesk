use std::{
    io::SeekFrom,
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::Utc;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, BufReader};

use crate::{
    model::{Run, RunnerExit},
    providers,
    supervisor::{Supervisor, input_socket, process_alive},
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

impl Supervisor {
    pub(crate) fn attach(&self, run: Run) {
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
