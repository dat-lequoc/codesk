# Codesk Product Requirements

Status: authoritative baseline for the MVP  
Date: 2026-08-13

## 1. Product definition

Codesk is a local desktop control plane for coding-agent runs. It gives one place to start, observe, steer, interrupt, resume, and receive notifications for agents such as Codex, Pi, Claude Code, and future command-line agents.

Codesk is not the execution environment for a remote project. Execution follows the project:

- A project on this computer runs on this computer.
- A project on a VPS runs entirely on that VPS.
- The desktop application is a viewer and controller for remote work.
- Losing the desktop application, changing Wi-Fi, sleeping the laptop, or losing SSH must not stop a remote run.

This separation is a core invariant, not an implementation detail.

## 2. Primary use cases

1. Start a Codex, Pi, or Claude Code run in a local project.
2. Start the same kind of run in a project on a VPS.
3. Watch structured events and raw output while the run is active.
4. Close the desktop application and later reconnect without losing the run or its history.
5. Move between networks and automatically regain the live stream.
6. Send a follow-up or steering message to a compatible active session.
7. Interrupt or stop a run with semantics equivalent to using the agent's CLI.
8. Spawn another run or child agent associated with an existing run.
9. Receive a desktop notification when a run completes, fails, blocks, or needs input.
10. Inspect past runs, their prompts, commands, events, duration, exit state, host, project, and provider session identifiers.
11. Start parallel runs in isolated Git worktrees without asking each agent to implement the isolation itself.
12. Open multiple empty chats in a project, switch between them without losing composer state, and create the execution-host run only when the first prompt is submitted.

## 3. Must-have requirements

### 3.1 Projects and execution location

- A project has a stable identity, display name, absolute path, execution host, and optional Git metadata.
- A project belongs to exactly one execution host at a time.
- Starting a run must always execute inside the selected project's execution host and project directory.
- Remote commands, agent CLIs, tools, hooks, MCP servers, Git commands, child processes, credentials, and project files must remain on the remote host.
- The client must visibly show the execution host and working directory before a run starts.
- The system must never silently fall back from a remote host to local execution.
- Local and remote projects use the same control API and user experience.

### 3.2 Execution-host daemon

- Every execution host runs a small Codesk daemon called `codeskd`.
- For a local project, the desktop client may start and manage the local daemon automatically.
- For a remote project, `codeskd` runs on the VPS and owns all remote runs.
- The daemon must continue running independently of the desktop client.
- The daemon must supervise process groups, persist run metadata, append durable event logs, and expose a versioned control protocol.
- The daemon must recover its run inventory after it restarts.
- Where possible, the daemon must determine whether previously supervised processes are still alive and reattach their status.
- Remote runs must not depend on a long-lived SSH terminal or a process owned by the desktop application.

### 3.3 Git worktrees

- Worktree management is a Codesk platform capability, independent of the selected agent provider.
- Each Git-backed run offers three workspace modes: **current checkout**, **new managed worktree**, or **existing worktree/path**.
- The recommended default is **new managed worktree** for a write-capable run when another run is active for the same repository. For a single run, the project may remember the user's preferred mode.
- The selected mode and exact working directory must be shown before the run starts.
- For a remote project, the execution-host daemon creates and manages the worktree on the remote host. The desktop client must not create a corresponding local worktree.
- A managed worktree must exist before the agent process starts; Codesk passes its absolute path as the agent's working directory.
- Codesk supports an automatically generated or explicitly supplied branch name and a selected base branch, ref, or commit.
- Multiple parallel runs must not receive the same managed worktree.
- The run record retains worktree path, branch, base ref, creation status, ownership, and cleanup status.
- Worktree creation failure fails the run before the agent starts and exposes the Git error.
- A dirty checkout must not be silently moved, cleaned, reset, or reused.
- Managed worktrees must not be deleted while an active run or registered process uses them.
- After completion, the user can keep the worktree, inspect its diff, open it, or remove it.
- Removal uses Git-aware cleanup and requires confirmation when uncommitted changes exist.
- Codesk distinguishes managed worktrees from discovered/user-owned worktrees and never automatically deletes user-owned worktrees.
- Worktree lifecycle operations are recorded as run events.
- Prompting an agent to create a worktree is allowed, but it is not a substitute for Codesk-managed isolation.

### 3.4 Agent providers

The MVP must provide first-class adapters for:

- Codex CLI
- Pi
- Claude Code
- Generic command-line agents through a configurable adapter

Each adapter must define:

- installation and version detection;
- command construction;
- supported permission/sandbox modes;
- structured streaming format when the CLI provides one;
- parsing into a normalized event model;
- extraction and persistence of the provider session ID;
- steering/follow-up behavior;
- resume/fork behavior;
- graceful interrupt behavior;
- hard-stop behavior;
- known provider limitations.

Provider-specific data must be retained alongside normalized events so that Codesk does not discard useful information.

### 3.5 Run lifecycle

Before a provider run exists, the desktop client may own a lightweight draft session:

- Clicking **New chat** creates a distinct draft row immediately under the selected project.
- Multiple empty drafts in one project remain independently selectable and are titled `New chat`.
- Draft prompt text, provider, workspace mode, host, and project persist across client/gateway restarts.
- A draft does not start a local or remote process, allocate a provider session ID, or mutate the project.
- On the first submitted prompt, the gateway starts the run on the project's execution host and removes the draft only after the daemon accepts the run.
- If the host is offline or run creation fails, the draft and its composer state remain intact.
- Drafts from another desktop application's unpublished renderer state are not execution-host sessions and are not assumed discoverable through SSH, provider databases, or process inspection.

A run has at least these states:

- `queued`
- `starting`
- `running`
- `waiting_for_input`
- `interrupting`
- `reconnecting` (client connection state, not execution state)
- `completed`
- `failed`
- `interrupted`
- `killed`
- `orphaned`

The daemon is authoritative for execution state. The client may independently show that its connection is offline or reconnecting.

Each run must persist:

- run ID and optional parent run ID;
- provider and provider session ID;
- project and host IDs;
- prompt and follow-up messages;
- exact executable, arguments, relevant adapter settings, and working directory;
- workspace mode, repository root, worktree path, branch, and base ref when applicable;
- environment-variable names supplied to the run, but never secret values;
- creation, start, update, and finish timestamps;
- process and process-group identifiers where applicable;
- normalized events and raw provider events;
- stdout and stderr, with rotation or retention limits;
- exit code, terminating signal, and final state;
- model, permission mode, and resource/cost data when exposed by the provider.

### 3.6 Streaming

- The daemon must stream events as they are produced.
- The stream must be resumable after disconnection.
- Every event must have a monotonically increasing per-run sequence number.
- The client reconnects with the last acknowledged sequence number and receives only missing events.
- Events must also be queryable from durable history.
- The UI must distinguish assistant text, reasoning/status, tool calls, tool output, file changes, approvals/input requests, stderr, system events, and lifecycle changes where the provider exposes them.
- Raw terminal output must remain available when structured parsing is incomplete.
- Backpressure and large-output limits must be defined so one noisy run cannot stall the daemon or client.

### 3.7 Steering and input

- The client must be able to send a message to a provider session when that provider supports live input.
- Input is delivered to the execution-host daemon, then to the actual provider process or provider session on that host.
- Input delivery must have an ID and acknowledgment so the client can distinguish accepted, rejected, and unknown delivery.
- If a provider cannot accept live input in its current mode, Codesk must make that clear and offer a provider-supported follow-up, resume, or fork operation instead.
- Approval and question events must be represented as typed requests with typed responses when the provider protocol supports them.
- The MVP must not claim interactive steering for a provider unless the adapter can deliver it reliably.

### 3.8 Interrupt and stop

Codesk must expose distinct controls:

- **Interrupt:** equivalent to the provider CLI's normal user interrupt, generally `SIGINT`/Ctrl-C or a provider protocol operation. This lets the agent clean up and persist its session.
- **Terminate:** request graceful process termination, generally `SIGTERM`, after an interrupt timeout or when chosen explicitly.
- **Kill:** forcefully stop the full process group, generally `SIGKILL`, only after confirmation.

Requirements:

- Signals must be sent by `codeskd` on the execution host, never by guessing a remote PID from the client.
- The whole supervised process group must be targeted so child commands do not remain behind.
- The run history must record who requested the action, which action was sent, when it was sent, and the resulting exit state.
- Interrupt must be idempotent.
- The UI must show `interrupting` while waiting for exit and permit escalation to terminate or kill.
- Provider protocol-native cancellation is preferred when it is more reliable than Unix signals.

### 3.9 Spawn, resume, and fork

- A user can start an independent run in a project.
- A user can spawn a child run associated with a parent run.
- A user can resume or fork a provider session when supported.
- Parent/child relationships must be persisted and displayed.
- Spawned work runs on the same execution host as its project unless the user explicitly selects another project/host.
- No child agent may accidentally execute on the desktop client for a remote project.
- A child run may reuse its parent's worktree only through an explicit choice. The safe default for concurrent write-capable work is a new managed worktree.

### 3.10 Hosts and automatic reconnection

- Hosts may be local or remote.
- A remote host has a stable host ID independent of its current IP address.
- Initial remote bootstrap may use an OpenSSH alias from `~/.ssh/config`.
- Changing Wi-Fi must not require recreating the host or project.
- The client must automatically reconnect with bounded exponential backoff and jitter.
- Network state and run state must be shown separately. A disconnected client does not imply a stopped run.
- After reconnecting, the client refreshes host state, active runs, pending input requests, and events after the last acknowledged sequence.
- Reconnection must tolerate changed DNS/IP, VPN transitions, and temporary route failures as long as the configured SSH alias or secure endpoint becomes reachable again.
- The user can request an immediate reconnect.
- A remote daemon must support a stable direct transport in addition to SSH tunneling in a later phase; the MVP may use an automatically recreated SSH tunnel.

### 3.11 Notifications

- Notify on completion, failure, interruption, required approval/input, remote-host loss, and successful reconnection.
- Notifications must identify project, provider, run, host, and event type.
- Clicking a notification should open the relevant run when desktop packaging is present.
- Notification preferences must be configurable globally and per project.
- Duplicate notifications must be suppressed across reconnects and client restarts.

### 3.12 History and observability

- Runs remain browsable after completion and after client or daemon restarts.
- The UI must filter by status, project, host, provider, parent run, and date.
- Run detail must show a live timeline and a raw-output view.
- The daemon must expose its own health, version, uptime, disk usage, active run count, and adapter availability.
- Operational logs must not contain secret values or raw authentication tokens.

### 3.13 Security

- `codeskd` must not expose an unauthenticated public listener.
- The MVP remote transport should bind the daemon to loopback or a Unix socket and reach it through authenticated SSH forwarding.
- Host authenticity follows OpenSSH host-key verification; Codesk must not automatically disable it.
- Authentication and authorization must be explicit and revocable.
- The client must not copy remote credentials, provider tokens, SSH keys, or project secrets to the local Codesk database.
- Secrets remain in the execution host's environment or secret store.
- Control requests must be authenticated and protected from replay where the transport does not already provide that property.
- Destructive actions such as force-kill and deleting history require confirmation.
- Audit events must record control actions without storing secret content.

### 3.14 Compatibility and installation

- macOS is the first desktop-client target.
- The execution daemon should support macOS and Linux in the MVP.
- The daemon must have a simple install, version check, upgrade, and uninstall path.
- Codesk must detect missing or incompatible provider CLIs per host.
- The client and daemon negotiate protocol versions and provide an actionable incompatibility message.
- Remote installation must be reviewable; Codesk must show the command before installing or upgrading a daemon.

## 4. User-interface requirements

The visual references establish the desired shape of the application:

- persistent left navigation for projects, hosts, and recent runs;
- prominent host, project, branch, provider, model, and permission context;
- a dense but readable run timeline;
- explicit online/offline/reconnecting state;
- one-click start, steer, interrupt, resume/fork, and inspect controls;
- desktop notifications and unread indicators;
- dark desktop-first interface;
- no ambiguity about whether execution is local or remote.

The UI must never imply that a remote run died merely because the client stream disconnected.

## 5. Non-functional requirements

- Remote run survival: a running remote agent continues through client exit and network loss.
- Event durability: acknowledged events survive daemon restart within configured retention.
- Reconnect correctness: no missing or duplicated displayed events after resuming by sequence number.
- Responsiveness: newly received events should normally appear within 250 ms on a healthy connection.
- Isolation: one failed or noisy run must not crash the daemon or block other streams.
- Resource limits: configurable maximum concurrent runs, log size, history age, and per-run output rate.
- Data integrity: metadata updates are atomic; event logs are append-only or transactionally persisted.
- Portability: the provider layer must not be coupled to the UI or transport.
- Testability: lifecycle, reconnection, event replay, and signal escalation must be integration tested.

## 6. Explicit architecture choices

### Chosen

- A thin desktop client plus an execution-host daemon.
- Execution follows the project host.
- One daemon per host, supervising multiple projects and runs.
- Daemon-managed Git worktrees for provider-independent parallel isolation.
- A versioned, provider-neutral control protocol.
- A durable event journal with sequence-based replay.
- Provider adapters behind a common interface.
- Process-group supervision for correct interrupt/terminate/kill behavior.
- SSH for secure discovery, bootstrap, and MVP tunneling to remote daemons.
- Automatic tunnel recreation and event replay after network changes.
- A local embedded database on each execution host for run metadata, plus append-friendly event/output storage.
- Local OS notifications from the desktop client, deduplicated by event ID.

### Rejected

- Running remote-project agents as children of a desktop-owned SSH command. They would be fragile across client exit and connectivity changes.
- Copying a remote project to the desktop to run its agent locally. This violates execution locality and changes tools, credentials, and filesystem semantics.
- Treating raw SSH stdout as the authoritative run database. It is not durable or resumable enough.
- Using only PID files without a daemon. PID reuse and lost process ancestry make control unsafe.
- Assuming every provider supports live steering. Capabilities must be adapter-declared and enforced.
- Relying on prompts to create worktrees. Isolation must be established before the agent starts and owned by the supervisor.
- Exposing the daemon directly to the public internet by default.

## 7. MVP acceptance criteria

The MVP is complete only when all of the following are demonstrated:

1. Add a Linux VPS using an SSH config alias.
2. Install or connect to `codeskd` on that VPS.
3. Register a remote project path.
4. Start at least one real Codex, Pi, or Claude Code run in that path.
5. Prove from process metadata and working directory that execution occurs on the VPS.
6. Stream structured or raw output to the desktop client.
7. Disconnect the client or network while the run continues.
8. Reconnect and replay all events without gaps or duplicates.
9. Interrupt the remote agent from the client with CLI-equivalent graceful behavior.
10. Escalate to terminate/kill when graceful interrupt does not finish.
11. Start a follow-up/resume/fork where supported and clearly report when unsupported.
12. Receive a deduplicated completion or input-required notification.
13. Restart both client and daemon and retain completed-run history.
14. Start two write-capable runs from the same repository in separate managed worktrees and prove their directories and branches are isolated.
15. Retain a finished run's worktree for review, then safely remove it through Codesk.

## 8. Later, not required for the first MVP

- Mobile client and internet relay service.
- Team/shared multi-user control plane.
- Browser-based public access.
- Windows execution hosts.
- Cloud-hosted history synchronization.
- Provider billing aggregation when the provider does not expose usage.
- Full terminal emulation for arbitrary interactive TUIs.
- Automatic cross-host project or Git-state handoff.
