import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/**
 * Node 25 exposes its own experimental `localStorage` global, which shadows
 * jsdom's and is inert without `--localstorage-file`. The app reads and writes
 * bare `localStorage`, so tests need one that behaves like the browser's.
 */
class MemoryStorage implements Storage {
  #data = new Map<string, string>()

  get length() {
    return this.#data.size
  }
  key(index: number) {
    return [...this.#data.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.#data.get(String(key)) ?? null
  }
  setItem(key: string, value: string) {
    this.#data.set(String(key), String(value))
  }
  removeItem(key: string) {
    this.#data.delete(String(key))
  }
  clear() {
    this.#data.clear()
  }
}

const storage = new MemoryStorage()
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

// jsdom implements none of these, and Radix probes them on mount.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})
