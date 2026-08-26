# Prompt: update the Codesk desktop app on this Mac

Copy everything below the line into an agent running on the Mac, in the Codesk
checkout.

---

You are updating the Codesk desktop app on this Mac from the latest `main`. Work
through the steps in order and stop at the first one that fails, reporting what
broke and what you tried. Do not skip verification steps because an earlier one
looked fine.

**Context you need before you start.** Three things landed upstream that change
how this repo is built and run:

1. **The package manager changed from npm to pnpm.** `package-lock.json` is gone
   and `pnpm-lock.yaml` replaces it. Your existing `node_modules` was installed
   by npm and has the wrong layout, so it must be removed rather than reused.
2. **`codeskd` now reports a fingerprint of its own binary** in `/v1/health`, and
   the gateway auto-upgrades any remote host whose fingerprint differs from the
   artifact it would install. The crate version is still `0.2.2` and does not
   move, so the fingerprint is the only way to tell builds apart — this matters
   for step 6.
3. **Session listing and turn-completion behaviour changed** in the daemon. Step 5
   is how you confirm the new binary is actually the one running.

## 1. Pull

```bash
git -C <checkout> status --short          # must be clean; stop and report if not
git -C <checkout> pull --ff-only origin main
git -C <checkout> log --oneline -3
```

The newest commit should be `dc6dfca` or later.

## 2. Make pnpm available

```bash
command -v pnpm && pnpm --version
```

If it is missing, install it with `corepack enable pnpm` (preferred — the repo
pins `pnpm@10.32.1` via `packageManager`), or `brew install pnpm`. Do not fall
back to npm for anything in this repo.

## 3. Reinstall dependencies

```bash
cd <checkout>
rm -rf node_modules
pnpm install --frozen-lockfile
```

`rm -rf node_modules` is required, not optional: pnpm uses a symlinked layout
that an npm-installed tree will shadow in confusing ways.

If pnpm reports `Ignored build scripts`, stop and report it. The repo allowlists
`esbuild` through `pnpm.onlyBuiltDependencies`, so that warning means something
new appeared and the build may be silently wrong.

## 4. Verify before building

```bash
pnpm run check          # tsc --noEmit && eslint src
pnpm run format:check
pnpm test               # expect 707 passing
cargo test -p codeskd   # expect 105 passing
pnpm run test:backend   # expect 25 lines starting "ok - "
```

`pnpm run test:backend` starts real daemons on random ports and cleans them up.
If it fails partway, re-run it once before investigating — a port collision is
the most common cause of a one-off failure.

## 5. Build and install the app

The normal path is:

```bash
pnpm run desktop:redeploy
```

Be aware of what this does before you run it: it quits the running
`/Applications/Codesk.app` through `cua-driver` (which needs Accessibility and
Screen Recording permissions), stops whatever is listening on ports 4242 and
4243, backs the old bundle up under `~/Library/Caches/Codesk/deploy-backups/`,
copies the new one into `/Applications`, relaunches it, and waits for the local
host to come back online.

If `cua-driver` is not installed or lacks those permissions, do **not** try to
work around it by killing processes yourself. Use the documented manual path
instead and tell me that is what you did:

```bash
pnpm run desktop:build -- --debug --bundles app
# quit Codesk from the menu bar yourself, then:
ditto target/debug/bundle/macos/Codesk.app /Applications/Codesk.app
open /Applications/Codesk.app
```

## 6. Confirm the running daemon is the new one

This is the step that actually proves the update landed. The version string will
say `0.2.2` whether or not you succeeded, so check the fingerprint:

```bash
curl -s http://127.0.0.1:4243/v1/health
```

`/v1/health` needs no token. You should get something like:

```json
{"ok":true,"version":"0.2.2","build":"98f72c6be9de154c","host_name":"...","uptime_seconds":12,"active_runs":0}
```

Now compare `build` against the binary the app is running:

```bash
shasum -a 256 /Applications/Codesk.app/Contents/Resources/bin/codeskd | cut -c1-16
```

(`tauri.conf.json` maps `binaries/codeskd` to `bin/codeskd` inside Resources. If
it is not there, locate it with `find /Applications/Codesk.app -name codeskd`.)

**The two values must match.** If `build` is missing from the response entirely,
you are still on the old daemon and the install did not take effect — say so
rather than moving on.

## 7. Confirm the behaviour changes

Two things should be observably different:

- **Session lists are fast.** Open a project that has never used Codex. The
  sidebar should populate immediately. Before this change it took ~10 seconds per
  poll, because a project with no Codex history fell through to a scan of every
  rollout file on disk.
- **A finished turn is marked.** Start a Claude Code session from Codesk, send it
  a short prompt, and switch to another conversation while it runs. When it
  finishes you should get an unread mark on that conversation in the sidebar, and
  a desktop notification if notifications are enabled. Previously a Claude Code
  turn finished in silence.

If you want a non-interactive check of the same thing, run:

```bash
pnpm run test:claude-completion-live
```

That drives a real Claude Code process and asserts both signals. It needs a
logged-in Claude Code and spends real credits, so ask me before running it.

## 8. Report back

Tell me:

- the commit you ended up on
- whether you used `desktop:redeploy` or the manual bundle path, and why
- the `build` fingerprint from `/v1/health` and the hash of the bundled binary,
  and whether they matched
- any test that failed, with its actual output
- anything you had to do that this prompt did not describe

Do not modify tracked files, commit, or push. If a step seems to require it, stop
and ask.
