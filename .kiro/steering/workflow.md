# Codesk workflow

## Nothing local outlives the app

The gateway and the local `codeskd` are owned by the desktop app and must die with
it. Quitting Codesk — including force-quit and crash — must leave no Codesk
process running, no port held, and no CPU burning. Ownership is the PID chain
described in [ARCHITECTURE.md](../../ARCHITECTURE.md) §6.5: each child gets
`CODESK_OWNER_PID` and exits when that PID disappears.

When touching this area:

- Do not add a LaunchAgent, login item, or any other autostart for the local
  daemon. It was deliberately rejected.
- A process spawned for the local host must inherit ownership, or it becomes an
  orphan the next time someone quits the app.
- Suppress respawn logic during shutdown. The local-daemon supervisor restarts
  `codeskd` 1.5s after it exits, which will happily undo a teardown.
- Leave unowned mode alone: with no `CODESK_OWNER_PID`, no watchdog runs. `npm
  run dev`, `npm start`, the test suite, and remote systemd daemons depend on it.
- Remote daemons keep their independence. This rule is local-only.

Durability does not come from a long-lived daemon. Runs are detached process
groups with on-disk journals, so killing the daemon is safe and the next launch
reattaches them.

## Never poll on an unbounded retry

Background workers in `codeskd` must be able to reach their idle cadence. Two
rules, both learned from a daemon that idled at 12% CPU for hours:

- Filter work queues by what is actually actionable, not just by an `enabled`
  flag. Rows for dead resources kept the tmux worker permanently in its 350ms
  fast path because the "nothing to do" branch tested only `enabled`.
- Any recovery that can never succeed needs backoff and a give-up. A control
  stuck with missing metadata forced a full `ps` process scan once per second,
  forever.

Prefer syscall-cheap checks over spawning processes on a timer. Subprocess churn
is what macOS reports as significant energy impact, even at low steady CPU.

## Always redeploy

After any change to this project that affects the desktop app, the gateway, or
`codeskd`, run the redeploy without asking:

```bash
npm run desktop:redeploy
```

The installed `/Applications/Codesk.app` runs a built binary, so source changes
and passing tests are invisible until the app is rebuilt and relaunched. Treat
the redeploy as part of finishing the task, not as a separate decision — do not
ask for permission, and do not stop at "you'll need to redeploy".

## Styling

New frontend work uses Tailwind utilities, not new rules in `src/styles.css`.
Preflight is deliberately off, and Tailwind utilities sit in a cascade layer that
loses to the unlayered rules in that stylesheet, so:

- Migrate an element by deleting its CSS rule, never by stacking utilities on it.
- Never mix a hand-written class and utilities on the same element.
- `border` needs `border-solid` beside it, because without Preflight the default
  border style is `none`.

See [docs/styling-migration.md](../../docs/styling-migration.md) for the phased
plan and the CSS audit command.
