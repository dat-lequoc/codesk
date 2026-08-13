import fs from 'node:fs'
import path from 'node:path'

const root = process.env.CODESK_CLIENT_DATA_DIR || path.resolve(process.cwd(), '.codesk')
const file = path.join(root, 'client-state.json')

const defaults = {
  hosts: [{ id: 'local', name: 'This Mac', type: 'local', daemonPort: 4243, status: 'checking', createdAt: new Date().toISOString() }],
  settings: { notifications: true },
}

export class Store {
  constructor() {
    fs.mkdirSync(root, { recursive: true })
    try { this.state = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) } }
    catch { this.state = structuredClone(defaults); this.save() }
    if (!this.state.hosts.some((host) => host.id === 'local')) this.state.hosts.unshift(defaults.hosts[0])
  }
  save() { const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); fs.renameSync(temp, file) }
}
