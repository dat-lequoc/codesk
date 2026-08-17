# Codesk

> Open-source control plane for coding agents, local or remote.

Codesk is a desktop app for running, monitoring, inspecting, and steering coding-agent harnesses from one place. The agent stays on the machine where the project lives—your laptop, workstation, or VPS—and Codesk connects locally or over SSH.

<p align="center">
  <img src="./docs/for_readme.png" alt="Codesk showing a live agent trajectory and tool inspector" width="1200">
</p>

## Platform support

<details open>
<summary><strong>macOS — desktop app</strong></summary>

Build and run the desktop app from source:

```bash
git clone https://github.com/dat-lequoc/codesk.git
cd codesk
npm install
npm run desktop:build -- --debug --bundles app
open target/debug/bundle/macos/Codesk.app
```

</details>

<details>
<summary><strong>Linux — execution host</strong></summary>

Linux is supported as a local or remote execution host. Build and install the daemon as a user service:

```bash
git clone https://github.com/dat-lequoc/codesk.git
cd codesk
cargo build --release -p codeskd
./target/release/codeskd install 4243
```

The desktop client connects to the daemon over SSH. A Linux desktop bundle is not published yet.

</details>

<details>
<summary><strong>Windows</strong></summary>

Windows desktop and execution-host packaging are not supported yet. Codesk currently relies on macOS/Linux service and process-management primitives.

</details>

## Supported harnesses

Codesk brings **Codex, Claude Code, OpenCode, Kiro CLI, Pi, Antigravity, DeepSeek Harness**, and generic command-line agents into one interface.

Codex has first-class support through its app server: persistent sessions, live steering, queued turns, approvals and input requests, interruption, resume, fork, and conversation backtracking.

## What you can do

- **Monitor every harness in one place.** Follow running, idle, and historical sessions without switching terminals.
- **View agent trajectories.** Inspect reasoning, commands, tool calls, file changes, results, usage, and raw provider events in chronological order.
- **Interact while agents work.** Start or resume sessions, steer an active turn, queue the next instruction, respond to requests, and interrupt or terminate runs.
- **Work over SSH.** Remote projects execute on their own host through `codeskd`; Codesk connects through an automatically recreated SSH tunnel, so tools and files stay close to the project.
- **Keep work isolated.** Run in the current checkout or use managed Git worktrees that can be inspected and cleaned up from the app.

The core rule is simple: **execution follows the project**. Codesk is the viewer and controller; the agent runs where the code lives.

## Status

The desktop client is currently developed and tested on macOS. Execution hosts can be macOS or Linux, including remote hosts reached through SSH.

## Development

```bash
npm install
cargo build -p codeskd
npm run dev
```

Run the test suite:

```bash
npm test
```

To rebuild, safely replace, and relaunch the locally installed app:

```bash
npm run desktop:redeploy
```

## Remote daemon

On a built macOS or Linux execution host:

```bash
codeskd install 4243
```

The daemon binds to loopback and is reached through SSH forwarding.

## More

- [Architecture](./ARCHITECTURE.md)
- [Requirements](./REQUIREMENTS.md)
- [Roadmap](./docs/roadmap.md)
- [Performance benchmark](./docs/performance-benchmark.md)
- [Contributing](./CONTRIBUTING.md)
- [Security policy](./SECURITY.md)
- [License](./LICENSE)
