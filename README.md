# Codesk

Codesk is one desktop app for monitoring and controlling coding-agent harnesses across local and remote machines.

<p align="center">
  <a href="https://github.com/dat-lequoc/codesk/blob/main/docs/for_readme.png?raw=1" title="Open the full-size Codesk screenshot">
    <img src="./docs/for_readme.png" alt="Codesk showing a live agent trajectory and tool inspector" width="1200">
  </a>
</p>

## Supported harnesses

Codesk brings **Codex, Claude Code, Kiro CLI, Pi, Antigravity, DeepSeek Harness**, and generic command-line agents into one interface.

Codex has first-class support through its app server: persistent sessions, live steering, queued turns, approvals and input requests, interruption, resume, fork, and conversation backtracking.

## What you can do

- **Monitor every harness in one place.** Follow running, idle, and historical sessions without switching terminals.
- **View agent trajectories.** Inspect reasoning, commands, tool calls, file changes, results, usage, and raw provider events in chronological order.
- **Interact while agents work.** Start or resume sessions, steer an active turn, queue the next instruction, respond to requests, and interrupt or terminate runs.
- **Work over SSH.** Remote projects execute on their own host through `codeskd`; Codesk connects through an automatically recreated SSH tunnel, so tools and files stay close to the project.
- **Keep work isolated.** Run in the current checkout or use managed Git worktrees that can be inspected and cleaned up from the app.

The core rule is simple: **execution follows the project**. Codesk is the viewer and controller; the agent runs where the code lives.

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

Build the macOS app:

```bash
npm run desktop:build -- --debug --bundles app
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
