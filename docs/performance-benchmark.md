# Codesk performance benchmark and regression runbook

This document records the macOS performance investigation completed on 2026-08-16 and provides a repeatable procedure for checking future builds. Use the same workload, process scope, sample duration, and warm-up state when comparing two revisions.

## Reference result

The reference run used:

- macOS 26.5 (25F71), Apple Silicon `Mac17,2`, 16 GB RAM;
- the packaged debug application installed at `/Applications/Codesk.app`;
- the local gateway on `127.0.0.1:4242` and local `codeskd` on `127.0.0.1:4243`;
- one configured remote host, `quocd2`, connected through the app-managed SSH tunnel;
- the main window visible, no active provider turn, navigation loaded, and caches warm;
- at least 30 seconds of settling time after launch before sampling.

| Metric | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| Idle CPU, complete local Codesk process set | 8.6% | 1.9% | 78% lower |
| Context switches | ~1,983/s | ~157/s | 92% lower |
| Resident memory | ~651 MB | ~270 MB | 59% lower |
| Cached `GET /api/state` median | 1,329 ms | 0.58 ms | >2,000x faster |
| Cached `GET /api/navigation` median | not recorded | 0.29 ms | final reference |

On macOS, 100% CPU means one fully occupied core. Memory is the sum of resident memory reported for the selected processes; it is useful for before/after comparison but can count shared pages more than once.

The final visual verification screenshot was written to `/tmp/codesk-performance-verified.png`. That path is a local test artifact rather than a durable repository asset.

## What belongs in the measurement

Measure the complete local Codesk client, not only the Tauri executable:

1. `/Applications/Codesk.app/Contents/MacOS/codesk-desktop`
2. Codesk's WebKit GPU, Networking, and WebContent helpers
3. `/Applications/Codesk.app/Contents/Resources/bin/codesk-gateway`
4. `/Applications/Codesk.app/Contents/Resources/bin/codeskd`
5. SSH forwarding processes whose parent is `codesk-gateway`

WebKit helpers are normally re-parented to PID 1, so a simple descendant-only process tree misses them. Identify the three helpers created at the same time as the current Codesk launch. Close other WebKit applications or record their PIDs before launching Codesk if attribution is ambiguous.

Do not add provider processes such as Codex, Pi, or Claude to the idle-app result. Record their cost separately when benchmarking an active turn. Likewise, the `codeskd` process running on a remote host is not part of the Mac's CPU or memory total; verify it separately over SSH.

## Acceptance thresholds

A build passes the idle regression check when it meets all of these conditions under the reference scenario:

| Check | Threshold |
| --- | ---: |
| Complete local process-set CPU | <= 2% average |
| Complete local process-set context switches | <= 400/s |
| Cached `/api/state` median | <= 10 ms |
| Cached `/api/navigation` median | <= 10 ms |
| Running-session update visible in the UI | <= 2 seconds |
| Idle historical-session update visible in the UI | <= 15 seconds |

Treat memory as a trend rather than a hard gate because WebKit varies with window content and system pressure. Investigate a repeatable increase greater than 20% against the same workload.

## Repeatable benchmark procedure

### 1. Build, install, and start the candidate

Run from the repository root:

```bash
rtk npm ci
rtk npm run check
rtk npm test
rtk npm run desktop:build -- --debug --bundles app
rtk ditto target/debug/bundle/macos/Codesk.app /Applications/Codesk.app
rtk open -a /Applications/Codesk.app
```

Wait for the local and remote hosts to show online, open the same project and conversation used for the comparison, then leave the app untouched for at least 30 seconds. Keep window visibility, project count, remote-host count, and active-run state identical between revisions.

### 2. Inventory the process set

```bash
rtk ps -axo pid=,ppid=,lstart=,%cpu=,rss=,command= | rg 'codesk|Codesk|WebKit'
rtk pgrep -afil 'codesk|Codesk|WebKit'
```

Record the PIDs for the components listed in [What belongs in the measurement](#what-belongs-in-the-measurement). Confirm that the gateway is the parent of the local daemon and app-owned SSH tunnel:

```bash
rtk ps -p <DESKTOP_PID>,<WEBKIT_GPU_PID>,<WEBKIT_NETWORK_PID>,<WEBKIT_CONTENT_PID>,<GATEWAY_PID>,<DAEMON_PID>,<SSH_PID> -o pid=,ppid=,%cpu=,rss=,command=
```

If several stale Codesk SSH tunnels exist, count only the tunnel whose parent is the current gateway. Stale tunnels should be investigated separately rather than added to the current app result.

### 3. Measure CPU, memory, and context switches

Take two `top` samples 10 seconds apart. Add one `-pid` argument for each PID in the recorded process set:

```bash
rtk top -l 2 -s 10 \
  -pid <DESKTOP_PID> \
  -pid <WEBKIT_GPU_PID> \
  -pid <WEBKIT_NETWORK_PID> \
  -pid <WEBKIT_CONTENT_PID> \
  -pid <GATEWAY_PID> \
  -pid <DAEMON_PID> \
  -pid <SSH_PID> \
  -stats pid,command,cpu,mem,csw
```

Use the second sample for CPU and memory:

- CPU = sum of the `%CPU` column.
- Memory = sum of the `MEM` column.
- Context switches per second = sum of `(second CSW - first CSW) / 10` for all selected PIDs. A trailing `+` on the second `CSW` value only means the cumulative counter increased.

Repeat this command three times and report the median run. Do not interact with the app during an idle sample.

For a quick diagnosis of a process that remains busy, sample it for five seconds:

```bash
rtk sample <PID> 5 1
```

### 4. Measure gateway endpoint latency

The following command performs five warm-ups, then reports median and p95 latency from 50 sequential requests to each cached endpoint:

```bash
rtk node --input-type=module <<'NODE'
const origin = 'http://127.0.0.1:4242'
const endpoints = ['/api/state', '/api/navigation']
const percentile = (values, fraction) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))]

for (const endpoint of endpoints) {
  for (let index = 0; index < 5; index += 1) await fetch(origin + endpoint)
  const samples = []
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now()
    const response = await fetch(origin + endpoint)
    if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`)
    await response.arrayBuffer()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  console.log(endpoint, {
    median_ms: percentile(samples, 0.5).toFixed(2),
    p95_ms: percentile(samples, 0.95).toFixed(2),
  })
}
NODE
```

Benchmark cached responses separately from an intentionally cold refresh. `/api/state` is designed to return the cached snapshot immediately and trigger stale host refreshes asynchronously, so a slow remote host must not delay the HTTP response.

### 5. Verify discovery and sessions

Check that the local daemon responds and that the gateway sees every configured host:

```bash
rtk curl -fsS http://127.0.0.1:4243/v1/health
rtk curl -fsS http://127.0.0.1:4242/api/navigation
rtk ssh quocd2 'curl -fsS http://127.0.0.1:4243/v1/health'
```

Exercise daemon discovery twice. The first request may scan processes; the second should use the 60-second cache:

```bash
rtk curl -fsS -o /dev/null -w 'cold discovery: %{time_total}s\n' http://127.0.0.1:4243/v1/agents/discover
rtk curl -fsS -o /dev/null -w 'cached discovery: %{time_total}s\n' http://127.0.0.1:4243/v1/agents/discover
```

Use IDs from `/api/navigation` to test a representative local and remote project. Run each request twice so the second value represents a warm session index:

```bash
rtk curl -fsS -o /dev/null -w 'sessions: %{time_total}s\n' 'http://127.0.0.1:4242/api/projects/<HOST_ID>/<PROJECT_ID>/sessions?limit=50'
rtk curl -fsS -o /dev/null -w 'sessions cached: %{time_total}s\n' 'http://127.0.0.1:4242/api/projects/<HOST_ID>/<PROJECT_ID>/sessions?limit=50'
```

Confirm that titles, timestamps, running/idle status, and the newest transcript messages are correct. A fast but stale or incomplete session list is a failure.

### 6. Verify live-update behavior

Use one running provider session and one idle historical session:

1. Send a message to the running session outside Codesk, or queue a message through Codesk. The new event should appear within 2 seconds without a full-page refresh.
2. Append a new message to an idle historical provider session. With the conversation selected and the window visible, it should appear within 15 seconds.
3. Hide or minimize Codesk for at least 30 seconds. CPU should fall rather than continuing foreground polling.
4. Restore the window. State and the selected conversation should refresh immediately.
5. Disconnect and reconnect `quocd2`. The host and sessions should recover without restarting the desktop app.

Take a screenshot showing the final conversation state and online host status. Store the path in the benchmark notes together with the revision and measurements.

## Root causes found in the 2026-08 investigation

- `GET /api/state` waited for synchronous local and remote host refresh work, so remote discovery and session indexing inflated every frontend state poll.
- Agent discovery repeatedly spawned macOS `lsof` once for the working directory and again for transcript files for every candidate process.
- The gateway lacked a daemon event stream and compensated with repeated state refreshes.
- Foreground and historical-session polling continued too aggressively and did not consistently stop when the window was hidden.
- Session indexing could fall through from Codex's state database to large legacy rollout scans; title enrichment could also scan history repeatedly.
- Transcript reads used a 2 MB tail even for incremental refreshes.
- Long conversations eagerly rendered every tool event and timeline row.

## Optimizations implemented

- Added a 60-second, single-flight daemon discovery cache. Concurrent callers share one scan.
- Replaced per-process macOS `lsof` calls with one batched invocation that extracts working directories and transcript paths.
- Added daemon-event WebSockets from `codeskd` through the gateway to the UI.
- Made `/api/state` cache-first: it returns the current snapshot and schedules stale host refreshes asynchronously.
- Added visibility-aware polling: global state pauses while hidden; selected historical sessions poll at 2 seconds while running and back off to 15 seconds while idle.
- Preferred Codex's authoritative state database and avoided unnecessary legacy transcript scans; missing history titles are queried in batches.
- Reduced incremental transcript tail reads from 2 MB to 256 KB.
- Deferred expensive tool-activity details until expanded.
- Virtualized timelines containing more than 40 rows.

## Power measurement caveat

CPU, context switches, wakeups, and endpoint latency are reliable non-privileged regression signals, but they are not direct watt measurements. Apple's `powermetrics` requires administrator access:

```bash
rtk sudo powermetrics --samplers tasks,cpu_power,gpu_power -i 1000 -n 30
```

Run it only when administrator access is available. Compare builds on battery or on the same power adapter, at similar charge and temperature, with identical display brightness and workload. Do not mix its whole-system watt figures with the process-scoped CPU figures above.

## Result template

Copy this block into an issue or pull request for future checks:

```text
Date/time and timezone:
Revision/build type:
macOS/hardware/RAM:
Scenario and selected project:
Configured remote hosts:
Settling time:
Included PIDs/components:

Idle CPU median:
Context switches/s median:
Resident memory:
/api/state median / p95:
/api/navigation median / p95:
Running-session update delay:
Idle-history update delay:

Tests:
Local daemon health:
Remote daemon health:
Screenshot:
Pass/fail against thresholds:
Notes:
```
