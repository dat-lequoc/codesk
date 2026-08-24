mod db;
mod discovery;
mod discovery_cache;
mod event_codec;
mod model;
mod providers;
mod pump;
mod runner;
mod sessions;
mod supervisor;
mod tmux;
mod tmux_worker;
mod transports;
mod worktrees;

use anyhow::Context;
use std::{
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
    http::{StatusCode, header},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{delete, get, post},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::{
    db::Db,
    discovery_cache::{DiscoveryState, cached_agents_with, invalidate_discovery},
    model::{
        CreateProjectRequest, CreateWorktreeRequest, DiscoverProjectsRequest, EventsQuery,
        ExternalInputRequest, ExternalQueuedInput, FilesQuery, Health, InputRequest,
        MergeWorktreeRequest, MessagesQuery, ProviderResponseRequest, SessionsQuery,
        StartRunRequest, TmuxControl, TmuxControlRequest,
    },
    supervisor::Supervisor,
    tmux::TmuxManager,
};

struct AppState {
    db: Db,
    supervisor: Supervisor,
    data_root: PathBuf,
    started: Instant,
    discovery: DiscoveryState,
    capabilities: std::sync::Mutex<Option<(Instant, Vec<model::AdapterCapability>)>>,
    tmux: TmuxManager,
}

/// How often an owned daemon confirms its owner is still alive.
const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(1);

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
        discovery: DiscoveryState::default(),
        capabilities: std::sync::Mutex::new(None),
        tmux,
    });
    tokio::spawn(tmux_worker::tmux_control_worker(state.clone()));
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
            "/v1/external-sessions/{pid}/tmux/log",
            get(external_tmux_log),
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
        .layer(middleware::from_fn(refuse_browser_callers))
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

/// The daemon's only callers are the gateway and the desktop shell, neither of
/// which is a browser. An `Origin` header therefore means a page the user
/// happened to visit reached the loopback port, and these routes start
/// processes and read files. The previous permissive CORS layer actively
/// handed such a page the responses.
async fn refuse_browser_callers(
    request: axum::extract::Request,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    if request.headers().contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
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
async fn capabilities(State(state): State<Arc<AppState>>) -> Json<Vec<model::AdapterCapability>> {
    const CAPABILITIES_TTL: Duration = Duration::from_secs(60);
    {
        let cached = state
            .capabilities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, capabilities)) = cached.as_ref() {
            if at.elapsed() < CAPABILITIES_TTL {
                return Json(capabilities.clone());
            }
        }
    }
    // Detection walks PATH plus every nvm bin directory per provider; do that
    // filesystem scan off the async runtime and at most once per TTL.
    let capabilities = tokio::task::spawn_blocking(providers::capabilities)
        .await
        .unwrap_or_default();
    *state
        .capabilities
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((Instant::now(), capabilities.clone()));
    Json(capabilities)
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
    let mut sessions = sessions::list(&project, &agents, query.limit)
        .await
        .map_err(api_error)?;
    sessions::bind_detected_tmux_sessions(&state.db, &sessions).map_err(api_error)?;
    let controls = state.db.tmux_controls().map_err(api_error)?;
    let runs = state.db.runs().map_err(api_error)?;
    sessions::apply_remembered_tmux(&mut sessions, &controls, &runs);
    Ok(Json(sessions))
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
    // Steering only writes to the tmux pane, so it works without a registered
    // project; queueing creates a run later and still needs one.
    let project_id = request.project_id.as_deref();
    if let Some(project_id) = project_id {
        validate_external_project(&state, &agent, project_id).map_err(api_error)?;
    }
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
    let project_id =
        project_id.ok_or_else(|| api_error("project_id is required to queue the next turn"))?;
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
    let pane = pane_for_agent(&state, &agent).await.map_err(api_error)?;
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
            project_id: request.project_id,
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
    // A harness does not always keep its transcript open (newer Codex builds
    // index through the state DB), so derive the path from the session id
    // instead of demanding a live file descriptor.
    let transcript_path = match agent.transcript_path.clone() {
        Some(path) => path,
        None => transcript_path_for_agent(&state, &agent, request.project_id.as_deref())
            .map_err(api_error)?,
    };
    let now = chrono::Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    state
        .db
        .upsert_tmux_control(&TmuxControl {
            id: id.clone(),
            project_id: request.project_id,
            run_id: None,
            provider: agent.provider,
            native_session_id: agent.native_session_id,
            transcript_path: Some(transcript_path),
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

#[derive(Debug, Deserialize)]
struct TmuxLogQuery {
    lines: Option<u32>,
}

/// Read-only peek at what an observed tmux session is printing. Works for any
/// discovered process attached to a pane — no project or enabled control
/// required, since capture-pane cannot disturb the session.
async fn external_tmux_log(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
    Query(query): Query<TmuxLogQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let agent = external_agent(&state, pid).await.map_err(api_error)?;
    let pane = pane_for_agent(&state, &agent).await.map_err(api_error)?;
    let lines = query.lines.unwrap_or(200).clamp(10, 2000);
    let text = state
        .tmux
        .capture_text_tail(&pane, lines)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({
        "ok": true,
        "pid": pid,
        "pane_id": pane.pane_id,
        "session_name": pane.session_name,
        "lines": lines,
        "text": text,
        "captured_at": chrono::Utc::now().to_rfc3339(),
    })))
}

async fn pane_for_agent(
    state: &AppState,
    agent: &model::DiscoveredAgent,
) -> anyhow::Result<tmux::TmuxPane> {
    let pane_id = agent
        .tmux_pane_id
        .as_deref()
        .context("this process is not attached to a tmux pane")?;
    let extra = discovery::tmux_sockets_from_pids(&[agent.pid]).await;
    state
        .tmux
        .panes_with_extra(&extra)
        .await?
        .into_iter()
        .find(|pane| pane.pane_id == pane_id)
        .context("the tmux pane is no longer available")
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

fn transcript_path_for_agent(
    state: &AppState,
    agent: &model::DiscoveredAgent,
    project_id: Option<&str>,
) -> anyhow::Result<String> {
    let session_id = agent
        .native_session_id
        .as_deref()
        .context("the provider session id is still being discovered")?;
    let project_id = project_id
        .context("the provider transcript is unknown; select the project so it can be resolved")?;
    let project = state.db.project(project_id)?.context("project not found")?;
    let path = sessions::source_path(&project, &agent.provider, session_id)?;
    Ok(path.to_string_lossy().into_owned())
}

fn validate_tmux_request(
    state: &AppState,
    agent: &model::DiscoveredAgent,
    request: &TmuxControlRequest,
) -> anyhow::Result<()> {
    if let Some(project_id) = request.project_id.as_deref() {
        validate_external_project(state, agent, project_id)?;
    }
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

async fn cached_agents(
    state: &AppState,
    force: bool,
) -> anyhow::Result<Vec<model::DiscoveredAgent>> {
    cached_agents_with(&state.discovery, force, || {
        discovery::discover_agents(&state.db, &state.data_root)
    })
    .await
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
    // Event replays can return thousands of rows; deserialize them on the
    // blocking pool instead of stalling the async runtime under the DB lock.
    let db = state.db.clone();
    Ok(Json(
        tokio::task::spawn_blocking(move || db.events_after(Some(&id), query.after))
            .await
            .map_err(api_error)?
            .map_err(api_error)?,
    ))
}
async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsQuery>,
) -> ApiResult<Json<Vec<model::Event>>> {
    let db = state.db.clone();
    Ok(Json(
        tokio::task::spawn_blocking(move || db.events_after(None, query.after))
            .await
            .map_err(api_error)?
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
    let mut cursor = after;
    if !replay_events(&mut socket, &state, &mut cursor).await {
        return;
    }
    let mut receiver = state.supervisor.events.subscribe();
    loop {
        tokio::select! {
            message = receiver.recv() => match message {
                Ok(event) => {
                    // A journal resync may already have delivered this event.
                    if event.global_sequence <= cursor {
                        continue;
                    }
                    cursor = event.global_sequence;
                    let Ok(text) = serde_json::to_string(&event) else { continue };
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                // A lagged receiver only means this client missed broadcast
                // buffer slots; every event is still in the journal. Resync
                // from the cursor instead of dropping the connection and
                // forcing the client through a full reconnect.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if !replay_events(&mut socket, &state, &mut cursor).await {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Close(_))) | None => break,
                _ => {}
            }
        }
    }
}

/// Stream journal events after `cursor` to the socket, following the query's
/// page limit until the journal is drained. Returns false when the socket is
/// gone.
async fn replay_events(socket: &mut WebSocket, state: &Arc<AppState>, cursor: &mut i64) -> bool {
    loop {
        let db = state.db.clone();
        let after = *cursor;
        let Ok(Ok(history)) =
            tokio::task::spawn_blocking(move || db.events_after(None, after)).await
        else {
            return true;
        };
        let drained = history.len() < 5000;
        for event in history {
            *cursor = event.global_sequence;
            let Ok(text) = serde_json::to_string(&event) else {
                continue;
            };
            if socket.send(Message::Text(text.into())).await.is_err() {
                return false;
            }
        }
        if drained {
            return true;
        }
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
            "[Unit]\nDescription=Codesk execution daemon\nAfter=network.target\n\n[Service]\nExecStart={}\nEnvironment=CODESK_PORT={}\nRestart=on-failure\nRestartSec=2\nKillMode=process\n\n[Install]\nWantedBy=default.target\n",
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
            // Mirror the Linux path: stage, mark executable, and rename so a
            // copied artifact that lost its mode bits still installs runnable.
            use std::os::unix::fs::PermissionsExt;
            let staged = bin_dir.join(format!(".codeskd-install-{}", std::process::id()));
            tokio::fs::copy(&executable, &staged).await?;
            tokio::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).await?;
            tokio::fs::rename(&staged, &target).await?;
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
