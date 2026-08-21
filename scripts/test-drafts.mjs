import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../server/store.mjs'
import { startDraft } from '../server/drafts.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codesk-drafts-'))
try {
  const first = new Store(root)
  assert.deepEqual(first.state.settings.pinnedSessionKeys, [])
  assert.deepEqual(first.state.settings.pinnedSessions, [])
  assert.deepEqual(first.state.settings.archivedSessionKeys, [])
  assert.deepEqual(first.state.settings.archivedSessions, [])
  const one = first.createDraft({ id: randomUUID(), hostId: 'remote', projectId: 'pi-agi' })
  const two = first.createDraft({ id: randomUUID(), hostId: 'remote', projectId: 'pi-agi' })
  assert.equal(one.id, two.id, 'repeated New chat actions should reuse the blank project composer')
  assert.equal(first.state.drafts.length, 1)
  assert(first.state.drafts.every((draft) => draft.title === 'New chat'))

  first.flushSync()
  const restarted = new Store(root)
  assert.deepEqual(restarted.state.drafts.map((draft) => draft.id), [one.id])
  const untouchedTimestamp = restarted.state.drafts[0].updatedAt
  restarted.updateDraft(one.id, { prompt: '', provider: 'codex', workspaceMode: 'current_checkout' })
  assert.equal(restarted.state.drafts[0].updatedAt, untouchedTimestamp, 'unchanged drafts must not appear recently updated')
  restarted.updateDraft(one.id, { prompt: 'preserved composer text', provider: 'pi', workspaceMode: 'managed_worktree' })
  restarted.flushSync()
  const edited = new Store(root).state.drafts.find((draft) => draft.id === one.id)
  assert.equal(edited.prompt, 'preserved composer text')
  assert.equal(edited.provider, 'pi')
  assert.equal(edited.workspaceMode, 'managed_worktree')

  const pinnedSession = { id: 'session-1', hostId: 'remote', projectId: 'pi-agi', provider: 'codex', nativeSessionId: 'native-1', cwd: '/srv/pi-agi', title: 'Design analysis', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sortAt: new Date().toISOString(), status: 'idle' }
  restarted.updateSettings({ pinnedSessionKeys: ['remote:session-1'], pinnedSessions: [pinnedSession] })
  restarted.updateSettings({ pinnedSessionKeys: [], pinnedSessions: [], archivedSessionKeys: ['remote:session-1'], archivedSessions: [pinnedSession] })
  restarted.updateNavigationHost('remote', { hostId: 'remote', projects: [{ id: 'pi-agi', hostId: 'remote', name: 'pi-agi' }], sessions: [pinnedSession], runs: [], providers: [], updatedAt: new Date().toISOString() })
  restarted.flushSync()
  const withNavigation = new Store(root)
  assert.deepEqual(withNavigation.state.settings.pinnedSessionKeys, [])
  assert.deepEqual(withNavigation.state.settings.archivedSessionKeys, ['remote:session-1'])
  assert.equal(withNavigation.state.settings.archivedSessions[0].title, 'Design analysis')
  assert.equal(withNavigation.state.navigationByHost.remote.projects[0].name, 'pi-agi')

  const cleanupRoot = path.join(root, 'cleanup')
  const cleanup = new Store(cleanupRoot)
  cleanup.createDraft({ id: randomUUID(), hostId: 'remote', projectId: 'remove-me' })
  const removedSession = { ...pinnedSession, id: 'remove-session', projectId: 'remove-me' }
  cleanup.updateSettings({ pinnedSessionKeys: ['remote:remove-session'], pinnedSessions: [removedSession], archivedSessionKeys: ['remote:remove-session'], archivedSessions: [removedSession] })
  cleanup.removeProjectReferences('remote', 'remove-me')
  assert.equal(cleanup.state.drafts.length, 0)
  assert.equal(cleanup.state.settings.pinnedSessions.length, 0)
  assert.equal(cleanup.state.settings.archivedSessions.length, 0)

  const afterReconciliation = new Store(root)
  assert.deepEqual(afterReconciliation.state.drafts.map((draft) => draft.id), [one.id])
  const failedGateway = { request: async () => { throw new Error('remote unavailable') } }
  await assert.rejects(startDraft(afterReconciliation, failedGateway, one.id, { prompt: 'do work' }), /remote unavailable/)
  assert.equal(afterReconciliation.state.drafts.length, 1, 'failed start must retain the draft')
  const gateway = { request: async (hostId, route, options) => {
    assert.equal(hostId, 'remote'); assert.equal(route, '/v1/runs')
    const input = JSON.parse(options.body)
    assert.equal(input.project_id, 'pi-agi'); assert.equal(input.prompt, 'do work'); assert.equal(input.provider, 'pi')
    return { id: 'run-1' }
  } }
  const started = await startDraft(afterReconciliation, gateway, one.id, { prompt: 'do work' })
  assert.equal(started.run.id, 'run-1')
  assert.equal(afterReconciliation.state.drafts.length, 0, 'successful start must reconcile the draft')

  // A corrupt store must never be silently replaced: the unreadable bytes are
  // preserved next to the fresh defaults so the user's hosts and drafts can be
  // recovered by hand.
  const corruptRoot = path.join(root, 'corrupt')
  await fs.mkdir(corruptRoot, { recursive: true })
  await fs.writeFile(path.join(corruptRoot, 'client-state.json'), '{"hosts": [truncated')
  const recovered = new Store(corruptRoot)
  assert.equal(recovered.state.hosts[0].id, 'local', 'corrupt store boots with defaults')
  const backups = (await fs.readdir(corruptRoot)).filter((name) => name.includes('.corrupt-'))
  assert.equal(backups.length, 1, 'corrupt store bytes are preserved as a backup')
  assert.equal(
    await fs.readFile(path.join(corruptRoot, backups[0]), 'utf8'),
    '{"hosts": [truncated',
    'backup preserves the original bytes',
  )
  console.log('ok - blank composers deduplicate and meaningful drafts persist')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
