// Every harness has to say when a turn ended.
//
// Codesk announces a finished turn — the sidebar mark and the desktop
// notification — from a `turn_completed` record in the conversation, and it
// shows a live turn as "running" from the same transcript. Codex, DSH, and
// Antigravity write an explicit end-of-turn event; Claude Code, Pi, Kiro, and
// OpenCode do not, and used to produce neither signal: a Claude turn finished
// in silence, and the transcript watcher, seeing a conversation that never
// closed a turn, kept polling it at its active-turn rate forever.
//
// These transcripts are synthetic on purpose. The assertions are about parsing
// a harness's own on-disk format, so they need no credits and no login, and
// they run on every commit. `scripts/test-claude-completion-live.mjs` proves the
// same two signals against a real Claude Code process.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { daemonAuth } from './daemon-token.mjs'

const root = await mkdtemp(join(tmpdir(), 'codesk-turns-'))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const port = 46000 + Math.floor(Math.random() * 500)
const base = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()
const slug = (path) => path.replace(/^\//, '').replace(/[^A-Za-z0-9-]/g, '-')

await mkdir(workspace, { recursive: true })
const write = async (path, lines) => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

// --- Claude Code -----------------------------------------------------------
// A turn ends with an assistant step that stopped, and Claude follows it with
// its own `turn_duration` record. The two describe one turn.
const claudeDirectory = join(home, '.claude/projects', `-${slug(workspace)}`)
const claudeRecords = (sessionId, finished) => {
  const records = [
    { type: 'user', uuid: `${sessionId}-u1`, sessionId, cwd: workspace, timestamp: iso(-60_000), message: { role: 'user', content: 'first prompt' } },
    { type: 'assistant', uuid: `${sessionId}-a1`, sessionId, cwd: workspace, timestamp: iso(-55_000), message: { role: 'assistant', content: [{ type: 'text', text: 'reading a file' }], stop_reason: 'tool_use' } },
    { type: 'user', uuid: `${sessionId}-u2`, sessionId, cwd: workspace, timestamp: iso(-50_000), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  ]
  if (!finished) return records
  return [
    ...records,
    { type: 'assistant', uuid: `${sessionId}-a2`, sessionId, cwd: workspace, timestamp: iso(-45_000), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'turn_duration', uuid: `${sessionId}-d1`, sessionId, cwd: workspace, timestamp: iso(-44_960), durationMs: 15_040 },
  ]
}
await write(join(claudeDirectory, 'claude-live.jsonl'), claudeRecords('claude-live', false))
await write(join(claudeDirectory, 'claude-done.jsonl'), claudeRecords('claude-done', true))

// --- Pi --------------------------------------------------------------------
// Pi names every mid-turn stop `toolUse`. `stop`, `error`, and `aborted` all end
// the turn, and reading the last two as live is what stranded a failed Pi
// session at "running" until its process was killed.
const piDirectory = join(home, '.pi/agent/sessions', `--${workspace.replace(/^\/|\/$/g, '').replaceAll('/', '-')}--`)
const piRecords = (sessionId, stopReason) => {
  const records = [
    { type: 'session', id: sessionId, cwd: workspace, timestamp: iso(-60_000) },
    { type: 'message', id: `${sessionId}-u1`, timestamp: iso(-60_000), message: { role: 'user', content: 'first prompt' } },
    { type: 'message', id: `${sessionId}-a1`, timestamp: iso(-55_000), message: { role: 'assistant', content: [{ type: 'text', text: 'calling a tool' }], stopReason: 'toolUse' } },
    { type: 'message', id: `${sessionId}-t1`, timestamp: iso(-54_000), message: { role: 'toolResult', content: 'ok' } },
  ]
  if (!stopReason) return records
  return [...records, { type: 'message', id: `${sessionId}-a2`, timestamp: iso(-48_000), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason } }]
}
await write(join(piDirectory, `2026-01-01T00-00-00-000Z_pi-live.jsonl`), piRecords('pi-live', null))
await write(join(piDirectory, `2026-01-01T00-00-01-000Z_pi-done.jsonl`), piRecords('pi-done', 'stop'))
await write(join(piDirectory, `2026-01-01T00-00-02-000Z_pi-failed.jsonl`), piRecords('pi-failed', 'error'))

// --- Kiro ------------------------------------------------------------------
// Kiro appends one AssistantMessage per step and writes nothing at the end, so
// the step that stops asking for tools is the boundary. Only its Prompt records
// carry a clock, so a Kiro turn's length is genuinely unknown.
const kiroDirectory = join(home, '.kiro/sessions/cli')
await mkdir(kiroDirectory, { recursive: true })
const kiroRecords = (finished) => {
  const records = [
    { kind: 'Prompt', version: 1, data: { message_id: 'k1', content: [{ data: 'first prompt' }], meta: { timestamp: Math.floor(Date.now() / 1000) - 60 } } },
    { kind: 'AssistantMessage', version: 1, data: { message_id: 'k2', content: [{ kind: 'text', data: 'calling a tool' }, { kind: 'toolUse', data: { name: 'fs_read', toolUseId: 'call-1', input: {} } }] } },
    { kind: 'ToolResults', version: 1, data: { message_id: 'k3', content: [{ data: { toolUseId: 'call-1', status: 'success', content: [{ text: 'ok' }] } }] } },
  ]
  if (!finished) return records
  return [...records, { kind: 'AssistantMessage', version: 1, data: { message_id: 'k4', content: [{ kind: 'text', data: 'done' }] } }]
}
for (const [id, finished] of [['kiro-live', false], ['kiro-done', true]]) {
  await writeFile(join(kiroDirectory, `${id}.json`), JSON.stringify({ session_id: id, cwd: workspace, title: `${id} conversation`, created_at: iso(-60_000), updated_at: iso(-40_000) }))
  await write(join(kiroDirectory, `${id}.jsonl`), kiroRecords(finished))
}

// --- OpenCode --------------------------------------------------------------
// OpenCode keeps history in SQLite, so it has no transcript file for the shared
// turn-active scan to read, and was the one provider that could never report a
// live turn at all. It does record when each assistant step finished and why.
const opencodeDirectory = join(home, '.local/share/opencode')
await mkdir(opencodeDirectory, { recursive: true })
const db = new DatabaseSync(join(opencodeDirectory, 'opencode.db'))
db.exec(`
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
`)
const now = Date.now()
const addOpencode = (sessionId, finish) => {
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,NULL)').run(sessionId, workspace, `${sessionId} conversation`, now - 60_000, now - 5_000)
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(`${sessionId}-m1`, sessionId, now - 60_000, JSON.stringify({ role: 'user', time: { created: now - 60_000 } }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(`${sessionId}-p1`, `${sessionId}-m1`, now - 60_000, JSON.stringify({ type: 'text', text: 'first prompt' }))
  const completed = finish ? { completed: now - 45_000 } : {}
  db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(`${sessionId}-m2`, sessionId, now - 55_000, JSON.stringify({ role: 'assistant', finish, time: { created: now - 55_000, ...completed } }))
  db.prepare('INSERT INTO part VALUES (?,?,?,?)').run(`${sessionId}-p2`, `${sessionId}-m2`, now - 55_000, JSON.stringify({ type: 'text', text: finish ? 'done' : 'working' }))
}
addOpencode('opencode-live', 'tool-calls')
addOpencode('opencode-done', 'stop')
db.close()

const daemon = spawn(join(process.cwd(), 'target/debug/codeskd'), [], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, '.local/share'), CODESK_DATA_DIR: root, CODESK_PORT: String(port), RUST_LOG: 'warn' },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let daemonErr = ''
daemon.stderr.on('data', (chunk) => { daemonErr += chunk.toString() })

const request = async (path, options = {}) => {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'content-type': 'application/json', ...daemonAuth(root), ...(options.headers || {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${text}`)
  return JSON.parse(text)
}

let failed = false
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await request('/v1/health')).ok) break } catch {}
    await sleep(200)
  }
  const project = await request('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'turn completion', path: workspace }) })
  const sessions = await request(`/v1/projects/${project.id}/sessions?limit=50`)
  const byId = new Map(sessions.map((session) => [session.native_session_id, session]))

  // Every synthetic conversation has to be indexed, or an assertion below would
  // pass by finding nothing.
  const expected = ['claude-live', 'claude-done', 'pi-live', 'pi-done', 'pi-failed', 'kiro-live', 'kiro-done', 'opencode-live', 'opencode-done']
  for (const id of expected) assert.ok(byId.has(id), `${id} was not indexed at all (found: ${[...byId.keys()].join(', ') || 'nothing'})`)

  const turnsOf = async (session) => {
    const messages = await request(`/v1/projects/${project.id}/sessions/${session.provider}/${encodeURIComponent(session.native_session_id)}/messages`)
    return messages.filter((message) => message.kind === 'turn_completed')
  }

  for (const id of expected) {
    const session = byId.get(id)
    const live = id.endsWith('-live')
    assert.equal(session.status, live ? 'running' : 'idle', `${id} reported status ${session.status}`)
    const turns = await turnsOf(session)
    assert.equal(turns.length, live ? 0 : 1, `${id} produced ${turns.length} turn markers`)
  }

  // A turn marker is only useful if it says how long the turn took, wherever the
  // harness records it. Kiro is the honest exception: it timestamps prompts and
  // nothing else, so its marker carries no duration rather than a fabricated one.
  const [claudeTurn] = await turnsOf(byId.get('claude-done'))
  assert.equal(claudeTurn.duration_ms, 15_040, 'the Claude turn lost the duration Claude recorded')
  const [opencodeTurn] = await turnsOf(byId.get('opencode-done'))
  assert.equal(opencodeTurn.duration_ms, 10_000, 'the OpenCode turn duration did not come from its own clock')
  const [piTurn] = await turnsOf(byId.get('pi-done'))
  assert.equal(piTurn.duration_ms, 12_000, 'the Pi turn duration was not measured from the prompt that opened it')
  const [kiroTurn] = await turnsOf(byId.get('kiro-done'))
  assert.ok(kiroTurn.duration_ms == null, `Kiro cannot time a turn and must not claim to (got ${kiroTurn.duration_ms})`)

  console.log('ok - every harness reports a live turn as running and writes a turn marker when it ends')
  console.log('ok - turn markers carry the duration the harness recorded, and none where it recorded none')
} catch (error) {
  failed = true
  if (daemonErr) console.error(JSON.stringify({ daemon: daemonErr.slice(-3000) }))
  throw error
} finally {
  if (daemon.exitCode === null) daemon.kill('SIGTERM')
  await sleep(400)
  if (!failed) await rm(root, { recursive: true, force: true })
  else console.error(`test data retained at ${root}`)
}
