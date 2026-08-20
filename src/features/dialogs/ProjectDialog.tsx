// Extracted from App.tsx during the Tailwind/module refactor.

import { Home } from 'lucide-react'
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderGit2,
  Laptop,
  RefreshCw,
  Search,
  Server,
} from 'lucide-react'
import { api } from '../../api'
import { useLatest } from '../../hooks/useLatest'
import { AppDialog } from '../../components/ui/app-dialog'
import { Button } from '../../components/ui/button'
import { StatusDot } from '../../components/ui/status-dot'
import { cn } from '../../lib/cn'
import { folderMatchScore } from '../../lib/app-state'
import { pathLike } from '../../lib/format'
import type { FileEntry, Host } from '../../types'
import { useEffect, useMemo, useRef, useState } from 'react'
const toolbarButton =
  'grid place-items-center rounded-md border border-line-strong bg-ink-850 disabled:cursor-default disabled:opacity-35'
const crumb = 'px-1 py-[3px] text-[11px] whitespace-nowrap text-fg-soft hover:text-fg'
const kbd =
  'inline-grid h-4 min-w-[17px] place-items-center rounded-sm border border-line-strong bg-ink-850 px-[3px] font-mono text-[9px] text-fg-soft'
const folderState =
  'flex h-full flex-col items-center justify-center gap-[7px] text-[11px] text-muted'

export function ProjectDialog({
  hosts,
  onClose,
  onCreated,
}: {
  hosts: Host[]
  onClose: () => void
  onCreated: () => void
}) {
  const online = hosts.filter((host) => host.status === 'online')
  const [hostId, setHost] = useState(online[0]?.id || '')
  const [input, setInput] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [highlighted, setHighlighted] = useState(0)
  const [busy, setBusy] = useState<'browse' | 'add' | ''>('')
  const [error, setError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedHost = online.find((host) => host.id === hostId)
  const isPathInput = pathLike(input)
  const filteredEntries = useMemo(() => {
    if (isPathInput) return entries
    return entries
      .map((entry) => ({ entry, score: folderMatchScore(entry, input) }))
      .filter((item) => Number.isFinite(item.score))
      .sort(
        (left, right) =>
          left.score - right.score || left.entry.name.localeCompare(right.entry.name),
      )
      .map((item) => item.entry)
  }, [entries, input, isPathInput])
  const browse = async (nextPath = currentPath) => {
    if (!hostId || busy === 'add') return
    setBusy('browse')
    setError('')
    try {
      const listing = await api.files(hostId, nextPath)
      setCurrentPath(listing.current_path)
      setSelectedPath(listing.current_path)
      setInput('')
      setHighlighted(0)
      setParentPath(listing.parent_path || null)
      setHomePath(listing.home_path)
      setEntries(listing.entries)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }
  // Switching hosts throws away everything about the previous filesystem before
  // the new listing lands, so the picker never shows one host's folders under
  // another host's name.
  const browseRef = useLatest(browse)
  const [browsingHostId, setBrowsingHostId] = useState(hostId)
  if (browsingHostId !== hostId) {
    setBrowsingHostId(hostId)
    setEntries([])
    setInput('')
    setSelectedPath('')
    setCurrentPath('')
    setParentPath(null)
    setHomePath('')
    setHighlighted(0)
  }
  useEffect(() => {
    if (hostId) void browseRef.current('')
  }, [browseRef, hostId])
  // Retyping the filter puts the highlight back on the best match.
  const [highlightedFor, setHighlightedFor] = useState(input)
  if (highlightedFor !== input) {
    setHighlightedFor(input)
    setHighlighted(0)
  }
  useEffect(() => {
    document.querySelector('.folder-entry.highlighted')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  const segments = currentPath.split('/').filter(Boolean)
  const openInput = () => {
    const target = isPathInput ? input.trim() : filteredEntries[highlighted]?.path
    if (target) void browse(target)
  }
  return (
    <AppDialog
      title="Add folder"
      subtitle="Choose a folder on this Mac or a connected host."
      onClose={onClose}
      className="max-w-[820px]"
    >
      {/* Hosts the Cmd/Ctrl+L shortcut for the path field; not itself a control,
          so it takes no role and never enters the tab order. */}
      <div
        role="presentation"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
            event.preventDefault()
            searchRef.current?.focus()
          }
        }}
      >
        <div className="scroll-thin mb-3.5 flex gap-2 overflow-auto">
          {online.map((host) => (
            <button
              type="button"
              className={cn(
                'flex h-12 min-w-[155px] items-center gap-2.5 rounded-lg border border-line-strong bg-sidebar px-[11px] text-left',
                host.id === hostId && 'border-ink-400 bg-ink-600',
              )}
              key={host.id}
              onClick={() => setHost(host.id)}
            >
              {host.type === 'ssh' ? <Server size={16} /> : <Laptop size={16} />}
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xs font-medium">{host.name}</strong>
                <small className="mt-[3px] block truncate text-[10px] text-muted">
                  {host.type === 'ssh' ? host.sshAlias : 'This Mac'}
                </small>
              </span>
              <StatusDot tone={host.status === 'online' ? 'online' : 'offline'} />
            </button>
          ))}
        </div>
        <div className="grid h-10 grid-cols-[38px_38px_1fr_38px] gap-1.5">
          <button
            type="button"
            className={toolbarButton}
            title="Parent folder"
            aria-label="Parent folder"
            disabled={!parentPath || !!busy}
            onClick={() => parentPath && void browse(parentPath)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            className={toolbarButton}
            title="Home folder"
            aria-label="Home folder"
            disabled={!homePath || !!busy}
            onClick={() => void browse(homePath)}
          >
            <Home size={16} />
          </button>
          <form
            className="grid grid-cols-[32px_1fr_36px] items-center overflow-hidden rounded-md border border-line-strong bg-ink-850 focus-within:border-ink-400"
            onSubmit={(event) => {
              event.preventDefault()
              openInput()
            }}
          >
            <Search size={15} className="ml-[11px] text-dim" />
            <input
              className="min-w-0 border-0 bg-transparent px-2 text-[11px] outline-none"
              ref={searchRef}
              aria-label="Search folders or enter a path"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setHighlighted((value) => Math.min(filteredEntries.length - 1, value + 1))
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setHighlighted((value) => Math.max(0, value - 1))
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setInput('')
                  setHighlighted(0)
                } else if (event.key === 'Tab' && !isPathInput && filteredEntries[highlighted]) {
                  event.preventDefault()
                  setInput(filteredEntries[highlighted].name)
                }
              }}
              placeholder={
                selectedHost?.type === 'ssh'
                  ? 'Search folders or enter /home/…'
                  : 'Search folders or enter /Users/…'
              }
            />
            <button
              className="grid h-full place-items-center border-l border-line-strong bg-ink-700 disabled:opacity-35"
              title={isPathInput ? 'Go to path' : 'Open highlighted folder'}
              aria-label={isPathInput ? 'Go to path' : 'Open highlighted folder'}
              disabled={(!input.trim() && !filteredEntries[highlighted]) || !!busy}
            >
              <ChevronRight size={16} />
            </button>
          </form>
          <button
            type="button"
            className={toolbarButton}
            title="Refresh"
            aria-label="Refresh"
            disabled={!!busy}
            onClick={() => void browse(currentPath)}
          >
            <RefreshCw className={cn(busy === 'browse' && 'animate-spin')} size={15} />
          </button>
        </div>
        <div className="scroll-thin flex h-[31px] items-center gap-0.5 overflow-auto px-1 text-dim">
          <button type="button" className={crumb} onClick={() => void browse('/')}>
            <span>/</span>
          </button>
          {segments.map((segment, index) => {
            const segmentPath = `/${segments.slice(0, index + 1).join('/')}`
            return (
              <span className="flex items-center" key={segmentPath}>
                <ChevronRight size={12} />
                <button type="button" className={crumb} onClick={() => void browse(segmentPath)}>
                  {segment}
                </button>
              </span>
            )
          })}
        </div>
        <div className="flex h-[25px] items-center px-[5px] text-[10px] text-muted">
          <span className="flex-1">
            {input.trim() && !isPathInput
              ? `${filteredEntries.length} matching folder${filteredEntries.length === 1 ? '' : 's'}`
              : `${entries.length} folder${entries.length === 1 ? '' : 's'}`}
          </span>
          <small className="flex items-center gap-1 text-dim">
            <kbd className={kbd}>↑</kbd>
            <kbd className={kbd}>↓</kbd> choose <kbd className={kbd}>Enter</kbd> open{' '}
            <kbd className={kbd}>Tab</kbd> complete <kbd className={kbd}>Esc</kbd> clear
          </small>
        </div>
        <div className="scroll-thin h-[290px] overflow-auto rounded-xl border border-line-strong bg-ink-850 p-[5px]">
          {busy === 'browse' && !entries.length ? (
            <div className={folderState}>
              <RefreshCw className="animate-spin" size={16} />
              Loading folders
            </div>
          ) : filteredEntries.length ? (
            filteredEntries.map((entry, index) => (
              <div
                className={cn(
                  'grid h-12 grid-cols-[1fr_34px] items-center rounded-[7px] hover:bg-ink-650',
                  selectedPath === entry.path && currentPath !== entry.path && 'bg-ink-650',
                  !isPathInput &&
                    index === highlighted &&
                    'bg-ink-600 shadow-[inset_2px_0_var(--color-ink-200)]',
                  !isPathInput &&
                    index === highlighted &&
                    selectedPath === entry.path &&
                    'shadow-[inset_2px_0_var(--color-grass-500)]',
                )}
                key={entry.path}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 items-center gap-2.5 px-1.5 text-left"
                  onMouseEnter={() => setHighlighted(index)}
                  onDoubleClick={() => void browse(entry.path)}
                  onClick={() => setSelectedPath(entry.path)}
                >
                  <span
                    className={cn(
                      'grid shrink-0 place-items-center',
                      entry.is_git ? 'text-grass-500' : 'text-muted',
                    )}
                  >
                    {entry.is_git ? <FolderGit2 size={17} /> : <Folder size={17} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-xs font-medium">{entry.name}</strong>
                    <small className="mt-[3px] block truncate font-mono text-[9px] text-dim">
                      {entry.path}
                    </small>
                  </span>
                  {entry.is_git && (
                    <em className="shrink-0 rounded-lg border border-grass-600/60 px-1.5 py-0.5 text-[9px] text-grass-500 not-italic">
                      Git repository
                    </em>
                  )}
                </button>
                <button
                  type="button"
                  className="grid size-7 place-items-center rounded-md text-muted hover:bg-ink-500 hover:text-fg"
                  title={`Open ${entry.name}`}
                  onClick={() => void browse(entry.path)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            ))
          ) : (
            <div className={folderState}>
              {input.trim() && !isPathInput ? (
                <>
                  <Search size={18} />
                  <strong className="text-xs text-fg-soft">No matching folders</strong>
                  <span>Try another name or type a full path.</span>
                </>
              ) : (
                <>
                  <Folder size={18} />
                  <strong className="text-xs text-fg-soft">This folder is empty</strong>
                  <span>You can still add it as a project.</span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="mt-2.5 flex h-[49px] items-center gap-2.5 rounded-lg border border-line-strong bg-ink-700 px-2.5">
          <FolderGit2 size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <small className="mb-[3px] block text-[9px] text-muted">Folder to add</small>
            <strong className="block truncate font-mono text-[10px] font-normal">
              {selectedPath || currentPath || 'Choose a folder'}
            </strong>
          </span>
          {selectedPath && currentPath && selectedPath !== currentPath && (
            <button
              type="button"
              className="shrink-0 text-[10px] text-muted hover:text-fg"
              onClick={() => void browse(selectedPath)}
            >
              Open
            </button>
          )}
        </div>
        {error && <p className="mt-3 text-xs leading-relaxed text-scarlet-400">{error}</p>}
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted">
          Codesk registers only the selected folder. Sessions from nested folders stay separate and
          are not included in this project.
        </p>
        <footer className="mt-4 flex justify-end gap-2.5">
          <Button type="button" variant="ghost" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="lg"
            disabled={!selectedPath || !!busy}
            onClick={async () => {
              setBusy('add')
              setError('')
              try {
                const name = selectedPath.split('/').filter(Boolean).at(-1) || selectedPath
                await api.createProject({ hostId, name, path: selectedPath })
                onCreated()
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
                setBusy('')
              }
            }}
          >
            {busy === 'add' ? (
              <>
                <RefreshCw className="animate-spin" size={14} />
                Adding…
              </>
            ) : (
              'Add folder'
            )}
          </Button>
        </footer>
      </div>
    </AppDialog>
  )
}
