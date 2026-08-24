import fs from 'node:fs'
import path from 'node:path'

const root = process.env.CODESK_CLIENT_DATA_DIR || path.resolve(process.cwd(), '.codesk')
const emptyDraftMaxAgeMs = 24 * 60 * 60 * 1000
const localHostName = process.platform === 'darwin' ? 'This Mac' : 'This machine'
const defaults = {
  hosts: [{ id: 'local', name: localHostName, type: 'local', daemonPort: 4243, status: 'checking', createdAt: new Date().toISOString() }],
  drafts: [],
  navigationByHost: {},
  settings: { notifications: true, theme: 'system', pinnedSessionKeys: [], pinnedSessions: [], archivedSessionKeys: [], archivedSessions: [], archivedRunKeys: [], hiddenAgentKeys: [] },
}

export class Store {
  constructor(dataRoot = root) {
    this.file = path.join(dataRoot, 'client-state.json')
    this.saveTimer = null
    this.dirty = false
    fs.mkdirSync(dataRoot, { recursive: true })
    // Debounced saves must still hit disk if the process exits normally
    // between the mutation and the timer. The data root may already be gone
    // during teardown (tests, uninstall); losing that final write is fine.
    process.once('exit', () => { try { this.flushSync() } catch {} })
    try {
      const persisted = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.state = { ...structuredClone(defaults), ...persisted, settings: { ...defaults.settings, ...persisted.settings } }
    }
    catch (error) {
      // A missing file is a fresh install; anything else is a store we failed
      // to parse. Overwriting it with defaults would silently destroy the
      // user's hosts, drafts, and settings, so preserve the bytes first.
      if (error.code !== 'ENOENT') {
        const backup = `${this.file}.corrupt-${Date.now()}`
        try { fs.renameSync(this.file, backup); console.error(`Codesk client state was unreadable (${error.message}); the original file was preserved at ${backup}`) } catch {}
      }
      this.state = structuredClone(defaults)
      this.save()
    }
    if (!this.state.hosts.some((host) => host.id === 'local')) this.state.hosts.unshift(defaults.hosts[0])
    if (!Array.isArray(this.state.drafts)) this.state.drafts = []
    const now = Date.now()
    const blankProjects = new Set()
    const normalizedDrafts = this.state.drafts.filter((draft) => {
      if (draft.prompt?.trim()) return true
      const createdAt = Date.parse(draft.createdAt || '')
      if (Number.isFinite(createdAt) && now - createdAt > emptyDraftMaxAgeMs) return false
      const key = `${draft.hostId}:${draft.projectId}`
      if (blankProjects.has(key)) return false
      blankProjects.add(key)
      return true
    })
    const draftsChanged = normalizedDrafts.length !== this.state.drafts.length
    this.state.drafts = normalizedDrafts
    if (!this.state.navigationByHost || typeof this.state.navigationByHost !== 'object') this.state.navigationByHost = {}
    if (!Array.isArray(this.state.settings.pinnedSessionKeys)) this.state.settings.pinnedSessionKeys = []
    if (!Array.isArray(this.state.settings.pinnedSessions)) this.state.settings.pinnedSessions = []
    if (!Array.isArray(this.state.settings.archivedSessionKeys)) this.state.settings.archivedSessionKeys = []
    if (!Array.isArray(this.state.settings.archivedSessions)) this.state.settings.archivedSessions = []
    if (!Array.isArray(this.state.settings.archivedRunKeys)) this.state.settings.archivedRunKeys = []
    if (!Array.isArray(this.state.settings.hiddenAgentKeys)) this.state.settings.hiddenAgentKeys = []
    if (!['system', 'light', 'dark'].includes(this.state.settings.theme)) this.state.settings.theme = 'system'
    if (draftsChanged) this.save()
  }
  /// Persist soon, not now. Every mutation used to rewrite the full document
  /// synchronously on the event loop; host status churn and navigation cache
  /// updates made that a constant background disk cost. Writes coalesce on a
  /// short timer, and `flushSync()` covers shutdown.
  save() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => { try { this.flushSync() } catch (error) { console.error(`Failed to persist client state: ${error.message}`) } }, 250)
    this.saveTimer.unref?.()
  }
  flushSync() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    if (!this.dirty) return
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2))
    fs.renameSync(temp, this.file)
    this.dirty = false
  }
  createDraft(input) {
    const existing = this.state.drafts.find((draft) => draft.hostId === input.hostId && draft.projectId === input.projectId && !draft.prompt?.trim())
    if (existing) return existing
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
    let changed = false
    if (typeof changes.prompt === 'string' && (draft.prompt || '') !== changes.prompt) { draft.prompt = changes.prompt; changed = true }
    if (typeof changes.provider === 'string' && draft.provider !== changes.provider) { draft.provider = changes.provider; changed = true }
    if ((changes.workspaceMode === 'current_checkout' || changes.workspaceMode === 'managed_worktree') && draft.workspaceMode !== changes.workspaceMode) { draft.workspaceMode = changes.workspaceMode; changed = true }
    if (!changed) return draft
    draft.updatedAt = new Date().toISOString()
    this.save()
    return draft
  }
  updateSettings(changes) {
    if (typeof changes.notifications === 'boolean') this.state.settings.notifications = changes.notifications
    if (['system', 'light', 'dark'].includes(changes.theme)) this.state.settings.theme = changes.theme
    if (Array.isArray(changes.pinnedSessionKeys)) this.state.settings.pinnedSessionKeys = [...new Set(changes.pinnedSessionKeys.filter((key) => typeof key === 'string'))]
    if (Array.isArray(changes.pinnedSessions)) {
      const allowed = new Set(this.state.settings.pinnedSessionKeys)
      this.state.settings.pinnedSessions = changes.pinnedSessions.filter((session) => session && allowed.has(`${session.hostId}:${session.id}`))
    } else {
      const allowed = new Set(this.state.settings.pinnedSessionKeys)
      this.state.settings.pinnedSessions = this.state.settings.pinnedSessions.filter((session) => allowed.has(`${session.hostId}:${session.id}`))
    }
    if (Array.isArray(changes.archivedSessionKeys)) this.state.settings.archivedSessionKeys = [...new Set(changes.archivedSessionKeys.filter((key) => typeof key === 'string'))]
    if (Array.isArray(changes.archivedSessions)) {
      const allowed = new Set(this.state.settings.archivedSessionKeys)
      this.state.settings.archivedSessions = changes.archivedSessions.filter((session) => session && allowed.has(`${session.hostId}:${session.id}`))
    } else {
      const allowed = new Set(this.state.settings.archivedSessionKeys)
      this.state.settings.archivedSessions = this.state.settings.archivedSessions.filter((session) => allowed.has(`${session.hostId}:${session.id}`))
    }
    if (Array.isArray(changes.archivedRunKeys)) this.state.settings.archivedRunKeys = [...new Set(changes.archivedRunKeys.filter((key) => typeof key === 'string'))]
    if (Array.isArray(changes.hiddenAgentKeys)) this.state.settings.hiddenAgentKeys = [...new Set(changes.hiddenAgentKeys.filter((key) => typeof key === 'string'))]
    this.save()
    return this.state.settings
  }
  removeProjectReferences(hostId, projectId) {
    this.state.drafts = this.state.drafts.filter((draft) => draft.hostId !== hostId || draft.projectId !== projectId)
    for (const prefix of ['pinned', 'archived']) {
      const sessionsKey = `${prefix}Sessions`
      const keysKey = `${prefix}SessionKeys`
      this.state.settings[sessionsKey] = this.state.settings[sessionsKey].filter((session) => session.hostId !== hostId || session.projectId !== projectId)
      const retained = new Set(this.state.settings[sessionsKey].map((session) => `${session.hostId}:${session.id}`))
      this.state.settings[keysKey] = this.state.settings[keysKey].filter((key) => retained.has(key))
    }
    this.save()
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
