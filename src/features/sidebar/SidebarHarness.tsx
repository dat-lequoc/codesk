import { ProviderIcon } from '../../components/ProviderIcon'
import { providerName } from '../../lib/providers'
import type { Provider } from '../../types'

export function SidebarHarness({ provider }: { provider: Provider['id'] }) {
  const label = providerName(provider)
  return (
    <span
      className="grid size-3.5 shrink-0 place-items-center text-muted [&>svg]:size-3"
      title={label}
      aria-label={label}
    >
      <ProviderIcon provider={provider} />
    </span>
  )
}
