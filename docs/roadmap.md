# Codesk Roadmap

Updated: 2026-08-16

Kiro CLI, DeepSeek Harness, and Antigravity are now implemented as first-class managed providers. The goal remains broader than launching a binary: every provider conversation should have structured display, interaction, commands, durable history, safe interruption, and continuation on the execution host where its project lives.

## Current foundation

Codesk already provides the shared machinery this integration should reuse:

- local and remote execution through `codeskd`;
- provider capability negotiation and supervised process groups;
- durable events, replay, reconnection, and session history;
- normalized assistant, tool, approval, status, and lifecycle presentation;
- live steering and queued follow-up delivery where a provider supports them;
- resume and fork controls with honest provider-specific limitations;
- project-scoped drafts, worktrees, archive/pin controls, and notifications.

The development machine currently has Kiro CLI 2.10.0. Its public command surface includes:

- `kiro-cli chat [INPUT]` for interactive or non-interactive chat;
- `kiro-cli acp` for Agent Client Protocol integration;
- `--resume` and `--resume-id <SESSION_ID>`;
- `--list-sessions --format json` and `--list-models`;
- agent, model, effort, and tool-trust options;
- interactive commands such as `/usage` that must work from Codesk.

ACP remains the typed protocol regression path. Interactive Kiro chats now use a Codesk-owned tmux pane for single-writer input while conversation display continues to come from Kiro's transcript parser, not terminal screen scraping.

## Kiro CLI milestone (implemented)

### 1. Capability and protocol spike

- Record the supported ACP initialization, session, prompt, cancellation, permission, tool-call, and usage messages for the installed Kiro version.
- Verify whether ACP supports input during an active turn. Advertise **Steer** only if delivery is acknowledged and reliable; otherwise keep the composer available and use **Queue**.
- Determine how slash commands are represented over ACP. Confirm `/usage` end to end and retain a PTY fallback only if ACP cannot carry the command.
- Verify session identifiers, resume behavior, transcript/history sources, and whether Kiro exposes a safe fork operation.
- Test both the current v2 engine and capability detection for newer engines without assuming identical behavior.
- Document version gates and degrade by capability rather than by a hard-coded Kiro version.

Exit criterion: a checked-in protocol fixture and a short adapter contract describe every feature Codesk will claim.

### 2. First-class provider adapter

- Add provider ID `kiro`, display name, icon treatment, capability metadata, and host availability/version detection.
- Start Kiro in the selected project's exact working directory on its execution host.
- Prefer `kiro-cli acp`; supervise the process and its children through the existing daemon lifecycle.
- Support agent, model, effort, trust mode, current checkout, and managed-worktree options without copying Kiro credentials off the execution host.
- Persist the exact command, adapter settings, Kiro session ID, and raw provider messages with each Codesk run.
- Support local and remote hosts through the same provider-neutral API.

Exit criterion: a user can select Kiro in a project draft, submit the first prompt, and receive a durable Kiro run in Codesk.

### 3. Structured conversation display

Normalize Kiro events into Codesk's existing presentation model:

- user and assistant messages;
- reasoning/progress status when exposed;
- tool calls, arguments, running/completed state, and tool output;
- file reads, edits, diffs, and command execution;
- permission requests and questions with typed responses;
- errors, warnings, retries, model/agent changes, and lifecycle state;
- token, context, quota, or cost information exposed by Kiro;
- raw provider events and a raw-output fallback for unknown event types.

`/usage` should render as a normal user command followed by a readable usage card while retaining Kiro's raw response for diagnostics. Unknown slash commands must be passed through unchanged and must show an explicit acknowledgment or provider error; Codesk must not silently reinterpret them.

Exit criterion: ordinary text, tool use, approvals, failures, and `/usage` are understandable without opening a terminal.

### 4. Interaction and commands

- Keep the input composer available for every live Kiro session.
- Send a follow-up immediately while idle.
- During an active turn, expose **Steer** when ACP proves it is supported and **Queue** in all cases where deferred delivery is safe.
- Deliver `/usage` and other Kiro slash commands to the existing conversation rather than starting a new chat.
- Display queued inputs, allow removal before delivery, and preserve ordering across UI or network reconnects.
- Support typed permission/approval responses where ACP exposes them.
- Implement provider-native cancellation when available, followed by the existing interrupt, terminate, and kill escalation policy.
- Never inject input into an unrelated process or infer ownership from PID alone; bind control to the recorded process and Kiro session identity.

Exit criterion: the user can converse, steer or queue, issue `/usage`, answer requests, and interrupt a running Kiro turn entirely from Codesk.

### 5. Sessions, continuation, and discovery

- Index project sessions from Kiro's JSON session listing or a more authoritative ACP source.
- Use provider timestamps and project paths so old sessions do not appear as newly created chats.
- Load historical messages without scraping terminal screen contents.
- Resume a selected session with `--resume-id` while preserving its project and execution host.
- Expose fork only if Kiro offers a safe, tested source-preserving operation; otherwise label the limitation clearly.
- Discover already-running Kiro processes non-invasively and correlate them with Kiro session IDs where possible.
- For externally started Kiro sessions, offer steer/queue only through a proven attachable transport. Otherwise keep the composer useful by offering a safe continuation into a Codesk-owned process rather than launching a second writer against the same active session.
- Launch new interactive Kiro chats in the isolated Codesk tmux socket; detect user-owned tmux panes and require one-click control adoption.

Exit criterion: recent sessions have correct dates, a historical conversation can be continued from Codesk, and no duplicate writer is created for an active provider session.

### 6. Verification and release gate

Automated coverage must include:

- adapter command construction and capability negotiation;
- ACP parsing fixtures for text, tools, approvals, errors, usage, and unknown messages;
- session listing, timestamp mapping, history loading, and resume by ID;
- active-turn steer capability or honest fallback to queue;
- slash-command delivery, including `/usage`;
- interruption, daemon restart recovery, event ordering, and queue persistence;
- local and remote execution-host behavior;
- compatibility behavior when Kiro or ACP is missing or too old.

The live release test must use a disposable real project and verify:

1. Start a new Kiro conversation from Codesk.
2. Complete a prompt that invokes at least one tool and changes or reads a file.
3. Send another message while idle.
4. Send a message during an active turn using Steer if supported and Queue otherwise.
5. Run `/usage` and verify its result is displayed correctly.
6. Exercise one permission or input request when available.
7. Interrupt a turn and confirm the session remains resumable.
8. Restart Codesk and `codeskd`, then verify replay and continued interaction.
9. Resume the same Kiro session by its provider session ID.
10. Repeat the critical path on a remote project.

Capture verification screenshots for the new-chat view, a tool call with output, the Steer/Queue state, `/usage`, and a resumed historical session. Run the full Codesk test suite, the tmux control runbook, the performance regression runbook, and `pnpm run desktop:redeploy` before marking the milestone complete.

## Definition of done

Kiro CLI is considered first-class only when:

- it can be selected and launched on any supported execution host;
- its conversation and tool activity are rendered structurally;
- its input box remains useful while idle and active;
- `/usage` and other provider commands reach the correct session;
- sessions can be listed with correct timestamps and safely resumed;
- interruption and recovery are reliable;
- claimed capabilities are based on tested protocol behavior;
- the integration passes automated and live screenshot verification without relying on tmux screen scraping.

## DeepSeek Harness milestone (implemented)

Codesk keeps DSH Web as the typed protocol regression path and runs interactive DSH chats through `dsh --profile tui` in the isolated Codesk tmux socket. Transcript parsing remains the display source.

Implemented behavior:

- provider discovery, selection, capability metadata, and process-group lifecycle;
- streamed text/reasoning plus structured tool calls, results, file locations, and raw DSH events;
- immediate steer and removable deferred queue delivery during active turns;
- DSH slash-command routing and a native projection-backed `/usage` card;
- provider-native cancellation followed by Codesk terminate/kill escalation;
- compressed `session.jsonl.zstd` indexing with project ownership, native timestamps, historical messages, tool activity, and turn duration;
- cold continuation of the same session, safe source-preserving fork, and Esc-Esc history branching;
- an authenticated live probe at `scripts/test-dsh-live.mjs` covering a real tool turn, queue, steer, usage, cancellation, resume, fork, and history.

The structured DSH test transport keeps the private DSH host behavior; the default interactive path uses tmux and transcript-gated queue delivery.

## Antigravity milestone (implemented)

Codesk integrates the installed Antigravity CLI through `agy --print --output-format stream-json`. A managed turn publishes its native conversation ID, streamed assistant text, structured tool calls/results, and the provider's token/cache/thinking/duration metrics. The same conversation can be continued through `agy --conversation <id>` after a turn exits.

Implemented behavior:

- provider discovery, selection, executable capability detection, and process-group lifecycle;
- structured assistant, reasoning, command/tool, file-change, failure, and usage presentation with retained raw events;
- project-scoped conversation indexing from Antigravity's summary database, with a recent-conversation fallback;
- historical transcript rendering from `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`;
- correct provider timestamps and `file://` workspace ownership mapping, including percent-encoded paths;
- safe cold continuation with the same native conversation ID and generic supervised interruption;
- non-invasive detection of `agy`/`antigravity-cli` processes and `--conversation` session correlation;
- an authenticated live probe at `scripts/test-agy-live.mjs` covering a real tool turn, usage, resume, history, and interruption.

Antigravity's print protocol remains available for structured regression. Interactive Antigravity chats run in tmux, allowing terminal-level Steer and Queue while safe conversation fork remains disabled.

## Later provider work

Use the same adapter contract and verification matrix for deeper Claude Code and Pi support and for additional protocol-capable agents. Prefer protocol-native integrations, retain provider-native raw events, and use generic PTY parsing only as an explicit compatibility tier.
