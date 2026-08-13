use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::model::{Event, Project, Run, Worktree};

#[derive(Clone)]
pub struct Db(pub Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection =
            Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.execute_batch(SCHEMA)?;
        Ok(Self(Arc::new(Mutex::new(connection))))
    }

    pub fn create_project(&self, project: &Project) -> Result<()> {
        self.0.lock().unwrap().execute(
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

    pub fn project_by_path(&self, path: &str) -> Result<Option<Project>> {
        Ok(self
            .0
            .lock()
            .unwrap()
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
        let connection = self.0.lock().unwrap();
        let mut statement = connection.prepare(
            "SELECT id,name,path,repo_root,created_at FROM projects ORDER BY created_at",
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
        Ok(self
            .0
            .lock()
            .unwrap()
            .query_row(
                "SELECT id,name,path,repo_root,created_at FROM projects WHERE id=?1",
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
        self.0.lock().unwrap().execute("INSERT INTO worktrees (id,project_id,path,branch,base_ref,ownership,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![item.id,item.project_id,item.path,item.branch,item.base_ref,item.ownership,item.status,item.created_at])?;
        Ok(())
    }

    pub fn update_worktree_status(&self, id: &str, status: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE worktrees SET status=?2 WHERE id=?1",
            params![id, status],
        )?;
        Ok(())
    }

    pub fn worktrees(&self, project_id: &str) -> Result<Vec<Worktree>> {
        let connection = self.0.lock().unwrap();
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
        Ok(self.0.lock().unwrap().query_row("SELECT id,project_id,path,branch,base_ref,ownership,status,created_at FROM worktrees WHERE id=?1", [id], |row| Ok(Worktree { id:row.get(0)?,project_id:row.get(1)?,path:row.get(2)?,branch:row.get(3)?,base_ref:row.get(4)?,ownership:row.get(5)?,status:row.get(6)?,created_at:row.get(7)? })).optional()?)
    }

    pub fn worktree_has_active_runs(&self, id: &str) -> Result<bool> {
        let count:i64=self.0.lock().unwrap().query_row("SELECT COUNT(*) FROM runs WHERE worktree_id=?1 AND status IN ('queued','starting','running','waiting_for_input','interrupting')",[id],|row|row.get(0))?;
        Ok(count > 0)
    }

    pub fn create_run(&self, run: &Run) -> Result<()> {
        self.0.lock().unwrap().execute("INSERT INTO runs (id,project_id,worktree_id,parent_run_id,provider,provider_session_id,title,prompt,model,cwd,command,args_json,status,pid,pgid,created_at,started_at,finished_at,exit_code,terminating_signal) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)", params![run.id,run.project_id,run.worktree_id,run.parent_run_id,run.provider,run.provider_session_id,run.title,run.prompt,run.model,run.cwd,run.command,serde_json::to_string(&run.args)?,run.status,run.pid,run.process_group_id,run.created_at,run.started_at,run.finished_at,run.exit_code,run.terminating_signal])?;
        Ok(())
    }

    pub fn update_run_started(
        &self,
        id: &str,
        pid: u32,
        pgid: i32,
        started_at: &str,
    ) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE runs SET status='running',pid=?2,pgid=?3,started_at=?4 WHERE id=?1",
            params![id, pid, pgid, started_at],
        )?;
        Ok(())
    }

    pub fn update_run_status(&self, id: &str, status: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
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
        self.0.lock().unwrap().execute("UPDATE runs SET status=?2,exit_code=?3,terminating_signal=?4,finished_at=?5 WHERE id=?1", params![id,status,exit_code,signal,finished_at])?;
        Ok(())
    }

    pub fn set_provider_session(&self, id: &str, session_id: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE runs SET provider_session_id=?2 WHERE id=?1",
            params![id, session_id],
        )?;
        Ok(())
    }

    pub fn runs(&self) -> Result<Vec<Run>> {
        let connection = self.0.lock().unwrap();
        let mut statement = connection.prepare(RUN_SELECT)?;
        Ok(statement
            .query_map([], row_to_run)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn run(&self, id: &str) -> Result<Option<Run>> {
        Ok(self
            .0
            .lock()
            .unwrap()
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
        let mut connection = self.0.lock().unwrap();
        let transaction = connection.transaction()?;
        let run_sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(run_sequence),0)+1 FROM events WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )?;
        let event_id = uuid::Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO events (event_id,run_id,run_sequence,timestamp,kind,provider_event_type,channel,payload_json,raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![event_id,run_id,run_sequence,timestamp,kind,provider_type,channel,serde_json::to_string(payload)?,raw_payload.map(serde_json::to_string).transpose()?])?;
        let global_sequence = transaction.last_insert_rowid();
        transaction.commit()?;
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
        let connection = self.0.lock().unwrap();
        let (sql, values): (&str, Vec<String>) = match run_id {
            Some(id) => (
                "SELECT global_sequence,run_sequence,event_id,run_id,timestamp,kind,provider_event_type,channel,payload_json,raw_json FROM events WHERE run_id=?1 AND run_sequence>?2 ORDER BY run_sequence",
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
            .0
            .lock()
            .unwrap()
            .query_row(
                "SELECT offset FROM stream_offsets WHERE run_id=?1 AND channel=?2",
                params![run_id, channel],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0) as u64)
    }

    pub fn set_stream_offset(&self, run_id: &str, channel: &str, offset: u64) -> Result<()> {
        self.0.lock().unwrap().execute("INSERT INTO stream_offsets(run_id,channel,offset) VALUES(?1,?2,?3) ON CONFLICT(run_id,channel) DO UPDATE SET offset=excluded.offset",params![run_id,channel,offset as i64])?;
        Ok(())
    }
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

const RUN_SELECT: &str = "SELECT id,project_id,worktree_id,parent_run_id,provider,provider_session_id,title,prompt,model,cwd,command,args_json,status,pid,pgid,created_at,started_at,finished_at,exit_code,terminating_signal FROM runs";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE,repo_root TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS worktrees (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),path TEXT NOT NULL UNIQUE,branch TEXT,base_ref TEXT,ownership TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),worktree_id TEXT REFERENCES worktrees(id),parent_run_id TEXT REFERENCES runs(id),provider TEXT NOT NULL,provider_session_id TEXT,title TEXT NOT NULL,prompt TEXT NOT NULL,model TEXT,cwd TEXT NOT NULL,command TEXT NOT NULL,args_json TEXT NOT NULL,status TEXT NOT NULL,pid INTEGER,pgid INTEGER,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,exit_code INTEGER,terminating_signal TEXT);
CREATE TABLE IF NOT EXISTS events (global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES runs(id),run_sequence INTEGER NOT NULL,timestamp TEXT NOT NULL,kind TEXT NOT NULL,provider_event_type TEXT,channel TEXT,payload_json TEXT NOT NULL,raw_json TEXT,UNIQUE(run_id,run_sequence));
CREATE INDEX IF NOT EXISTS events_run_sequence ON events(run_id,run_sequence);
CREATE TABLE IF NOT EXISTS stream_offsets (run_id TEXT NOT NULL REFERENCES runs(id),channel TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run_id,channel));
"#;
