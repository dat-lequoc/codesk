import { createMappers, usableTmuxCommand } from '../server/mappers.mjs'

const store = {
  state: {
    hosts: [
      { id: 'local', type: 'local' },
      { id: 'remote', type: 'ssh', sshAlias: 'quocd2' },
    ],
  },
}
const { mapSession, accessCommandForHost } = createMappers(store)

if (usableTmuxCommand('tmux attach-session -t plugin') !== 'TMUX= tmux attach-session -t plugin') {
  throw new Error('attach pasted from inside tmux must unset TMUX')
}
if (usableTmuxCommand('TMUX= tmux attach-session -t =plugin') !== 'TMUX= tmux attach-session -t =plugin') {
  throw new Error('an already-usable command was rewritten')
}

const dead = mapSession({
  id: 'kiro:dead',
  provider: 'kiro',
  native_session_id: 'dead',
  project_id: 'p',
  cwd: '/home/nightfury/dsh-headlong',
  title: 'gone',
  created_at: '',
  updated_at: '',
  status: 'idle',
  pid: null,
  tmux_name: 'codesk-kiro-0f52a58e',
  tmux_access_command: 'tmux -S /home/nightfury/.local/share/codesk/tmux/codesk.sock attach-session -t codesk-kiro-0f52a58e',
  tmux_controlled: false,
  tmux_owned: true,
}, 'remote')
if (dead.tmuxAccessCommand || dead.tmuxHostAccessCommand) {
  throw new Error(`dead pane still advertised attach: ${dead.tmuxAccessCommand}`)
}
if (dead.tmuxName !== 'codesk-kiro-0f52a58e') {
  throw new Error('dead pane should still show its tmux name')
}

const live = mapSession({
  id: 'kiro:live',
  provider: 'kiro',
  native_session_id: 'live',
  project_id: 'p',
  cwd: '/home/nightfury/dsh-headlong',
  title: 'live',
  created_at: '',
  updated_at: '',
  status: 'idle',
  pid: 1361599,
  tmux_name: 'plugin',
  tmux_access_command: 'tmux -S /tmp/tmux-1001/default attach-session -t plugin',
  tmux_controlled: true,
  tmux_owned: false,
}, 'remote')
if (!live.tmuxHostAccessCommand.startsWith('TMUX= ')) {
  throw new Error(`live on-host command should unset TMUX: ${live.tmuxHostAccessCommand}`)
}
if (!live.tmuxAccessCommand.startsWith("ssh -t 'quocd2' 'TMUX= ")) {
  throw new Error(`live access command should ssh and unset TMUX: ${live.tmuxAccessCommand}`)
}

const wrapped = accessCommandForHost('remote', 'tmux attach-session -t plugin')
if (wrapped !== "ssh -t 'quocd2' 'TMUX= tmux attach-session -t plugin'") {
  throw new Error(`unexpected wrap: ${wrapped}`)
}

console.log('ok - tmux attach commands are omitted for dead panes and usable from inside tmux')
