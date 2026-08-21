use anyhow::Result;

use super::{home_dir, index_directory};
use crate::model::{Project, ProviderSession};

pub(crate) fn index_pi(project: &Project, limit: usize) -> Result<Vec<ProviderSession>> {
    let directory = home_dir().join(".pi/agent/sessions").join(format!(
        "--{}--",
        project.path.trim_matches('/').replace('/', "-")
    ));
    index_directory(project, "pi", &directory, limit)
}
