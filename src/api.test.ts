import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, gatewayOrigin } from './api'

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as Response

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const lastCall = () => {
  const [url, options] = fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined]
  return { url, options }
}

describe('gatewayOrigin', () => {
  it('is same-origin when served over http(s)', () => {
    // jsdom serves tests from http://localhost, the browser case.
    expect(gatewayOrigin).toBe('')
  })
})

describe('request plumbing', () => {
  it('sends JSON content-type on every call', async () => {
    await api.state()
    expect(lastCall().options?.headers).toMatchObject({ 'content-type': 'application/json' })
  })

  it('returns the parsed body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ hosts: [] }))
    await expect(api.state()).resolves.toEqual({ hosts: [] })
  })

  it('throws the server-supplied error message on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'host is offline' }, { ok: false, status: 503 }),
    )
    await expect(api.state()).rejects.toThrow('host is offline')
  })

  it('falls back to the status code when the body carries no message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }))
    await expect(api.state()).rejects.toThrow('Request failed (500)')
  })

  it('propagates a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(api.state()).rejects.toThrow('offline')
  })
})

describe('endpoints', () => {
  it('reads application state', async () => {
    await api.state()
    expect(lastCall().url).toBe('/api/state')
  })

  it('reads navigation separately from full state', async () => {
    await api.navigation()
    expect(lastCall().url).toBe('/api/navigation')
  })

  it('patches settings with the given fields', async () => {
    await api.updateSettings({ notifications: false })
    const { url, options } = lastCall()
    expect(url).toBe('/api/settings')
    expect(options?.method).toBe('PATCH')
    expect(JSON.parse(String(options?.body))).toEqual({ notifications: false })
  })

  it('creates a host', async () => {
    await api.createHost({ name: 'Server', sshAlias: 'srv' })
    const { url, options } = lastCall()
    expect(url).toBe('/api/hosts')
    expect(options?.method).toBe('POST')
    expect(JSON.parse(String(options?.body))).toEqual({ name: 'Server', sshAlias: 'srv' })
  })

  it('deletes a host by id', async () => {
    await api.removeHost('host-a')
    const { url, options } = lastCall()
    expect(url).toBe('/api/hosts/host-a')
    expect(options?.method).toBe('DELETE')
  })

  it('reconnects a host', async () => {
    await api.reconnectHost('host-a')
    expect(lastCall().url).toBe('/api/hosts/host-a/reconnect')
  })

  it('lists ssh aliases', async () => {
    await api.sshAliases()
    expect(lastCall().url).toBe('/api/ssh-aliases')
  })
})
