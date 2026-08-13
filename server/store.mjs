import fs from 'node:fs'
import path from 'node:path'

const root = process.env.CODESK_CLIENT_DATA_DIR || path.resolve(process.cwd(), '.codesk')
const defaults = {
  hosts: [{ id: 'local', name: 'This Mac', type: 'local', daemonPort: 4243, status: 'checking', createdAt: new Date().toISOString() }],
  drafts: [],
  settings: { notifications: true },
}

export class Store {
  constructor(dataRoot = root) {
    this.file = path.join(dataRoot, 'client-state.json')
    fs.mkdirSync(dataRoot, { recursive: true })
    try { this.state = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) } }
    catch { this.state = structuredClone(defaults); this.save() }
    if (!this.state.hosts.some((host) => host.id === 'local')) this.state.hosts.unshift(defaults.hosts[0])
    if (!Array.isArray(this.state.drafts)) this.state.drafts = []
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
}
