export type ThemePreference = 'system' | 'light' | 'dark'

/// Mirrors the gateway-persisted setting so the correct palette applies on
/// launch, before the async state load — otherwise light-theme users get a
/// dark flash on every start.
export const themeStorageKey = 'codesk.theme:v1'

export const normalizeTheme = (value: unknown): ThemePreference =>
  value === 'light' || value === 'dark' ? value : 'system'

const systemPrefersLight = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: light)').matches

/** Resolve a preference to the palette actually shown. */
export const resolvedTheme = (preference: ThemePreference): 'light' | 'dark' => {
  if (preference === 'system') return systemPrefersLight() ? 'light' : 'dark'
  return preference
}

/** Flip the palette by toggling the `light` class the stylesheet keys on. */
export const applyTheme = (preference: ThemePreference) => {
  document.documentElement.classList.toggle('light', resolvedTheme(preference) === 'light')
}

export const rememberTheme = (preference: ThemePreference) => {
  try {
    localStorage.setItem(themeStorageKey, preference)
  } catch {
    /* Storage may be unavailable; the gateway copy still applies after load. */
  }
}

export const storedTheme = (): ThemePreference => {
  try {
    return normalizeTheme(localStorage.getItem(themeStorageKey))
  } catch {
    return 'system'
  }
}

/**
 * Re-apply on OS appearance changes while the preference is `system`.
 * Returns the cleanup that unsubscribes.
 */
export const watchSystemTheme = (preference: ThemePreference) => {
  if (preference !== 'system' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const listener = () => applyTheme('system')
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
