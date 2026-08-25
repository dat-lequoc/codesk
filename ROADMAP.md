# Codesk Roadmap

The living backlog: what is being built now, what is queued, and what is
deliberately not being built. Each box names the gap it closes rather than a
feature label, and points at the code that has to change.

`docs/roadmap.md` is a different document — the record of how the Kiro CLI,
DeepSeek Harness, and Antigravity integrations were specified and verified.
`REQUIREMENTS.md` holds the product contract this backlog serves.

## Now

### Model and reasoning effort control, beyond a live pane

Codex and Kiro sessions now report the model and reasoning level they are
running and let both be changed from the composer. What is left is every case
without a live pane to read or drive.

- [x] Report model and effort for a dormant Codex session, which has no pane to
      read, from the last `turn_context` record in its rollout. Kiro reads the
      same from `session_state` in its session file.
- [ ] Report model and effort for Claude Code, Pi, DSH, Antigravity, and
      opencode, none of which expose either today.
- [ ] Choose the model and effort when starting a run. `StartScreen` sends no
      model (`src/features/screens/StartScreen.tsx`) and `StartRunRequest` has
      no effort field (`crates/codeskd/src/model.rs`).

## Next

- [ ] **Attachments in the composer.** The `+` button in every composer is
      disabled and titled "Attachments are not supported yet". Needs an upload
      path to the execution host plus a per-harness encoding.
- [ ] **Keep model and effort fresh.** The periodic host refresh calls the
      daemon without `refresh=true` (`server/state-cache.mjs`), so a change made
      outside Codesk can take a full discovery TTL to appear.
- [ ] **Give `RunScreen` the same model source as `SessionScreen`.** The run
      screen still starts from the model the run was requested with and only
      learns about changes the harness announced or the picker applied, rather
      than reading the pane the way the session screen does.
- [ ] **Pull requests, scheduled runs, and plugins.** Three sidebar entries are
      visible but disabled with a "Coming soon" title
      (`src/features/sidebar/Sidebar.tsx`) — advertising work that does not
      exist yet.
- [ ] **Windows execution hosts.** Codesk relies on POSIX process groups,
      signals, and tmux. Windows needs a different supervision strategy, not a
      port of this one.
- [ ] **Deeper Claude Code, Pi, and opencode support.** They run today through
      the generic terminal tier, without the structured tool, approval, and
      usage rendering the other four providers have.
- [ ] **Live tests that do not need a human.** The live probes require a
      logged-in harness and real credits, so they cannot run in CI. A
      recorded-protocol tier would let the same assertions run on every commit.

## Later

- [ ] Mobile client and an internet relay, so a phone can watch a run.
- [ ] Team or shared multi-user control plane, which changes the trust model in
      `SECURITY.md` from one POSIX user to many.
- [ ] Browser-based access to a hosted gateway.
- [ ] Cloud history synchronization across machines.
- [ ] Automatic cross-host project and Git-state handoff.

## Not planned

- Full terminal emulation for arbitrary interactive TUIs. Codesk drives a
  harness through one stable writer and renders the harness's own transcript;
  becoming a general terminal would trade that guarantee away.
- Provider billing aggregation for harnesses that do not report usage. Codesk
  reports what a provider tells it and does not estimate.

## Recently shipped

- [x] Model and reasoning effort in the composer: a session reports what it is
      running and both can be changed, by driving Codex's numbered `/model`
      picker and Kiro's slash commands, with a live script covering each.
- [x] Codex's startup dialogs answered before the opening prompt, so a first run
      in an untrusted directory no longer swallows it.
- [x] Shell-style prompt history: every submitted prompt is recalled with Up and
      Down from any composer, so a prompt the harness swallows is recoverable.
- [x] Token authentication and origin rejection on the daemon and gateway.
- [x] tmux attach commands that work when pasted inside another tmux client.
- [x] Claude Code sessions that are actually steerable from Codesk.
