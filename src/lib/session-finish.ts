// The gateway keeps a just-finished session as `stopped` for 45s so the
// sidebar can surface it. Once the user has viewed the bottom of that
// thread, the red circle should go away immediately — this set is that
// "I already checked it" mark. It is in-memory because the hold itself
// only lasts 45 seconds.

const seen = new Set<string>()
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}

export const sessionFinishSeen = (key: string) => seen.has(key)

export const markSessionFinishSeen = (key: string) => {
  if (seen.has(key)) return
  seen.add(key)
  emit()
}

export const forgetSessionFinishSeen = (key: string) => {
  if (!seen.delete(key)) return
  emit()
}

export const subscribeSessionFinishSeen = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const resetSessionFinishSeen = () => {
  if (seen.size === 0) return
  seen.clear()
  emit()
}
