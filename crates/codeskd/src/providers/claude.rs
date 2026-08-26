use std::path::{Path, PathBuf};

use anyhow::Result;
use uuid::Uuid;

use crate::{
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{ProviderAdapter, ProviderDescriptor, RunnerKind, support};

pub(crate) struct Claude;
pub(crate) static ADAPTER: Claude = Claude;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "claude",
    name: "Claude Code",
    binary: Some("claude"),
    structured_output: true,
    live_input: false,
    resume: true,
    fork: true,
    native_interrupt: false,
    queued_input: false,
    turn_rewind: false,
    provider_responses: false,
    runner: RunnerKind::Stdio,
    limitations: &[
        "Active print-mode sessions cannot accept live steering; use resume or fork after completion",
    ],
};

impl ProviderAdapter for Claude {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }
    fn build(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<support::CommandSpec> {
        let mut args = vec![
            "--print".into(),
            "--verbose".into(),
            "--output-format".into(),
            "stream-json".into(),
        ];
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            args.extend([
                "--resume".into(),
                support::require_resume_session(request)?.into(),
            ]);
            if request.operation.as_deref() == Some("fork") {
                args.push("--fork-session".into());
            }
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        args.push(request.prompt.clone());
        Ok(support::CommandSpec {
            command: support::provider_command("claude")?,
            args,
            session_id: request.resume_session_id.clone(),
        })
    }
    fn build_terminal(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        let mut args = Vec::new();
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            args.extend([
                "--resume".into(),
                support::require_resume_session(request)?.into(),
            ]);
            if request.operation.as_deref() == Some("fork") {
                args.push("--fork-session".into());
            }
        }
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        // Codesk drives this TUI unattended. Without the flag a permission
        // prompt steals the composer and a steer types into the dialog.
        args.push("--dangerously-skip-permissions".into());
        Ok(Some(support::CommandSpec {
            command: support::provider_command("claude")?,
            args,
            session_id: request.resume_session_id.clone(),
        }))
    }
    fn matches_command(&self, command: &str) -> bool {
        support::command_tokens(&command.to_lowercase()).contains(&"claude")
    }
    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with(".jsonl") && path.contains("/.claude/projects/")
    }
    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let stem = PathBuf::from(path).file_stem()?.to_str()?.to_string();
        Uuid::parse_str(&stem).ok().map(|_| stem)
    }
    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_claude(project, limit)
    }
    fn session_messages(
        &self,
        project: &Project,
        native_session_id: &str,
        after: Option<&str>,
        before: Option<&str>,
        limit: Option<usize>,
    ) -> Result<Vec<SessionMessage>> {
        sessions::file_messages_for_project(
            project,
            DESCRIPTOR.id,
            native_session_id,
            after,
            before,
            limit,
        )
    }
    fn transcript_turn_active(&self, path: &Path) -> bool {
        sessions::transcript_turn_active(path, DESCRIPTOR.id)
    }

    fn keep_terminal_parent_shell(&self) -> bool {
        true
    }

    fn terminal_ready(&self, screen: &str) -> bool {
        !claude_input_blocked(screen)
    }

    fn terminal_input_blocked(&self, screen: &str) -> Option<bool> {
        Some(claude_input_blocked(screen))
    }

    fn terminal_startup_key(&self, screen: &str) -> Option<&'static str> {
        claude_folder_trust_prompt(screen).then_some("Enter")
    }
}

fn claude_folder_trust_prompt(screen: &str) -> bool {
    screen.contains("Yes, I trust this folder")
}

/// Claude's interactive TUI accepts a paste only at an idle composer.
///
/// The transcript is a poor gate here: compact and other TUI-only work write a
/// `user` record (or nothing classifiable), so the queue either fires into a
/// busy screen — the prompt vanishes — or waits forever after `/compact`.
/// The visible pane is the source of truth.
fn claude_input_blocked(screen: &str) -> bool {
    if claude_folder_trust_prompt(screen) {
        return true;
    }
    let tail: Vec<&str> = screen.lines().rev().take(20).collect();
    if tail.iter().any(|line| {
        line.contains("Compacting conversation")
            || line.contains('▰')
            || line.contains('▱')
            // Idle Claude omits this; a live turn and compact both show it.
            || line.contains("esc to interrupt")
            || line.contains("Loading previous session")
    }) {
        return true;
    }
    if tail.iter().any(|line| claude_status_working(line)) {
        return true;
    }
    // The welcome splash paints a composer placeholder before the TUI is
    // accepting input. Pasting then vanishes. The mode footer is the signal
    // that the input loop is actually up.
    let composer = tail.iter().any(|line| {
        let trimmed = line.trim();
        trimmed == "❯" || trimmed.starts_with('❯')
    });
    let input_loop = tail.iter().any(|line| line.contains("shift+tab to cycle"));
    !composer || !input_loop
}

fn claude_status_working(line: &str) -> bool {
    let trimmed = line.trim();
    let spinner = trimmed.starts_with('✻') || trimmed.starts_with('✶') || trimmed.starts_with('●');
    if !spinner || trimmed.contains("Remote Control") || claude_finished_status(trimmed) {
        return false;
    }
    true
}

/// `✻ Baked for 7m 58s` / `✻ Brewed for 12s` is the completed-turn footer,
/// not an in-progress spinner.
fn claude_finished_status(line: &str) -> bool {
    let rest = line.trim_start_matches(['✻', '✶', '●', ' ']);
    rest.split_once(" for ")
        .is_some_and(|(_, duration)| duration.starts_with(|c: char| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::{ADAPTER, claude_input_blocked};
    use crate::providers::ProviderAdapter;

    const IDLE: &str = "\
all four PRs are merged and verified in production.

✻ Baked for 7m 58s

※ recap: Goal was fixing ReadFluent reader bugs.

● Remote Control not started here · another Claude Code on this machine
  (started 2h ago) already has Remote Control for this conversation

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
";

    const WORKING: &str = "\
❯ https://example.test/bundle.zip: check this

● I'll download and go through it.

· Whatchamacalliting… (4s · ↓ 48 tokens)

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents
";

    const COMPACTING: &str = "\
✻ Baked for 7m 58s

❯ /compact

✻ Compacting conversation… (1m 23s)
  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 60%

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents
";

    const STARTUP: &str = "\
Claude Code

Loading previous session…
";

    const SPLASH_WITHOUT_FOOTER: &str = "\
╭─── Claude Code ──────────────────────────────────────────────────────────────╮
│                  Welcome back                                                │
╰──────────────────────────────────────────────────────────────────────────────╯
❯ Try \"fix typecheck errors\"
";

    const POST_COMPACT: &str = "\
✻ Brewed for 7m 58s

❯ /compact
  ⎿  Compacted (ctrl+o to see full summary)

────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
";

    const FOLDER_TRUST: &str = "\
 Accessing workspace:

 /tmp/new-project

 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
";

    #[test]
    fn idle_composer_accepts_input() {
        assert!(!claude_input_blocked(IDLE));
        assert!(!claude_input_blocked(POST_COMPACT));
        assert!(ADAPTER.terminal_ready(IDLE));
        assert_eq!(ADAPTER.terminal_input_blocked(IDLE), Some(false));
    }

    #[test]
    fn live_turn_blocks_input() {
        assert!(claude_input_blocked(WORKING));
        assert!(!ADAPTER.terminal_ready(WORKING));
    }

    #[test]
    fn compacting_blocks_input() {
        assert!(claude_input_blocked(COMPACTING));
        assert!(!ADAPTER.terminal_ready(COMPACTING));
        assert_eq!(ADAPTER.terminal_input_blocked(COMPACTING), Some(true));
    }

    #[test]
    fn startup_without_composer_blocks_input() {
        assert!(claude_input_blocked(STARTUP));
        assert!(claude_input_blocked(SPLASH_WITHOUT_FOOTER));
        assert!(!ADAPTER.terminal_ready(STARTUP));
    }

    #[test]
    fn folder_trust_prompt_is_dismissed_before_the_first_prompt() {
        assert!(claude_input_blocked(FOLDER_TRUST));
        assert_eq!(ADAPTER.terminal_startup_key(FOLDER_TRUST), Some("Enter"));
        assert_eq!(ADAPTER.terminal_startup_key(IDLE), None);
    }

    #[test]
    fn terminal_keeps_a_parent_shell() {
        assert!(ADAPTER.keep_terminal_parent_shell());
    }
}
