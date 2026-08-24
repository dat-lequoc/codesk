// A host whose automatic install fails must keep retrying on its own. This
// regressed once: the bootstrap attempt cancelled the reconnect timer that the
// tunnel exit had scheduled and never replaced it, so the host stayed offline
// until someone pressed reconnect manually.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../server/store.mjs'
import { Gateway, assertReleaseArtifactUrl } from '../server/gateway.mjs'

// The URL install path curls and executes its artifact on the remote host, so
// only the configured release channel may supply one.
const refuses = (artifactUrl, because) => {
  try { assertReleaseArtifactUrl(artifactUrl) } catch { return }
  throw new Error(`an artifact URL ${because} was accepted: ${artifactUrl}`)
}
delete process.env.CODESK_DAEMON_RELEASE_BASE_URL
refuses('https://releases.example/codeskd-Linux-aarch64', 'with no release channel configured')
process.env.CODESK_DAEMON_RELEASE_BASE_URL = 'https://releases.example/v1'
refuses('https://evil.example/payload', 'from another origin')
refuses('https://releases.example/v1-evil/payload', 'that only prefix-matches the channel')
refuses('file:///etc/passwd', 'with a non-HTTP scheme')
refuses('not a url', 'that is not absolute')
assertReleaseArtifactUrl('https://releases.example/v1/codeskd-Linux-aarch64')
delete process.env.CODESK_DAEMON_RELEASE_BASE_URL
console.log('ok - codeskd artifact installs are confined to the configured release channel')

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-retry-'))
const store = new Store(path.join(temp, 'data'))
const gateway = new Gateway(store, () => {})
const host = { id: 'test-host', name: 'unreachable', type: 'ssh', sshAlias: 'unreachable.invalid', daemonPort: 4243, status: 'offline', createdAt: new Date().toISOString() }
store.state.hosts.push(host)

try {
  gateway.bootstrapRemote = async () => { throw new Error('no artifact available') }
  const handled = await gateway.autoBootstrap(host)
  if (handled) throw new Error('a failed install must not report success')
  if (!host.bootstrapError?.includes('no artifact available')) throw new Error(`install failure was not surfaced: ${host.bootstrapError}`)
  if (!gateway.pollers.has(`connect:${host.id}`)) throw new Error('no reconnect was scheduled after the install failed')
  if (gateway.bootstrapping.has(host.id)) throw new Error('bootstrap lock was not released')

  // Attempts are capped so a permanently unprovisionable host retries the
  // tunnel without reinstalling on every cycle.
  await gateway.autoBootstrap(host)
  const capped = await gateway.autoBootstrap(host)
  if (capped) throw new Error('bootstrap attempts should stop after the cap')

  gateway.markOnline(host)
  if (gateway.bootstrapAttempts.has(host.id) || host.bootstrapError) throw new Error('coming online must clear bootstrap state')
  console.log('ok - a failed automatic install retries with backoff, stops reinstalling after the cap, and resets once online')
} finally {
  for (const timer of gateway.pollers.values()) clearTimeout(timer)
  gateway.closeEvents(host.id)
  store.save = () => {}
  await fs.rm(temp, { recursive: true, force: true })
}
