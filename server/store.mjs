import fs from 'node:fs'
import path from 'node:path'

const root = process.env.CODESK_CLIENT_DATA_DIR || path.resolve(process.cwd(), '.codesk')
const defaults = {
  hosts: [{ id: 'local', name: 'This Mac', type: 'local', daemonPort: 4243, status: 'checking', createdAt: new Date().toISOString() }],
  drafts: [],
  navigationByHost: {},
  settings: { notifications: true, pinnedSessionKeys: [], pinnedSessions: [] },
}

export class Store {
  constructor(dataRoot = root) {
    this.file = path.join(dataRoot, 'client-state.json')
    fs.mkdirSync(dataRoot, { recursive: true })
    try {
      const persisted = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.state = { ...structuredClone(defaults), ...persisted, settings: { ...defaults.settings, ...persisted.settings } }
    }
    catch { this.state = structuredClone(defaults); this.save() }
    if (!this.state.hosts.some((host) => host.id === 'local')) this.state.hosts.unshift(defaults.hosts[0])
    if (!Array.isArray(this.state.drafts)) this.state.drafts = []
    if (!this.state.navigationByHost || typeof this.state.navigationByHost !== 'object') this.state.navigationByHost = {}
    if (!Array.isArray(this.state.settings.pinnedSessionKeys)) this.state.settings.pinnedSessionKeys = []
    if (!Array.isArray(this.state.settings.pinnedSessions)) this.state.settings.pinnedSessions = []
  }
  save() { const temp = `${this.file}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); fs.renameSync(temp, this.file) }
  createDraft(input) {
    const now = new Date().toISOString()
    const draft = { id: input.id, hostId: input.hostId, projectId: input.projectId, title: 'New chat', provider: input.provider || 'codex', workspaceMode: input.workspaceMode || 'current_checkout', createdAt: now, updatedAt: now }
    this.state.drafts.unshift(draft)
    this.save()
    return draft
  }
  deleteDraft(id) {
    const before = this.state.drafts.length
    this.state.drafts = this.state.drafts.filter((draft) => draft.id !== id)
    if (this.state.drafts.length !== before) this.save()
    return this.state.drafts.length !== before
  }
  updateDraft(id, changes) {
    const draft = this.state.drafts.find((item) => item.id === id)
    if (!draft) return null
    if (typeof changes.prompt === 'string') draft.prompt = changes.prompt
    if (typeof changes.provider === 'string') draft.provider = changes.provider
    if (changes.workspaceMode === 'current_checkout' || changes.workspaceMode === 'managed_worktree') draft.workspaceMode = changes.workspaceMode
    draft.updatedAt = new Date().toISOString()
    this.save()
    return draft
  }
  updateSettings(changes) {
    if (typeof changes.notifications === 'boolean') this.state.settings.notifications = changes.notifications
    if (Array.isArray(changes.pinnedSessionKeys)) this.state.settings.pinnedSessionKeys = [...new Set(changes.pinnedSessionKeys.filter((key) => typeof key === 'string'))]
    if (Array.isArray(changes.pinnedSessions)) {
      const allowed = new Set(this.state.settings.pinnedSessionKeys)
      this.state.settings.pinnedSessions = changes.pinnedSessions.filter((session) => session && allowed.has(`${session.hostId}:${session.id}`))
    } else {
      const allowed = new Set(this.state.settings.pinnedSessionKeys)
      this.state.settings.pinnedSessions = this.state.settings.pinnedSessions.filter((session) => allowed.has(`${session.hostId}:${session.id}`))
    }
    this.save()
    return this.state.settings
  }
  updateNavigationHost(hostId, snapshot) {
    const prior = this.state.navigationByHost[hostId]
    const priorComparable = prior ? { ...prior, updatedAt: undefined } : null
    const nextComparable = { ...snapshot, updatedAt: undefined }
    if (JSON.stringify(priorComparable) === JSON.stringify(nextComparable)) return
    this.state.navigationByHost[hostId] = snapshot
    this.save()
  }
  removeNavigationHost(hostId) {
    if (!(hostId in this.state.navigationByHost)) return
    delete this.state.navigationByHost[hostId]
    this.save()
  }
}
