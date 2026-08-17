use std::path::Path;

use anyhow::Result;
use chrono::Utc;

use crate::{
    model::{RunnerExit, RunnerSpec},
    providers, transports,
};

pub async fn run(spec_path: &Path) -> Result<()> {
    let spec: RunnerSpec = serde_json::from_slice(&tokio::fs::read(spec_path).await?)?;
    let run_dir = Path::new(&spec.run_dir);
    tokio::fs::create_dir_all(run_dir).await?;
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }
    let kind = providers::require(&spec.provider)?.descriptor().runner;
    let status = transports::run(kind, &spec).await?;
    write_exit(run_dir, status).await
}

async fn write_exit(run_dir: &Path, status: std::process::ExitStatus) -> Result<()> {
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
