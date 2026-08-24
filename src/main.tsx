import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { applyTheme, storedTheme } from './lib/theme'
import './index.css'

// Apply the last-known theme before first paint; the gateway-persisted
// setting takes over once state loads.
applyTheme(storedTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
