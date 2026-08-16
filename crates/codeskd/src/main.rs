mod adapters;
mod codex_app_server;
mod db;
mod discovery;
mod dsh_web;
mod kiro_acp;
mod model;
mod runner;
mod sessions;
mod supervisor;
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
        ExternalInputRequest, ExternalQueuedInput, FilesQuery, Health, InputRequest, MessagesQuery,
        ProviderResponseRequest, SessionsQuery, StartRunRequest,
    },
    supervisor::Supervisor,
};

struct AppState {
    db: Db,
    supervisor: Supervisor,
    data_root: PathBuf,
    started: Instant,
    discovery: Mutex<DiscoveryCache>,
    external_queues: Mutex<HashMap<u32, Vec<ExternalQueuedInput>>>,
}

#[derive(Default)]
struct DiscoveryCache {
    updated_at: Option<Instant>,
    agents: Vec<model::DiscoveredAgent>,
}

const DISCOVERY_TTL: Duration = Duration::from_secs(60);
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
    supervisor.recover().await?;
    let state = Arc::new(AppState {
        db,
        supervisor,
        data_root,
        started: Instant::now(),
        discovery: Mutex::new(DiscoveryCache::default()),
        external_queues: Mutex::new(HashMap::new()),
    });
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
            "/v1/projects/{id}/worktrees",
            get(list_worktrees).post(create_worktree),
        )
        .route("/v1/worktrees/{id}", delete(delete_worktree))
        .route("/v1/worktrees/{id}/status", get(worktree_status))
        .route("/v1/runs", get(runs).post(start_run))
        .route("/v1/runs/{id}", get(run))
        .route("/v1/runs/{id}/events", get(run_events))
        .route("/v1/runs/{id}/input", post(input))
        .route("/v1/runs/{id}/response", post(provider_response))
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
    Json(adapters::capabilities())
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
    let agents = cached_agents(&state, false).await.map_err(api_error)?;
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
    if request.delivery == "queue" {
        let transcript = agent
            .transcript_path
            .as_deref()
            .ok_or_else(|| api_error("queueing requires a provider transcript"))?;
        if sessions::transcript_turn_active(std::path::Path::new(transcript), &agent.provider) {
            let queued = ExternalQueuedInput {
                id: Uuid::new_v4().to_string(),
                pid,
                session_id: agent.native_session_id.clone(),
                message,
                created_at: chrono::Utc::now().to_rfc3339(),
                status: "queued".to_string(),
                error: None,
            };
            let start_worker = {
                let mut queues = state.external_queues.lock().await;
                let items = queues.entry(pid).or_default();
                let start_worker = !items
                    .iter()
                    .any(|item| matches!(item.status.as_str(), "queued" | "sending"));
                items.push(queued.clone());
                start_worker
            };
            if start_worker {
                let worker_state = state.clone();
                tokio::spawn(async move {
                    deliver_external_queue(worker_state, agent).await;
                });
            }
            return Ok(Json(json!({"ok":true,"delivery":"queue","queued":queued})));
        }
    }
    discovery::send_external_input(&agent, &message)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true,"delivery":"steer","pid":pid})))
}

async fn external_session_queue(
    State(state): State<Arc<AppState>>,
    Path(pid): Path<u32>,
) -> Json<Vec<ExternalQueuedInput>> {
    Json(
        state
            .external_queues
            .lock()
            .await
            .get(&pid)
            .cloned()
            .unwrap_or_default(),
    )
}

async fn remove_external_session_queue(
    State(state): State<Arc<AppState>>,
    Path((pid, queue_id)): Path<(u32, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut queues = state.external_queues.lock().await;
    let Some(items) = queues.get_mut(&pid) else {
        return Err(api_error("queued message not found"));
    };
    let Some(index) = items.iter().position(|item| item.id == queue_id) else {
        return Err(api_error("queued message not found"));
    };
    if items[index].status == "sending" {
        return Err(api_error("queued message is already being delivered"));
    }
    items.remove(index);
    if items.is_empty() {
        queues.remove(&pid);
    }
    Ok(Json(json!({"ok":true,"queue_id":queue_id})))
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
    anyhow::ensure!(
        agent.tmux_pane.is_some(),
        "this live session is not attached to a tmux pane"
    );
    Ok(agent)
}

async fn deliver_external_queue(state: Arc<AppState>, agent: model::DiscoveredAgent) {
    loop {
        let queued = state
            .external_queues
            .lock()
            .await
            .get(&agent.pid)
            .and_then(|items| items.iter().find(|item| item.status == "queued"))
            .cloned();
        let Some(queued) = queued else { return };
        if let Err(error) = wait_for_external_turn_idle(&state, &agent).await {
            fail_pending_external_queue(&state, agent.pid, error).await;
            return;
        }
        {
            let mut queues = state.external_queues.lock().await;
            let Some(item) = queues
                .get_mut(&agent.pid)
                .and_then(|items| items.iter_mut().find(|item| item.id == queued.id))
            else {
                continue;
            };
            item.status = "sending".to_string();
        }
        let transcript_size = agent
            .transcript_path
            .as_deref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        match discovery::send_external_input(&agent, &queued.message).await {
            Ok(()) => {
                finish_external_queue(&state, agent.pid, &queued.id).await;
                if has_pending_external_queue(&state, agent.pid).await {
                    if let Err(error) =
                        wait_for_external_turn_boundary(&state, &agent, transcript_size).await
                    {
                        fail_pending_external_queue(&state, agent.pid, error).await;
                        return;
                    }
                }
            }
            Err(error) => {
                fail_pending_external_queue(&state, agent.pid, &error.to_string()).await;
                return;
            }
        }
    }
}

async fn wait_for_external_turn_idle(
    state: &AppState,
    agent: &model::DiscoveredAgent,
) -> Result<(), &'static str> {
    let deadline = Instant::now() + Duration::from_secs(24 * 60 * 60);
    loop {
        if !has_pending_external_queue(state, agent.pid).await {
            return Ok(());
        }
        if !discovery::external_process_alive(agent.pid) {
            return Err("agent process stopped before the queued message could be delivered");
        }
        if Instant::now() >= deadline {
            return Err("queued message expired after 24 hours");
        }
        let active = agent.transcript_path.as_deref().is_some_and(|path| {
            sessions::transcript_turn_active(std::path::Path::new(path), &agent.provider)
        });
        if !active {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn wait_for_external_turn_boundary(
    state: &AppState,
    agent: &model::DiscoveredAgent,
    initial_transcript_size: u64,
) -> Result<(), &'static str> {
    let deadline = Instant::now() + Duration::from_secs(24 * 60 * 60);
    let mut saw_active = false;
    let mut saw_transcript_change = false;
    loop {
        if !has_pending_external_queue(state, agent.pid).await {
            return Ok(());
        }
        if !discovery::external_process_alive(agent.pid) {
            return Err("agent process stopped before the remaining queue could be delivered");
        }
        if Instant::now() >= deadline {
            return Err("queued message expired while waiting for the previous turn to finish");
        }
        let active = agent.transcript_path.as_deref().is_some_and(|path| {
            sessions::transcript_turn_active(std::path::Path::new(path), &agent.provider)
        });
        saw_active |= active;
        saw_transcript_change |= agent
            .transcript_path
            .as_deref()
            .and_then(|path| std::fs::metadata(path).ok())
            .is_some_and(|metadata| metadata.len() > initial_transcript_size);
        if !active && (saw_active || saw_transcript_change) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn has_pending_external_queue(state: &AppState, pid: u32) -> bool {
    state
        .external_queues
        .lock()
        .await
        .get(&pid)
        .is_some_and(|items| items.iter().any(|item| item.status == "queued"))
}

async fn finish_external_queue(state: &AppState, pid: u32, queue_id: &str) {
    let mut queues = state.external_queues.lock().await;
    if let Some(items) = queues.get_mut(&pid) {
        items.retain(|item| item.id != queue_id);
        if items.is_empty() {
            queues.remove(&pid);
        }
    }
}

async fn fail_pending_external_queue(state: &AppState, pid: u32, error: &str) {
    if let Some(items) = state.external_queues.lock().await.get_mut(&pid) {
        for item in items
            .iter_mut()
            .filter(|item| matches!(item.status.as_str(), "queued" | "sending"))
        {
            item.status = "failed".to_string();
            item.error = Some(error.to_string());
        }
    }
}

async fn cached_agents(
    state: &AppState,
    force: bool,
) -> anyhow::Result<Vec<model::DiscoveredAgent>> {
    cached_agents_with(&state.discovery, force, || {
        discovery::discover_agents(&state.db)
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
