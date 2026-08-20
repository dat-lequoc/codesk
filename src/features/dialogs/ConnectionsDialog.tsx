// Extracted from App.tsx during the Tailwind/module refactor.

import { Plus, Radio, RefreshCw, Square } from 'lucide-react'
import { api } from '../../api'
import { AppDialog } from '../../components/ui/app-dialog'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { StatusDot } from '../../components/ui/status-dot'
import { providerIcon } from '../../providerRegistry'
import type { DiscoveredAgent, Host } from '../../types'
import { useEffect, useState } from 'react'
export function ConnectionsDialog({
  hosts,
  onClose,
  onChanged,
}: {
  hosts: Host[]
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [aliases, setAliases] = useState<string[]>([])
  const [agents, setAgents] = useState<Record<string, DiscoveredAgent[]>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    api
      .sshAliases()
      .then(setAliases)
      .catch(() => {})
  }, [])
  const inspectAgents = async (host: Host) => {
    setBusy(`agents:${host.id}`)
    setError('')
    try {
      const found = await api.discoveredAgents(host.id)
      setAgents((current) => ({ ...current, [host.id]: found }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }
  return (
    <AppDialog title="Connections" subtitle="Local and SSH execution hosts" onClose={onClose}>
      <div className="scroll-thin max-h-[410px] overflow-auto">
        {hosts.map((host) => (
          <div className="my-2.5 rounded-xl border border-line-strong" key={host.id}>
            <div className="flex h-[68px] items-center gap-[11px] px-3.5">
              <StatusDot
                tone={host.status === 'online' ? 'online' : 'offline'}
                className="size-4"
              />
              <span className="min-w-0 flex-1">
                <strong className="block">{host.name}</strong>
                <small className="mt-1 block truncate text-muted">
                  {host.type === 'local' ? 'Local daemon' : host.sshAlias}
                  {host.error ? ` · ${host.error}` : ''}
                </small>
              </span>
              <Button
                variant="ghost"
                size="icon"
                title="Discover running agents"
                aria-label="Discover running agents"
                disabled={host.status !== 'online'}
                onClick={() => void inspectAgents(host)}
              >
                <Radio size={15} />
              </Button>
              {host.type === 'ssh' && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="Install or reconnect"
                  aria-label="Install or reconnect"
                  onClick={async () => {
                    setBusy(`host:${host.id}`)
                    setError('')
                    try {
                      await api.bootstrapHost(host.id)
                      await onChanged()
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause))
                    } finally {
                      setBusy('')
                    }
                  }}
                >
                  {busy === `host:${host.id}` ? (
                    <RefreshCw className="animate-spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                </Button>
              )}
            </div>
            {agents[host.id]?.map((agent) => (
              <div
                className="mx-2.5 mb-2.5 flex h-[55px] items-center gap-2.5 rounded-lg bg-ink-850 px-2.5"
                key={agent.id}
              >
                {providerIcon(agent.provider)}
                <span className="min-w-0 flex-1">
                  <strong className="block text-xs">
                    {agent.provider} · PID {agent.pid}
                  </strong>
                  <small className="block truncate text-[10px] text-muted">
                    {agent.cwd || agent.command}
                  </small>
                </span>
                {agent.managed_run_id ? (
                  <em className="text-[10px] text-grass-500 not-italic">Managed</em>
                ) : (
                  <button
                    className="flex items-center gap-[5px] text-[11px] text-ember-400 hover:text-ember-500"
                    onClick={() => api.controlDiscoveredAgent(host.id, agent.pid, 'interrupt')}
                  >
                    <Square size={12} />
                    Interrupt
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {error && <p className="mt-3 text-xs leading-relaxed text-scarlet-400">{error}</p>}
      <form
        className="grid grid-cols-[1fr_1fr_auto] gap-2 pt-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setError('')
          try {
            const host = await api.createHost({ name: name || alias, sshAlias: alias })
            setName('')
            setAlias('')
            await onChanged()
            try {
              await api.bootstrapHost(host.id)
              await onChanged()
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }}
      >
        <Input
          className="h-10"
          value={name}
          aria-label="Display name"
          onChange={(event) => setName(event.target.value)}
          placeholder="Display name"
        />
        <Input
          className="h-10"
          list="ssh-aliases"
          value={alias}
          aria-label="SSH alias"
          onChange={(event) => setAlias(event.target.value)}
          placeholder="SSH alias"
        />
        <datalist id="ssh-aliases">
          {aliases.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <Button variant="primary" size="lg" type="submit">
          <Plus size={16} />
          Connect
        </Button>
      </form>
    </AppDialog>
  )
}
