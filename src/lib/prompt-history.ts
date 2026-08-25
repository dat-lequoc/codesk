// A submitted prompt can genuinely vanish. The composer clears on send,
// steering types straight into a harness TUI that may swallow the keystrokes,
// and a resume can navigate to a different screen entirely. Nothing in the
// thread replays what was typed when that happens, so every prompt Codesk
// sends is recorded here and any composer can walk back through it the way a
// shell recalls its history.
//
// The list is deliberately global rather than per session: a prompt is most
// often lost at the moment the UI moves somewhere else, and a history that
// only exists on the screen you just left cannot rescue it.

const storageKey = 'codesk.prompt-history:v1'
// Deep enough to cover a long working day, short enough that the read on every
// arrow press stays trivial.
const limit = 200

// Oldest first, newest last, so walking backwards from the end is "most recent
// first" without reversing anything.
export const promptHistory = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    return []
  }
}

export const rememberPrompt = (prompt: string) => {
  const value = prompt.trim()
  if (!value) return
  // Resending the same text moves it back to the front instead of stacking
  // duplicates the operator has to arrow past.
  const next = promptHistory().filter((item) => item !== value)
  next.push(value)
  try {
    localStorage.setItem(storageKey, JSON.stringify(next.slice(-limit)))
  } catch {}
}

export const forgetPromptHistory = () => {
  try {
    localStorage.removeItem(storageKey)
  } catch {}
}
