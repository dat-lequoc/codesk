use std::{fs::OpenOptions as StdOpenOptions, path::Path, process::Stdio};

use anyhow::{Context, Result};
use chrono::Utc;
use tokio::{io::copy, net::UnixListener, process::Command};

use crate::model::{RunnerExit, RunnerSpec};

pub async fn run(spec_path: &Path) -> Result<()> {
    let spec: RunnerSpec = serde_json::from_slice(&tokio::fs::read(spec_path).await?)?;
    let run_dir = Path::new(&spec.run_dir);
    tokio::fs::create_dir_all(run_dir).await?;
    let stdout = StdOpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stdout.log"))?;
    let stderr = StdOpenOptions::new()
        .create(true)
        .append(true)
        .open(run_dir.join("stderr.log"))?;
    let socket_path = std::path::PathBuf::from(&spec.input_socket);
    let _ = tokio::fs::remove_file(&socket_path).await;
    let listener = UnixListener::bind(&socket_path)?;
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    tokio::fs::write(run_dir.join("ready"), format!("{}\n", std::process::id())).await?;
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::signal(libc::SIGHUP, libc::SIG_DFL);
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("spawn {}", spec.command))?;
    let stdin = child.stdin.take().context("child stdin unavailable")?;
    let input_task = tokio::spawn(async move {
        let mut stdin = stdin;
        while let Ok((mut socket, _)) = listener.accept().await {
            if copy(&mut socket, &mut stdin).await.is_err() {
                break;
            }
        }
    });
    let status = child.wait().await?;
    input_task.abort();
    let _ = tokio::fs::remove_file(&socket_path).await;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    let result = RunnerExit {
        exit_code: status.code(),
        signal: status.signal(),
        finished_at: Utc::now().to_rfc3339(),
    };
    let temp = run_dir.join("exit.json.tmp");
    tokio::fs::write(&temp, serde_json::to_vec(&result)?).await?;
    tokio::fs::rename(temp, run_dir.join("exit.json")).await?;
    Ok(())
}
