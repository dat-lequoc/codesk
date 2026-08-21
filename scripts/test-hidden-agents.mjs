// Discovered processes the user hid from the sidebar persist as bare
// `hostId:pid:command-hash` keys — same pattern as archived runs — so a
// recycled pid with a different argv does not stay hidden.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Store } from '../server/store.mjs'

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-hidden-agents-'))

try {
  const store = new Store(dataDir)
  assert.deepEqual(store.state.settings.hiddenAgentKeys, [], 'defaults to empty')

  const saved = store.updateSettings({
    hiddenAgentKeys: ['local:12:abc', 'local:13:def', 'local:12:abc'],
  })
  assert.deepEqual(saved.hiddenAgentKeys, ['local:12:abc', 'local:13:def'], 'deduplicates keys')

  const withRuns = store.updateSettings({ archivedRunKeys: ['local:run-a'] })
  assert.deepEqual(
    withRuns.hiddenAgentKeys,
    ['local:12:abc', 'local:13:def'],
    'hidden keys survive a run-archive update',
  )
  assert.deepEqual(withRuns.archivedRunKeys, ['local:run-a'], 'run keys retained')

  store.flushSync()
  const reopened = new Store(dataDir)
  assert.deepEqual(
    reopened.state.settings.hiddenAgentKeys,
    ['local:12:abc', 'local:13:def'],
    'persists across reopen',
  )

  const unhidden = reopened.updateSettings({ hiddenAgentKeys: ['local:13:def'] })
  assert.deepEqual(unhidden.hiddenAgentKeys, ['local:13:def'], 'unhiding removes one key')

  const cleaned = reopened.updateSettings({
    hiddenAgentKeys: ['local:13:def', null, 7, { id: 'x' }],
  })
  assert.deepEqual(cleaned.hiddenAgentKeys, ['local:13:def'], 'prunes non-string keys')

  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-hidden-agents-legacy-'))
  await fs.writeFile(
    path.join(legacyDir, 'client-state.json'),
    JSON.stringify({ settings: { notifications: true, archivedRunKeys: ['local:old'] } }),
  )
  const legacy = new Store(legacyDir)
  assert.deepEqual(legacy.state.settings.hiddenAgentKeys, [], 'legacy state gains an empty list')
  assert.deepEqual(
    legacy.state.settings.archivedRunKeys,
    ['local:old'],
    'legacy archives preserved',
  )
  await fs.rm(legacyDir, { recursive: true, force: true })

  console.log('ok - hidden agent keys deduplicate, persist, unhide, and prune invalid entries')
} finally {
  await fs.rm(dataDir, { recursive: true, force: true })
}
