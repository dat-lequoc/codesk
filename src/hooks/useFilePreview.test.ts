import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileContent } from '../types'

vi.mock('../api', () => ({ gatewayOrigin: '', api: { file: vi.fn() } }))

const { useFilePreview } = await import('./useFilePreview')
const { api } = await import('../api')

const fileContent = (overrides: Partial<FileContent> = {}): FileContent =>
  ({
    path: '/home/dev/codesk/src/App.tsx',
    content: 'export function App() {}',
    ...overrides,
  }) as FileContent

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.file).mockResolvedValue(fileContent())
})

describe('useFilePreview', () => {
  it('starts with nothing open', () => {
    const { result } = renderHook(() => useFilePreview('host-local', '/home/dev/codesk'))
    expect(result.current.preview).toBeNull()
  })

  it('shows the requested path before the contents arrive', async () => {
    const { result } = renderHook(() => useFilePreview('host-local', '/home/dev/codesk'))
    act(() => result.current.open('src/App.tsx'))
    expect(result.current.preview).toEqual({ requestedPath: '/home/dev/codesk/src/App.tsx' })
    await waitFor(() => expect(result.current.preview?.file).toBeDefined())
    expect(api.file).toHaveBeenCalledWith('host-local', '/home/dev/codesk/src/App.tsx')
  })

  it('resolves a line-suffixed relative link against the working directory', async () => {
    const { result } = renderHook(() => useFilePreview('host-local', '/home/dev/codesk'))
    act(() => result.current.open('./src/App.tsx:42'))
    await waitFor(() =>
      expect(api.file).toHaveBeenCalledWith('host-local', '/home/dev/codesk/src/App.tsx'),
    )
  })

  it('surfaces a read failure in place of the file', async () => {
    vi.mocked(api.file).mockRejectedValue(new Error('No such file'))
    const { result } = renderHook(() => useFilePreview('host-local', '/home/dev/codesk'))
    act(() => result.current.open('nope.txt'))
    await waitFor(() => expect(result.current.preview?.error).toBe('No such file'))
  })

  it('closes on request', async () => {
    const { result } = renderHook(() => useFilePreview('host-local', '/home/dev/codesk'))
    act(() => result.current.open('src/App.tsx'))
    await waitFor(() => expect(result.current.preview?.file).toBeDefined())
    act(() => result.current.close())
    expect(result.current.preview).toBeNull()
  })

  // A path resolved against one checkout means nothing in another.
  it('drops the open file when the working directory changes', async () => {
    const { result, rerender } = renderHook(({ hostId, cwd }) => useFilePreview(hostId, cwd), {
      initialProps: { hostId: 'host-local', cwd: '/home/dev/codesk' },
    })
    act(() => result.current.open('src/App.tsx'))
    await waitFor(() => expect(result.current.preview?.file).toBeDefined())
    rerender({ hostId: 'host-local', cwd: '/home/dev/other' })
    expect(result.current.preview).toBeNull()
  })

  it('drops the open file when the host changes', async () => {
    const { result, rerender } = renderHook(({ hostId, cwd }) => useFilePreview(hostId, cwd), {
      initialProps: { hostId: 'host-local', cwd: '/home/dev/codesk' },
    })
    act(() => result.current.open('src/App.tsx'))
    await waitFor(() => expect(result.current.preview?.file).toBeDefined())
    rerender({ hostId: 'host-remote', cwd: '/home/dev/codesk' })
    expect(result.current.preview).toBeNull()
  })

  it('keeps the open file across an unrelated re-render', async () => {
    const { result, rerender } = renderHook(({ hostId, cwd }) => useFilePreview(hostId, cwd), {
      initialProps: { hostId: 'host-local', cwd: '/home/dev/codesk' },
    })
    act(() => result.current.open('src/App.tsx'))
    await waitFor(() => expect(result.current.preview?.file).toBeDefined())
    rerender({ hostId: 'host-local', cwd: '/home/dev/codesk' })
    expect(result.current.preview?.file).toBeDefined()
  })
})
