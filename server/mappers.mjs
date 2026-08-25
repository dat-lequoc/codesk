export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

/// Paste-able tmux attach has to work from inside another tmux client.
/// Unset TMUX so attach talks to the socket in the command, not the current one.
export const usableTmuxCommand = (command) => {
  if (!command) return null
  return /(?:^|\s)TMUX=/.test(command) ? command : `TMUX= ${command}`
}

export function createMappers(store) {
  const accessCommandForHost = (hostId, command) => {
    const usable = usableTmuxCommand(command)
    if (!usable) return null
    const host = store.state.hosts.find((item) => item.id === hostId)
    return host?.type === 'ssh' ? `ssh -t ${shellQuote(host.sshAlias)} ${shellQuote(usable)}` : usable
  }
  const sessionAttach = (hostId, command, pid) => pid ? accessCommandForHost(hostId, command) : null
  const sessionHostAttach = (command, pid) => pid ? usableTmuxCommand(command) : null
  const mapRun = (item, hostId) => ({ id:item.id, projectId:item.project_id, worktreeId:item.worktree_id, parentRunId:item.parent_run_id, provider:item.provider, sessionId:item.provider_session_id, title:item.title, prompt:item.prompt, model:item.model || '', cwd:item.cwd, command:item.command, args:item.args, status:item.status, pid:item.pid, processGroupId:item.process_group_id, createdAt:item.created_at, startedAt:item.started_at, finishedAt:item.finished_at, exitCode:item.exit_code, terminatingSignal:item.terminating_signal, displayCommand:[item.command,...(item.args || [])].join(' '), inputTransport:item.input_transport, tmuxName:item.tmux_name, tmuxAccessCommand:sessionAttach(hostId,item.tmux_access_command,item.pid), tmuxHostAccessCommand:sessionHostAttach(item.tmux_access_command,item.pid), hostId })
  const mapSession = (item, hostId) => ({ id:item.id, provider:item.provider, nativeSessionId:item.native_session_id, projectId:item.project_id, hostId, cwd:item.cwd, title:item.title, createdAt:item.created_at, updatedAt:item.updated_at, sortAt:item.updated_at, status:item.status, pid:item.pid, managedRunId:item.managed_run_id, inputAvailable:item.input_available, inputTransport:item.input_transport, tmuxName:item.tmux_name, tmuxAccessCommand:sessionAttach(hostId,item.tmux_access_command,item.pid), tmuxHostAccessCommand:sessionHostAttach(item.tmux_access_command,item.pid), tmuxControlled:item.tmux_controlled, tmuxOwned:item.tmux_owned, model:item.model, effort:item.effort })
  const mapAgent = (item, hostId) => ({ ...item, tmux_host_access_command:usableTmuxCommand(item.tmux_access_command), tmux_access_command:accessCommandForHost(hostId,item.tmux_access_command) })
  const mapExternalQueued = (item, hostId) => item?.run ? { ...item, run:mapRun(item.run, hostId) } : item
  return { shellQuote, accessCommandForHost, mapRun, mapSession, mapAgent, mapExternalQueued }
}
