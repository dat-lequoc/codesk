// codeskd mints a 0600 token in its data directory at startup and requires it
// on every route but /v1/health. Scripts that drive a daemon they spawned read
// it back from the data directory they handed that daemon.
import fs from 'node:fs'
import path from 'node:path'

export function daemonToken(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim()
  } catch {
    return ''
  }
}

/// Read per call rather than once at import: the daemon usually has not
/// started yet when a test module is first evaluated.
export function daemonAuth(dataDir) {
  const token = daemonToken(dataDir)
  return token ? { authorization: `Bearer ${token}` } : {}
}
