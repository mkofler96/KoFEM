import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { sendToWorker, resetWorker } from './workers/sharedWorker'

// Exposed for Playwright tests — not part of the public API.
;(
  window as Window & {
    __kofem?: {
      sendToWorker: typeof sendToWorker
      resetWorker: typeof resetWorker
    }
  }
).__kofem = { sendToWorker, resetWorker }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
