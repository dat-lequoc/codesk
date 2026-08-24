import type { StatusTone } from '../../components/ui/status-dot'

/* Shared row styles. Values mirror the computed styles of the stylesheet this
   replaced, so density is unchanged; the names now say what each row is. */
export const rowTitle = 'flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap'
export const rowMeta = 'max-w-[44px] shrink-0 truncate text-[9px] text-muted'
export const recentStatus = 'grid w-[11px] shrink-0 place-items-center [&>svg]:max-w-[10px]'
export const unreadDot =
  'block size-2 shrink-0 rounded-full bg-scarlet-500 shadow-[0_0_0_2px_#ff3b3033,0_0_7px_#ff3b30aa]'
/* Hover/focus reveals the trailing controls, so the row pads out to make room. */
export const rowAffordance =
  'absolute top-[3px] grid size-[21px] place-items-center rounded-sm bg-ink-600 text-muted opacity-0 transition-opacity hover:bg-ink-500 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'
export const sessionRow =
  'flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md py-0 pl-0.5 text-left text-[12.5px] text-fg-soft transition-[padding] pr-1.5 group-hover:pr-[47px] group-focus-within:pr-[47px] hover:bg-ink-700'

export const hostTone = (status?: string): StatusTone =>
  status === 'online'
    ? 'online'
    : status === 'connecting' || status === 'checking'
      ? 'connecting'
      : 'offline'
