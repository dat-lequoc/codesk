# Codesk Architecture

This document turns the product requirements into a concrete implementation design.

## 1. System boundary

```text
┌───────────────────────────── macOS desktop ─────────────────────────────┐
│                                                                         │
│  Codesk client                                                          │
│  - project/run UI                                                       │
│  - live event rendering                                                 │
│  - commands: start, steer, interrupt, terminate, kill, resume, spawn    │
│  - notifications                                                        │
│  - connection manager                                                   │
│             │                                                           │
│             │ authenticated local channel or SSH-forwarded channel      │
└─────────────┼───────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────── execution host: Mac or Linux VPS ───────────────┐
│                                                                         │
│  codeskd                                                                │
│  ├─ API and event-stream server                                         │
│  ├─ project registry                                                    │
│  ├─ Git/worktree manager                                                │
│  ├─ run supervisor                                                      │
│  ├─ static provider registry and one adapter module per harness          │
│  ├─ process-group and signal controller                                 │
│  ├─ SQLite metadata database                                            │
│  └─ durable event and raw-output journals                               │
│             │                                                           │
│             ├─ agent CLI process                                        │
│             ├─ tool subprocesses                                        │
│             ├─ Git and filesystem                                       │
│             └─ host-local credentials, MCP servers, hooks, environment  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

For a remote project, everything below `codeskd` is on the VPS. The client never owns the remote agent process.

## 2. Components

### 2.1 Desktop client

Responsibilities:

- maintain the catalog of known hosts and connection preferences;
- establish a local daemon connection or SSH tunnel to a remote daemon;
- present projects, runs, event timelines, pending requests, and host health;
- send idempotent control commands;
- track the last applied event sequence per run;
- reconnect and request replay after connection loss;
- display OS notifications and suppress duplicate notification event IDs.
- persist client-side draft sessions for pre-submission `New chat` rows and reconcile them with daemon-owned runs after the first prompt is accepted.

It does not execute remote agents, parse local copies of remote files, or store remote secrets.

Draft sessions are intentionally client-owned because no execution exists yet. They live in the local gateway store with a generated draft ID, host/project identity, prompt, provider, and workspace mode. Creating or editing one never contacts the remote daemon. The first prompt is a two-phase handoff: request run creation from the execution-host daemon, then delete the draft only after a successful response. This preserves the draft during network or provider failures and avoids a false remote session record.

Provider-native discovery remains separate. Codex Desktop, for example, can render `client-new-thread:*` rows before `thread/start`; those rows do not appear in the VPS Codex SQLite database, rollout files, process list, or app-server loaded-thread inventory. Codesk models the same lifecycle for chats created in Codesk, but does not scrape another app's private renderer memory.

Packaging choice: Tauri 2 with a React/TypeScript frontend. Tauri provides a native macOS application with a small footprint, notification integration, secure credential storage, autostart helpers, and a Rust backend suitable for managing SSH tunnels and local daemon processes.

The current web prototype is a UI exploration only. It is not the final remote execution architecture.

### 2.2 `codeskd` execution daemon

Responsibilities:

- own project and run state on its host;
- create, register, inspect, retain, and safely remove managed Git worktrees;
- spawn interactive harness runs in a Codesk-owned tmux pane on the execution host, while retaining the durable structured runner for protocol regression and non-interactive shell jobs;
- retain enough process identity to signal the correct group;
- normalize provider events and retain raw events;
- persist run metadata transactionally;
- append event records with monotonic sequence numbers;
- serve snapshots and replayable event streams;
- accept control operations and return durable acknowledgments;
- expose daemon and adapter health;
- enforce concurrency, output, and retention limits.

Implementation choice: Rust service using Tokio. Rust is appropriate because this daemon owns long-lived subprocesses, signal semantics, concurrent streaming, resource limits, and a small deployable binary on macOS/Linux.

### 2.3 Provider adapter

The internal interface should resemble:

```rust
trait AgentAdapter {
    fn id(&self) -> &'static str;
    async fn detect(&self) -> AdapterStatus;
    fn capabilities(&self) -> Capabilities;
    fn build_start(&self, request: StartRequest) -> CommandSpec;
    fn build_resume(&self, request: ResumeRequest) -> Result<CommandSpec>;
    fn parse_event(&mut self, channel: Channel, bytes: &[u8]) -> Vec<AgentEvent>;
    async fn send_input(&mut self, input: AgentInput) -> Result<InputAck>;
    async fn interrupt(&mut self) -> Result<ControlAck>;
}
```

Capabilities are explicit booleans or enums, including:

- structured output;
- live input;
- typed approvals;
- resume;
- fork;
- provider-native interrupt;
- usage/cost reporting;
- session ID availability.

This prevents the UI from offering controls that only appear to work.

The implemented adapter boundary is static and deliberately smaller than a runtime plugin ABI. `crates/codeskd/src/providers/mod.rs` owns the registry and contract; `codex.rs`, `kiro.rs`, `opencode.rs`, `dsh.rs`, `agy.rs`, `pi.rs`, `claude.rs`, and `shell.rs` own provider descriptors plus execution, input, discovery, and session routing. Protocol transports are separate under `crates/codeskd/src/transports/`: stdio, shared ACP, Codex app-server, and DSH Web. Provider event codecs are shared only when the wire protocol is shared.

The desktop mirrors this with `src/lib/providers.ts`, which owns provider names, ordering, colors, and interaction quirks, and `src/components/ProviderIcon.tsx`, which owns icon and fallback rendering. Execution capability fields returned by `codeskd` remain authoritative; UI registry values are compatibility fallbacks for older remote daemons that do not yet return newer additive fields.

Adding a provider therefore follows one bounded path:

1. add one backend provider module and register its static adapter;
2. choose an existing transport or add a protocol transport independent of provider branding;
3. implement command/input/event/discovery/session methods and fixtures in that module;
4. add one frontend registry entry, using the generic icon fallback until a branded icon is available;
5. run registry conformance, provider fixture, daemon, frontend, redeploy, and native screenshot checks.

Provider IDs and stored session/run records remain stable. New capability fields are additive so a newer desktop can continue to connect to an older remote daemon with conservative registry fallbacks.

## 3. Transport

### 3.1 Local

- `codeskd` listens on a Unix domain socket.
- The desktop application starts it on demand or connects to an existing per-user service.
- Socket filesystem permissions restrict access to the current user.

### 3.2 Remote MVP

- `codeskd` listens only on a Unix socket or loopback TCP port on the VPS.
- The client uses the user's OpenSSH alias and host-key policy.
- The client creates a local forward to the daemon endpoint.
- SSH `ControlMaster`/`ControlPersist`, keepalives, bounded exponential backoff, and jitter reduce reconnect latency.
- The application recreates the tunnel when the network path changes.
- The protocol reconnect is independent from the SSH process reconnect.

An SSH tunnel is only transport. The remote daemon, database, journals, and agent processes remain alive without it.

### 3.3 Future direct transport

A mutually authenticated TLS or WireGuard/Tailscale-accessible endpoint can later replace the tunnel for always-on connectivity. The application protocol remains unchanged.

## 4. Control protocol

Choice: versioned HTTP for snapshots and commands plus WebSocket for live events in the MVP. A later migration to gRPC is possible, but HTTP/WebSocket keeps client inspection and adapter development simple.

Core endpoints:

```text
GET    /v1/health
GET    /v1/capabilities
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/{project_id}/worktrees
POST   /v1/projects/{project_id}/worktrees
DELETE /v1/worktrees/{worktree_id}
GET    /v1/runs
POST   /v1/runs
GET    /v1/runs/{run_id}
GET    /v1/runs/{run_id}/events?after={sequence}
POST   /v1/runs/{run_id}/input
POST   /v1/runs/{run_id}/response
POST   /v1/runs/{run_id}/interrupt
POST   /v1/runs/{run_id}/terminate
POST   /v1/runs/{run_id}/kill
POST   /v1/runs/{run_id}/resume
POST   /v1/runs/{run_id}/fork
POST   /v1/runs/{run_id}/spawn
WS     /v1/events?after_global={sequence}
```

Every mutating request carries:

- `request_id`, generated by the client;
- protocol version;
- actor/client identity;
- target run generation where relevant.

The daemon stores recent request IDs and returns the original result for retries. This makes a control safe when the network drops after the daemon acted but before the client received the acknowledgment.

## 5. Event model

Every event contains:

```text
event_id
run_id
sequence             # monotonically increasing within the run
global_sequence      # monotonically increasing within the daemon
timestamp
kind
provider
provider_event_type
payload              # normalized data
raw_payload           # optional provider-native data
```

Important event kinds:

- `run.created`
- `worktree.creating`
- `worktree.created`
- `worktree.retained`
- `worktree.removed`
- `worktree.failed`
- `run.started`
- `assistant.message.delta`
- `assistant.message.completed`
- `agent.status`
- `tool.started`
- `tool.output`
- `tool.completed`
- `file.changed`
- `approval.requested`
- `input.requested`
- `input.accepted`
- `control.requested`
- `control.acknowledged`
- `run.completed`
- `run.failed`
- `run.interrupted`
- `run.killed`
- `daemon.warning`

The client persists the last applied sequence. On reconnect it requests `after=last_sequence`; applying an already-seen sequence is a no-op.

## 6. Process supervision

### 6.1 Workspace preparation

Workspace preparation occurs before process creation and is provider-independent.

The scheduler recommends `managed_worktree` when another write-capable run is active for the repository. It does not silently change a user's explicit workspace-mode selection.

For `current_checkout`, the daemon validates the registered project path and records repository state without changing it.

For `existing_worktree`, the daemon resolves the supplied path, verifies it belongs to the expected repository, checks that an incompatible active run does not own it, and records it as user-owned.

For `managed_worktree`, the daemon:

1. resolves the repository common directory and selected base ref;
2. generates or validates a branch name;
3. reserves a unique worktree ID and path in the database;
4. selects a host-local path under `~/.local/share/codesk/worktrees/<project-id>/<worktree-id>` by default;
5. invokes Git directly with argument arrays rather than an interpolated shell command;
6. runs `git worktree add` and creates the branch when requested;
7. validates the resulting repository and worktree identity;
8. records ownership, branch, HEAD, base ref, path, and creation event;
9. supplies the absolute worktree path to the provider adapter as the run working directory.

Failure records `worktree.failed`, fails the run before agent spawn, and rolls back only resources Codesk created in that attempt.

Cleanup is an explicit lifecycle action. Completed runs retain managed worktrees by default for review. Removal checks active users and uncommitted changes, then uses `git worktree remove`; forced removal requires confirmation. User-owned worktrees are never automatically removed.

### 6.2 Start

- Validate project path and adapter availability on the execution host.
- Complete workspace/worktree preparation and use its resolved path.
- Resolve the command without invoking a shell when possible.
- Set the project directory.
- Create a new session/process group.
- Attach stdout/stderr pipes or a pseudo-terminal if required by the adapter.
- Persist the run and intended command before spawning.
- Persist PID, process-group ID, and start fingerprint immediately after spawning.
- Begin journal append and stream publication.

### 6.3 Interrupt

The control sequence is:

1. If the adapter has provider-native cancellation, call it.
2. Otherwise send `SIGINT` to the process group, equivalent to Ctrl-C.
3. Mark the run `interrupting` and wait for a configurable grace period.
4. If still alive, let the user or policy escalate to `SIGTERM`.
5. If still alive after the terminate grace period, allow confirmed `SIGKILL`.

Signals target the process group, not only the top-level CLI process.

### 6.4 Daemon restart

The daemon reads running records and validates process identity using PID plus a start-time fingerprint. If the supervised process is alive, it marks it attached or partially attached according to what streams can be recovered. If it cannot prove identity, it marks the run `orphaned` and never signals that PID automatically.

For robust output recovery across daemon restart, the launch shim writes stdout/stderr to daemon-owned journal files in addition to streaming them. The restarted daemon resumes from file offsets.

### 6.5 Local process lifetime is owned by the app

Everything Codesk starts on the user's own machine — the gateway and the local `codeskd` — dies with the desktop app. There is no LaunchAgent and no background service. The app is the only reason a local daemon exists, so when the app is gone the daemon is garbage.

Ownership is a PID chain, established at spawn and verified continuously:

```text
Codesk.app (owner)
  └── codesk-gateway   CODESK_OWNER_PID = app pid
        └── codeskd     CODESK_OWNER_PID = gateway pid
```

- Each spawned process receives `CODESK_OWNER_PID` and polls that PID once per second with a signal-0 liveness probe. This costs one syscall per second and spawns nothing. When the owner is gone, the process shuts itself down.
- When the app finds a gateway already listening on 4242 it does not spawn a second one; it registers itself as an owner with `POST /api/owners`. The gateway tracks a set of owner PIDs and exits when the set becomes empty, so the last window to close takes the daemon down and a second app instance never orphans the first one's daemon.
- On a graceful quit the app calls `POST /api/shutdown` from its Tauri exit hook, so teardown is immediate instead of waiting up to a second for the watchdog. The request carries the app's PID and only releases that one ownership; a PID that does not own this gateway is ignored entirely, so quitting a packaged app next to a hand-started `npm run dev` never stops the developer's server. The watchdog exists for the cases a hook cannot cover: `SIGKILL`, force-quit, and panics.
- The gateway's local-daemon respawn timer is suppressed once shutdown begins. Without this, tearing down `codeskd` would simply resurrect it 1.5 s later.
- Shutdown covers every child the gateway owns, including SSH tunnels for remote hosts, so no `ssh -N` process is left holding a forwarded port.
- **Unowned mode is preserved.** With no `CODESK_OWNER_PID` in the environment, no watchdog starts and the process runs until signalled. This is what `npm run dev`, `npm start`, and the test suite rely on, and it is how a remote `codeskd` under systemd runs.

This is scoped to local processes only. A remote `codeskd` is a service on the VPS with its own lifecycle, and per REQUIREMENTS.md §3.2 remote runs must not depend on a process owned by the desktop application.

Killing the local daemon is safe because it is not where the work lives. Runs execute in their own detached process groups, output is journaled to disk, and stream offsets are committed to SQLite, so the next launch reattaches live runs and replays their output by the mechanism in §6.4. Users resume where they left off.

## 7. Persistence

Per execution host:

```text
~/.local/share/codesk/
├── codesk.db                 # SQLite metadata and idempotency records
├── worktrees/<project-id>/<worktree-id>/
├── runs/<run-id>/
│   ├── stdout.log
│   ├── stderr.log
│   ├── events.jsonl          # optional append journal / recovery source
│   └── artifacts/
└── daemon.log
```

SQLite uses WAL mode. Metadata transitions and final state are transactional. Large raw output remains outside SQLite, while indexed event metadata can live in SQLite. Retention policies prune completed runs and rotate output without touching active runs.

The desktop client stores only:

- known-host definitions;
- project presentation cache;
- connection preferences;
- last event cursors;
- notification deduplication IDs;
- non-secret UI preferences.

## 8. Reconnection state machine

```text
disconnected
    │ user opens host / scheduled retry
    ▼
resolving SSH alias
    ▼
opening tunnel ───────────────┐
    ▼                        │ failure
authenticating protocol      │
    ▼                        │
synchronizing snapshot       │
    ▼                        │
replaying missing events     │
    ▼                        │
online ── connection lost ───┘
```

Retry policy:

- immediate retry for an unexpected established-connection loss;
- exponential delay, for example 1, 2, 4, 8, 15, 30, 60 seconds;
- random jitter to avoid synchronized retries;
- reset backoff after a stable online period;
- an immediate manual retry button;
- listen to OS network-change events to retry immediately after interface or route changes.

During all disconnected states, the UI retains the daemon's last known run state and labels the connection stale. It never changes `running` to `failed` solely because transport is unavailable.

## 9. Provider approach for the MVP

### Codex

- Codesk-managed Codex chats use an isolated execution-host tmux socket for single-writer terminal input and the native Codex transcript for display. The `codex app-server` durable runner remains available under `CODESK_RUN_TRANSPORT=structured` for protocol regression tests.
- The runner performs the JSON-RPC initialization handshake, creates/resumes/forks the thread, and keeps the app-server alive while the thread is idle so later turns do not require a new process.
- `turn/steer`, `turn/interrupt`, approval responses, and request-user-input responses stay on the execution host and travel through the run's Unix control socket.
- Codesk keeps queued prompts in the durable execution-host runner because the installed stable app-server schema does not expose `thread/queue/*`. A normally completed turn starts the next prompt automatically; interruption pauses the queue until the user starts or removes it.
- Esc-Esc-style prompt editing uses the stable `thread/fork.lastTurnId` boundary. Codesk forks through the turn immediately before the selected prompt, or starts a fresh thread when editing the first prompt. Conversation history branches, but existing workspace file changes are not reverted automatically.
- Raw app-server messages and normalized turn/item events are persisted in the same sequenced journal used for SSH reconnect and daemon recovery.

### Pi

- Prefer Pi RPC mode for live input and typed control.
- Use JSON print mode only as a non-interactive fallback.
- Persist Pi session IDs and session paths only on the execution host.

### Claude Code

- Prefer `--input-format stream-json` plus `--output-format stream-json` for bidirectional sessions where supported.
- Retain Claude session IDs for resume/fork.
- Use process-group `SIGINT` for CLI-equivalent interruption unless a stronger protocol-native operation is available.

### Generic adapter

- Configurable executable and arguments.
- Optional JSONL parser mapping.
- Raw stdout/stderr streaming.
- Process-group interrupt/terminate/kill.
- No live-input or resume claims unless configured and tested.

## 10. Deployment and service management

Local macOS daemon: owned by the desktop app, not a LaunchAgent. A LaunchAgent (or any other autostart mechanism) is deliberately rejected for the local daemon, because it outlives the app and leaves a polling daemon burning CPU on a machine whose user has closed Codesk. See §6.5.

Remote Linux daemon: systemd user service where available, with a documented foreground fallback.

Remote bootstrap flow:

1. Resolve and verify the SSH alias.
2. Inspect OS/architecture and existing daemon version.
3. Show the planned install or upgrade action.
4. Upload or download a signed/versioned daemon binary.
5. Install the user service and bind only to a protected local endpoint.
6. Start the service.
7. Open the tunnel and perform protocol/version negotiation.

The daemon upgrade must not kill active agent runs. If a restart is required, it uses the recovery behavior described above.

## 11. Implementation phases

### Phase 1: execution correctness

- Rust `codeskd` scaffold.
- SQLite run/project model.
- Managed worktree creation, retention, and safe cleanup.
- Local Unix-socket client connection.
- Process-group supervision.
- Generic adapter plus one first-class provider.
- Durable event sequence and replay.
- Interrupt/terminate/kill.

### Phase 2: remote correctness

- SSH bootstrap and tunnel manager.
- Remote project registration.
- Network-change reconnection.
- Remote survival and replay tests.
- Daemon service installation.

### Phase 3: provider completeness

- Codex, Pi, and Claude Code adapters.
- Capability negotiation.
- Live steering where genuinely supported.
- Resume, fork, approvals, and usage data.

### Phase 4: desktop product

- Tauri packaging.
- Final dashboard/run timeline.
- Native notifications and deep links.
- Search, filters, settings, retention controls, and updater.

## 12. Architecture decision summary

The essential decision is that Codesk is a distributed supervisor, not an SSH terminal wrapper. A remote project is executed and supervised on its VPS. The desktop application can disappear at any time without changing the execution state. Reconnection restores the view by querying durable daemon state and replaying sequenced events. All steering and interrupt actions travel back to the daemon that owns the real process.

That independence is a statement about *remote* execution hosts. On the user's own machine the opposite rule applies: the gateway and local `codeskd` are owned by the app and exit with it (§6.5). Durability there comes from detached run process groups and on-disk journals, not from a daemon that outlives the window — so quitting Codesk leaves nothing running, and reopening it reattaches the work.
