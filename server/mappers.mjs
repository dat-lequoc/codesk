export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

export function createMappers(store) {
  const accessCommandForHost = (hostId, command) => {
    if (!command) return null
    const host = store.state.hosts.find((item) => item.id === hostId)
    return host?.type === 'ssh' ? `ssh -t ${shellQuote(host.sshAlias)} ${shellQuote(command)}` : command
  }
  const mapRun = (item, hostId) => ({ id:item.id, projectId:item.project_id, worktreeId:item.worktree_id, parentRunId:item.parent_run_id, provider:item.provider, sessionId:item.provider_session_id, title:item.title, prompt:item.prompt, model:item.model || '', cwd:item.cwd, command:item.command, args:item.args, status:item.status, pid:item.pid, processGroupId:item.process_group_id, createdAt:item.created_at, startedAt:item.started_at, finishedAt:item.finished_at, exitCode:item.exit_code, terminatingSignal:item.terminating_signal, displayCommand:[item.command,...(item.args || [])].join(' '), inputTransport:item.input_transport, tmuxName:item.tmux_name, tmuxAccessCommand:accessCommandForHost(hostId,item.tmux_access_command), tmuxHostAccessCommand:item.tmux_access_command || null, hostId })
  const mapSession = (item, hostId) => ({ id:item.id, provider:item.provider, nativeSessionId:item.native_session_id, projectId:item.project_id, hostId, cwd:item.cwd, title:item.title, createdAt:item.created_at, updatedAt:item.updated_at, sortAt:item.updated_at, status:item.status, pid:item.pid, managedRunId:item.managed_run_id, inputAvailable:item.input_available, inputTransport:item.input_transport, tmuxName:item.tmux_name, tmuxAccessCommand:accessCommandForHost(hostId,item.tmux_access_command), tmuxHostAccessCommand:item.tmux_access_command || null, tmuxControlled:item.tmux_controlled, tmuxOwned:item.tmux_owned, model:item.model, effort:item.effort })
  const mapAgent = (item, hostId) => ({ ...item, tmux_host_access_command:item.tmux_access_command || null, tmux_access_command:accessCommandForHost(hostId,item.tmux_access_command) })
  const mapExternalQueued = (item, hostId) => item?.run ? { ...item, run:mapRun(item.run, hostId) } : item
  return { shellQuote, accessCommandForHost, mapRun, mapSession, mapAgent, mapExternalQueued }
}
