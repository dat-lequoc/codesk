import { useSyncExternalStore } from 'react'

import {
  sessionFinishSeen,
  subscribeSessionFinishSeen,
} from '../lib/session-finish'

export function useSessionFinishSeen(key: string) {
  return useSyncExternalStore(
    subscribeSessionFinishSeen,
    () => sessionFinishSeen(key),
    () => false,
  )
}
