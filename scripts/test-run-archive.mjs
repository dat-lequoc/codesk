// Runs that never produced a matching provider session are listed in project
// navigation indefinitely, so they need the same archive affordance sessions
// have. Archived runs are stored as bare `hostId:runId` keys — no snapshot,
// because the daemon keeps reporting runs — and must survive a store reopen.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Store } from '../server/store.mjs'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-run-archive-'))

try {
  const store = new Store(dataDir)
  assert.deepEqual(store.state.settings.archivedRunKeys, [], 'defaults to empty')

  const saved = store.updateSettings({ archivedRunKeys: ['local:run-a', 'local:run-b', 'local:run-a'] })
  assert.deepEqual(saved.archivedRunKeys, ['local:run-a', 'local:run-b'], 'deduplicates keys')

  // Archiving a run must not disturb archived or pinned sessions.
  const withSession = store.updateSettings({
    archivedSessionKeys: ['local:session-1'],
    archivedSessions: [{ hostId: 'local', id: 'session-1', projectId: 'p1', title: 'kept' }],
  })
  assert.deepEqual(withSession.archivedRunKeys, ['local:run-a', 'local:run-b'], 'run keys survive a session update')
  assert.equal(withSession.archivedSessions.length, 1, 'session snapshot retained')

  store.flushSync()
  const reopened = new Store(dataDir)
  assert.deepEqual(reopened.state.settings.archivedRunKeys, ['local:run-a', 'local:run-b'], 'persists across reopen')

  const unarchived = reopened.updateSettings({ archivedRunKeys: ['local:run-b'] })
  assert.deepEqual(unarchived.archivedRunKeys, ['local:run-b'], 'unarchiving removes one key')

  // Non-string entries are rejected rather than persisted.
  const cleaned = reopened.updateSettings({ archivedRunKeys: ['local:run-b', null, 7, { id: 'x' }] })
  assert.deepEqual(cleaned.archivedRunKeys, ['local:run-b'], 'drops non-string keys')

  // A store written before this field existed must still load.
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-run-archive-legacy-'))
  await fs.writeFile(
    path.join(legacyDir, 'client-state.json'),
    JSON.stringify({ settings: { notifications: true, archivedSessionKeys: ['local:old'] } }),
  )
  const legacy = new Store(legacyDir)
  assert.deepEqual(legacy.state.settings.archivedRunKeys, [], 'legacy state gains an empty list')
  assert.deepEqual(legacy.state.settings.archivedSessionKeys, ['local:old'], 'legacy archives preserved')
  await fs.rm(legacyDir, { recursive: true, force: true })

  console.log('ok - archived run keys deduplicate, persist, unarchive, and load from legacy state')
} finally {
  await fs.rm(dataDir, { recursive: true, force: true })
}
