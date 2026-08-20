import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { providerRegistry } from '../lib/providers'
import { ProviderIcon } from './ProviderIcon'

describe('ProviderIcon', () => {
  it('renders an icon for every registered provider', () => {
    for (const provider of providerRegistry) {
      const { container, unmount } = render(<ProviderIcon provider={provider.id} />)
      expect(container.firstChild).toBeTruthy()
      unmount()
    }
  })

  it('renders for an unknown provider without crashing', () => {
    const { container } = render(<ProviderIcon provider={'brand-new-agent' as never} />)
    expect(container.firstChild).toBeTruthy()
  })

  it('applies the requested size', () => {
    const { container } = render(<ProviderIcon provider="codex" size={32} />)
    const svg = container.querySelector('svg, img')
    expect(svg?.getAttribute('width') ?? svg?.getAttribute('height')).toBeTruthy()
  })
})
