# Tmux control architecture and regression checks

Codesk uses tmux as the single-writer transport for interactive harness sessions. Conversation rendering still comes from each provider's transcript parser; tmux is used only for lifecycle and terminal input.

## Behavior contract

- New interactive Codex, Claude, Kiro, Pi, OpenCode, DSH, and Antigravity runs start in a Codesk-owned tmux server.
- Codesk-owned panes use the isolated socket at `$CODESK_DATA_DIR/tmux/codesk.sock`.
- Existing processes already running in a user tmux server are detected from their TTY. They remain user-owned until **Enable control** is clicked.
- Existing non-tmux terminal sessions expose **Move to tmux**. Codesk waits for transcript state to become idle, sends `SIGTERM` to the idle provider process group, and resumes the same native session in a Codesk-owned pane.
- Conversion preserves provider options from the original command. In particular, Codex `--yolo` is retained.
- Enter sends **Steer** immediately. Tab submits the current draft to **Queue**. Shift+Enter inserts a newline.
- Queue items are persisted in SQLite and delivered in order after the transcript changes from active to idle. They survive daemon and SSH reconnects.
- When a newly launched Linux harness does not keep its transcript file descriptor open, Codesk recovers the native session from the provider's project index using the managed run title and start time. Ambiguous matches are left pending instead of attaching the wrong conversation.
- Prompt injection uses a named tmux buffer, bracketed `paste-buffer`, and a separate `send-keys Enter`; prompts are never interpolated into a shell command.
- The UI displays the tmux session name and the exact access command. For SSH hosts, the gateway wraps it as `ssh -t <alias> '<remote tmux command>'`.

## Automated checks

Run:

```sh
cargo test -p codeskd
pnpm run check
pnpm run build
pnpm test
```

The Rust suite covers:

- pane parsing and TTY normalization;
- provider-process ancestry deduplication;
- rejection of headless provider transports from interactive discovery;
- Codex flag preservation during conversion;
- local attach-command quoting;
- multiline and Unicode shell quoting;
- durable, ordered queue recovery after reopening SQLite.

## Local live test

Use a disposable project and session. Do not reuse a user's existing tmux panes.

1. Start a normal terminal session:

   ```sh
   cd /tmp/codesk-tmux-live
   codex --yolo
   ```

2. Send a small request and wait until the response is complete.
3. Refresh the project in Codesk and open that conversation.
4. Confirm the compact **Terminal session** notice appears and click **Move to tmux**.
5. Verify the original terminal process exits only after the turn is idle.
6. Verify Environment shows:
   - a name shaped like `codesk-codex-xxxxxxxx`;
   - `tmux -S <data-dir>/tmux/codesk.sock attach-session -t <name>`.
7. Type a small prompt and press Enter. Confirm it appears immediately in the same native conversation.
8. While that turn is active, type another prompt and press Tab. Confirm it appears as queued and is delivered only after the active turn completes.
9. Confirm the resumed command still contains `--yolo`:

   ```sh
   tmux -S "$CODESK_DATA_DIR/tmux/codesk.sock" list-panes -a -F '#{pane_start_command}'
   ```

10. Restart `codeskd`, reconnect Codesk, and verify control plus any queued item remains available.

## Existing user tmux test

1. Start a disposable provider session in the default tmux server.
2. Refresh its project in Codesk.
3. Confirm Codesk displays the detected tmux name and `tmux attach-session -t <name>`.
4. Click **Enable control**.
5. Verify Enter steers and Tab queues without changing or killing the user's tmux session.
6. Disable control through the daemon endpoint if testing the backend directly; confirm the pane remains alive and only Codesk metadata is removed.

## SSH live test

Repeat the local test on a disposable remote folder. The daemon on the remote host performs discovery, queue gating, and tmux input; the desktop gateway only proxies HTTP and formats the access command.

Expected Environment values:

- the same remote tmux name reported by `tmux list-sessions` on the server;
- an access command shaped like:

  ```sh
  ssh -t vps-1 'tmux -S <remote-data-dir>/tmux/codesk.sock attach-session -t <name>'
  ```

After queuing a prompt, restart the SSH tunnel or desktop gateway. The queued row must remain in the remote daemon's SQLite database and deliver after the active remote turn completes.

For a new remote Codex run, also verify that `/v1/runs/{id}` changes from `running` to `waiting_for_input`, gains `provider_session_id`, and keeps `input_transport: "tmux"`. This covers Linux installations where Codex closes the rollout file between writes.

## Failure checks

- Copy mode: input must fail with a clear request to leave tmux copy mode.
- Dead pane: control becomes `dead`; Codesk must not start a second writer automatically.
- Missing transcript: Queue remains pending rather than guessing that a turn is idle.
- Failed idle conversion: Codesk records an error and does not escalate from `SIGTERM` to `SIGKILL` automatically.
- Multiple provider descendants on one TTY: only the root interactive process appears as a session; descendant transcript/session metadata is propagated to it.
