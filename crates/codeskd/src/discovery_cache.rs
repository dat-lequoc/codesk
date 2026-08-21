use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::{AppState, model};

/// Discovery results split from the scan guard so readers never block behind
/// a `ps`/`lsof`/tmux scan: the snapshot is always readable, while the scan
/// mutex only serializes the scanners themselves.
#[derive(Default)]
pub(crate) struct DiscoveryState {
    scan: Mutex<()>,
    cache: std::sync::RwLock<DiscoveryCache>,
}

#[derive(Default)]
struct DiscoveryCache {
    updated_at: Option<Instant>,
    agents: Vec<model::DiscoveredAgent>,
}

const DISCOVERY_TTL: Duration = Duration::from_secs(60);

pub(crate) async fn invalidate_discovery(state: &AppState) {
    state
        .discovery
        .cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .updated_at = None;
}

pub(crate) async fn cached_agents_with<F, Fut>(
    discovery: &DiscoveryState,
    force: bool,
    scan: F,
) -> anyhow::Result<Vec<model::DiscoveredAgent>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<model::DiscoveredAgent>>>,
{
    let read_cache = || {
        let cache = discovery
            .cache
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fresh = cache
            .updated_at
            .is_some_and(|updated| updated.elapsed() < DISCOVERY_TTL);
        (fresh, cache.updated_at.is_some(), cache.agents.clone())
    };
    if !force {
        let (fresh, has_snapshot, agents) = read_cache();
        if fresh {
            return Ok(agents);
        }
        // A scan is already in flight and a previous snapshot exists: serve the
        // stale snapshot instead of queueing this handler behind ps/lsof/tmux.
        // The very first discovery has nothing to serve, so it waits.
        if has_snapshot {
            if let Ok(guard) = discovery.scan.try_lock() {
                // The scanner that just released the lock may have refreshed.
                let (fresh, _, agents) = read_cache();
                if fresh {
                    return Ok(agents);
                }
                return run_discovery_scan(discovery, guard, scan).await;
            }
            return Ok(agents);
        }
    }
    let guard = discovery.scan.lock().await;
    // Single-flight: a concurrent scanner may have refreshed while this caller
    // waited for the guard. force still rescans unconditionally.
    if !force {
        let (fresh, _, agents) = read_cache();
        if fresh {
            return Ok(agents);
        }
    }
    run_discovery_scan(discovery, guard, scan).await
}

async fn run_discovery_scan<F, Fut>(
    discovery: &DiscoveryState,
    _guard: tokio::sync::MutexGuard<'_, ()>,
    scan: F,
) -> anyhow::Result<Vec<model::DiscoveredAgent>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Vec<model::DiscoveredAgent>>>,
{
    let agents = scan().await?;
    let mut cache = discovery
        .cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.updated_at = Some(Instant::now());
    cache.agents = agents.clone();
    Ok(agents)
}

#[cfg(test)]
mod cache_tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::*;

    #[tokio::test]
    async fn discovery_refresh_is_single_flight_within_the_ttl() {
        let cache = Arc::new(DiscoveryState::default());
        let scans = Arc::new(AtomicUsize::new(0));
        let first = {
            let cache = cache.clone();
            let scans = scans.clone();
            tokio::spawn(async move {
                cached_agents_with(&cache, false, || async move {
                    scans.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    Ok(Vec::new())
                })
                .await
                .unwrap()
            })
        };
        let second = {
            let cache = cache.clone();
            let scans = scans.clone();
            tokio::spawn(async move {
                cached_agents_with(&cache, false, || async move {
                    scans.fetch_add(1, Ordering::SeqCst);
                    Ok(Vec::new())
                })
                .await
                .unwrap()
            })
        };
        let _ = tokio::join!(first, second);
        assert_eq!(scans.load(Ordering::SeqCst), 1);
        cached_agents_with(&cache, true, || async {
            scans.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        })
        .await
        .unwrap();
        assert_eq!(scans.load(Ordering::SeqCst), 2);
    }
}
