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

- [ ] **Attachments the harness cannot read as text.** Text files are inlined
      into the prompt today; images, PDFs, and archives are accepted and then
      marked "only text files can be sent" (`src/lib/attachments.ts`). Sending
      them needs an upload path to the execution host plus a per-harness
      encoding.
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
- [ ] **Announce a finished turn on a protocol run too.** A finished turn now
      raises a mark and a notification for every conversation whose transcript
      Codesk watches, which is every tmux-driven run and every agent started
      outside Codesk. A run on a protocol transport publishes `turn.completed`
      instead, and nothing listens: `notificationEventKinds`
      (`src/lib/events.ts`) covers only terminal run statuses, approvals, and
      input requests. Needs the "are they watching it right now" suppression the
      transcript watcher already applies.
- [ ] **Live tests that do not need a human.** Several live probes require a
      logged-in harness and real credits, so they cannot run in CI. A
      recorded-protocol tier would let the same assertions run on every commit.
      `scripts/test-turn-completion.mjs` is the shape to copy: it drives the real
      daemon against synthetic transcripts in a throwaway `HOME`.

## Later

- [ ] Mobile client and an internet relay, so a phone can watch a run.
- [ ] Team or shared multi-user control plane, which changes the trust model in
      `SECURITY.md` from one POSIX user to many.
- [ ] Cloud history synchronization across machines.
- [ ] Automatic cross-host project and Git-state handoff.

## Not planned

- Full terminal emulation for arbitrary interactive TUIs. Codesk drives a
  harness through one stable writer and renders the harness's own transcript;
  becoming a general terminal would trade that guarantee away.
- Provider billing aggregation for harnesses that do not report usage. Codesk
  reports what a provider tells it and does not estimate.

## Recently shipped

- [x] A finished turn announces itself for every harness. Claude Code, Pi, Kiro,
      and OpenCode write no end-of-turn record, so their conversations looked
      like one turn that never ended: nothing raised a mark or a notification,
      and the transcript watcher polled them at its active-turn rate forever.
      Each parser now derives the boundary from the harness's own format, with
      the duration where the harness records one. OpenCode also reports a live
      turn for the first time, and a failed Pi turn no longer sits at "running"
      until its process is killed.
- [x] Session lists that answer in milliseconds. A project with no Codex history
      fell through to a scan of every rollout on disk — nine seconds per call, on
      every poll — which left every harness's running state too stale to see. The
      Codex state database is now trusted when it returns nothing, as it already
      was when it returned rows.
- [x] Browser access to a hosted gateway: `CODESK_WEB_MODE` serves the UI from
      the gateway itself, bound to loopback behind a `tailscale serve` front
      door, with origin rules that survive DNS rebinding.
- [x] Attachments in the composer: text files are read in the browser and inlined
      into the prompt, from every composer, by drop, paste, or the `+` button.
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
