use std::{fs::OpenOptions as StdOpenOptions, path::Path, process::Stdio};

use anyhow::{Context, Result};
use tokio::{io::copy, net::UnixListener, process::Command};

use crate::model::RunnerSpec;

pub(crate) async fn run(spec: &RunnerSpec) -> Result<std::process::ExitStatus> {
    let run_dir = Path::new(&spec.run_dir);
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
    Ok(status)
}
