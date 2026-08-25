use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    model::{Project, ProviderSession, SessionMessage, StartRunRequest},
    sessions,
};

use super::{
    EffortLevel, ModelControl, ModelPage, ProviderAdapter, ProviderDescriptor, RunnerKind,
    TerminalStatus, support,
};

pub(crate) struct Codex;
pub(crate) static ADAPTER: Codex = Codex;

static DESCRIPTOR: ProviderDescriptor = ProviderDescriptor {
    id: "codex",
    name: "Codex",
    binary: Some("codex"),
    structured_output: true,
    live_input: true,
    resume: true,
    fork: true,
    native_interrupt: true,
    queued_input: true,
    turn_rewind: true,
    provider_responses: true,
    runner: RunnerKind::CodexAppServer,
    limitations: &[
        "Esc-Esc style rewind creates a source-preserving thread fork; it does not revert files already changed in the workspace",
    ],
};

impl ProviderAdapter for Codex {
    fn descriptor(&self) -> &'static ProviderDescriptor {
        &DESCRIPTOR
    }

    fn build(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<support::CommandSpec> {
        if matches!(request.operation.as_deref(), Some("resume") | Some("fork")) {
            support::require_resume_session(request)?;
        }
        Ok(support::CommandSpec {
            command: support::provider_command("codex")?,
            args: vec!["app-server".into()],
            session_id: request.resume_session_id.clone(),
        })
    }

    fn build_terminal(
        &self,
        request: &StartRunRequest,
        _session_key: &str,
        _cwd: &str,
    ) -> Result<Option<support::CommandSpec>> {
        let mut args = match request.operation.as_deref() {
            Some("resume") => vec![
                "resume".into(),
                support::require_resume_session(request)?.into(),
            ],
            Some("fork") => vec![
                "fork".into(),
                support::require_resume_session(request)?.into(),
            ],
            _ => Vec::new(),
        };
        args.push("--yolo".into());
        if let Some(model) = support::model(request) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(Some(support::CommandSpec {
            command: support::provider_command("codex")?,
            args,
            session_id: request.resume_session_id.clone(),
        }))
    }

    /// Codex is ready once it has painted its status line and no turn is
    /// running. A running turn shows `• Working (14s • esc to interrupt)`.
    fn terminal_ready(&self, screen: &str) -> bool {
        parse_status_line(screen).is_some() && !screen.contains("esc to interrupt")
    }

    /// Two startup dialogs hold the composer, and the opening prompt is typed
    /// into whichever one is showing unless it is answered first. Neither may
    /// be answered with Enter: the highlighted row of the update notice
    /// installs a new Codex.
    fn terminal_startup_key(&self, screen: &str) -> Option<&'static str> {
        // An answered dialog scrolls up but stays in the scrollback Codesk
        // captures, and answering it again types a stray digit into whatever
        // is on screen now. A live dialog owns the bottom of the pane and ends
        // in its own footer, which is what tells it apart from its own echo.
        let tail = screen_tail(screen, 14);
        if !tail.ends_with("Press enter to continue") {
            return None;
        }
        for (marker, choice) in [
            (TRUST_HEADING, "Yes, continue"),
            // Skipping asks again next launch rather than writing the
            // operator's answer into their Codex config.
            (UPDATE_HEADING, "Skip"),
        ] {
            if !tail.contains(marker) {
                continue;
            }
            let rows = parse_picker_page(&tail, marker);
            if let Some(key) = row_number(&rows, choice).and_then(digit_key) {
                return Some(key);
            }
        }
        None
    }

    /// Every page of the `/model` picker ends in the same footer, and it is the
    /// bottom of the pane for as long as the picker is up.
    fn terminal_picker_open(&self, screen: &str) -> bool {
        screen_tail(screen, 1).ends_with(PICKER_FOOTER)
    }

    fn parse_terminal_status(&self, screen: &str) -> Option<TerminalStatus> {
        parse_status_line(screen)
    }

    fn parse_model_page(&self, screen: &str) -> ModelPage {
        parse_model_page(screen)
    }

    fn effort_levels(&self) -> &'static [EffortLevel] {
        &EFFORT_LEVELS
    }

    fn model_control(&self) -> Option<ModelControl> {
        Some(ModelControl::NumberedPicker)
    }

    fn encode_input(
        &self,
        message: &str,
        request_id: &str,
        delivery: &str,
        last_turn_id: Option<&str>,
    ) -> Result<String> {
        match delivery {
            "auto" | "steer" | "queue" => Ok(json!({"type":"submit","message":message,"requestId":request_id,"delivery":delivery}).to_string()),
            "fork" => Ok(json!({"type":"rewind","message":message,"requestId":request_id,"lastTurnId":last_turn_id}).to_string()),
            value => anyhow::bail!("unsupported Codex input delivery: {value}"),
        }
    }

    fn status_from_event(&self, raw: Option<&Value>) -> Option<&'static str> {
        let raw = raw?;
        match raw.get("method").and_then(Value::as_str) {
            Some("turn/started") => Some("running"),
            Some("turn/completed") => Some("waiting_for_input"),
            _ if raw.get("type").and_then(Value::as_str) == Some("codesk.control.ack")
                && raw.get("accepted").and_then(Value::as_bool) == Some(false) =>
            {
                Some("waiting_for_input")
            }
            _ => None,
        }
    }

    fn interrupt_event_type(&self) -> &'static str {
        "codex.turn/interrupt"
    }

    fn matches_command(&self, command: &str) -> bool {
        support::command_tokens(&command.to_lowercase()).contains(&"codex")
    }

    fn command_session_id(&self, command: &str) -> Option<String> {
        let tokens = support::command_tokens(command);
        for (index, token) in tokens.iter().enumerate() {
            if !matches!(*token, "resume" | "fork" | "--resume") {
                continue;
            }
            let value = tokens.get(index + 1)?;
            if Uuid::parse_str(value).is_ok() {
                return Some((*value).to_string());
            }
        }
        None
    }

    fn transcript_matches(&self, path: &str) -> bool {
        path.ends_with(".jsonl") && path.contains("/.codex/sessions/")
    }

    fn transcript_session_id(&self, path: &str) -> Option<String> {
        let stem = PathBuf::from(path).file_stem()?.to_str()?.to_string();
        stem.get(stem.len().checked_sub(36)?..)
            .filter(|value| Uuid::parse_str(value).is_ok())
            .map(str::to_string)
    }

    fn index_sessions(&self, project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
        sessions::index_codex(project, limit)
    }

    fn session_messages(
        &self,
        project: &Project,
        native_session_id: &str,
        after: Option<&str>,
    ) -> Result<Vec<SessionMessage>> {
        sessions::codex_messages_for_project(project, native_session_id, after)
    }

    fn transcript_turn_active(&self, path: &Path) -> bool {
        sessions::transcript_turn_active(path, DESCRIPTOR.id)
    }
}

/// Codex's reasoning levels: the id its status line prints, and the row label
/// its picker shows for the same level.
pub(crate) static EFFORT_LEVELS: [EffortLevel; 6] = [
    EffortLevel {
        id: "low",
        label: "Low",
    },
    EffortLevel {
        id: "medium",
        label: "Medium",
    },
    EffortLevel {
        id: "high",
        label: "High",
    },
    EffortLevel {
        id: "xhigh",
        label: "Extra high",
    },
    EffortLevel {
        id: "max",
        label: "Max",
    },
    EffortLevel {
        id: "ultra",
        label: "Ultra",
    },
];

/// The three pages of Codex's `/model` picker. `Max` and `Ultra` live behind a
/// `More reasoning…` row on the reasoning page.
pub(crate) const MODEL_HEADING: &str = "Select Model and Effort";
pub(crate) const REASONING_HEADING: &str = "Select Reasoning Level";
pub(crate) const ADVANCED_HEADING: &str = "Advanced Reasoning";
const PICKER_FOOTER: &str = "Press enter to confirm or esc to go back";

/// The startup dialogs that stand between a new pane and its composer.
const TRUST_HEADING: &str = "Do you trust the contents of this directory";
const UPDATE_HEADING: &str = "Update available!";

/// Codex paints `gpt-5.6-sol high · Context 100% left · /path` under the
/// composer and keeps it there during a turn, so it is the only place a
/// terminal-driven Codex session reports its live model and effort. The
/// remaining context is what tells that line apart from prose: a session that
/// has never been given a reasoning level reports `default` where the level
/// belongs, and a model name is an arbitrary token.
pub(crate) fn parse_status_line(screen: &str) -> Option<TerminalStatus> {
    for line in screen.lines().rev() {
        let fields = line
            .split('\u{b7}')
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .collect::<Vec<_>>();
        if fields.len() < 2 {
            continue;
        }
        let Some(context_percentage) = fields.iter().find_map(|field| {
            field
                .strip_prefix("Context ")?
                .trim_end_matches(" left")
                .trim_end_matches('%')
                .parse::<f64>()
                .ok()
        }) else {
            continue;
        };
        let mut head = fields[0].split_whitespace();
        let Some(model) = head.next() else { continue };
        let effort = head.next();
        if head.next().is_some() {
            continue;
        }
        return Some(TerminalStatus {
            model: Some(model.to_string()),
            effort: effort.map(str::to_string),
            agent: None,
            context_percentage: Some(context_percentage),
        });
    }
    None
}

/// One numbered row of a Codex picker page, for example
/// `› 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.`
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PickerRow {
    pub number: usize,
    pub head: String,
    pub description: String,
    /// The value the session is using, marked `(current)`.
    pub current: bool,
    /// The row the picker's cursor sits on, marked `›`.
    pub selected: bool,
}

/// Read the rows of one picker page. Rows are only taken from below the page
/// heading, so a numbered list printed by the model earlier in the
/// conversation cannot be mistaken for a menu.
pub(crate) fn parse_picker_page(screen: &str, heading: &str) -> Vec<PickerRow> {
    let Some(start) = screen.rfind(heading) else {
        return Vec::new();
    };
    screen[start..]
        .lines()
        .skip(1)
        .take_while(|line| !line.contains("Press enter to"))
        .filter_map(parse_picker_row)
        .collect()
}

fn screen_tail(screen: &str, lines: usize) -> String {
    let visible = screen
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    visible[visible.len().saturating_sub(lines)..].join("\n")
}

/// tmux takes a key by name, and a row is chosen by typing its number.
fn digit_key(number: usize) -> Option<&'static str> {
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
        .get(number.checked_sub(1)?)
        .copied()
}

fn parse_picker_row(line: &str) -> Option<PickerRow> {
    let cursor = ['\u{203a}', '\u{276f}', '>'];
    let row = line.trim_start_matches([' ']).trim_end();
    let selected = row.starts_with(cursor);
    let (number, rest) = row
        .trim_start_matches(cursor)
        .trim_start()
        .split_once(". ")?;
    let number = number.parse::<usize>().ok()?;
    // Codex separates a row's value from its description with a run of padding
    // spaces.
    let (head, description) = rest.split_once("  ").unwrap_or((rest, ""));
    Some(PickerRow {
        number,
        selected,
        current: head.contains("(current)"),
        head: head
            .replace("(current)", "")
            .replace("(default)", "")
            .trim()
            .to_string(),
        description: description.trim().to_string(),
    })
}

/// Parse Codex's model page. The whole catalog fits on one page, so there is
/// no remainder to report and no paging to do.
pub(crate) fn parse_model_page(screen: &str) -> ModelPage {
    let models = parse_picker_page(screen, MODEL_HEADING)
        .into_iter()
        .map(|row| {
            json!({
                "id": row.head,
                "description": row.description,
                "active": row.current,
            })
        })
        .collect();
    ModelPage { models, more: None }
}

/// The row number that selects `value` on a page, matching the picker's own
/// label rather than an id Codesk invented.
pub(crate) fn row_number(rows: &[PickerRow], value: &str) -> Option<usize> {
    rows.iter()
        .find(|row| row.head == value)
        .map(|row| row.number)
}

/// The row that opens the `Max` and `Ultra` submenu.
pub(crate) fn more_reasoning_row(rows: &[PickerRow]) -> Option<usize> {
    rows.iter()
        .find(|row| row.head.starts_with("More reasoning"))
        .map(|row| row.number)
}

pub(crate) fn current_row(rows: &[PickerRow]) -> Option<usize> {
    rows.iter().find(|row| row.current).map(|row| row.number)
}

pub(crate) fn selected_row(rows: &[PickerRow]) -> Option<usize> {
    rows.iter().find(|row| row.selected).map(|row| row.number)
}

/// The row that leaves this page's value as it is. A model that was never
/// given an explicit reasoning level has no `(current)` row at all, so fall
/// back to where Codex put its own cursor.
pub(crate) fn unchanged_row(rows: &[PickerRow]) -> Option<usize> {
    current_row(rows).or_else(|| selected_row(rows))
}

pub(crate) fn effort_label(id: &str) -> Option<&'static str> {
    EFFORT_LEVELS
        .iter()
        .find(|level| level.id == id)
        .map(|level| level.label)
}

#[cfg(test)]
mod tests {
    use super::{
        ADAPTER, ADVANCED_HEADING, MODEL_HEADING, REASONING_HEADING, current_row, effort_label,
        more_reasoning_row, parse_model_page, parse_picker_page, parse_status_line, row_number,
        selected_row, unchanged_row,
    };
    use crate::providers::ProviderAdapter;

    // Verbatim captures from a real `codex --yolo` pane at 80 columns.
    const IDLE: &str = "\u{25a0} Conversation interrupted - tell the model what to do differently.\n\u{203a} Explain this codebase\n  gpt-5.6-sol high \u{b7} Context 100% left \u{b7} /private/tmp/probe-workspace\n";
    const BUSY: &str = "\u{203a} reply with exactly OK\n\u{2022} Working (14s \u{2022} esc to interrupt)\n\u{203a} Explain this codebase\n  gpt-5.6-sol xhigh \u{b7} Context 98% left \u{b7} /private/tmp/probe-workspace\n";
    const MODEL_PAGE: &str = "  Select Model and Effort\n  Access legacy models by running codex -m <model_name> or in your config.toml\n\u{203a} 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.\n  2. gpt-5.6-terra          Balanced agentic coding model for everyday work.\n  3. gpt-5.6-luna           Fast and affordable agentic coding model.\n  4. gpt-5.5                Frontier model for complex coding, research, and real-world work.\n  5. gpt-5.2                Optimized for professional work and long-running agents.\n  Press enter to confirm or esc to go back\n";
    const REASONING_PAGE: &str = "  Select Reasoning Level for gpt-5.6-sol\n  1. Low (default)    Fast responses with lighter reasoning\n  2. Medium           Balances speed and reasoning depth for everyday tasks\n\u{203a} 3. High (current)   Greater reasoning depth for complex problems\n  4. Extra high       Extra high reasoning depth for complex problems\n  5. More reasoning\u{2026}  Max and Ultra consume usage limits faster\n  Press enter to confirm or esc to go back\n";
    // Switching models opens a reasoning page for a model that was never given
    // a level: nothing is marked `(current)` and the cursor sits on the default.
    const UNSET_REASONING_PAGE: &str = "  Select Reasoning Level for gpt-5.6-terra\n  1. Low                Fast responses with lighter reasoning\n\u{203a} 2. Medium (default)  Balances speed and reasoning depth for everyday tasks\n  3. High               Greater reasoning depth for complex problems\n  4. Extra high         Extra high reasoning depth for complex problems\n  5. More reasoning\u{2026}   Max and Ultra consume usage limits faster\n  Press enter to confirm or esc to go back\n";
    // Verbatim first screens of `codex --yolo` in a new directory.
    const UPDATE_DIALOG: &str = "  \u{2728} Update available! 0.147.0 -> 0.149.1\n  Release notes: https://github.com/openai/codex/releases/latest\n\u{203a} 1. Update now (runs `npm install -g @openai/codex`)\n  2. Skip\n  3. Skip until next version\n  Press enter to continue\n";
    const TRUST_DIALOG: &str = "  Welcome to Codex, OpenAI's command-line coding agent\n> You are in /private/tmp/fresh\n  Do you trust the contents of this directory? Working with untrusted contents\n  comes with higher risk of prompt injection.\n\u{203a} 1. Yes, continue\n  2. No, quit\n  Press enter to continue\n";
    const ADVANCED_PAGE: &str = "  Advanced Reasoning\n  \u{26a0} Consumes usage limits faster\n\u{203a} 1. Max    For difficult problems when quality matters more than speed \u{b7} higher usage\n  2. Ultra  For demanding work using multiple agents \u{b7} highest usage\n  Press enter to confirm or esc to go back\n";

    #[test]
    fn reads_the_live_model_and_effort_from_the_status_line() {
        let status = parse_status_line(IDLE).expect("status line should parse");
        assert_eq!(status.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(status.effort.as_deref(), Some("high"));
        assert_eq!(status.context_percentage, Some(100.0));

        // The status line stays painted while a turn runs.
        let busy = parse_status_line(BUSY).expect("status line should parse while busy");
        assert_eq!(busy.effort.as_deref(), Some("xhigh"));
        assert_eq!(busy.context_percentage, Some(98.0));
    }

    #[test]
    fn reads_a_session_that_was_never_given_a_reasoning_level() {
        let status = parse_status_line(
            "  gpt-5.6-sol default \u{b7} Context 100% left \u{b7} /tmp/workspace\n",
        )
        .expect("status line should parse");
        assert_eq!(status.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(status.effort.as_deref(), Some("default"));
    }

    #[test]
    fn ignores_screens_without_a_status_line() {
        assert!(parse_status_line("\u{203a} Explain this codebase\n").is_none());
        // Picker rows carry separators of their own.
        assert!(parse_status_line(ADVANCED_PAGE).is_none());
        // So does prose the model writes.
        assert!(parse_status_line("  one thing \u{b7} another thing\n").is_none());
    }

    #[test]
    fn treats_a_running_turn_as_not_ready() {
        assert!(ADAPTER.terminal_ready(IDLE));
        assert!(!ADAPTER.terminal_ready(BUSY));
        assert!(!ADAPTER.terminal_ready("codex booting\n"));
    }

    #[test]
    fn sees_an_open_picker_but_not_a_startup_dialog() {
        assert!(ADAPTER.terminal_picker_open(MODEL_PAGE));
        assert!(ADAPTER.terminal_picker_open(ADVANCED_PAGE));
        assert!(!ADAPTER.terminal_picker_open(IDLE));
        // Escape quits this one instead of walking back a page.
        assert!(!ADAPTER.terminal_picker_open(TRUST_DIALOG));
        // A picker that was already answered is only scrollback.
        assert!(!ADAPTER.terminal_picker_open(&format!("{MODEL_PAGE}{IDLE}")));
    }

    #[test]
    fn parses_the_model_page_and_marks_the_current_model() {
        let page = parse_model_page(MODEL_PAGE);
        assert_eq!(page.more, None);
        assert_eq!(page.models.len(), 5);
        assert_eq!(page.models[0]["id"], "gpt-5.6-sol");
        assert_eq!(page.models[0]["active"], true);
        assert_eq!(
            page.models[0]["description"],
            "Latest frontier agentic coding model."
        );
        assert_eq!(page.models[1]["id"], "gpt-5.6-terra");
        assert_eq!(page.models[1]["active"], false);
    }

    #[test]
    fn reads_a_numbered_row_for_every_reasoning_level() {
        let rows = parse_picker_page(REASONING_PAGE, REASONING_HEADING);
        assert_eq!(current_row(&rows), Some(3));
        assert_eq!(selected_row(&rows), Some(3));
        assert_eq!(row_number(&rows, effort_label("low").unwrap()), Some(1));
        assert_eq!(row_number(&rows, effort_label("xhigh").unwrap()), Some(4));
        // Max and Ultra are only reachable through the submenu.
        assert_eq!(row_number(&rows, effort_label("max").unwrap()), None);
        assert_eq!(more_reasoning_row(&rows), Some(5));

        let unset = parse_picker_page(UNSET_REASONING_PAGE, REASONING_HEADING);
        assert_eq!(current_row(&unset), None);
        // Keeping the effort means confirming the row Codex already sits on.
        assert_eq!(unchanged_row(&unset), Some(2));
        assert_eq!(unchanged_row(&rows), Some(3));

        let advanced = parse_picker_page(ADVANCED_PAGE, ADVANCED_HEADING);
        assert_eq!(row_number(&advanced, effort_label("max").unwrap()), Some(1));
        assert_eq!(
            row_number(&advanced, effort_label("ultra").unwrap()),
            Some(2)
        );
        assert_eq!(
            advanced[0].description,
            "For difficult problems when quality matters more than speed \u{b7} higher usage"
        );
    }

    #[test]
    fn answers_the_startup_dialogs_without_pressing_enter() {
        assert_eq!(ADAPTER.terminal_startup_key(UPDATE_DIALOG), Some("2"));
        assert_eq!(ADAPTER.terminal_startup_key(TRUST_DIALOG), Some("1"));
        assert_eq!(ADAPTER.terminal_startup_key(IDLE), None);
        assert!(!ADAPTER.terminal_ready(TRUST_DIALOG));
        // An answered dialog scrolls up but stays in the captured scrollback,
        // and answering it twice types a stray digit into the composer.
        assert_eq!(
            ADAPTER.terminal_startup_key(&format!("{TRUST_DIALOG}{IDLE}")),
            None
        );
        // An open picker covers the status line, so the scrollback is all
        // there is to go on and the dialog still must not be answered again.
        assert_eq!(
            ADAPTER.terminal_startup_key(&format!("{TRUST_DIALOG}{MODEL_PAGE}")),
            None
        );
    }

    #[test]
    fn ignores_numbered_lines_outside_the_picker() {
        let transcript = "  1. first step\n  2. second step\n";
        assert!(parse_picker_page(transcript, MODEL_HEADING).is_empty());
        assert!(parse_model_page(transcript).models.is_empty());
    }
}
