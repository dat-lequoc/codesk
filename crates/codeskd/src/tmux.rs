use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result};
use tokio::{io::AsyncWriteExt, process::Command};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct TmuxManager {
    data_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TmuxPane {
    pub socket_path: Option<String>,
    pub pane_id: String,
    pub session_name: String,
    pub tty: String,
    pub pane_pid: u32,
    pub dead: bool,
    pub in_mode: bool,
    pub current_command: String,
    pub current_path: String,
    pub controlled: bool,
    pub control_id: Option<String>,
    pub owned: bool,
}

#[derive(Clone, Debug)]
pub struct TmuxLaunch {
    pub pane: TmuxPane,
    pub access_command: String,
}

impl TmuxManager {
    pub fn new(data_root: PathBuf) -> Self {
        Self { data_root }
    }

    pub fn owned_socket(&self) -> PathBuf {
        self.data_root.join("tmux").join("codesk.sock")
    }

    pub async fn available(&self) -> bool {
        Command::new("tmux")
            .arg("-V")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success())
    }

    pub async fn panes(&self) -> Result<Vec<TmuxPane>> {
        self.panes_with_extra(&[]).await
    }

    /// Same as [`Self::panes`], plus any sockets discovered from a live process
    /// (`TMUX=…`). Codesk otherwise only sees the default server and its own
    /// socket, so a user session on `tmux -L` / `tmux -S` looks like a bare tty.
    pub async fn panes_with_extra(&self, extra: &[PathBuf]) -> Result<Vec<TmuxPane>> {
        let owned = self.owned_socket();
        let mut sockets = discover_tmux_sockets().await;
        for path in extra {
            if !path.as_os_str().is_empty() && !sockets.iter().any(|existing| existing == path) {
                sockets.push(path.clone());
            }
        }
        let mut panes = Vec::new();
        if sockets.is_empty() {
            panes.extend(list_panes(None, false).await?);
        }
        for socket in &sockets {
            panes.extend(list_panes(Some(socket), socket == &owned).await?);
        }
        if !sockets.iter().any(|socket| socket == &owned) {
            panes.extend(list_panes(Some(&owned), true).await?);
        }
        panes.sort_by(|left, right| {
            left.session_name
                .cmp(&right.session_name)
                .then_with(|| left.pane_id.cmp(&right.pane_id))
        });
        panes.dedup_by(|left, right| {
            left.socket_path == right.socket_path && left.pane_id == right.pane_id
        });
        Ok(panes)
    }

    pub async fn launch(
        &self,
        provider: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        control_id: &str,
        environment: Option<&BTreeMap<String, String>>,
        keep_parent_shell: bool,
    ) -> Result<TmuxLaunch> {
        anyhow::ensure!(self.available().await, "tmux is not installed on this host");
        let socket = self.owned_socket();
        if let Some(parent) = socket.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let name = unique_session_name(provider);
        let shell_command = if keep_parent_shell {
            parent_shell_command_with_environment(command, args, environment)
        } else {
            shell_command_with_environment(command, args, environment)
        };
        let output = Command::new("tmux")
            .args([
                "-S",
                socket.to_string_lossy().as_ref(),
                "new-session",
                "-d",
                "-s",
                &name,
                "-c",
                cwd,
                &shell_command,
            ])
            .output()
            .await
            .context("start Codesk tmux session")?;
        anyhow::ensure!(
            output.status.success(),
            "tmux could not start the session: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        let mut panes = list_panes(Some(&socket), true).await?;
        let pane = panes
            .drain(..)
            .find(|pane| pane.session_name == name)
            .context("tmux session started without a pane")?;
        set_pane_option(Some(&socket), &pane.pane_id, "@codesk_controlled", "1").await?;
        set_pane_option(
            Some(&socket),
            &pane.pane_id,
            "@codesk_control_id",
            control_id,
        )
        .await?;
        set_pane_option(Some(&socket), &pane.pane_id, "@codesk_provider", provider).await?;
        let pane = list_panes(Some(&socket), true)
            .await?
            .into_iter()
            .find(|candidate| candidate.pane_id == pane.pane_id)
            .context("tmux pane disappeared after launch")?;
        Ok(TmuxLaunch {
            access_command: access_command(Some(&socket), &name),
            pane,
        })
    }

    pub async fn enable_control(
        &self,
        pane: &TmuxPane,
        control_id: &str,
        provider: &str,
    ) -> Result<()> {
        let socket = pane.socket_path.as_deref().map(Path::new);
        set_pane_option(socket, &pane.pane_id, "@codesk_controlled", "1").await?;
        set_pane_option(socket, &pane.pane_id, "@codesk_control_id", control_id).await?;
        set_pane_option(socket, &pane.pane_id, "@codesk_provider", provider).await?;
        Ok(())
    }

    pub async fn disable_control(&self, pane: &TmuxPane) -> Result<()> {
        let socket = pane.socket_path.as_deref().map(Path::new);
        unset_pane_option(socket, &pane.pane_id, "@codesk_controlled").await?;
        unset_pane_option(socket, &pane.pane_id, "@codesk_control_id").await?;
        unset_pane_option(socket, &pane.pane_id, "@codesk_provider").await?;
        Ok(())
    }

    pub async fn send_prompt(&self, pane: &TmuxPane, message: &str) -> Result<()> {
        anyhow::ensure!(!pane.dead, "the tmux pane has exited");
        anyhow::ensure!(!pane.in_mode, "leave tmux copy mode before sending input");
        let socket = pane.socket_path.as_deref().map(Path::new);
        let buffer = format!("codesk-{}", Uuid::new_v4().simple());
        let mut command = tmux_command(socket);
        command
            .args(["load-buffer", "-b", &buffer, "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().context("create tmux paste buffer")?;
        child
            .stdin
            .take()
            .context("tmux buffer stdin is unavailable")?
            .write_all(message.as_bytes())
            .await?;
        let output = child.wait_with_output().await?;
        anyhow::ensure!(
            output.status.success(),
            "tmux could not create the paste buffer: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        run_tmux(
            socket,
            &[
                "paste-buffer",
                "-p",
                "-d",
                "-b",
                &buffer,
                "-t",
                &pane.pane_id,
            ],
        )
        .await?;
        // Harness TUIs (Codex among them) treat keys arriving in the same burst
        // as a paste as pasted text, so an immediate Enter becomes a newline in
        // the composer and the prompt silently never submits. Let the paste
        // burst window close before pressing Enter.
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        run_tmux(socket, &["send-keys", "-t", &pane.pane_id, "Enter"]).await?;
        Ok(())
    }

    pub async fn capture_text(&self, pane: &TmuxPane) -> Result<String> {
        self.capture_text_tail(pane, 100).await
    }

    /// Capture only the last `lines` of scrollback. Status-line checks need a
    /// screenful at most, and every extra line is bytes tmux serializes on a
    /// hot polling path.
    pub async fn capture_text_tail(&self, pane: &TmuxPane, lines: u32) -> Result<String> {
        let socket = pane.socket_path.as_deref().map(Path::new);
        let start = format!("-{lines}");
        let output = tmux_command(socket)
            .args(["capture-pane", "-p", "-S", &start, "-t", &pane.pane_id])
            .output()
            .await
            .context("capture tmux pane")?;
        anyhow::ensure!(
            output.status.success(),
            "tmux could not capture the pane: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    pub async fn send_key(&self, pane: &TmuxPane, key: &str) -> Result<()> {
        let socket = pane.socket_path.as_deref().map(Path::new);
        run_tmux(socket, &["send-keys", "-t", &pane.pane_id, key]).await
    }

    pub async fn interrupt(&self, pane: &TmuxPane) -> Result<()> {
        let socket = pane.socket_path.as_deref().map(Path::new);
        run_tmux(socket, &["send-keys", "-t", &pane.pane_id, "C-c"]).await
    }

    pub async fn kill_pane(&self, pane: &TmuxPane) -> Result<()> {
        let socket = pane.socket_path.as_deref().map(Path::new);
        run_tmux(socket, &["kill-pane", "-t", &pane.pane_id]).await
    }

    pub async fn pane(&self, socket_path: Option<&str>, pane_id: &str) -> Result<Option<TmuxPane>> {
        Ok(
            list_panes(socket_path.map(Path::new), socket_path.is_some())
                .await?
                .into_iter()
                .find(|pane| pane.pane_id == pane_id),
        )
    }

    /// Snapshot every pane reachable on the given sockets, spawning one `tmux`
    /// process per distinct socket rather than one per pane.
    ///
    /// The supervisor loop resolves several controls on every tick. Looking each
    /// one up with [`Self::pane`] spawned a subprocess per control per tick,
    /// which dominates idle cost once more than one session is supervised.
    /// Sockets repeat heavily in practice — usually just the Codesk-owned socket
    /// plus the user's default one — so batching collapses that to a constant.
    pub async fn pane_snapshot(&self, sockets: &[Option<String>]) -> PaneSnapshot {
        let mut distinct: Vec<Option<String>> = Vec::new();
        for socket in sockets {
            if !distinct.contains(socket) {
                distinct.push(socket.clone());
            }
        }
        let mut panes = BTreeMap::new();
        for socket in distinct {
            let listed = list_panes(socket.as_deref().map(Path::new), socket.is_some())
                .await
                .unwrap_or_default();
            for pane in listed {
                panes.insert((socket.clone(), pane.pane_id.clone()), pane);
            }
        }
        PaneSnapshot { panes }
    }
}

/// Panes observed during one supervisor tick, keyed by socket and pane id.
#[derive(Debug, Default)]
pub struct PaneSnapshot {
    panes: BTreeMap<(Option<String>, String), TmuxPane>,
}

impl PaneSnapshot {
    pub fn get(&self, socket_path: Option<&str>, pane_id: &str) -> Option<&TmuxPane> {
        self.panes
            .get(&(socket_path.map(str::to_string), pane_id.to_string()))
    }
}

pub fn access_command(socket: Option<&Path>, session_name: &str) -> String {
    // `=` forces an exact session name. Without it, `attach -t codesk-kiro-…`
    // can land on a user's session named `codesk` because tmux treats the
    // target as a prefix. `TMUX=` is required when the command is pasted
    // inside another tmux client: attach otherwise talks to that server and
    // refuses to nest.
    let target = format!("={session_name}");
    let attach = match socket {
        Some(socket) => format!(
            "tmux -S {} attach-session -t {}",
            shell_quote(socket.to_string_lossy().as_ref()),
            shell_quote(&target)
        ),
        None => format!("tmux attach-session -t {}", shell_quote(&target)),
    };
    format!("TMUX= {attach}")
}

pub fn resume_command_from_original(
    provider: &str,
    original_command: &str,
    native_session_id: &str,
) -> Result<(String, Vec<String>)> {
    let tokens = shell_words::split(original_command).context("parse provider command")?;
    anyhow::ensure!(!tokens.is_empty(), "provider command is empty");
    let expected = match provider {
        "codex" => &["codex"][..],
        "claude" => &["claude"][..],
        "kiro" => &["kiro-cli", "kiro-cli-chat"][..],
        "pi" => &["pi"][..],
        "opencode" => &["opencode"][..],
        "dsh" => &["dsh"][..],
        "agy" => &["agy"][..],
        _ => anyhow::bail!("{provider} cannot be moved to tmux"),
    };
    let binary_index = tokens
        .iter()
        .position(|token| {
            Path::new(token)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| expected.contains(&name))
        })
        .unwrap_or(0);
    let command = tokens[binary_index].clone();
    let preserved = preserved_options(provider, &tokens[binary_index + 1..]);
    let mut args = match provider {
        "codex" => vec!["resume".into(), native_session_id.into()],
        "claude" => vec!["--resume".into(), native_session_id.into()],
        "kiro" => vec![
            "chat".into(),
            "--resume-id".into(),
            native_session_id.into(),
        ],
        "pi" => vec!["--session".into(), native_session_id.into()],
        "opencode" => vec!["--session".into(), native_session_id.into()],
        "dsh" => vec![
            "--profile".into(),
            "tui".into(),
            "--resume".into(),
            native_session_id.into(),
        ],
        "agy" => vec!["--conversation".into(), native_session_id.into()],
        _ => unreachable!(),
    };
    args.extend(preserved);
    Ok((command, args))
}

fn preserved_options(provider: &str, tokens: &[String]) -> Vec<String> {
    let excluded = match provider {
        "codex" => &["--resume", "resume", "fork"][..],
        "claude" => &[
            "--resume",
            "--fork-session",
            "--print",
            "-p",
            "--output-format",
            "--verbose",
        ][..],
        "kiro" => &["chat", "--resume-id", "acp"][..],
        "pi" => &["--session", "--session-id", "--fork", "--mode"][..],
        "opencode" => &["--session", "-s", "acp", "run"][..],
        "dsh" => &["--resume", "--profile", "web"][..],
        "agy" => &["--conversation", "--print", "--output-format"][..],
        _ => &[][..],
    };
    let boolean = [
        "--yolo",
        "--full-auto",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-skip-permissions",
        "--no-alt-screen",
        "--oss",
    ];
    let mut result = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if excluded.contains(&token.as_str()) {
            index += 1;
            if token.starts_with('-')
                && !boolean.contains(&token.as_str())
                && tokens
                    .get(index)
                    .is_some_and(|value| !value.starts_with('-'))
            {
                index += 1;
            }
            continue;
        }
        if token.starts_with('-') {
            result.push(token.clone());
            if !token.contains('=')
                && !boolean.contains(&token.as_str())
                && tokens
                    .get(index + 1)
                    .is_some_and(|value| !value.starts_with('-'))
            {
                result.push(tokens[index + 1].clone());
                index += 1;
            }
        }
        index += 1;
    }
    result
}

fn unique_session_name(provider: &str) -> String {
    let provider = provider
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
        .collect::<String>();
    format!(
        "codesk-{}-{}",
        provider,
        &Uuid::new_v4().simple().to_string()[..8]
    )
}

fn shell_command(command: &str, args: &[String]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_command_with_environment(
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
) -> String {
    let Some(environment) = environment.filter(|values| !values.is_empty()) else {
        return shell_command(command, args);
    };
    let assignments = environment
        .iter()
        .map(|(key, value)| format!("{key}={}", shell_quote(value)))
        .collect::<Vec<_>>()
        .join(" ");
    format!("env {assignments} {}", shell_command(command, args))
}

fn parent_shell_command_with_environment(
    command: &str,
    args: &[String],
    environment: Option<&BTreeMap<String, String>>,
) -> String {
    let exports = environment
        .filter(|values| !values.is_empty())
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| format!("export {key}={}", shell_quote(value)))
                .collect::<Vec<_>>()
                .join("; ")
        });
    let script = match exports {
        Some(exports) => format!("{exports}; \"$@\"; status=$?; exit \"$status\""),
        None => "\"$@\"; status=$?; exit \"$status\"".to_string(),
    };
    let mut wrapped = vec![
        "-c".to_string(),
        script,
        "codesk-terminal".to_string(),
        command.to_string(),
    ];
    wrapped.extend(args.iter().cloned());
    shell_command("/bin/sh", &wrapped)
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_@%+=:,./-".contains(character))
    {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn tmux_socket_directories(
    uid: u32,
    tmux_tmpdir: Option<&str>,
    tmpdir: Option<&str>,
    xdg_runtime: Option<&str>,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut push = |root: PathBuf| {
        if root.as_os_str().is_empty() {
            return;
        }
        let directory = root.join(format!("tmux-{uid}"));
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    };
    if let Some(value) = tmux_tmpdir {
        push(PathBuf::from(value));
    }
    if let Some(value) = tmpdir {
        push(PathBuf::from(value));
    }
    if let Some(value) = xdg_runtime {
        push(PathBuf::from(value));
    }
    push(PathBuf::from("/tmp"));
    push(PathBuf::from("/var/tmp"));
    push(PathBuf::from(format!("/run/user/{uid}")));
    directories
}

fn is_tmux_socket_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.ends_with(".lock")
}

async fn discover_tmux_sockets() -> Vec<PathBuf> {
    let uid = unsafe { libc::getuid() };
    let directories = tmux_socket_directories(
        uid,
        std::env::var("TMUX_TMPDIR").ok().as_deref(),
        std::env::var("TMPDIR").ok().as_deref(),
        std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
    );
    let mut sockets = Vec::new();
    for directory in directories {
        let Ok(mut entries) = tokio::fs::read_dir(&directory).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !is_tmux_socket_name(name) {
                continue;
            }
            let path = entry.path();
            if tokio::fs::metadata(&path)
                .await
                .is_ok_and(|metadata| metadata.is_dir())
            {
                continue;
            }
            sockets.push(path);
        }
    }
    sockets.sort();
    sockets.dedup();
    sockets
}

async fn list_panes(socket: Option<&Path>, owned: bool) -> Result<Vec<TmuxPane>> {
    let format = "#{pane_id}\x1f#{session_name}\x1f#{pane_tty}\x1f#{pane_pid}\x1f#{pane_dead}\x1f#{pane_in_mode}\x1f#{pane_current_command}\x1f#{pane_current_path}\x1f#{@codesk_controlled}\x1f#{@codesk_control_id}";
    let output = tmux_command(socket)
        .args(["list-panes", "-a", "-F", format])
        .output()
        .await;
    let Ok(output) = output else {
        return Ok(Vec::new());
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let socket_path = socket.map(|path| path.to_string_lossy().into_owned());
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| parse_pane_line(line, socket_path.clone(), owned))
        .collect())
}

/// tmux escapes non-printable bytes as octal (`\037`) when its output is a
/// pipe rather than a terminal — which it always is for a daemon. Undo that
/// (and `\\`) so the 0x1f field separator survives the round trip.
fn unescape_tmux_visual(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' && index + 3 < bytes.len() {
            let digits = &bytes[index + 1..index + 4];
            if digits.iter().all(|byte| (b'0'..=b'7').contains(byte)) {
                let value = digits
                    .iter()
                    .fold(0u32, |total, byte| total * 8 + u32::from(byte - b'0'));
                if value <= 0xff {
                    result.push(value as u8);
                    index += 4;
                    continue;
                }
            }
        }
        if bytes[index] == b'\\' && bytes.get(index + 1) == Some(&b'\\') {
            result.push(b'\\');
            index += 2;
            continue;
        }
        result.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&result).into_owned()
}

fn parse_pane_line(line: &str, socket_path: Option<String>, owned: bool) -> Option<TmuxPane> {
    let line = unescape_tmux_visual(line);
    let fields = line.split('\x1f').collect::<Vec<_>>();
    if fields.len() != 10 {
        return None;
    }
    Some(TmuxPane {
        socket_path,
        pane_id: fields[0].to_string(),
        session_name: fields[1].to_string(),
        tty: normalize_tty(fields[2]),
        pane_pid: fields[3].parse().ok()?,
        dead: fields[4] == "1",
        in_mode: fields[5] == "1",
        current_command: fields[6].to_string(),
        current_path: fields[7].to_string(),
        controlled: fields[8] == "1",
        control_id: (!fields[9].is_empty()).then(|| fields[9].to_string()),
        owned,
    })
}

pub fn normalize_tty(value: &str) -> String {
    value.trim().trim_start_matches("/dev/").to_string()
}

async fn set_pane_option(
    socket: Option<&Path>,
    pane_id: &str,
    option: &str,
    value: &str,
) -> Result<()> {
    run_tmux(socket, &["set-option", "-p", "-t", pane_id, option, value]).await
}

async fn unset_pane_option(socket: Option<&Path>, pane_id: &str, option: &str) -> Result<()> {
    run_tmux(socket, &["set-option", "-pu", "-t", pane_id, option]).await
}

fn tmux_command(socket: Option<&Path>) -> Command {
    let mut command = Command::new("tmux");
    if let Some(socket) = socket {
        command.arg("-S").arg(socket);
    }
    command
}

async fn run_tmux(socket: Option<&Path>, args: &[&str]) -> Result<()> {
    let output = tmux_command(socket).args(args).output().await?;
    anyhow::ensure!(
        output.status.success(),
        "tmux command failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_and_owned_panes() {
        let line =
            "%7\x1fwork\x1f/dev/ttys003\x1f123\x1f0\x1f0\x1fcodex\x1f/repo\x1f1\x1fcontrol-1";
        let pane = parse_pane_line(line, None, false).unwrap();
        assert_eq!(pane.pane_id, "%7");
        assert_eq!(pane.tty, "ttys003");
        assert!(pane.controlled);
        assert_eq!(pane.control_id.as_deref(), Some("control-1"));
        assert!(!pane.owned);
    }

    #[test]
    fn preserves_codex_yolo_when_resuming() {
        let session = "019ff788-c44a-7e23-a9fa-8733e15a3990";
        let (command, args) = resume_command_from_original(
            "codex",
            "/opt/homebrew/bin/codex --yolo --model gpt-5.6-sol",
            session,
        )
        .unwrap();
        assert_eq!(command, "/opt/homebrew/bin/codex");
        assert_eq!(
            args,
            ["resume", session, "--yolo", "--model", "gpt-5.6-sol"]
        );
    }

    #[test]
    fn parses_pane_lines_with_octal_escaped_separators() {
        // tmux 3.4 on Linux pipes: `\037` instead of the raw 0x1f separator.
        let escaped = "%0\\037codesk-codex-4c92e1d5\\037/dev/pts/3\\0373284414\\0370\\0370\\037node\\037/root/dev\\037\\037";
        let pane = parse_pane_line(escaped, None, true).expect("escaped line parses");
        assert_eq!(pane.pane_id, "%0");
        assert_eq!(pane.session_name, "codesk-codex-4c92e1d5");
        assert_eq!(pane.tty, "pts/3");
        assert_eq!(pane.pane_pid, 3284414);
        assert!(!pane.dead);
        assert!(!pane.controlled);

        // Raw separators (interactive tmux, macOS) must keep working.
        let raw = "%1\u{1f}work\u{1f}/dev/ttys002\u{1f}77\u{1f}0\u{1f}0\u{1f}zsh\u{1f}/repo\u{1f}1\u{1f}control-1";
        let pane = parse_pane_line(raw, Some("/tmp/s".into()), false).expect("raw line parses");
        assert_eq!(pane.session_name, "work");
        assert!(pane.controlled);
        assert_eq!(pane.control_id.as_deref(), Some("control-1"));

        // A literal backslash in a path arrives doubled and must be restored.
        assert_eq!(unescape_tmux_visual("a\\\\b"), "a\\b");
    }

    #[test]
    fn access_commands_are_copyable_and_shell_safe() {
        assert_eq!(
            access_command(None, "work"),
            "TMUX= tmux attach-session -t =work"
        );
        assert_eq!(
            access_command(Some(Path::new("/tmp/Codesk data/codesk.sock")), "chat one"),
            "TMUX= tmux -S '/tmp/Codesk data/codesk.sock' attach-session -t '=chat one'"
        );
    }

    #[test]
    fn shell_command_quotes_multiline_and_unicode_arguments() {
        assert_eq!(
            shell_command("codex", &["hello\n世界's".into()]),
            "codex 'hello\n世界'\\''s'"
        );
    }

    #[test]
    fn searches_standard_tmux_socket_directories() {
        let directories = tmux_socket_directories(
            1000,
            Some("/custom"),
            Some("/var/folders/tmp"),
            Some("/run/user/1000"),
        );
        assert!(directories.contains(&PathBuf::from("/custom/tmux-1000")));
        assert!(directories.contains(&PathBuf::from("/var/folders/tmp/tmux-1000")));
        assert!(directories.contains(&PathBuf::from("/run/user/1000/tmux-1000")));
        assert!(directories.contains(&PathBuf::from("/tmp/tmux-1000")));
        assert!(!is_tmux_socket_name("default.lock"));
        assert!(is_tmux_socket_name("default"));
        assert!(is_tmux_socket_name("work"));
    }

    #[test]
    fn parent_shell_guard_prevents_exec_optimization() {
        assert_eq!(
            parent_shell_command_with_environment("kiro-cli", &["chat".into()], None),
            "/bin/sh -c '\"$@\"; status=$?; exit \"$status\"' codesk-terminal kiro-cli chat"
        );
        let environment =
            BTreeMap::from([("CODESK_PROJECT_PATH".into(), "/tmp/project path".into())]);
        assert_eq!(
            parent_shell_command_with_environment("kiro-cli", &["chat".into()], Some(&environment)),
            "/bin/sh -c 'export CODESK_PROJECT_PATH='\\''/tmp/project path'\\''; \"$@\"; status=$?; exit \"$status\"' codesk-terminal kiro-cli chat"
        );
    }
}
