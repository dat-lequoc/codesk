# Codesk

Codesk is a desktop control plane for local and remote coding agents. It is designed to monitor, stream, notify, steer, spawn, resume, and interrupt Codex, Pi, Claude Code, and other command-line agents.

The core invariant is simple: **execution follows the project**. A project on a VPS is executed and supervised entirely on that VPS; the desktop application is only its viewer and controller.

Start with:

- [Product requirements](./REQUIREMENTS.md)
- [Architecture](./ARCHITECTURE.md)

## Repository status

Codesk now implements the execution-host architecture: the packaged desktop app starts its embedded client gateway and local daemon, while remote projects are owned by `codeskd` on the remote host through an automatically recreated SSH tunnel.

Implemented today:

- durable local and remote runs with sequenced replay;
- Codex, Pi, Claude Code, and generic command adapters;
- Pi live steering plus honest resume/fork fallbacks for supported provider sessions;
- interrupt, terminate, and process-group kill;
- managed worktree creation, inspection, retention, and cleanup;
- SSH alias onboarding and same-OS/architecture daemon bootstrap;
- execution-host folder browsing and recursive Git project discovery;
- durable per-project `New chat` drafts that create no process until the first prompt and reconcile safely into remote runs;
- read-only detection of already-running Codex, Pi, and Claude processes without attaching debuggers or changing them;
- deduplicated desktop notifications and client/network reconnection.

External processes that were not started by Codesk are intentionally shown as observed external agents. Codesk can identify and signal them, but it does not claim access to their historical stdout or interactive protocol unless that provider exposes a safe attach mechanism.

## Target stack

- Tauri 2 + React/TypeScript desktop client
- Rust/Tokio `codeskd` daemon on every execution host
- SQLite metadata plus durable event/output journals
- Unix socket locally
- Automatically recreated SSH tunnel for the remote MVP
- Provider adapters for Codex, Pi, Claude Code, and generic agents

## Development

```bash
npm install
cargo build -p codeskd
npm run dev
```

The Vite UI runs on `http://127.0.0.1:5173`. The client gateway runs on port 4242 and connects to the local daemon on port 4243.

Run the integration suite with:

```bash
npm test
```

The suite verifies daemon restart survival, ordered event replay, interrupt delivery, managed-worktree isolation and cleanup, execution-host folder browsing, recursive project discovery, and non-invasive external-agent inspection.

Build the self-contained macOS app with:

```bash
npm run desktop:build -- --debug --bundles app
```

The resulting bundle is `target/debug/bundle/macos/Codesk.app`; it does not require `npm run dev`.

## Installing the daemon

On a built host:

```bash
codeskd install 4243
```

This installs a systemd user service on Linux or a LaunchAgent on macOS. The daemon binds to loopback; the desktop gateway reaches remote daemons through SSH forwarding.

Remote bootstrap supports a versioned daemon artifact URL. Until release artifacts are published, build `codeskd` for the VPS OS/architecture, copy it to that host, and run the install command above.

Release tags run [.github/workflows/release.yml](./.github/workflows/release.yml) to publish Linux and macOS daemon binaries. Set `CODESK_DAEMON_RELEASE_BASE_URL` for the packaged gateway to automatically select `codeskd-<OS>-<architecture>` during remote bootstrap. A same-OS/architecture desktop build can also upload its embedded daemon directly.
