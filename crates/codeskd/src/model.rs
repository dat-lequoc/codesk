use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub repo_root: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub ownership: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeStatus {
    pub worktree: Worktree,
    pub dirty: bool,
    pub summary: String,
    pub diff_stat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub project_id: String,
    pub worktree_id: Option<String>,
    pub parent_run_id: Option<String>,
    pub provider: String,
    pub provider_session_id: Option<String>,
    pub title: String,
    pub prompt: String,
    pub model: Option<String>,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub status: String,
    pub pid: Option<u32>,
    pub process_group_id: Option<i32>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub terminating_signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub global_sequence: i64,
    pub run_sequence: i64,
    pub event_id: String,
    pub run_id: String,
    pub timestamp: String,
    pub kind: String,
    pub provider_event_type: Option<String>,
    pub channel: Option<String>,
    pub payload: Value,
    pub raw_payload: Option<Value>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorktreeRequest {
    pub base_ref: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StartRunRequest {
    pub project_id: String,
    pub title: Option<String>,
    pub prompt: String,
    pub provider: String,
    pub model: Option<String>,
    #[serde(default = "default_workspace_mode")]
    pub workspace_mode: String,
    pub worktree_id: Option<String>,
    pub base_ref: Option<String>,
    pub branch: Option<String>,
    pub parent_run_id: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub operation: Option<String>,
    pub resume_session_id: Option<String>,
}

fn default_workspace_mode() -> String {
    "current_checkout".to_string()
}

#[derive(Debug, Deserialize)]
pub struct InputRequest {
    pub message: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub after: i64,
}

#[derive(Debug, Serialize)]
pub struct AdapterCapability {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub executable: Option<String>,
    pub structured_output: bool,
    pub live_input: bool,
    pub resume: bool,
    pub fork: bool,
    pub native_interrupt: bool,
    pub limitations: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct Health {
    pub ok: bool,
    pub version: &'static str,
    pub host_name: String,
    pub uptime_seconds: u64,
    pub active_runs: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_git: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileListing {
    pub current_path: String,
    pub parent_path: Option<String>,
    pub home_path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredProject {
    pub name: String,
    pub path: String,
    pub repo_root: Option<String>,
    pub registered_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredAgent {
    pub id: String,
    pub provider: String,
    pub pid: u32,
    pub process_group_id: i32,
    pub cwd: Option<String>,
    pub command: String,
    pub managed_run_id: Option<String>,
    pub native_session_id: Option<String>,
    pub transcript_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderSession {
    pub id: String,
    pub provider: String,
    pub native_session_id: String,
    pub project_id: String,
    pub cwd: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub status: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMessage {
    pub id: String,
    pub timestamp: String,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct FilesQuery {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SessionsQuery {
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    pub after: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DiscoverProjectsRequest {
    pub path: String,
    #[serde(default = "default_discovery_depth")]
    pub max_depth: usize,
    #[serde(default)]
    pub register: bool,
}

fn default_discovery_depth() -> usize {
    2
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerSpec {
    pub run_id: String,
    pub provider: String,
    pub cwd: String,
    pub command: String,
    pub args: Vec<String>,
    pub run_dir: String,
    pub input_socket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerExit {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub finished_at: String,
}
