mod db;
mod discovery;
mod event_codec;
mod model;
mod providers;
mod runner;
mod sessions;
mod supervisor;
mod tmux;
mod transports;
mod worktrees;

use anyhow::Context;
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Mutex;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

use crate::{
    db::Db,
    model::{
        CreateProjectRequest, CreateWorktreeRequest, DiscoverProjectsRequest, EventsQuery,
        ExternalInputRequest, ExternalQueuedInput, FilesQuery, Health, InputRequest,
        MergeWorktreeRequest, MessagesQuery, ProviderResponseRequest, ProviderSession, Run,
        SessionsQuery, StartRunRequest, TmuxControl, TmuxControlRequest,
    },
    supervisor::Supervisor,
    tmux::TmuxManager,
};

struct AppState {
    db: Db,
    supervisor: Supervisor,
    data_root: PathBuf,
    started: Instant,
    discovery: Mutex<DiscoveryCache>,
    tmux: TmuxManager,
}

#[derive(Default)]
struct DiscoveryCache {
    updated_at: Option<Instant>,
    agents: Vec<model::DiscoveredAgent>,
}

const DISCOVERY_TTL: Duration = Duration::from_secs(60);
/// Cadence used while at least one tmux session is under Codesk control.
const TMUX_WORKER_ACTIVE_INTERVAL: Duration = Duration::from_millis(350);
/// Cadence used when nothing is under control. Enabling control writes a row and
/// the next tick picks it up, so the only cost of the longer wait is how soon
/// after that a newly controlled pane starts being serviced.
const TMUX_WORKER_IDLE_INTERVAL: Duration = Duration::from_millis(2_000);
/// How often an owned daemon confirms its owner is still alive.
const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(1);
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

/// Exit when the process that started this daemon is gone.
///
/// A locally spawned `codeskd` belongs to the desktop app that started it and
/// must not outlive it; see ARCHITECTURE.md §6.5. The gateway normally stops us
/// directly, so this is the backstop for the cases it cannot cover: the gateway
/// being `SIGKILL`ed, or the whole app being force-quit.
///
/// Without `CODESK_OWNER_PID` the daemon is unowned and this returns
/// immediately, which is what standalone runs rely on: `npm start`, the test
/// suite, and a remote daemon under systemd.
async fn owner_watchdog() {
    let Some(owner) = env::var("CODESK_OWNER_PID")
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1)
    else {
        return;
    };
    tracing::info!(owner, "daemon lifetime is bound to its owner");
    loop {
        tokio::time::sleep(OWNER_POLL_INTERVAL).await;
        // Signal 0 checks for existence without delivering anything. EPERM means
        // the PID is alive under another user, so only a genuine "no such
        // process" counts as the owner being gone.
        let alive = unsafe { libc::kill(owner, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !alive {
            tracing::info!(owner, "owner exited; shutting down");
            // Runs are detached process groups with durable journals, so exiting
            // here loses no work: the next launch reattaches them.
            std::process::exit(0);
        }
    }
}
type ApiResult<T> = Result<T, (StatusCode, Json<serde_json::Value>)>;
fn api_error(error: impl std::fmt::Display) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":error.to_string()})),
    )
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut arguments = env::args_os();
    let _ = arguments.next();
    match arguments.next().as_deref() {
        Some(value)
            if value == std::ffi::OsStr::new("--version")
                || value == std::ffi::OsStr::new("-V") =>
        {
            println!("codeskd {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some(value) if value == std::ffi::OsStr::new("__runner") => {
            let path = arguments
                .next()
                .ok_or_else(|| anyhow::anyhow!("runner spec path is required"))?;
            return runner::run(std::path::Path::new(&path)).await;
        }
        Some(value) if value == std::ffi::OsStr::new("install") => {
            let port = arguments
                .next()
                .and_then(|value| value.to_string_lossy().parse::<u16>().ok())
                .unwrap_or(4243);
            return install_service(port).await;
        }
        _ => {}
    }
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let data_root = env::var_os("CODESK_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(default_data_root);
    tokio::fs::create_dir_all(&data_root).await?;
    let db = Db::open(&data_root.join("codesk.db"))?;
    let supervisor = Supervisor::new(db.clone(), data_root.clone());
    let tmux = TmuxManager::new(data_root.clone());
    supervisor.recover().await?;
    let state = Arc::new(AppState {
        db,
        supervisor,
        data_root,
        started: Instant::now(),
        discovery: Mutex::new(DiscoveryCache::default()),
        tmux,
    });
    tokio::spawn(tmux_control_worker(state.clone()));
    tokio::spawn(owner_watchdog());
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/projects", get(projects).post(create_project))
        .route("/v1/projects/{id}", delete(remove_project))
        .route("/v1/projects/{id}/git-context", get(project_git_context))
        .route("/v1/projects/{id}/sessions", get(project_sessions))
        .route(
            "/v1/projects/{id}/sessions/{provider}/{session_id}/messages",
            get(project_session_messages),
        )
        .route("/v1/projects/discover", post(discover_projects))
        .route("/v1/files", get(files))
        .route("/v1/file", get(file))
        .route("/v1/agents/discover", get(discover_agents))
        .route("/v1/agents/{pid}/{action}", post(control_external_agent))
        .route(
            "/v1/external-sessions/{pid}/input",
            post(input_external_session),
        )
        .route(
            "/v1/external-sessions/{pid}/queue",
            get(external_session_queue),
        )
        .route(
            "/v1/external-sessions/{pid}/queue/{queue_id}",
            delete(remove_external_session_queue),
        )
        .route(
            "/v1/external-sessions/{pid}/tmux/adopt",
            post(adopt_external_tmux),
        )
        .route(
            "/v1/external-sessions/{pid}/tmux/move",
            post(move_external_to_tmux),
        )
        .route(
            "/v1/external-sessions/{pid}/tmux/disable",
            post(disable_external_tmux),
        )
        .route(
            "/v1/projects/{id}/worktrees",
            get(list_worktrees).post(create_worktree),
        )
        .route("/v1/worktrees/{id}", delete(delete_worktree))
        .route("/v1/worktrees/{id}/status", get(worktree_status))
        .route("/v1/worktrees/{id}/merge", post(merge_worktree))
        .route("/v1/runs", get(runs).post(start_run))
        .route("/v1/runs/{id}", get(run))
        .route("/v1/runs/{id}/events", get(run_events))
        .route("/v1/runs/{id}/input", post(input))
        .route("/v1/runs/{id}/response", post(provider_response))
        .route("/v1/runs/{id}/models", post(provider_models))
        .route("/v1/runs/{id}/queue/start", post(start_queued))
        .route("/v1/runs/{id}/queue/{queue_id}", delete(remove_queued))
        .route("/v1/runs/{id}/interrupt", post(interrupt))
        .route("/v1/runs/{id}/terminate", post(terminate))
        .route("/v1/runs/{id}/kill", post(kill))
        .route("/v1/events", get(events))
        .route("/v1/events/ws", get(events_ws))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);
    let port: u16 = env::var("CODESK_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4243);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(address).await?;
    tracing::info!(%address,"codeskd listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
        host_name: env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into()),
        uptime_seconds: state.started.elapsed().as_secs(),
        active_runs: state.supervisor.active_count().await,
    })
}
async fn capabilities() -> Json<Vec<model::AdapterCapability>> {
    Json(providers::capabilities())
}
async fn projects(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<model::Project>>> {
    Ok(Json(state.db.projects().map_err(api_error)?))
}
async fn project_sessions(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<SessionsQuery>,
) -> ApiResult<Json<Vec<model::ProviderSession>>> {
    let project = state
        .db
        .project(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("project not found"))?;
    let agents = cached_agents(&state, query.refresh)
        .await
        .map_err(api_error)?;
    Ok(Json(
        sessions::list(&project, &agents, query.limit)
            .await
            .map_err(api_error)?,
    ))
}
async fn project_session_messages(
    State(state): State<Arc<AppState>>,
    Path((id, provider, session_id)): Path<(String, String, String)>,
    Query(query): Query<MessagesQuery>,
) -> ApiResult<Json<Vec<model::SessionMessage>>> {
    let project = state
        .db
        .project(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("project not found"))?;
    Ok(Json(
        sessions::messages(&project, &provider, &session_id, query.after.as_deref())
            .await
            .map_err(api_error)?,
    ))
}
async fn create_project(
    State(state): State<Arc<AppState>>,
    Json(request): Json<CreateProjectRequest>,
) -> ApiResult<(StatusCode, Json<model::Project>)> {
    let path = tokio::fs::canonicalize(&request.path)
        .await
        .map_err(api_error)?;
    let repo = worktrees::detect_repo(&path).await;
    if let Some(existing) = state
        .db
        .project_by_path(path.to_string_lossy().as_ref())
        .map_err(api_error)?
    {
        state.db.register_project(&existing.id).map_err(api_error)?;
        return Ok((StatusCode::OK, Json(existing)));
    }
    let item = model::Project {
        id: Uuid::new_v4().to_string(),
        name: request.name,
        path: path.to_string_lossy().into_owned(),
        repo_root: repo,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    state.db.create_project(&item).map_err(api_error)?;
    Ok((StatusCode::CREATED, Json(item)))
}
async fn remove_project(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    if !state.db.unregister_project(&id).map_err(api_error)? {
        return Err(api_error("project not found"));
    }
    Ok(Json(json!({"ok": true, "id": id})))
}
async fn project_git_context(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<model::GitContext>> {
    let project = state
        .db
        .project(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("project not found"))?;
    Ok(Json(
        worktrees::git_context(PathBuf::from(project.path).as_path()).await,
    ))
}
async fn files(Query(query): Query<FilesQuery>) -> ApiResult<Json<model::FileListing>> {
    Ok(Json(
        discovery::list_files(query.path.as_deref())
            .await
            .map_err(api_error)?,
    ))
}
async fn file(Query(query): Query<FilesQuery>) -> ApiResult<Json<model::FileContent>> {
    Ok(Json(
        discovery::read_file(query.path.as_deref())
            .await
            .map_err(api_error)?,
    ))
}
async fn discover_projects(
    State(state): State<Arc<AppState>>,
    Json(request): Json<DiscoverProjectsRequest>,
) -> ApiResult<Json<Vec<model::DiscoveredProject>>> {
    Ok(Json(
        discovery::discover_projects(
            &state.db,
            &request.path,
            request.max_depth,
            request.register,
        )
        .await
        .map_err(api_error)?,
    ))
}
async fn discover_agents(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<Vec<model::DiscoveredAgent>>> {
    Ok(Json(cached_agents(&state, false).await.map_err(api_error)?))
}
async fn control_external_agent(
    State(state): State<Arc<AppState>>,
    Path((pid, action)): Path<(u32, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    let agents = cached_agents(&state, true).await.map_err(api_error)?;
    let agent = agents
        .into_iter()
        .find(|item| item.pid == pid)
        .ok_or_else(|| api_error("agent process not found"))?;
    if agent.managed_run_id.is_some() {
        return Err(api_error("managed runs must use the run control API"));
    }
    let signal = match action.as_str() {
        "interrupt" => libc::SIGINT,
        "terminate" => libc::SIGTERM,
        "kill" => libc::SIGKILL,
        _ => return Err(api_error("unsupported action")),
    };
    discovery::signal_external(agent.pid, agent.process_group_id, signal).map_err(api_error)?;
    Ok(Json(
        json!({"ok":true,"pid":pid,"process_group_id":agent.process_group_id,"action":action}),
    ))
}

async fn input_external_session(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
    Json(request): Json<ExternalInputRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let message = request.message.trim().to_string();
    if message.is_empty() {
        return Err(api_error("message is required"));
    }
    if !matches!(request.delivery.as_str(), "auto" | "steer" | "queue") {
        return Err(api_error(
            "external session delivery must be steer or queue",
        ));
    }
    let agent = external_agent(&state, pid).await.map_err(api_error)?;
    if let Some(session_id) = request.session_id.as_deref() {
        if agent.native_session_id.as_deref() != Some(session_id) {
            return Err(api_error(
                "the active process no longer owns this provider session",
            ));
        }
    }
    let project_id = request
        .project_id
        .as_deref()
        .ok_or_else(|| api_error("project_id is required to control an external session"))?;
    validate_external_project(&state, &agent, project_id).map_err(api_error)?;
    let control = state
        .db
        .tmux_control_for_pid(pid)
        .map_err(api_error)?
        .filter(|control| control.enabled && control.status == "active")
        .ok_or_else(|| {
            api_error(if agent.tmux_pane_id.is_some() {
                "enable Codesk control for this tmux session first"
            } else {
                "move this terminal session to tmux before sending input"
            })
        })?;
    let pane = control_pane(&state, &control).await.map_err(api_error)?;
    if request.delivery != "queue" {
        state
            .tmux
            .send_prompt(&pane, &message)
            .await
            .map_err(api_error)?;
        state
            .db
            .update_tmux_queue_state(&control.id, "awaiting_start")
            .map_err(api_error)?;
        return Ok(Json(json!({"ok":true,"delivery":"steer"})));
    }
    let queued = ExternalQueuedInput {
        id: Uuid::new_v4().to_string(),
        pid,
        project_id: project_id.to_string(),
        session_id: agent.native_session_id.clone(),
        message,
        title: request.title,
        created_at: chrono::Utc::now().to_rfc3339(),
        status: "queued".to_string(),
        error: None,
        run: None,
    };
    state
        .db
        .enqueue_tmux_input(&control.id, &queued)
        .map_err(api_error)?;
    Ok(Json(json!({
        "ok":true,
        "delivery":"queue",
        "queued":queued
    })))
}

async fn external_session_queue(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
) -> Json<Vec<ExternalQueuedInput>> {
    let items = state
        .db
        .tmux_control_for_pid(pid)
        .ok()
        .flatten()
        .and_then(|control| state.db.tmux_queue(&control.id).ok())
        .unwrap_or_default();
    Json(items)
}

async fn remove_external_session_queue(
    State(state): State<Arc<AppState>>,
    Path((pid, queue_id)): Path<(u32, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    let control = state
        .db
        .tmux_control_for_pid(pid)
        .map_err(api_error)?
        .ok_or_else(|| api_error("tmux control not found"))?;
    if !state
        .db
        .delete_tmux_queue(&control.id, &queue_id)
        .map_err(api_error)?
    {
        return Err(api_error("queued message not found or already sending"));
    }
    Ok(Json(json!({"ok":true,"queue_id":queue_id})))
}

async fn adopt_external_tmux(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
    Json(request): Json<TmuxControlRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let agent = external_agent(&state, pid).await.map_err(api_error)?;
    validate_tmux_request(&state, &agent, &request).map_err(api_error)?;
    let pane_id = agent
        .tmux_pane_id
        .as_deref()
        .ok_or_else(|| api_error("this process is not attached to a tmux pane"))?;
    let pane = state
        .tmux
        .panes()
        .await
        .map_err(api_error)?
        .into_iter()
        .find(|pane| pane.pane_id == pane_id && pane.tty == agent.tty.clone().unwrap_or_default())
        .ok_or_else(|| api_error("the tmux pane is no longer available"))?;
    let now = chrono::Utc::now().to_rfc3339();
    let id = pane
        .control_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    state
        .tmux
        .enable_control(&pane, &id, &agent.provider)
        .await
        .map_err(api_error)?;
    let access = tmux::access_command(
        pane.socket_path.as_deref().map(std::path::Path::new),
        &pane.session_name,
    );
    state
        .db
        .upsert_tmux_control(&TmuxControl {
            id: id.clone(),
            project_id: Some(request.project_id),
            run_id: None,
            provider: agent.provider,
            native_session_id: agent.native_session_id,
            transcript_path: agent.transcript_path,
            source_pid: agent.pid,
            source_pgid: agent.process_group_id,
            cwd: agent.cwd.unwrap_or_else(|| pane.current_path.clone()),
            original_command: agent.command,
            socket_path: pane.socket_path.clone(),
            pane_id: Some(pane.pane_id.clone()),
            session_name: Some(pane.session_name.clone()),
            access_command: Some(access.clone()),
            owned: pane.owned,
            enabled: true,
            status: "active".to_string(),
            error: None,
            queue_state: "ready".to_string(),
            queue_state_at: now.clone(),
            created_at: now.clone(),
            updated_at: now,
        })
        .map_err(api_error)?;
    invalidate_discovery(&state).await;
    Ok(Json(
        json!({"ok":true,"control_id":id,"tmux_name":pane.session_name,"tmux_access_command":access}),
    ))
}

async fn move_external_to_tmux(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
    Json(request): Json<TmuxControlRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let agent = external_agent(&state, pid).await.map_err(api_error)?;
    validate_tmux_request(&state, &agent, &request).map_err(api_error)?;
    if agent.tmux_pane_id.is_some() {
        return Err(api_error(
            "this session is already running in tmux; enable control instead",
        ));
    }
    if agent.transcript_path.is_none() {
        return Err(api_error("the provider transcript is required"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    state
        .db
        .upsert_tmux_control(&TmuxControl {
            id: id.clone(),
            project_id: Some(request.project_id),
            run_id: None,
            provider: agent.provider,
            native_session_id: agent.native_session_id,
            transcript_path: agent.transcript_path,
            source_pid: agent.pid,
            source_pgid: agent.process_group_id,
            cwd: agent
                .cwd
                .context("working directory is unknown")
                .map_err(api_error)?,
            original_command: agent.command,
            socket_path: None,
            pane_id: None,
            session_name: None,
            access_command: None,
            owned: true,
            enabled: true,
            status: "waiting_idle".to_string(),
            error: None,
            queue_state: "settling".to_string(),
            queue_state_at: now.clone(),
            created_at: now.clone(),
            updated_at: now,
        })
        .map_err(api_error)?;
    Ok(Json(
        json!({"ok":true,"control_id":id,"status":"waiting_idle"}),
    ))
}

async fn disable_external_tmux(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
) -> ApiResult<Json<serde_json::Value>> {
    let control = state
        .db
        .tmux_control_for_pid(pid)
        .map_err(api_error)?
        .ok_or_else(|| api_error("tmux control not found"))?;
    if let Ok(pane) = control_pane(&state, &control).await {
        state.tmux.disable_control(&pane).await.map_err(api_error)?;
    }
    state
        .db
        .disable_tmux_control(&control.id)
        .map_err(api_error)?;
    invalidate_discovery(&state).await;
    Ok(Json(json!({"ok":true,"control_id":control.id})))
}

async fn external_agent(state: &AppState, pid: u32) -> anyhow::Result<model::DiscoveredAgent> {
    let agent = cached_agents(state, true)
        .await?
        .into_iter()
        .find(|item| item.pid == pid)
        .context("agent process not found")?;
    anyhow::ensure!(
        agent.managed_run_id.is_none(),
        "managed runs must use the run input API"
    );
    Ok(agent)
}

fn validate_external_project(
    state: &AppState,
    agent: &model::DiscoveredAgent,
    project_id: &str,
) -> anyhow::Result<()> {
    let project = state.db.project(project_id)?.context("project not found")?;
    let cwd = agent
        .cwd
        .as_deref()
        .context("external session working directory is unknown")?;
    let matches = std::path::Path::new(cwd) == std::path::Path::new(&project.path)
        || std::fs::canonicalize(cwd)
            .ok()
            .zip(std::fs::canonicalize(&project.path).ok())
            .is_some_and(|(left, right)| left == right);
    anyhow::ensure!(matches, "external session belongs to another project");
    Ok(())
}

fn validate_tmux_request(
    state: &AppState,
    agent: &model::DiscoveredAgent,
    request: &TmuxControlRequest,
) -> anyhow::Result<()> {
    validate_external_project(state, agent, &request.project_id)?;
    if let Some(session_id) = request.session_id.as_deref() {
        anyhow::ensure!(
            agent.native_session_id.as_deref() == Some(session_id),
            "the active process no longer owns this provider session"
        );
    }
    anyhow::ensure!(
        agent.native_session_id.is_some(),
        "the provider session id is still being discovered"
    );
    Ok(())
}

async fn control_pane(state: &AppState, control: &TmuxControl) -> anyhow::Result<tmux::TmuxPane> {
    let pane_id = control
        .pane_id
        .as_deref()
        .context("tmux pane is unavailable")?;
    state
        .tmux
        .pane(control.socket_path.as_deref(), pane_id)
        .await?
        .context("tmux pane is no longer available")
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

async fn invalidate_discovery(state: &AppState) {
    state.discovery.lock().await.updated_at = None;
}

async fn tmux_control_worker(state: Arc<AppState>) {
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

async fn cached_agents(
    state: &AppState,
    force: bool,
) -> anyhow::Result<Vec<model::DiscoveredAgent>> {
    cached_agents_with(&state.discovery, force, || {
        discovery::discover_agents(&state.db, &state.data_root)
    })
    .await
}

async fn cached_agents_with<F, Fut>(
    discovery: &Mutex<DiscoveryCache>,
    force: bool,
    scan: F,
) -> anyhow::Result<Vec<model::DiscoveredAgent>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<model::DiscoveredAgent>>>,
{
    // Holding the lock while scanning intentionally makes refreshes single-flight:
    // concurrent project/session requests reuse the one in-progress discovery.
    let mut cache = discovery.lock().await;
    if !force
        && cache
            .updated_at
            .is_some_and(|updated| updated.elapsed() < DISCOVERY_TTL)
    {
        return Ok(cache.agents.clone());
    }
    let agents = scan().await?;
    cache.updated_at = Some(Instant::now());
    cache.agents = agents.clone();
    Ok(agents)
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

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

    #[tokio::test]
    async fn discovery_refresh_is_single_flight_within_the_ttl() {
        let cache = Arc::new(Mutex::new(DiscoveryCache::default()));
        let scans = Arc::new(AtomicUsize::new(0));
        let first = {
            let cache = cache.clone();
            let scans = scans.clone();
            tokio::spawn(async move {
                cached_agents_with(&cache, false, || async move {
                    scans.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Ok(Vec::new())
                })
                .await
                .unwrap()
            })
        };
        let second = {
            let cache = cache.clone();
            let scans = scans.clone();
            tokio::spawn(async move {
                cached_agents_with(&cache, false, || async move {
                    scans.fetch_add(1, Ordering::SeqCst);
                    Ok(Vec::new())
                })
                .await
                .unwrap()
            })
        };
        let _ = tokio::join!(first, second);
        assert_eq!(scans.load(Ordering::SeqCst), 1);
        cached_agents_with(&cache, true, || async {
            scans.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        })
        .await
        .unwrap();
        assert_eq!(scans.load(Ordering::SeqCst), 2);
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
async fn list_worktrees(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<model::Worktree>>> {
    Ok(Json(state.db.worktrees(&id).map_err(api_error)?))
}
async fn create_worktree(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(request): Json<CreateWorktreeRequest>,
) -> ApiResult<(StatusCode, Json<model::Worktree>)> {
    let project = state
        .db
        .project(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("project not found"))?;
    let item = worktrees::create(&state.db, &state.data_root, &project, &request)
        .await
        .map_err(api_error)?;
    Ok((StatusCode::CREATED, Json(item)))
}
#[derive(Deserialize)]
struct DeleteQuery {
    #[serde(default)]
    force: bool,
}
async fn delete_worktree(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let item = state
        .db
        .worktree(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("worktree not found"))?;
    worktrees::remove(&state.db, &item, query.force)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn worktree_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<model::WorktreeStatus>> {
    let item = state
        .db
        .worktree(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("worktree not found"))?;
    Ok(Json(worktrees::status(&item).await.map_err(api_error)?))
}
async fn merge_worktree(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(request): Json<MergeWorktreeRequest>,
) -> ApiResult<Json<model::MergeWorktreeResult>> {
    let item = state
        .db
        .worktree(&id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("worktree not found"))?;
    let project = state
        .db
        .project(&item.project_id)
        .map_err(api_error)?
        .ok_or_else(|| api_error("project not found"))?;
    Ok(Json(
        worktrees::merge(&state.db, &item, &project, &request)
            .await
            .map_err(api_error)?,
    ))
}
async fn runs(State(state): State<Arc<AppState>>) -> ApiResult<Json<Vec<model::Run>>> {
    Ok(Json(state.db.runs().map_err(api_error)?))
}
async fn start_run(
    State(state): State<Arc<AppState>>,
    Json(request): Json<StartRunRequest>,
) -> ApiResult<(StatusCode, Json<model::Run>)> {
    let run = state.supervisor.start(request).await.map_err(api_error)?;
    Ok((StatusCode::CREATED, Json(run)))
}
async fn run(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<model::Run>> {
    Ok(Json(
        state
            .db
            .run(&id)
            .map_err(api_error)?
            .ok_or_else(|| api_error("run not found"))?,
    ))
}
async fn run_events(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<Vec<model::Event>>> {
    Ok(Json(
        state
            .db
            .events_after(Some(&id), query.after)
            .map_err(api_error)?,
    ))
}
async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<Vec<model::Event>>> {
    Ok(Json(
        state
            .db
            .events_after(None, query.after)
            .map_err(api_error)?,
    ))
}
async fn input(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(request): Json<InputRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .input(
            &id,
            &request.message,
            request.request_id.as_deref(),
            &request.delivery,
            request.last_turn_id.as_deref(),
        )
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true,"request_id":request.request_id})))
}
async fn provider_models(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let models = state
        .supervisor
        .provider_models(&id)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"models":models})))
}
async fn start_queued(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .start_queued(&id)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn remove_queued(
    State(state): State<Arc<AppState>>,
    Path((id, queue_id)): Path<(String, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .remove_queued(&id, &queue_id)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn provider_response(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(request): Json<ProviderResponseRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .provider_response(&id, request.rpc_id, request.result)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn interrupt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state.supervisor.interrupt(&id).await.map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn terminate(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .signal(&id, libc::SIGTERM, "terminate", "interrupting")
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn kill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .signal(&id, libc::SIGKILL, "kill", "interrupting")
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true})))
}
async fn events_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, query.after))
}
async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, after: i64) {
    if let Ok(history) = state.db.events_after(None, after) {
        for event in history {
            if socket
                .send(Message::Text(serde_json::to_string(&event).unwrap().into()))
                .await
                .is_err()
            {
                return;
            }
        }
    }
    let mut receiver = state.supervisor.events.subscribe();
    loop {
        tokio::select! {message=receiver.recv()=>match message{Ok(event)=>if socket.send(Message::Text(serde_json::to_string(&event).unwrap().into())).await.is_err(){break},Err(_)=>break},incoming=socket.next()=>match incoming{Some(Ok(Message::Close(_)))|None=>break,_=>{}}}
    }
}

fn default_data_root() -> PathBuf {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    return home.join("Library/Application Support/Codesk");
    #[cfg(not(target_os = "macos"))]
    return home.join(".local/share/codesk");
}

async fn install_service(port: u16) -> anyhow::Result<()> {
    let executable = std::env::current_exe()?;
    #[cfg(target_os = "linux")]
    {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set")?;
        let bin_dir = home.join(".local/bin");
        tokio::fs::create_dir_all(&bin_dir).await?;
        let target = bin_dir.join("codeskd");
        if executable != target {
            use std::os::unix::fs::PermissionsExt;
            let staged = bin_dir.join(format!(".codeskd-install-{}", std::process::id()));
            tokio::fs::copy(&executable, &staged).await?;
            tokio::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).await?;
            tokio::fs::rename(&staged, &target).await?;
        }
        let unit_dir = home.join(".config/systemd/user");
        tokio::fs::create_dir_all(&unit_dir).await?;
        let unit = format!(
            "[Unit]\nDescription=Codesk execution daemon\nAfter=network.target\n\n[Service]\nExecStart={}\nEnvironment=CODESK_PORT={}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
            target.display(),
            port
        );
        tokio::fs::write(unit_dir.join("codeskd.service"), unit).await?;
        let status = tokio::process::Command::new("systemctl")
            .args(["--user", "daemon-reload"])
            .status()
            .await?;
        anyhow::ensure!(status.success(), "systemctl --user daemon-reload failed");
        let status = tokio::process::Command::new("systemctl")
            .args(["--user", "enable", "--now", "codeskd.service"])
            .status()
            .await?;
        anyhow::ensure!(status.success(), "failed to enable codeskd user service");
        let status = tokio::process::Command::new("systemctl")
            .args(["--user", "restart", "codeskd.service"])
            .status()
            .await?;
        anyhow::ensure!(status.success(), "failed to restart codeskd user service");
        println!(
            "installed {} and started codeskd.service on 127.0.0.1:{}",
            target.display(),
            port
        );
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set")?;
        let bin_dir = home.join(".local/bin");
        tokio::fs::create_dir_all(&bin_dir).await?;
        let target = bin_dir.join("codeskd");
        if executable != target {
            tokio::fs::copy(&executable, &target).await?;
        }
        let agents = home.join("Library/LaunchAgents");
        tokio::fs::create_dir_all(&agents).await?;
        let label = "com.codesk.codeskd";
        let plist = agents.join(format!("{label}.plist"));
        let content = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{}</string></array><key>EnvironmentVariables</key><dict><key>CODESK_PORT</key><string>{port}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>{}/Library/Logs/codeskd.log</string><key>StandardErrorPath</key><string>{}/Library/Logs/codeskd.log</string></dict></plist>",
            target.display(),
            home.display(),
            home.display()
        );
        tokio::fs::write(&plist, content).await?;
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let _ = tokio::process::Command::new("launchctl")
            .args(["bootout", &domain, plist.to_string_lossy().as_ref()])
            .status()
            .await;
        let status = tokio::process::Command::new("launchctl")
            .args(["bootstrap", &domain, plist.to_string_lossy().as_ref()])
            .status()
            .await?;
        anyhow::ensure!(status.success(), "launchctl bootstrap failed");
        println!(
            "installed {} and started {} on 127.0.0.1:{}",
            target.display(),
            label,
            port
        );
        return Ok(());
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        anyhow::bail!("service installation is unsupported on this platform")
    }
}
