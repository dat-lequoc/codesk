// Per-conversation scroll. SessionScreen and RunScreen remount when the
// selection changes, so the last offset has to live outside those components
// or coming back always lands on the top of the thread.

export type ThreadScrollPosition = {
  following: boolean
  top: number
}

export const threadScrollStorageKey = 'codesk.thread-scroll:v1'
const MAX_ENTRIES = 80

let memory: Record<string, ThreadScrollPosition> | null = null

const isPosition = (value: unknown): value is ThreadScrollPosition =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as ThreadScrollPosition).following === 'boolean' &&
  Number.isFinite((value as ThreadScrollPosition).top)

const readStorage = () => {
  try {
    const value = JSON.parse(localStorage.getItem(threadScrollStorageKey) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [
        string,
        ThreadScrollPosition,
      ] => isPosition(entry[1])),
    )
  } catch {
    return {}
  }
}

const loadAll = () => {
  if (!memory) memory = readStorage()
  return memory
}

const persist = () => {
  try {
    localStorage.setItem(threadScrollStorageKey, JSON.stringify(loadAll()))
  } catch {
    // Quota or private-mode — the in-memory map still covers this session.
  }
}

export const recallThreadScroll = (key: string) => loadAll()[key]

export const rememberThreadScroll = (key: string, position: ThreadScrollPosition) => {
  const all = loadAll()
  delete all[key]
  all[key] = { following: position.following, top: Math.max(0, position.top) }
  const keys = Object.keys(all)
  if (keys.length > MAX_ENTRIES) delete all[keys[0]]
  persist()
}

export const resetThreadScrollCache = () => {
  memory = null
}
