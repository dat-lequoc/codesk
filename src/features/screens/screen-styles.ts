/**
 * Styles shared by the four conversation screens (Run, Session, Observed and
 * Start). They were a single tangle of `.thread-*` rules redefined across the
 * stylesheet; the final cascade winner is what each constant encodes.
 */

/* The composer and the reading column must stay the same width and centre. */
const READING_WIDTH = 'w-[calc(100%-24px)] md:w-[min(780px,calc(100%-96px))]'

export const threadScreen = 'relative flex h-full flex-col [--file-preview-width:min(48%,720px)]'
export const threadScreenEnvOpen =
  'grid grid-cols-[minmax(0,1fr)] grid-rows-[45px_auto_minmax(0,1fr)]'
export const threadHeader = 'flex h-[45px] items-center gap-2 md:gap-2.5 border-b border-ink-700 px-3 md:px-4'
export const threadHeaderTitle = 'min-w-0 max-w-[200px] sm:max-w-[320px] md:max-w-[420px] truncate text-sm md:text-[15px]'
export const threadScroll = 'scroll-thin flex-1 overflow-auto px-2.5 md:px-0 pt-4 md:pt-8 pb-[140px] md:pb-[164px]'
export const threadScrollFilePreview = 'md:mr-[var(--file-preview-width)]'
export const historyScroll = 'pb-25'
export const historyScrollContinuable = 'pb-27'

export const threadComposer = `absolute bottom-3 md:bottom-3.5 left-1/2 -translate-x-1/2 ${READING_WIDTH} overflow-hidden rounded-2xl border border-line-strong bg-surface`
export const threadComposerFilePreview =
  'left-3 md:left-9 right-3 md:right-[calc(var(--file-preview-width)+36px)] w-auto translate-x-0'
export const threadComposerMenuOpen = 'overflow-visible'
export const composerTextarea =
  'h-[68px] w-full resize-none bg-transparent p-4 text-[15px] outline-none'
export const historyTextarea = 'h-[43px] px-3.5 py-3 text-sm'
export const composerBar = 'flex min-h-[44px] md:h-[47px] flex-wrap items-center gap-1.5 md:gap-2.5 px-2.5 md:px-3 py-1 md:py-0'
export const composerHint = 'text-[13px] text-muted'

export const headerButton = 'grid place-items-center text-muted hover:text-fg'
export const openIn =
  'flex h-8 items-center gap-[7px] rounded-lg border border-line-strong bg-sunken px-2.5 text-sm text-fg-soft hover:bg-raised'
export const environmentToggle =
  'flex h-[30px] items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-[11px] text-muted hover:text-fg'
export const environmentToggleActive = 'bg-raised text-fg'

export const sendButton =
  'inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-ink-100 text-ink-850 hover:bg-fg disabled:opacity-35 transition-colors'
export const sendButtonSmall = 'size-7'
export const interrupt = 'text-[13px] text-ember-400 hover:text-ember-500'
export const queueLabel = 'text-[13px] text-grass-400'

export const queuePanel =
  'scroll-thin block max-h-[150px] overflow-auto border-b border-grass-600/40 bg-grass-950 px-2.5 py-[7px]'
export const queueHeader = 'flex min-h-[27px] items-center gap-[7px] text-[10px] text-grass-400'
export const queueHeaderButton =
  'rounded-[7px] border border-grass-600/60 px-[7px] py-1 text-grass-400 hover:bg-grass-600/25'
export const queueRow =
  'flex min-h-[27px] items-center gap-[7px] pl-5 font-mono text-[10px]/[1.35] text-fg-soft'
export const queueRowFailed = 'text-scarlet-400'
export const queueRowButton =
  'grid size-[22px] shrink-0 place-items-center text-muted hover:text-fg'

export const deliveryMode =
  'flex h-7 items-center gap-[5px] rounded-[7px] bg-grass-950 px-2 text-[11px] whitespace-nowrap text-grass-400'
export const deliveryModeQueue = 'bg-amber-signal-950 text-amber-signal-400'

export const rewindBanner =
  'flex h-8 items-center gap-2.5 border-b border-amber-signal-600/50 bg-amber-signal-950 px-4 text-[11px] text-amber-signal-400'

export const observedBadge =
  'flex items-center gap-[5px] rounded-lg bg-ember-950 px-2 py-1 text-[10px] text-ember-400'

export const historyNotice = `absolute bottom-3 md:bottom-3.5 left-1/2 -translate-x-1/2 ${READING_WIDTH} flex min-h-[52px] md:min-h-[58px] items-center gap-2 md:gap-[11px] rounded-xl border border-line-strong bg-ink-850 px-2.5 md:px-3 py-2 md:py-2.5 text-xs md:text-sm text-muted`

export const emptyState = 'mx-auto mt-25 max-w-[430px] text-center text-muted'

export const environmentActions =
  'flex flex-wrap justify-end gap-[7px] border-t border-line px-3 pt-2.5 pb-1'
export const environmentActionButton =
  'flex h-7 items-center gap-1 rounded-[7px] border border-line-strong px-2 text-[9px] hover:bg-ink-600 disabled:cursor-wait disabled:opacity-50'
export const environmentActionDanger = 'text-ember-400'

export const tmuxNotice =
  'mx-[12px] md:mx-[18px] mb-2 flex flex-wrap md:flex-nowrap items-center gap-2.5 rounded-lg border border-grass-600/40 bg-grass-950 px-2.5 py-2.5 text-fg-soft'
export const tmuxNoticeButton =
  'flex h-[29px] shrink-0 items-center gap-1.5 rounded-[7px] border border-grass-600/70 bg-grass-600/25 px-2.5 text-[10px] text-grass-400 disabled:cursor-default disabled:opacity-55'
