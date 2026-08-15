# Codesk Design Implementation Status

Last updated: 2026-08-15

Source audit: [DESIGN_ANALYSIS.md](./DESIGN_ANALYSIS.md)

## Purpose

This is the living implementation checklist for the Codesk design audit. It separates shipped behavior from partial work and future work so that the original audit is not mistaken for a fully completed specification.

Status meanings:

- **Implemented**: present in the current code and verified in proportion to its risk.
- **Partial**: meaningful work exists, but one or more requirements from the audit remain.
- **Missing**: the audited behavior is not implemented.
- **Not verified**: implementation may be directionally correct, but the stated acceptance condition has not been demonstrated.

## Executive status

The high-impact redesign is substantially implemented:

- The sidebar is now one repository/session navigation tree with one scroller.
- Navigation is cached and offline repositories remain visible.
- Conversations render Markdown and structured activity instead of only flat event text.
- Composer primitives, real Git context, runtime controls, and an environment inspector are present.
- The React/webview surface has been exercised at desktop and narrower browser sizes.

The full audit is **not complete**. Native macOS chrome, a resizable/collapsible sidebar, complete keyboard tree navigation, several advanced thread actions, and the proposed component/data decomposition remain.

## Phase status

### Phase 1: Navigation foundation — mostly implemented

Implemented:

- One `.navigation-scroller` contains Pinned, Projects, and nested conversations.
- The rendered global Recents duplication is removed.
- Application controls and the Gateway/Settings footer remain fixed.
- Pinned conversations persist through gateway settings.
- Pinned rows show repository and host context.
- Project rows show repository name, host identity, and connection status.
- Duplicate repository names on different hosts are distinguishable.
- Idle sessions use quieter presentation; exceptional running/stopped states remain visible.
- Each project initially shows at most five provider sessions.
- Show more expands only the selected project in place.
- Selected projects auto-expand while other explicit expansion state is retained.
- Expansion state and navigation scroll position persist locally.
- Search retains repository context and matches project, session, provider, and host information.
- Clearing search restores the previous navigation scroll position.
- `Cmd/Ctrl+K` focuses search and `Cmd/Ctrl+N` starts a new chat.
- Tree, tree-item, group, and `aria-expanded` semantics exist at a basic level.

Partial or missing:

- Pin order is persisted, but there is no user-facing reorder interaction.
- Up/Down/Left/Right/Enter tree navigation is missing.
- Roving focus, `aria-current`, and complete keyboard-focus treatment are missing.
- Project rows are not sticky, so a tall expanded project can still have its header scroll above visible children.
- A dedicated global history/search screen is not implemented; Archived chats remains a navigation action rather than the audited history experience.
- Fifty-repository usability has not been explicitly demonstrated.

### Phase 2: Fast and stable data — mostly implemented

Implemented:

- `/api/navigation` provides a navigation-oriented snapshot separately from the full state request.
- Navigation snapshots are persisted per host in the gateway store.
- The React shell requests cached navigation immediately and refreshes full state afterward.
- Offline or reconnecting hosts retain their last known projects, runs, and session summaries.
- Slow provider/session/agent discovery no longer has to block the initial navigation snapshot.
- Gateway refreshes merge current and cached host state.
- Project discovery canonicalizes paths before registration.
- Folder browsing can discover and register Git repositories.
- External agents are discovered read-only without terminating or attaching to them.

Partial or missing:

- Discovered working directories are not presented in a dedicated **Discovered** or **Unregistered** navigation section.
- There is no explicit promote-to-project workflow from such a navigation section.
- Persisted user-controlled project ordering is missing.
- Stable UI identity uses host plus stored IDs; the audit's complete host-plus-canonical-path identity model is not exposed consistently throughout the client.
- Automatic registration of every repository previously opened through Codesk is not defined as a separate policy.

### Phase 3: Structured thread rendering — mostly implemented

Implemented:

- User and assistant content uses `react-markdown` with GFM support.
- Environment-context XML is removed from visible conversation text.
- Hidden environment payloads produce a compact context note.
- Consecutive operational events are grouped in collapsible activity sections.
- Failed activity opens automatically while completed activity is collapsed by default.
- Reasoning summaries, command rows, command output, file-change cards, approval requests, and input requests have distinct presentation.
- Turn completion renders a duration boundary such as `Worked for 2m 3s` when timing data exists.
- Historical provider sessions use a compact noninteractive notice instead of a disabled composer-shaped control.
- Offline historical sessions render a stable offline state and do not continuously poll unavailable messages.
- Rewind/edit-from-here, fork, queue, interrupt, continue, and provider-response flows remain integrated with the structured timeline.

Partial or missing:

- Turn boundaries do not yet combine final status, model, token/cost data, activity count, and timestamp.
- File-change cards show changed paths but lack Review diff, Open file, Undo, and Copy path actions.
- Tool normalization remains event-shape driven and is not a complete provider-independent presentation model.
- Observed external agents can still appear as navigation children; the audit recommends keeping them secondary unless they expose meaningful conversation history.
- A dedicated raw-event or developer inspector is not implemented.

### Phase 4: Composer and environment — mostly implemented

Implemented:

- Start and thread composers reuse `ComposerFrame`, `ComposerInput`, and `ComposerFooter` primitives.
- Start-screen context shows repository, local/remote location, actual Git branch, dirty state, host, and workspace mode.
- The backend exposes Git branch/worktree context rather than hardcoding `main`.
- Active Codex turns expose Interrupt and Queue controls.
- Terminate and Kill appear after interruption escalation rather than as normal primary controls.
- Environment details moved into a toolbar-controlled inspector.
- The inspector includes provider, host, project, branch/worktree, path, and available worktree actions.
- The inspector does not overlap the reading column at the verified wide and narrow layouts.
- Historical sessions provide clear read-only messaging when safe resume/fork is unavailable.

Partial or missing:

- The two composer experiences share primitives but are not one fully consolidated composer component and state model.
- Not every context item is interactive.
- Permission mode is not represented as a consistent explicit context field across all composer states.
- The environment inspector's open/closed state is not persisted.
- The thread-header **Open in** control is visually present but does not yet implement the complete editor-selection flow.
- Session-history environment details are less complete than managed-run environment details.

### Phase 5: Native polish — largely missing

Missing:

- Integrated macOS title-bar styling.
- Sidebar background extended beneath macOS traffic lights.
- Explicit Tauri drag regions for the integrated title bar.
- Removal of duplicate native/application title chrome.
- User-resizable sidebar with a persisted width.
- Fully collapsible sidebar with a toolbar control and reopen shortcut.
- Complete narrow-window navigation behavior beyond the current fixed minimum width.
- Full keyboard navigation and accessibility acceptance criteria.

Partial:

- The reading column is centered and the environment inspector adapts between side-by-side and stacked layouts.
- Host labels become more compact below the existing breakpoint.
- Project/session weights, muted metadata, selection treatment, icon usage, and scrollbars were refined.
- The font stack contains the macOS system fonts, but `Inter` still precedes them rather than using the system font first as recommended.

Current native configuration still uses a decorated Tauri window:

```json
"decorations": true
```

## Sidebar acceptance criteria

| Criterion | Status | Notes |
| --- | --- | --- |
| One scrollbar for pins, projects, and sessions | Implemented | Verified in the rendered UI. |
| Project header cannot scroll away from visible children | Missing | Project rows are not sticky. |
| Fifty repositories remain comfortably navigable | Not verified | Content visibility and unified scrolling help, but the exact scale was not tested. |
| Offline repositories remain visible | Implemented | Cached host navigation is retained and dimmed by status. |
| Duplicate local/remote repository names are distinguishable | Implemented | Host label and status are visible on every project row. |
| No second Recents duplication | Implemented | No rendered `.side-recents` section remains. |
| No more than five sessions before expansion | Implemented | Provider session previews use `slice(0, 5)`. |
| Search results retain repository context | Implemented | Results remain nested below their parent project. |
| Scroll and expansion survive refresh/search | Implemented | Stored navigation scroll and expansion sets are restored. |
| Session, not parent project, receives primary selection | Implemented | Project selection is suppressed while a child is selected. |
| Navigation appears from cache before full refresh | Implemented | The client loads `/api/navigation` before the complete polling result. |

## Architecture status

The audit's suggested component architecture is only partially adopted.

Implemented building blocks include:

- Composer primitives
- Markdown message rendering
- Operational event rendering
- Activity groups
- Environment rows and inspector
- Dialog and folder-browser components

Still missing:

- Separate files/components for `SidebarShell`, `PrimaryNavigation`, `ProjectTree`, `ProjectRow`, `SessionRow`, `ThreadToolbar`, `ConversationTimeline`, and `Turn`.
- A dedicated client navigation projection that prevents `Sidebar` from repeatedly joining projects, drafts, sessions, runs, and observed agents during rendering.
- A provider-independent normalized timeline model beyond the current event grouping helpers.

## Verification completed

Static and build validation:

- `npm run check`
- `npm run build`
- `cargo fmt --check`
- `git diff --check`

Automated behavior validation:

- 15 Rust unit tests
- Codex app-server steering, durable queueing, interruption, continuation, and rewind integration
- Gateway restart and missed-event replay integration
- Daemon restart/survival integration
- Managed worktree isolation and cleanup integration
- Project discovery and read-only external-agent inspection integration
- Draft and persisted navigation/settings integration

Browser/webview-surface validation:

- 1440×960 desktop layout
- 1024×768 narrower layout
- One navigation scroller and no rendered Recents section
- Five-session preview and Show more behavior
- Host identity and duplicate repository names
- Offline cached-session state
- Search repository context and exact scroll restoration
- Selected-session versus parent-project styling
- Markdown and hidden environment XML
- Environment inspector placement without reading-column overlap
- No horizontal body overflow
- No captured console, page, or HTTP response errors

Browser testing validates the React surface rendered inside Tauri's webview. It does not validate native macOS title-bar appearance, traffic-light layout, drag regions, or other Tauri-only behavior.

## Remaining work in recommended order

1. Implement complete keyboard navigation, focus management, and ARIA state for the project tree.
2. Prevent orphaned session children by making expanded project context remain visible while scrolling.
3. Add the Discovered/Unregistered repository section and promote-to-project workflow.
4. Add persisted project ordering and explicit pin reordering.
5. Complete file-change actions and richer turn metadata.
6. Consolidate the composer and normalize context fields across start, live, reconnecting, and historical states.
7. Persist environment-inspector state and complete thread-toolbar actions.
8. Decompose the large sidebar/thread implementation and introduce a navigation projection in the data layer.
9. Add a resizable/collapsible sidebar and verify a fifty-repository fixture.
10. Implement and test native macOS title-bar integration and drag regions in the actual Tauri application.

## Completion rule

Do not mark the original design audit fully implemented until every **Missing** item is resolved, every **Partial** item satisfies the audit's stated behavior, and the native-only work has been verified in the packaged Tauri application rather than only in a browser.
