mod adapters;
mod db;
mod discovery;
mod model;
mod runner;
mod sessions;
mod supervisor;
mod worktrees;

use anyhow::Context;
use std::{env, net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};

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
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use uuid::Uuid;

use crate::{
    db::Db,
    model::{
        CreateProjectRequest, CreateWorktreeRequest, DiscoverProjectsRequest, EventsQuery,
        FilesQuery, Health, InputRequest, MessagesQuery, SessionsQuery, StartRunRequest,
    },
    supervisor::Supervisor,
};

#[derive(Clone)]
struct AppState {
    db: Db,
    supervisor: Supervisor,
    data_root: PathBuf,
    started: Instant,
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
    supervisor.recover().await?;
    let state = Arc::new(AppState {
        db,
        supervisor,
        data_root,
        started: Instant::now(),
    });
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/projects", get(projects).post(create_project))
        .route("/v1/projects/{id}/sessions", get(project_sessions))
        .route(
            "/v1/projects/{id}/sessions/{provider}/{session_id}/messages",
            get(project_session_messages),
        )
        .route("/v1/projects/discover", post(discover_projects))
        .route("/v1/files", get(files))
        .route("/v1/agents/discover", get(discover_agents))
        .route("/v1/agents/{pid}/{action}", post(control_external_agent))
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
    let agents = discovery::discover_agents(&state.db)
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
async fn files(Query(query): Query<FilesQuery>) -> ApiResult<Json<Vec<model::FileEntry>>> {
    Ok(Json(
        discovery::list_files(query.path.as_deref())
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
    Ok(Json(
        discovery::discover_agents(&state.db)
            .await
            .map_err(api_error)?,
    ))
}
async fn control_external_agent(
    State(state): State<Arc<AppState>>,
    Path((pid, action)): Path<(u32, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    let agents = discovery::discover_agents(&state.db)
        .await
        .map_err(api_error)?;
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
        .input(&id, &request.message)
        .await
        .map_err(api_error)?;
    Ok(Json(json!({"ok":true,"request_id":request.request_id})))
}
async fn interrupt(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .supervisor
        .signal(&id, libc::SIGINT, "interrupt", "interrupting")
        .await
        .map_err(api_error)?;
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
