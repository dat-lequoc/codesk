# Codesk Design Audit: Matching Codex's Design and Organization

## Executive summary

The central difference between Codesk and Codex is organizational, not merely visual.

Codesk currently exposes much of its internal data model directly: projects, drafts, provider sessions, managed runs, observed agents, and a separate recents list. Codex presents a simpler user model: application actions, a single navigable project/session hierarchy, and a fixed gateway/settings footer.

That simpler hierarchy is why Codex remains easy to scan with many open repositories. The highest-impact improvement is to replace Codesk's separate Projects and Recents scroll areas with one unified navigation scrollbar containing pinned conversations, projects, and their nested sessions.

The redesign should proceed in this order:

1. Unify sidebar navigation and remove duplicated session lists.
2. Make repository navigation load immediately and remain stable while hosts reconnect.
3. Replace flat transcript output with structured messages, tools, commands, diffs, and turn boundaries.
4. Consolidate the composer, environment context, and thread toolbar.
5. Refine macOS window chrome, typography, responsive behavior, and accessibility.

## Reviewed screenshots

This audit uses the following side-by-side and focused comparisons:

- [Codesk and Codex thread comparison at 14:15](<./Screenshot 2026-08-14 at 14.15.18.png>)
- [Codesk and Codex live-run comparison at 14:16](<./Screenshot 2026-08-14 at 14.16.00.png>)
- [Codesk and Codex thread/activity comparison at 14:23](<./Screenshot 2026-08-14 at 14.23.11.png>)
- [Codesk home screen and sidebar comparison at 14:23](<./Screenshot 2026-08-14 at 14.23.29.png>)
- [Narrow sidebar comparison at 15:15](<./Screenshot 2026-08-14 at 15.15.45.png>)

Some screenshots represent slightly different Codesk iterations, but the repeated structural issues are consistent.

## High-level comparison

| Area | Codex | Codesk currently |
| --- | --- | --- |
| Navigation scrolling | One project/session navigation scrollbar | Separate Projects and Recents scrollbars |
| Repository organization | Stable repository rows with visible host identity | Registered projects only; duplicate names are ambiguous |
| Session organization | Sessions nested beneath their repository | Sessions nested beneath projects and duplicated in Recents |
| Long project lists | Collapsed projects, limited session previews, Show more | Multiple expanded projects competing for a fixed-height region |
| Thread rendering | Structured messages, tools, diffs, activity, and turn boundaries | Mostly flat text and raw event output |
| Context | Progressive disclosure through toolbar, composer, and cards | Floating Environment card plus raw metadata in messages |
| Window chrome | Integrated macOS title bar and application toolbar | Standard title bar plus a second application header |
| Loading | Navigation remains stable while details load | Project list can start empty or temporarily omit hosts |

## 1. Sidebar and navigation

This should be the first redesign because it affects every workflow and every screenshot.

### Current problem: two competing scroll regions

Codesk gives Projects and Recents independent scroll containers:

```css
.side-projects {
  max-height: 46%;
  overflow: auto;
}

.side-recents {
  overflow: auto;
  flex: 1;
}
```

The same sessions are rendered once beneath their project and again in the global Recents section. This creates several usability problems:

- Users must manage two unrelated scroll positions.
- Projects can use only 46 percent of the available navigation height even when projects are the primary navigation object.
- The same session occupies two persistent positions in one sidebar.
- Expanded projects compete for an arbitrary fixed amount of space.
- A project header can scroll away while its child sessions remain visible, leaving visually orphaned rows directly beneath the Projects heading.
- Users can see a scrollbar indicating more information while the repository they need is hidden inside a different scrollbar.

The 15:15 screenshot demonstrates the orphaning problem clearly: Codesk shows conversation rows immediately beneath Projects, while their repository row has scrolled out of view. The official Codex sidebar retains a coherent project/session hierarchy.

### Target sidebar structure

The desired structure is:

```text
Fixed application controls
├── Codesk header
├── New chat
├── Pull requests
├── Scheduled
└── Plugins

One navigation scroll container
├── Pinned
│   └── Pinned session
└── Projects
    ├── codesk                         This Mac ●
    │   ├── Current session
    │   ├── Previous session
    │   └── Show more
    ├── pi-agi                         quocd2 ●
    │   ├── Current session
    │   └── Previous session
    ├── instant_context                quocd2 ●
    └── thinking                       quocd2 ●

Fixed footer
└── Gateway / Settings
```

There should be exactly one scrollbar from Pinned through the complete project tree. The primary application actions and bottom Gateway/settings row should remain fixed.

### Remove the global Recents duplication

To match Codex, Recents should not be a second full session list beneath Projects.

Recommended options, in priority order:

1. Remove Recents and rely on recent sessions nested beneath projects.
2. Add a compact Pinned section above Projects.
3. Provide global history and search as a dedicated screen.
4. If a Recents mode remains desirable, make it a filter mode that replaces the project tree rather than appearing beneath it.

Pinned conversations are more useful than a duplicated recent-history list. They create a cross-project working set without making the whole sidebar repetitive.

### Project row design

Each repository row should contain:

- Repository icon
- Repository name
- Host name, such as `This Mac` or `quocd2`
- Small connection-status dot
- Optional running-session count
- Hover-only new-chat action

The host label is essential because Codesk can contain repositories with the same name on different machines. The screenshots already show two `codesk` repositories, one local and one remote. A green dot alone does not explain which repository the user is selecting.

The project name should remain the primary label. Host identity should be visible but subdued, following the official Codex pattern:

```text
codesk                         quocd2 ●
```

### Session row design

Session children should be visually quieter than their project row:

- Regular or medium font weight rather than bold
- One line with ellipsis
- Relative update time at the right
- Status icon only when it communicates a useful exceptional state
- Selected background on the session, not simultaneously on its project
- Approximately five recent sessions before a Show more row

Codesk currently uses provider icons, broadcast/radio indicators, stopped dots, observed labels, and running styles on many rows. This creates excessive visual activity. Provider identity is usually secondary and can appear in the thread header, tooltip, or context menu.

Persistent strong indicators should be limited to states such as:

- Running
- Waiting for input
- Failed
- Disconnected

Idle historical sessions should generally look like plain text rows.

### Expansion behavior for many repositories

To work well with dozens of repositories:

- The selected project should automatically expand.
- Other projects should preserve the user's explicit expanded/collapsed state.
- Selecting one project should not collapse all other projects.
- Each project should initially show no more than five recent sessions.
- Show more should expand only that project in place.
- Sidebar scroll position should survive state refreshes and reconnections.
- Selecting a session should scroll it into view only when necessary.
- Background polling should never reset the user's navigation position.

The current persisted expansion set is a good foundation, but it needs to operate inside one stable navigation scroller.

### Pinned conversations

Codex's Pinned section is especially valuable when many repositories are open.

Codesk should support:

- Pin and unpin from a session context menu
- Persisted pin ordering
- Repository and host context in a tooltip or subtle secondary label
- Identical selection state whether the conversation is opened from Pinned or from its project

A pin should be a shortcut to the canonical session, not a duplicated session record.

### Search behavior

Search should filter the unified project tree:

- Matching projects remain visible.
- Matching sessions retain their parent repository context.
- Empty nonmatching projects disappear while searching.
- Search can include project name, session title, provider, and host.
- Clearing search restores the prior expansion and scroll position.

A session result without repository context is ambiguous when several projects contain similarly named conversations.

### Keyboard navigation and accessibility

The project tree should support:

- Up and Down to move between visible rows
- Left and Right to collapse or expand a project
- Enter to open the selected project or session
- A keyboard shortcut for search
- A keyboard shortcut for New chat
- Proper `aria-expanded`, `aria-current`, tree, and tree-item semantics
- Visible keyboard focus independent of mouse hover

## 2. Repository loading and persistence

Visual stability cannot be solved solely through CSS. The project data currently arrives too slowly and inconsistently.

### Current state-loading issue

The gateway waits for all of these before returning application state:

- Projects
- Runs
- Provider capabilities
- Agent process discovery
- Session history for every project

A measured `/api/state` request took approximately 10.8 seconds. The React application begins with an empty project array, so repositories are genuinely absent while that request is pending.

This explains the intermittent behavior observed in the sidebar:

- During initial loading, the list is empty.
- A reconnecting SSH host is omitted until it becomes online.
- Codesk only shows repositories registered in its own daemon database.
- Codex's complete repository catalog is not imported.
- A slow session or agent-discovery request delays unrelated project navigation.

### Navigation must load independently

Codesk needs a fast navigation snapshot containing:

- Known hosts
- Persisted projects
- Draft summaries
- Cached session summaries
- Pin and project ordering
- Last-known connection state

This snapshot should render immediately from local persistence. Live host requests should update it afterward.

Projects should not wait for:

- Full session history
- Agent process discovery
- Provider capability probing
- Conversation messages
- Run event history

Those details can load asynchronously after the navigation shell is visible.

### Preserve repositories while offline

When a host disconnects, its repositories should remain visible:

```text
pi-agi                         quocd2 ○
```

The project can be dimmed and marked offline or reconnecting, but it should not disappear. Disappearance changes the navigation structure exactly when the user needs to understand what became unavailable.

The recommended flow is stale-while-revalidate:

1. Render the last persisted project and session summaries.
2. Mark the host reconnecting.
3. Refresh in the background.
4. Merge updates without rebuilding the entire sidebar.

### Repository discovery

Codesk currently shows registered repositories. It can also discover active agent working directories, but unregistered directories are not promoted into the project tree.

Recommended behavior:

- Detect repository roots from provider sessions and active-agent working directories.
- Match them against registered projects.
- Place unmatched repositories under an Unregistered or Discovered section.
- Offer Add to Projects.
- Optionally auto-register repositories previously opened through Codesk.
- Never hide a running agent merely because its repository was not manually registered.

This will make Codesk's repository catalog feel much closer to Codex's complete workspace list.

### Stable project identity

Project identity must include host ID and canonical path, not only the project name. This is necessary for:

- Duplicate repository names across machines
- Worktrees belonging to the same repository
- Repositories renamed on disk
- Remote hosts with similar directory layouts
- Stable pins and expansion state

## 3. Thread and activity organization

The screenshots show a major difference in how agent work is presented.

### Codesk currently renders events too literally

The current general event renderer mostly converts events into plain text, a small lifecycle label, or an approval card.

Consequences visible in the screenshots include:

- Markdown syntax appearing as raw text
- Environment XML appearing as a giant user message
- Commands and tool results blending into assistant prose
- File changes being described in prose instead of structured cards
- Little distinction between the assistant's conclusion and operational activity
- Long sessions becoming visually monotonous and difficult to scan

### Codex uses progressive disclosure

The official thread separates information into distinct levels:

1. User message
2. Agent progress and activity
3. Collapsible tool or command rows
4. Final assistant explanation
5. File-change summary
6. Turn duration and boundary
7. Composer

This allows users to read the answer without processing every command while keeping operational evidence available.

### Recommended event components

Codesk should normalize events into reusable presentation components:

- `UserMessage`
- `AssistantMessage`
- `ReasoningSummary`
- `ToolActivityGroup`
- `CommandRow`
- `CommandOutput`
- `FileChangeCard`
- `ApprovalRequest`
- `InputRequest`
- `TurnBoundary`
- `RunStatus`
- `ErrorNotice`

Repeated command events should be grouped beneath one collapsible activity section. Completed activity should default to collapsed; failed activity should default to expanded.

### Markdown rendering

Assistant and user content should use a real markdown renderer supporting:

- Paragraphs
- Lists
- Headings
- Inline code
- Code blocks
- Links
- Tables
- File references

Raw system metadata should never be rendered as ordinary user-facing conversation content.

### Hide internal context payloads

The environment-context XML visible in Codesk is useful protocol data but poor conversation UI.

Convert it into a compact context strip:

```text
codesk · quocd2 · main · unrestricted filesystem
```

The complete payload can remain available behind View raw event or a developer inspector.

### Turn boundaries

Codex uses labels such as `Worked for 12m 3s` and a divider to establish clear turn boundaries. Codesk should add:

- Turn duration
- Final status
- Model used
- Token or cost information when available
- Expandable activity count
- Timestamp

This is especially valuable when a conversation includes many follow-up turns.

### File-change summaries

When the provider reports changed files, Codesk should render a dedicated card:

```text
Edited 2 files                         Review

src/App.tsx                         +6 −5
src/styles.css                      +3 −2
```

Useful actions include:

- Review diff
- Open file
- Undo where supported
- Open worktree
- Copy path

This is more useful than requiring the assistant to explain every file change through prose.

### Historical and observed sessions

The large disabled composer currently used for read-only history looks interactive but cannot be used. This creates a false affordance.

Replace it with a compact footer:

```text
Provider-native history · Read only       Resume   Fork
```

If resume is supported, enable the real composer. If it is not supported, show a clearly noninteractive notice rather than a disabled composer-shaped surface.

Observed external sessions should remain visually secondary to managed sessions. Observed should be a badge in the thread header, not a repeated sidebar row unless it represents a meaningful conversation with retrievable history.

## 4. Composer and start screen

The current start screen is directionally close to Codex: a central prompt, suggestion cards, and a bottom composer.

### Elements worth retaining

- Four starter actions
- Repository context in the composer
- Host and local/remote context
- Workspace-mode selection
- Provider/model selection
- Persistent drafts

### Accurate context

The branch displayed in the current composer is hardcoded to `main`. It must show the actual selected branch, worktree branch, or base ref.

The context bar should consistently show:

```text
Repository | Host | Branch/worktree | Permission mode
```

Each context item should be interactive when a choice is available.

### Reduce visual branding

The start-screen logo should be smaller and quieter. The prompt and composer are the primary interface; branding should not compete with them.

### One shared composer component

New-session and existing-session composers should use one component and one visual language:

- Same border radius
- Same padding
- Same attachment button
- Same provider/model control
- Same permission/workspace control
- Same send/stop position
- State-specific content above the input for queue, rewind, approval, or reconnecting states

### Running controls

During an active turn:

- Replace Send with Stop or Interrupt.
- Keep Queue as a secondary action.
- Put Terminate and Kill inside an escalation menu after interruption fails.
- Avoid showing multiple destructive controls simultaneously.

## 5. Environment and thread header

The floating Environment card consumes horizontal space and disappears entirely below the current responsive breakpoint. Context is therefore prominent at wide widths and unavailable at narrow widths.

A better design is:

- Put repository, host, branch, workspace, and status identity in the thread toolbar.
- Add an optional inspector button for detailed environment information.
- Open the inspector as a right panel or popover.
- Persist whether the inspector is open.
- Never allow it to overlap the reading column.

The thread header should contain:

```text
[repository/session title] [running status]

Open in editor   Branch/worktree   More
```

## 6. macOS window chrome

Codesk currently uses a standard decorated Tauri window and then renders another application header inside the sidebar. This produces extra vertical chrome compared with Codex.

To match the official organization:

- Use an integrated macOS title-bar style.
- Extend the sidebar background beneath the traffic lights.
- Position application identity and navigation consistently with the native controls.
- Define a proper draggable region.
- Preserve native resize, minimize, and close behavior.
- Avoid showing Codesk in both the native title bar and the sidebar header.

## 7. Responsive layout

Codesk currently changes the sidebar from 326 pixels to 300 pixels below 1250 pixels and abruptly hides the Environment card.

A better responsive model is:

- User-resizable sidebar between approximately 280 and 400 pixels
- Default width around 326 pixels, matching Codex
- Persisted user width
- Complete sidebar collapse at very narrow window widths instead of compressing its hierarchy
- Toolbar button and keyboard shortcut to reopen it
- Centered conversation column
- Environment inspector converted into a popover or drawer instead of becoming inaccessible

## 8. Visual language

Codesk is already close in its dark palette, but several refinements would improve hierarchy.

### Typography

- Use the macOS system font stack first.
- Use medium weight for project names.
- Use regular weight for session names.
- Avoid bolding every active or observed row.
- Use muted labels for host, time, and status.
- Keep assistant prose around 15–16 pixels with generous line height.

### Selection

Only the canonical selected item should receive a filled selection background.

When a session is selected:

- Highlight the session row.
- Do not also strongly highlight its parent project.
- Use only a subtle expanded or active indication on the project.

### Icons

Reduce the number of persistent icons. Icons should communicate:

- Object type: project, session, worktree
- Exceptional status: running, failed, needs input
- Action: add, search, settings

Provider icons and generic robot or broadcast icons on every historical session add noise without improving navigation.

### Scrollbars

The unified navigation should use one thin, low-contrast overlay scrollbar. It should appear while scrolling or hovering and otherwise remain unobtrusive.

The important improvement is not styling the scrollbar; it is eliminating the second navigation scrollbar.

## 9. Suggested component architecture

The interface will be easier to maintain if the current large Sidebar and thread components are decomposed into focused pieces:

```text
SidebarShell
├── AppHeader
├── PrimaryNavigation
├── NavigationScroller
│   ├── PinnedSection
│   └── ProjectTree
│       ├── ProjectRow
│       ├── SessionRow
│       └── ShowMoreRow
└── SidebarFooter

ThreadScreen
├── ThreadToolbar
├── ConversationTimeline
│   ├── Turn
│   ├── Message
│   ├── ActivityGroup
│   └── FileChangeCard
├── EnvironmentInspector
└── Composer
```

The data layer should expose a navigation-oriented projection instead of requiring the Sidebar component to join projects, drafts, sessions, runs, and observed agents on every render.

## 10. Recommended implementation order

### Phase 1: Navigation foundation

- Replace Projects and Recents with one navigation scroller.
- Add Pinned.
- Show host identity on every project.
- Limit sessions per project and retain Show more.
- Correct session/project selection styling.
- Preserve scroll position.
- Retain offline projects.

This phase will deliver the largest usability improvement immediately.

### Phase 2: Fast and stable data

- Return cached navigation state immediately.
- Load session history and agent discovery separately.
- Stop clearing projects during reconnects.
- Add discovered and unregistered repositories.
- Persist project ordering, pins, expansion, and cached session summaries.

### Phase 3: Structured thread rendering

- Add markdown rendering.
- Group tool events.
- Hide raw environment payloads.
- Add turn boundaries.
- Add file-change cards.
- Separate final answers from activity.
- Replace disabled composer-shaped history notices.

### Phase 4: Composer and environment

- Create one shared composer component.
- Display the actual branch or worktree.
- Move environment details into the toolbar and an inspector.
- Refine running, queue, interrupt, and escalation states.

### Phase 5: Native polish

- Integrate the macOS title bar.
- Add a resizable and collapsible sidebar.
- Refine typography, icon usage, and selection.
- Add keyboard navigation and accessibility semantics.

## 11. Sidebar acceptance criteria

The sidebar redesign should be considered successful when:

- There is only one scrollbar for pinned conversations, projects, and nested sessions.
- A project header cannot scroll away while leaving visually orphaned children at the top.
- Fifty repositories remain comfortably navigable.
- Every repository remains visible while its host reconnects.
- Local and remote repositories with the same name are distinguishable.
- Sessions are not duplicated in a second Recents list.
- No project shows more than five sessions without explicit expansion.
- Search results retain repository context.
- Scroll position and project expansion survive background refreshes.
- The selected session, rather than every related parent row, is the primary highlighted item.
- Navigation appears immediately from cache rather than after the current multi-second state request.

## Conclusion

The sidebar and data-loading work should come before pixel-level visual polishing. Once the hierarchy is correct, Codesk will feel substantially closer to Codex even before every color, radius, and icon is matched.

The most important principle is simple: treat repositories and their conversations as one stable navigation tree. Give that tree one scrollbar, preserve it during reconnects, and progressively disclose secondary details instead of duplicating them.
