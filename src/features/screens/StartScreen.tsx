import { cn } from '../../lib/cn'
import { StatusDot } from '../../components/ui/status-dot'
import { sendButton } from './screen-styles'
import { Globe2 } from 'lucide-react'
import {
  Check,
  ChevronDown,
  FolderGit2,
  GitBranch,
  Laptop,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  TreePine,
  Zap,
} from 'lucide-react'
import { api } from '../../api'
import { logoUrl } from '../../lib/app-state'
import { harnessOrder, providerIcon } from '../../providerRegistry'
import type { AppState, DraftSession, GitContext, Host, Project, Run } from '../../types'
import { ComposerFooter, ComposerFrame, ComposerInput } from '../composer/Composer'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
const starterCard =
  'flex h-[121px] flex-col justify-between rounded-2xl border border-line bg-canvas p-[18px] text-left text-fg-soft hover:border-line-strong hover:bg-ink-900'
const starterLabel = 'text-sm leading-snug font-medium'
const codexComposer =
  'absolute bottom-3.5 left-1/2 z-10 w-[min(790px,calc(100%-80px))] -translate-x-1/2 rounded-[19px] border border-line-strong bg-surface shadow-2xl shadow-black/40'
const composerContext = 'flex h-9 items-center gap-4 rounded-t-[18px] bg-sunken px-4'
const contextButton = 'flex items-center gap-[7px] text-xs text-fg-soft hover:text-fg'
const harnessOption =
  'flex h-[30px] shrink-0 items-center gap-[5px] rounded-lg border border-line-strong bg-ink-850 px-2 text-[10px] whitespace-nowrap text-fg-soft hover:border-ink-400 hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 [&>svg]:size-[13px]'
const harnessOptionSelected =
  'border-grass-600/70 bg-grass-950 text-fg shadow-[inset_0_0_0_1px_#51d49722]'
const workspaceOption =
  'grid min-h-[58px] w-full grid-cols-[24px_minmax(0,1fr)_18px] items-center gap-[7px] rounded-lg px-2.5 py-2 text-left text-fg-soft hover:bg-ink-600 aria-selected:bg-ink-650 disabled:cursor-not-allowed disabled:opacity-40'

export function StartScreen({
  state,
  draft,
  project,
  host,
  onProject,
  onStarted,
  onError,
}: {
  state: AppState
  draft?: DraftSession
  project?: Project
  host?: Host
  onProject: () => void
  onStarted: (run: Run) => void
  onError: (message: string) => void
}) {
  const [prompt, setPrompt] = useState(draft?.prompt || '')
  const [provider, setProvider] = useState(draft?.provider || 'codex')
  const [workspace, setWorkspace] = useState<'current_checkout' | 'managed_worktree'>(
    draft?.workspaceMode || 'current_checkout',
  )
  const [workspaceMenu, setWorkspaceMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gitContext, setGitContext] = useState<GitContext | null>(null)
  const submitting = useRef(false)
  const started = useRef(false)
  const providers = project ? state.providersByHost[project.hostId] || [] : []
  const harnesses = useMemo(
    () =>
      providers
        .filter((item) => item.id !== 'shell')
        .sort((left, right) => harnessOrder.indexOf(left.id) - harnessOrder.indexOf(right.id)),
    [providers],
  )
  const selectedHarness = harnesses.find((item) => item.id === provider)
  useEffect(() => {
    if (selectedHarness?.available) return
    const first = harnesses.find((item) => item.available)
    if (first) setProvider(first.id)
  }, [harnesses, selectedHarness?.available])
  useEffect(() => {
    if (!draft || started.current) return
    const timer = window.setTimeout(() => {
      void api
        .updateDraft(draft.id, { prompt, provider, workspaceMode: workspace })
        .catch((cause) => {
          if (!submitting.current && !started.current)
            onError(cause instanceof Error ? cause.message : String(cause))
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [draft?.id, prompt, provider, workspace, onError])
  useEffect(() => {
    let cancelled = false
    setGitContext(null)
    if (project && host?.status === 'online')
      api
        .projectContext(project.hostId, project.id)
        .then((value) => {
          if (!cancelled) setGitContext(value)
        })
        .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [project?.hostId, project?.id, host?.status])
  useEffect(() => {
    if (gitContext && !gitContext.available && workspace === 'managed_worktree')
      setWorkspace('current_checkout')
  }, [gitContext?.available, workspace])
  const canUseWorktree = gitContext?.available === true
  const checkoutLabel = host?.type === 'ssh' ? 'Remote checkout' : 'Local'
  const canSubmit = Boolean(
    project &&
      host?.status === 'online' &&
      selectedHarness?.available &&
      prompt.trim() &&
      (workspace !== 'managed_worktree' || canUseWorktree),
  )
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!project || !canSubmit || submitting.current) return
    submitting.current = true
    setBusy(true)
    try {
      const input = {
        hostId: project.hostId,
        project_id: project.id,
        provider,
        prompt,
        workspace_mode: workspace,
        base_ref: workspace === 'managed_worktree' ? gitContext?.branch || 'HEAD' : undefined,
      }
      const next = draft ? await api.startDraft(draft.id, input) : await api.createRun(input)
      started.current = true
      onStarted(next)
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <div className="relative grid h-full place-items-center">
      <div className="-translate-y-[58px] text-center">
        <img
          className="mx-auto size-16 rounded-2xl object-cover shadow-[0_10px_28px_#0007,0_0_0_1px_#ffffff1c]"
          src={logoUrl}
          alt="Codesk"
        />
        <h1 className="mt-4 mb-10 text-2xl font-normal tracking-[-0.55px]">
          {project ? `What should we work on in ${project.name}?` : 'Add a project to get started'}
        </h1>
        {project && (
          <div className="grid grid-cols-[repeat(4,195px)] gap-3">
            <button
              className={starterCard}
              onClick={() => setPrompt('Explore and explain this codebase')}
            >
              <Search size={17} className="text-azure-500" />
              <span className={starterLabel}>
                Explore and
                <br />
                understand code
              </span>
            </button>
            <button
              className={starterCard}
              onClick={() => setPrompt('Build a new feature for this project')}
            >
              <Zap size={17} className="text-[#a37bff]" />
              <span className={starterLabel}>
                Build a new feature,
                <br />
                app, or tool
              </span>
            </button>
            <button
              className={starterCard}
              onClick={() => setPrompt('Review the code and suggest improvements')}
            >
              <RefreshCw size={17} className="text-grass-500" />
              <span className={starterLabel}>
                Review code and
                <br />
                suggest changes
              </span>
            </button>
            <button
              className={starterCard}
              onClick={() => setPrompt('Find and fix issues and failures')}
            >
              <ShieldAlert size={17} className="text-ember-500" />
              <span className={starterLabel}>Fix issues and failures</span>
            </button>
          </div>
        )}
      </div>
      {project ? (
        <ComposerFrame className={codexComposer} onSubmit={submit}>
          <div className={composerContext}>
            <button type="button" className={contextButton}>
              <FolderGit2 size={15} />
              {project.name}
            </button>
            <button type="button" className={contextButton}>
              {host?.type === 'ssh' ? <Globe2 size={15} /> : <Laptop size={15} />}
              {host?.type === 'ssh' ? 'Remote' : 'Local'}
            </button>
            <button
              type="button"
              className={contextButton}
              title={
                gitContext?.detached
                  ? 'Detached HEAD'
                  : gitContext?.dirty
                    ? 'Working tree has changes'
                    : gitContext?.available
                      ? 'Current Git branch'
                      : 'This folder is not a Git repository'
              }
            >
              <GitBranch size={15} />
              {gitContext
                ? gitContext.available
                  ? gitContext.branch
                  : 'No Git repository'
                : host?.status === 'online'
                  ? 'Loading branch'
                  : 'Unavailable'}
              {gitContext?.dirty ? ' *' : ''}
            </button>
            <span className="flex-1" />
            <strong className="flex items-center gap-2 text-[11px]">
              {host?.name}
              <StatusDot tone={host?.status === 'online' ? 'online' : 'offline'} />
            </strong>
          </div>
          <div className="flex h-[47px] items-center gap-2.5 border-b border-line px-3 pt-2 pb-[5px]">
            <span className="text-[10px] font-semibold whitespace-nowrap text-muted">
              Start with
            </span>
            <div
              className="scroll-none flex min-w-0 items-center gap-[5px] overflow-x-auto"
              role="radiogroup"
              aria-label="Choose a harness"
            >
              {harnesses.map((item) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={provider === item.id}
                  className={cn(harnessOption, provider === item.id && harnessOptionSelected)}
                  key={item.id}
                  disabled={!item.available}
                  title={
                    item.available
                      ? `Start this chat with ${item.name}`
                      : `${item.name} is not installed on ${host?.name || 'this host'}`
                  }
                  onClick={() => setProvider(item.id)}
                >
                  {providerIcon(item.id)}
                  <span>{item.name}</span>
                  <i
                    className={cn(
                      'size-[5px] shrink-0 rounded-full',
                      item.available ? 'bg-grass-500' : 'bg-ink-400',
                    )}
                  />
                </button>
              ))}
            </div>
          </div>
          <ComposerInput
            className="h-[60px] px-4 py-3 text-[13px]"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={
              selectedHarness
                ? `Ask ${selectedHarness.name} to do anything`
                : 'Choose a harness to get started'
            }
          />
          <ComposerFooter className="rounded-b-[18px]">
            <button
              type="button"
              className="grid size-7 shrink-0 place-items-center text-muted hover:text-fg"
              aria-label="Add attachment"
            >
              <Plus size={18} />
            </button>
            <div className="relative">
              <button
                type="button"
                className={cn(
                  'flex h-[30px] items-center gap-1.5 rounded-md px-[7px] text-xs hover:bg-ink-650 aria-expanded:bg-ink-650',
                  workspace === 'managed_worktree' ? 'text-grass-500' : 'text-ember-500',
                )}
                aria-haspopup="listbox"
                aria-expanded={workspaceMenu}
                onClick={() => setWorkspaceMenu((value) => !value)}
              >
                {workspace === 'managed_worktree' ? <TreePine size={15} /> : <Laptop size={15} />}
                {workspace === 'managed_worktree' ? 'New worktree' : checkoutLabel}
                <ChevronDown size={13} />
              </button>
              {workspaceMenu && (
                <div
                  className="absolute -left-2 bottom-9 z-20 w-[310px] rounded-xl border border-line-strong bg-ink-700 p-2 shadow-2xl shadow-black/60"
                  role="listbox"
                  aria-label="Work in"
                >
                  <header className="flex h-[29px] items-center px-2.5 text-[11px] text-muted">
                    Work in
                  </header>
                  <button
                    type="button"
                    role="option"
                    aria-selected={workspace === 'current_checkout'}
                    className={workspaceOption}
                    onClick={() => {
                      setWorkspace('current_checkout')
                      setWorkspaceMenu(false)
                    }}
                  >
                    <Laptop size={18} />
                    <span className="flex min-w-0 flex-col gap-[3px]">
                      <strong className="text-[13px] font-medium">{checkoutLabel}</strong>
                      <small className="text-[10px] leading-tight text-muted">
                        Use the project’s current checkout.
                      </small>
                    </span>
                    {workspace === 'current_checkout' && <Check size={16} />}
                  </button>
                  <button
                    type="button"
                    role="option"
                    aria-selected={workspace === 'managed_worktree'}
                    className={workspaceOption}
                    disabled={!canUseWorktree}
                    title={
                      canUseWorktree
                        ? `Create a copy of ${project.name} to work in parallel.`
                        : 'New worktrees require a Git repository'
                    }
                    onClick={() => {
                      setWorkspace('managed_worktree')
                      setWorkspaceMenu(false)
                    }}
                  >
                    <TreePine size={18} />
                    <span className="flex min-w-0 flex-col gap-[3px]">
                      <strong className="text-[13px] font-medium">New worktree</strong>
                      <small className="text-[10px] leading-tight text-muted">
                        {canUseWorktree
                          ? `Create an isolated copy from ${gitContext?.branch || 'HEAD'}.`
                          : 'This project is not a Git repository.'}
                      </small>
                    </span>
                    {workspace === 'managed_worktree' && <Check size={16} />}
                  </button>
                </div>
              )}
            </div>
            <span className="flex-1" />
            <small className="flex items-center gap-1.5 text-[10px] whitespace-nowrap text-muted [&>svg]:size-[13px]">
              {selectedHarness && providerIcon(selectedHarness.id)}
              {selectedHarness?.name || 'No harness available'}
            </small>
            <button
              className={sendButton}
              disabled={busy || !canSubmit}
              title={
                host?.status !== 'online'
                  ? 'Execution host is offline'
                  : !selectedHarness?.available
                    ? 'Choose an installed harness'
                    : workspace === 'managed_worktree' && !canUseWorktree
                      ? 'New worktrees require a Git repository'
                      : 'Start chat'
              }
            >
              {busy ? <RefreshCw className="animate-spin" size={17} /> : <Send size={17} />}
            </button>
          </ComposerFooter>
        </ComposerFrame>
      ) : (
        <button
          className="flex h-[38px] items-center gap-[7px] rounded-lg bg-ink-100 px-4 text-ink-850 hover:bg-fg"
          onClick={onProject}
        >
          <Plus size={17} />
          Add project
        </button>
      )}
    </div>
  )
}
