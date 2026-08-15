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
  const one = first.createDraft({ id: randomUUID(), hostId: 'remote', projectId: 'pi-agi' })
  const two = first.createDraft({ id: randomUUID(), hostId: 'remote', projectId: 'pi-agi' })
  assert.notEqual(one.id, two.id)
  assert.equal(first.state.drafts.length, 2)
  assert(first.state.drafts.every((draft) => draft.title === 'New chat'))

  const restarted = new Store(root)
  assert.deepEqual(restarted.state.drafts.map((draft) => draft.id), [two.id, one.id])
  restarted.updateDraft(two.id, { prompt: 'preserved composer text', provider: 'pi', workspaceMode: 'managed_worktree' })
  const edited = new Store(root).state.drafts.find((draft) => draft.id === two.id)
  assert.equal(edited.prompt, 'preserved composer text')
  assert.equal(edited.provider, 'pi')
  assert.equal(edited.workspaceMode, 'managed_worktree')
  assert.equal(restarted.deleteDraft(two.id), true)

  const pinnedSession = { id: 'session-1', hostId: 'remote', projectId: 'pi-agi', provider: 'codex', nativeSessionId: 'native-1', cwd: '/srv/pi-agi', title: 'Design analysis', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sortAt: new Date().toISOString(), status: 'idle' }
  restarted.updateSettings({ pinnedSessionKeys: ['remote:session-1'], pinnedSessions: [pinnedSession] })
  restarted.updateNavigationHost('remote', { hostId: 'remote', projects: [{ id: 'pi-agi', hostId: 'remote', name: 'pi-agi' }], sessions: [pinnedSession], runs: [], providers: [], updatedAt: new Date().toISOString() })
  const withNavigation = new Store(root)
  assert.deepEqual(withNavigation.state.settings.pinnedSessionKeys, ['remote:session-1'])
  assert.equal(withNavigation.state.settings.pinnedSessions[0].title, 'Design analysis')
  assert.equal(withNavigation.state.navigationByHost.remote.projects[0].name, 'pi-agi')

  const afterReconciliation = new Store(root)
  assert.deepEqual(afterReconciliation.state.drafts.map((draft) => draft.id), [one.id])
  const failedGateway = { request: async () => { throw new Error('remote unavailable') } }
  await assert.rejects(startDraft(afterReconciliation, failedGateway, one.id, { prompt: 'do work' }), /remote unavailable/)
  assert.equal(afterReconciliation.state.drafts.length, 1, 'failed start must retain the draft')
  const gateway = { request: async (hostId, route, options) => {
    assert.equal(hostId, 'remote'); assert.equal(route, '/v1/runs')
    const input = JSON.parse(options.body)
    assert.equal(input.project_id, 'pi-agi'); assert.equal(input.prompt, 'do work'); assert.equal(input.provider, 'codex')
    return { id: 'run-1' }
  } }
  const started = await startDraft(afterReconciliation, gateway, one.id, { prompt: 'do work' })
  assert.equal(started.run.id, 'run-1')
  assert.equal(afterReconciliation.state.drafts.length, 0, 'successful start must reconcile the draft')
  console.log('ok - independent draft chats persist and reconcile individually')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
