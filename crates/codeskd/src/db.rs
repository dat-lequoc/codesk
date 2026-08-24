use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::model::{Event, ExternalQueuedInput, Project, Run, TmuxControl, Worktree};

#[derive(Clone)]
pub struct Db {
    connection: Arc<Mutex<Connection>>,
    /// Last allocated `run_sequence` per run. Allocating from memory avoids a
    /// `MAX(run_sequence)` scan and an explicit transaction on every appended
    /// event, which is the hottest write path in the daemon.
    sequences: Arc<Mutex<HashMap<String, i64>>>,
}

impl Db {
    /// A poisoned mutex only means another thread panicked mid-operation; the
    /// SQLite connection itself is still usable (any open transaction was
    /// rolled back when it unwound). Propagating the poison would turn one
    /// panic into a daemon-wide outage, so recover the guard instead.
    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection =
            Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        // WAL defaults to `synchronous=FULL`, which fsyncs on every commit. Run
        // events arrive one per streamed provider delta, so that default turns a
        // fast Codex turn into hundreds of disk syncs per second. NORMAL keeps
        // WAL crash-safe against process death and only risks the most recent
        // commits on host power loss, which is the right trade for a
        // reconstructible activity log.
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(SCHEMA)?;
        let has_registered: i64 = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name='registered'",
            [],
            |row| row.get(0),
        )?;
        if has_registered == 0 {
            connection.execute(
                "ALTER TABLE projects ADD COLUMN registered INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        ensure_column(&connection, "runs", "input_transport", "TEXT")?;
        ensure_column(&connection, "runs", "tmux_name", "TEXT")?;
        ensure_column(&connection, "runs", "tmux_access_command", "TEXT")?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            sequences: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn create_project(&self, project: &Project) -> Result<()> {
        self.lock().execute(
            "INSERT INTO projects (id,name,path,repo_root,created_at) VALUES (?1,?2,?3,?4,?5)",
            params![
                project.id,
                project.name,
                project.path,
                project.repo_root,
                project.created_at
            ],
        )?;
        Ok(())
    }

    pub fn update_project_repo_root(&self, id: &str, repo_root: Option<&str>) -> Result<()> {
        self.lock().execute(
            "UPDATE projects SET repo_root=?2 WHERE id=?1",
            params![id, repo_root],
        )?;
        Ok(())
    }

    pub fn register_project(&self, id: &str) -> Result<()> {
        self.lock()
            .execute("UPDATE projects SET registered=1 WHERE id=?1", [id])?;
        Ok(())
    }

    pub fn unregister_project(&self, id: &str) -> Result<bool> {
        Ok(self.lock().execute(
            "UPDATE projects SET registered=0 WHERE id=?1 AND registered=1",
            [id],
        )? > 0)
    }

    pub fn project_by_path(&self, path: &str) -> Result<Option<Project>> {
        Ok(self
            .lock()
            .query_row(
                "SELECT id,name,path,repo_root,created_at FROM projects WHERE path=?1",
                [path],
                |row| {
                    Ok(Project {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        repo_root: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT id,name,path,repo_root,created_at FROM projects WHERE registered=1 ORDER BY created_at",
        )?;
        Ok(statement
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    repo_root: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn project(&self, id: &str) -> Result<Option<Project>> {
        Ok(self.lock()
            .query_row(
                "SELECT id,name,path,repo_root,created_at FROM projects WHERE id=?1 AND registered=1",
                [id],
                |row| {
                    Ok(Project {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        path: row.get(2)?,
                        repo_root: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn create_worktree(&self, item: &Worktree) -> Result<()> {
        self.lock().execute("INSERT INTO worktrees (id,project_id,path,branch,base_ref,ownership,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![item.id,item.project_id,item.path,item.branch,item.base_ref,item.ownership,item.status,item.created_at])?;
        Ok(())
    }

    pub fn update_worktree_status(&self, id: &str, status: &str) -> Result<()> {
        self.lock().execute(
            "UPDATE worktrees SET status=?2 WHERE id=?1",
            params![id, status],
        )?;
        Ok(())
    }

    pub fn worktrees(&self, project_id: &str) -> Result<Vec<Worktree>> {
        let connection = self.lock();
        let mut statement = connection.prepare("SELECT id,project_id,path,branch,base_ref,ownership,status,created_at FROM worktrees WHERE project_id=?1 ORDER BY created_at DESC")?;
        Ok(statement
            .query_map([project_id], |row| {
                Ok(Worktree {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    path: row.get(2)?,
                    branch: row.get(3)?,
                    base_ref: row.get(4)?,
                    ownership: row.get(5)?,
                    status: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn worktree(&self, id: &str) -> Result<Option<Worktree>> {
        Ok(self.lock().query_row("SELECT id,project_id,path,branch,base_ref,ownership,status,created_at FROM worktrees WHERE id=?1", [id], |row| Ok(Worktree { id:row.get(0)?,project_id:row.get(1)?,path:row.get(2)?,branch:row.get(3)?,base_ref:row.get(4)?,ownership:row.get(5)?,status:row.get(6)?,created_at:row.get(7)? })).optional()?)
    }

    pub fn worktree_has_active_runs(&self, id: &str) -> Result<bool> {
        let count:i64=self.lock().query_row("SELECT COUNT(*) FROM runs WHERE worktree_id=?1 AND status IN ('queued','starting','running','waiting_for_input','interrupting')",[id],|row|row.get(0))?;
        Ok(count > 0)
    }

    pub fn create_run(&self, run: &Run) -> Result<()> {
        self.lock().execute("INSERT INTO runs (id,project_id,worktree_id,parent_run_id,provider,provider_session_id,title,prompt,model,cwd,command,args_json,status,pid,pgid,created_at,started_at,finished_at,exit_code,terminating_signal,input_transport,tmux_name,tmux_access_command) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)", params![run.id,run.project_id,run.worktree_id,run.parent_run_id,run.provider,run.provider_session_id,run.title,run.prompt,run.model,run.cwd,run.command,serde_json::to_string(&run.args)?,run.status,run.pid,run.process_group_id,run.created_at,run.started_at,run.finished_at,run.exit_code,run.terminating_signal,run.input_transport,run.tmux_name,run.tmux_access_command])?;
        Ok(())
    }

    pub fn update_run_started(
        &self,
        id: &str,
        pid: u32,
        pgid: i32,
        started_at: &str,
    ) -> Result<()> {
        self.lock().execute(
            "UPDATE runs SET status='running',pid=?2,pgid=?3,started_at=?4 WHERE id=?1",
            params![id, pid, pgid, started_at],
        )?;
        Ok(())
    }

    pub fn update_run_status(&self, id: &str, status: &str) -> Result<()> {
        self.lock()
            .execute("UPDATE runs SET status=?2 WHERE id=?1", params![id, status])?;
        Ok(())
    }

    pub fn finish_run(
        &self,
        id: &str,
        status: &str,
        exit_code: Option<i32>,
        signal: Option<&str>,
        finished_at: &str,
    ) -> Result<()> {
        self.lock().execute("UPDATE runs SET status=?2,exit_code=?3,terminating_signal=?4,finished_at=?5 WHERE id=?1", params![id,status,exit_code,signal,finished_at])?;
        Ok(())
    }

    pub fn set_provider_session(&self, id: &str, session_id: &str) -> Result<()> {
        self.lock().execute(
            "UPDATE runs SET provider_session_id=?2 WHERE id=?1",
            params![id, session_id],
        )?;
        Ok(())
    }

    pub fn update_run_tmux(
        &self,
        id: &str,
        pid: u32,
        tmux_name: &str,
        access_command: &str,
        started_at: &str,
    ) -> Result<()> {
        self.lock().execute(
            "UPDATE runs SET status='running',pid=?2,pgid=?2,started_at=?3,input_transport='tmux',tmux_name=?4,tmux_access_command=?5 WHERE id=?1",
            params![id, pid, started_at, tmux_name, access_command],
        )?;
        Ok(())
    }

    pub fn runs(&self) -> Result<Vec<Run>> {
        let connection = self.lock();
        let mut statement = connection.prepare(RUN_SELECT)?;
        Ok(statement
            .query_map([], row_to_run)?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Count non-terminal runs without materializing the whole table; the
    /// health endpoint calls this on every gateway probe.
    pub fn active_run_count(&self) -> Result<usize> {
        Ok(self.lock().query_row(
            "SELECT COUNT(*) FROM runs WHERE status NOT IN ('completed','failed','interrupted','killed','orphaned')",
            [],
            |row| row.get::<_, i64>(0),
        )? as usize)
    }

    pub fn run(&self, id: &str) -> Result<Option<Run>> {
        Ok(self
            .lock()
            .query_row(&format!("{RUN_SELECT} WHERE id=?1"), [id], row_to_run)
            .optional()?)
    }

    pub fn append_event(
        &self,
        run_id: &str,
        kind: &str,
        provider_type: Option<&str>,
        channel: Option<&str>,
        payload: &Value,
        raw_payload: Option<&Value>,
        timestamp: &str,
    ) -> Result<Event> {
        let connection = self.lock();
        let mut sequences = self
            .sequences
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // First append for a run since this daemon started: seed the counter
        // from the journal once, then allocate from memory. The connection lock
        // is held for the whole read-allocate-insert, so sequences stay gapless
        // and unique even under concurrent appends.
        let run_sequence: i64 = match sequences.get(run_id) {
            Some(last) => last + 1,
            None => connection.query_row(
                "SELECT COALESCE(MAX(run_sequence),0)+1 FROM events WHERE run_id=?1",
                [run_id],
                |row| row.get(0),
            )?,
        };
        let event_id = uuid::Uuid::new_v4().to_string();
        connection.execute("INSERT INTO events (event_id,run_id,run_sequence,timestamp,kind,provider_event_type,channel,payload_json,raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![event_id,run_id,run_sequence,timestamp,kind,provider_type,channel,serde_json::to_string(payload)?,raw_payload.map(serde_json::to_string).transpose()?])?;
        let global_sequence = connection.last_insert_rowid();
        sequences.insert(run_id.to_string(), run_sequence);
        Ok(Event {
            global_sequence,
            run_sequence,
            event_id,
            run_id: run_id.to_string(),
            timestamp: timestamp.to_string(),
            kind: kind.to_string(),
            provider_event_type: provider_type.map(str::to_string),
            channel: channel.map(str::to_string),
            payload: payload.clone(),
            raw_payload: raw_payload.cloned(),
        })
    }

    pub fn events_after(&self, run_id: Option<&str>, after: i64) -> Result<Vec<Event>> {
        let connection = self.lock();
        let (sql, values): (&str, Vec<String>) = match run_id {
            // The per-run replay is bounded like the global one: a long run can
            // accumulate hundreds of thousands of events, and an unbounded
            // SELECT materializes all of them in memory per request. Callers
            // page forward by passing the last run_sequence as `after`.
            Some(id) => (
                "SELECT global_sequence,run_sequence,event_id,run_id,timestamp,kind,provider_event_type,channel,payload_json,raw_json FROM events WHERE run_id=?1 AND run_sequence>?2 ORDER BY run_sequence LIMIT 5000",
                vec![id.to_string(), after.to_string()],
            ),
            None => (
                "SELECT global_sequence,run_sequence,event_id,run_id,timestamp,kind,provider_event_type,channel,payload_json,raw_json FROM events WHERE global_sequence>?1 ORDER BY global_sequence LIMIT 5000",
                vec![after.to_string()],
            ),
        };
        let mut statement = connection.prepare(sql)?;
        let rows = if run_id.is_some() {
            statement
                .query_map(params![values[0], values[1].parse::<i64>()?], row_to_event)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            statement
                .query_map(params![values[0].parse::<i64>()?], row_to_event)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    }

    pub fn stream_offset(&self, run_id: &str, channel: &str) -> Result<u64> {
        Ok(self
            .lock()
            .query_row(
                "SELECT offset FROM stream_offsets WHERE run_id=?1 AND channel=?2",
                params![run_id, channel],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0) as u64)
    }

    pub fn set_stream_offset(&self, run_id: &str, channel: &str, offset: u64) -> Result<()> {
        self.lock().execute("INSERT INTO stream_offsets(run_id,channel,offset) VALUES(?1,?2,?3) ON CONFLICT(run_id,channel) DO UPDATE SET offset=excluded.offset",params![run_id,channel,offset as i64])?;
        Ok(())
    }

    pub fn upsert_tmux_control(&self, control: &TmuxControl) -> Result<()> {
        // Identity columns are normally sticky, because a live pane reports its
        // session id only intermittently. They are not sticky across a provider
        // change: the pane then hosts a different harness, and the recorded
        // conversation belongs to the one that left.
        self.lock().execute(
            "INSERT INTO tmux_controls(id,project_id,run_id,provider,native_session_id,transcript_path,source_pid,source_pgid,cwd,original_command,socket_path,pane_id,session_name,access_command,owned,enabled,status,error,queue_state,queue_state_at,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,run_id=CASE WHEN excluded.provider<>tmux_controls.provider THEN excluded.run_id ELSE COALESCE(excluded.run_id,tmux_controls.run_id) END,native_session_id=CASE WHEN excluded.provider<>tmux_controls.provider THEN excluded.native_session_id ELSE COALESCE(excluded.native_session_id,tmux_controls.native_session_id) END,transcript_path=CASE WHEN excluded.provider<>tmux_controls.provider THEN excluded.transcript_path ELSE COALESCE(excluded.transcript_path,tmux_controls.transcript_path) END,provider=excluded.provider,source_pid=excluded.source_pid,source_pgid=excluded.source_pgid,cwd=excluded.cwd,original_command=excluded.original_command,socket_path=excluded.socket_path,pane_id=excluded.pane_id,session_name=excluded.session_name,access_command=excluded.access_command,owned=excluded.owned,enabled=excluded.enabled,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at",
            params![control.id,control.project_id,control.run_id,control.provider,control.native_session_id,control.transcript_path,control.source_pid,control.source_pgid,control.cwd,control.original_command,control.socket_path,control.pane_id,control.session_name,control.access_command,control.owned,control.enabled,control.status,control.error,control.queue_state,control.queue_state_at,control.created_at,control.updated_at],
        )?;
        Ok(())
    }

    pub fn tmux_controls(&self) -> Result<Vec<TmuxControl>> {
        let connection = self.lock();
        let mut statement = connection.prepare(TMUX_CONTROL_SELECT)?;
        Ok(statement
            .query_map([], row_to_tmux_control)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn tmux_control(&self, id: &str) -> Result<Option<TmuxControl>> {
        Ok(self
            .lock()
            .query_row(
                &format!("{TMUX_CONTROL_SELECT} WHERE id=?1"),
                [id],
                row_to_tmux_control,
            )
            .optional()?)
    }

    pub fn tmux_control_for_run(&self, run_id: &str) -> Result<Option<TmuxControl>> {
        Ok(self
            .lock()
            .query_row(
                &format!("{TMUX_CONTROL_SELECT} WHERE run_id=?1 AND enabled=1"),
                [run_id],
                row_to_tmux_control,
            )
            .optional()?)
    }

    pub fn tmux_control_for_pid(&self, pid: u32) -> Result<Option<TmuxControl>> {
        Ok(self.lock()
            .query_row(
                &format!("{TMUX_CONTROL_SELECT} WHERE source_pid=?1 ORDER BY enabled DESC, updated_at DESC LIMIT 1"),
                [pid],
                row_to_tmux_control,
            )
            .optional()?)
    }

    pub fn tmux_control_for_pane(
        &self,
        socket_path: Option<&str>,
        pane_id: &str,
    ) -> Result<Option<TmuxControl>> {
        let socket_key = socket_path.unwrap_or("");
        Ok(self.lock()
            .query_row(
                &format!("{TMUX_CONTROL_SELECT} WHERE COALESCE(socket_path,'')=?1 AND pane_id=?2 ORDER BY enabled DESC, updated_at DESC LIMIT 1"),
                params![socket_key, pane_id],
                row_to_tmux_control,
            )
            .optional()?)
    }

    /// Drops the conversation a pane used to host. tmux recycles pane ids, so a
    /// control row can outlive the harness it was written for; its session id and
    /// transcript then describe a conversation that no longer runs there.
    pub fn clear_tmux_control_identity(&self, id: &str) -> Result<()> {
        self.lock().execute(
            "UPDATE tmux_controls SET native_session_id=NULL,transcript_path=NULL,run_id=NULL WHERE id=?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn update_tmux_control_status(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.lock().execute(
            "UPDATE tmux_controls SET status=?2,error=?3,updated_at=?4 WHERE id=?1",
            params![id, status, error, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn update_tmux_control_location(
        &self,
        id: &str,
        source_pid: u32,
        source_pgid: i32,
        socket_path: Option<&str>,
        pane_id: &str,
        session_name: &str,
        access_command: &str,
        transcript_path: Option<&str>,
        native_session_id: Option<&str>,
    ) -> Result<()> {
        self.lock().execute(
            "UPDATE tmux_controls SET source_pid=?2,source_pgid=?3,socket_path=?4,pane_id=?5,session_name=?6,access_command=?7,transcript_path=COALESCE(?8,transcript_path),native_session_id=COALESCE(?9,native_session_id),owned=1,enabled=1,status='active',error=NULL,updated_at=?10 WHERE id=?1",
            params![id,source_pid,source_pgid,socket_path,pane_id,session_name,access_command,transcript_path,native_session_id,chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn update_tmux_queue_state(&self, id: &str, state: &str) -> Result<()> {
        self.lock().execute(
            "UPDATE tmux_controls SET queue_state=?2,queue_state_at=?3,updated_at=?3 WHERE id=?1",
            params![id, state, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn disable_tmux_control(&self, id: &str) -> Result<()> {
        self.lock().execute(
            "UPDATE tmux_controls SET enabled=0,status='disabled',updated_at=?2 WHERE id=?1",
            params![id, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn enqueue_tmux_input(&self, control_id: &str, item: &ExternalQueuedInput) -> Result<()> {
        self.lock().execute(
            "INSERT INTO tmux_queue(id,control_id,pid,project_id,session_id,message,title,created_at,status,error) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![item.id,control_id,item.pid,item.project_id,item.session_id,item.message,item.title,item.created_at,item.status,item.error],
        )?;
        Ok(())
    }

    pub fn tmux_queue(&self, control_id: &str) -> Result<Vec<ExternalQueuedInput>> {
        let connection = self.lock();
        let mut statement = connection.prepare("SELECT id,pid,project_id,session_id,message,title,created_at,status,error FROM tmux_queue WHERE control_id=?1 ORDER BY created_at,id")?;
        Ok(statement
            .query_map([control_id], |row| {
                Ok(ExternalQueuedInput {
                    id: row.get(0)?,
                    pid: row.get(1)?,
                    project_id: row.get(2)?,
                    session_id: row.get(3)?,
                    message: row.get(4)?,
                    title: row.get(5)?,
                    created_at: row.get(6)?,
                    status: row.get(7)?,
                    error: row.get(8)?,
                    run: None,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn next_tmux_queue(&self, control_id: &str) -> Result<Option<ExternalQueuedInput>> {
        Ok(self.lock()
            .query_row(
                "SELECT id,pid,project_id,session_id,message,title,created_at,status,error FROM tmux_queue WHERE control_id=?1 AND status='queued' ORDER BY created_at,id LIMIT 1",
                [control_id],
                |row| {
                    Ok(ExternalQueuedInput {
                        id: row.get(0)?,
                        pid: row.get(1)?,
                        project_id: row.get(2)?,
                        session_id: row.get(3)?,
                        message: row.get(4)?,
                        title: row.get(5)?,
                        created_at: row.get(6)?,
                        status: row.get(7)?,
                        error: row.get(8)?,
                        run: None,
                    })
                },
            )
            .optional()?)
    }

    pub fn delete_tmux_queue(&self, control_id: &str, queue_id: &str) -> Result<bool> {
        Ok(self.lock().execute(
            "DELETE FROM tmux_queue WHERE control_id=?1 AND id=?2 AND status='queued'",
            params![control_id, queue_id],
        )? > 0)
    }

    pub fn mark_tmux_queue_sending(&self, control_id: &str, queue_id: &str) -> Result<bool> {
        Ok(self.lock().execute(
            "UPDATE tmux_queue SET status='sending' WHERE control_id=?1 AND id=?2 AND status='queued'",
            params![control_id, queue_id],
        )? > 0)
    }

    pub fn finish_tmux_queue(&self, control_id: &str, queue_id: &str) -> Result<()> {
        self.lock().execute(
            "DELETE FROM tmux_queue WHERE control_id=?1 AND id=?2",
            params![control_id, queue_id],
        )?;
        Ok(())
    }

    pub fn fail_tmux_queue(&self, control_id: &str, queue_id: &str, error: &str) -> Result<()> {
        self.lock().execute(
            "UPDATE tmux_queue SET status='failed',error=?3 WHERE control_id=?1 AND id=?2",
            params![control_id, queue_id, error],
        )?;
        Ok(())
    }
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    let count: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name=?1"),
        [column],
        |row| row.get(0),
    )?;
    if count == 0 {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    let args: String = row.get(11)?;
    Ok(Run {
        id: row.get(0)?,
        project_id: row.get(1)?,
        worktree_id: row.get(2)?,
        parent_run_id: row.get(3)?,
        provider: row.get(4)?,
        provider_session_id: row.get(5)?,
        title: row.get(6)?,
        prompt: row.get(7)?,
        model: row.get(8)?,
        cwd: row.get(9)?,
        command: row.get(10)?,
        args: serde_json::from_str(&args).unwrap_or_default(),
        status: row.get(12)?,
        pid: row.get(13)?,
        process_group_id: row.get(14)?,
        created_at: row.get(15)?,
        started_at: row.get(16)?,
        finished_at: row.get(17)?,
        exit_code: row.get(18)?,
        terminating_signal: row.get(19)?,
        input_transport: row.get(20)?,
        tmux_name: row.get(21)?,
        tmux_access_command: row.get(22)?,
    })
}

fn row_to_tmux_control(row: &rusqlite::Row<'_>) -> rusqlite::Result<TmuxControl> {
    Ok(TmuxControl {
        id: row.get(0)?,
        project_id: row.get(1)?,
        run_id: row.get(2)?,
        provider: row.get(3)?,
        native_session_id: row.get(4)?,
        transcript_path: row.get(5)?,
        source_pid: row.get(6)?,
        source_pgid: row.get(7)?,
        cwd: row.get(8)?,
        original_command: row.get(9)?,
        socket_path: row.get(10)?,
        pane_id: row.get(11)?,
        session_name: row.get(12)?,
        access_command: row.get(13)?,
        owned: row.get(14)?,
        enabled: row.get(15)?,
        status: row.get(16)?,
        error: row.get(17)?,
        queue_state: row.get(18)?,
        queue_state_at: row.get(19)?,
        created_at: row.get(20)?,
        updated_at: row.get(21)?,
    })
}

fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    let payload: String = row.get(8)?;
    let raw: Option<String> = row.get(9)?;
    Ok(Event {
        global_sequence: row.get(0)?,
        run_sequence: row.get(1)?,
        event_id: row.get(2)?,
        run_id: row.get(3)?,
        timestamp: row.get(4)?,
        kind: row.get(5)?,
        provider_event_type: row.get(6)?,
        channel: row.get(7)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        raw_payload: raw.and_then(|value| serde_json::from_str(&value).ok()),
    })
}

const RUN_SELECT: &str = "SELECT id,project_id,worktree_id,parent_run_id,provider,provider_session_id,title,prompt,model,cwd,command,args_json,status,pid,pgid,created_at,started_at,finished_at,exit_code,terminating_signal,input_transport,tmux_name,tmux_access_command FROM runs";
const TMUX_CONTROL_SELECT: &str = "SELECT id,project_id,run_id,provider,native_session_id,transcript_path,source_pid,source_pgid,cwd,original_command,socket_path,pane_id,session_name,access_command,owned,enabled,status,error,queue_state,queue_state_at,created_at,updated_at FROM tmux_controls";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,repo_root TEXT,created_at TEXT NOT NULL,registered INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS worktrees (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),path TEXT NOT NULL UNIQUE,branch TEXT,base_ref TEXT,ownership TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),worktree_id TEXT REFERENCES worktrees(id),parent_run_id TEXT REFERENCES runs(id),provider TEXT NOT NULL,provider_session_id TEXT,title TEXT NOT NULL,prompt TEXT NOT NULL,model TEXT,cwd TEXT NOT NULL,command TEXT NOT NULL,args_json TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,pgid INTEGER,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,exit_code INTEGER,terminating_signal TEXT);
CREATE TABLE IF NOT EXISTS events (global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES runs(id),run_sequence INTEGER NOT NULL,timestamp TEXT NOT NULL,kind TEXT NOT NULL,provider_event_type TEXT,channel TEXT,payload_json TEXT NOT NULL,raw_json TEXT,UNIQUE(run_id,run_sequence));
CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id,run_sequence);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS runs_worktree_status ON runs(worktree_id,status);
CREATE INDEX IF NOT EXISTS worktrees_project ON worktrees(project_id);
CREATE TABLE IF NOT EXISTS stream_offsets (run_id TEXT NOT NULL REFERENCES runs(id),channel TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run_id,channel));
CREATE TABLE IF NOT EXISTS tmux_controls (id TEXT PRIMARY KEY,project_id TEXT,run_id TEXT UNIQUE,provider TEXT NOT NULL,native_session_id TEXT,transcript_path TEXT,source_pid INTEGER NOT NULL,source_pgid INTEGER NOT NULL,cwd TEXT NOT NULL,original_command TEXT NOT NULL,socket_path TEXT,pane_id TEXT,session_name TEXT,access_command TEXT,owned INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL,error TEXT,queue_state TEXT NOT NULL DEFAULT 'ready',queue_state_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tmux_controls_pane ON tmux_controls(socket_path,pane_id);
CREATE INDEX IF NOT EXISTS tmux_controls_pid ON tmux_controls(source_pid);
CREATE TABLE IF NOT EXISTS tmux_queue (id TEXT PRIMARY KEY,control_id TEXT NOT NULL REFERENCES tmux_controls(id) ON DELETE CASCADE,pid INTEGER NOT NULL,project_id TEXT NOT NULL,session_id TEXT,message TEXT NOT NULL,title TEXT,created_at TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
CREATE INDEX IF NOT EXISTS tmux_queue_control ON tmux_queue(control_id,created_at);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn tmux_control_fixture(id: &str, provider: &str) -> TmuxControl {
        let now = chrono::Utc::now().to_rfc3339();
        TmuxControl {
            id: id.into(),
            project_id: None,
            run_id: Some("run-1".into()),
            provider: provider.into(),
            native_session_id: None,
            transcript_path: None,
            source_pid: 42,
            source_pgid: 42,
            cwd: "/tmp".into(),
            original_command: provider.into(),
            socket_path: Some("/tmp/codesk.sock".into()),
            pane_id: Some("%3".into()),
            session_name: Some("codesk".into()),
            access_command: Some("tmux attach".into()),
            owned: false,
            enabled: true,
            status: "active".into(),
            error: None,
            queue_state: "ready".into(),
            queue_state_at: now.clone(),
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn a_pane_that_changes_provider_drops_the_previous_conversation() {
        let path = std::env::temp_dir().join(format!("codeskd-pane-{}.db", Uuid::new_v4()));
        let control_id = Uuid::new_v4().to_string();
        let db = Db::open(&path).unwrap();

        let mut codex = tmux_control_fixture(&control_id, "codex");
        codex.native_session_id = Some("01a00cf4-codex".into());
        codex.transcript_path = Some("/home/user/.codex/sessions/rollout.jsonl".into());
        db.upsert_tmux_control(&codex).unwrap();

        // The same pane reports the session id only intermittently, so a later
        // sighting of the same harness must not lose it.
        let mut quiet = tmux_control_fixture(&control_id, "codex");
        quiet.run_id = None;
        db.upsert_tmux_control(&quiet).unwrap();
        let kept = db.tmux_control(&control_id).unwrap().unwrap();
        assert_eq!(kept.native_session_id.as_deref(), Some("01a00cf4-codex"));
        assert_eq!(kept.run_id.as_deref(), Some("run-1"));

        // A different harness in that pane owns a different conversation.
        let mut kiro = tmux_control_fixture(&control_id, "kiro");
        kiro.run_id = None;
        db.upsert_tmux_control(&kiro).unwrap();
        let replaced = db.tmux_control(&control_id).unwrap().unwrap();
        assert_eq!(replaced.provider, "kiro");
        assert_eq!(replaced.native_session_id, None);
        assert_eq!(replaced.transcript_path, None);
        assert_eq!(replaced.run_id, None);

        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
    }

    #[test]
    fn looks_up_a_detected_pane_that_is_not_yet_controlled() {
        let path = std::env::temp_dir().join(format!("codeskd-detected-{}.db", Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        let mut control = tmux_control_fixture("detected-1", "codex");
        control.enabled = false;
        control.status = "detected".into();
        control.native_session_id = Some("session-1".into());
        db.upsert_tmux_control(&control).unwrap();
        let found = db.tmux_control_for_pid(42).unwrap().unwrap();
        assert_eq!(found.id, "detected-1");
        assert_eq!(found.native_session_id.as_deref(), Some("session-1"));
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
    }

    #[test]
    fn event_sequences_stay_gapless_across_reopen_and_replay_pages_by_cursor() {
        let path = std::env::temp_dir().join(format!("codeskd-events-{}.db", Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        db.create_project(&Project {
            id: "p1".into(),
            name: "p1".into(),
            path: format!("/tmp/p1-{}", Uuid::new_v4()),
            repo_root: None,
            created_at: "2026-08-17T00:00:00Z".into(),
        })
        .unwrap();
        let run = Run {
            id: "run-1".into(),
            project_id: "p1".into(),
            worktree_id: None,
            parent_run_id: None,
            provider: "codex".into(),
            provider_session_id: None,
            title: "t".into(),
            prompt: "p".into(),
            model: None,
            cwd: "/tmp".into(),
            command: "codex".into(),
            args: vec![],
            status: "running".into(),
            pid: None,
            process_group_id: None,
            created_at: "2026-08-17T00:00:00Z".into(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            terminating_signal: None,
            input_transport: None,
            tmux_name: None,
            tmux_access_command: None,
        };
        db.create_run(&run).unwrap();
        for index in 0..3 {
            db.append_event(
                "run-1",
                "agent.event",
                None,
                None,
                &serde_json::json!({ "index": index }),
                None,
                "2026-08-17T00:00:01Z",
            )
            .unwrap();
        }
        drop(db);
        // The in-memory counter is gone after a reopen; the next append must
        // reseed from the journal without gaps or duplicates.
        let db = Db::open(&path).unwrap();
        let appended = db
            .append_event(
                "run-1",
                "agent.event",
                None,
                None,
                &serde_json::json!({ "index": 3 }),
                None,
                "2026-08-17T00:00:02Z",
            )
            .unwrap();
        assert_eq!(appended.run_sequence, 4);
        let all = db.events_after(Some("run-1"), 0).unwrap();
        assert_eq!(
            all.iter()
                .map(|event| event.run_sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        // Replay pages forward from the last sequence a client saw.
        let tail = db.events_after(Some("run-1"), 2).unwrap();
        assert_eq!(tail.first().unwrap().run_sequence, 3);
        assert_eq!(tail.len(), 2);
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
    }

    #[test]
    fn tmux_queue_is_ordered_and_survives_database_reopen() {
        let path = std::env::temp_dir().join(format!("codeskd-tmux-{}.db", Uuid::new_v4()));
        let control_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        {
            let db = Db::open(&path).unwrap();
            db.upsert_tmux_control(&TmuxControl {
                id: control_id.clone(),
                project_id: None,
                run_id: None,
                provider: "codex".into(),
                native_session_id: Some("session-1".into()),
                transcript_path: Some("/tmp/session.jsonl".into()),
                source_pid: 42,
                source_pgid: 42,
                cwd: "/tmp".into(),
                original_command: "codex --yolo".into(),
                socket_path: Some("/tmp/codesk.sock".into()),
                pane_id: Some("%1".into()),
                session_name: Some("codesk-codex-test".into()),
                access_command: Some("tmux attach".into()),
                owned: true,
                enabled: true,
                status: "active".into(),
                error: None,
                queue_state: "active".into(),
                queue_state_at: now.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .unwrap();
            for (id, message, created_at) in [
                ("a", "first", "2026-08-17T00:00:00Z"),
                ("b", "second", "2026-08-17T00:00:01Z"),
            ] {
                db.enqueue_tmux_input(
                    &control_id,
                    &ExternalQueuedInput {
                        id: id.into(),
                        pid: 42,
                        project_id: "project".into(),
                        session_id: Some("session-1".into()),
                        message: message.into(),
                        title: None,
                        created_at: created_at.into(),
                        status: "queued".into(),
                        error: None,
                        run: None,
                    },
                )
                .unwrap();
            }
        }
        let db = Db::open(&path).unwrap();
        let items = db.tmux_queue(&control_id).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.message.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(db.next_tmux_queue(&control_id).unwrap().unwrap().id, "a");
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
    }
}
