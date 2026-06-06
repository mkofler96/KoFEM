// Singleton WASM worker shared across all components.
// Each call gets a unique message ID; the onmessage handler routes
// responses back to the correct Promise via a pending-call map.

let _worker: Worker | null = null
let _msgId = 0
const _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
let _logCallback: ((message: string) => void) | null = null

export function setLogCallback(cb: ((message: string) => void) | null) {
  _logCallback = cb
}

function createWorker(): Worker {
  const w = new Worker(
    new URL('./solver.worker.ts', import.meta.url),
    { type: 'module' },
  )

  w.onmessage = (e: MessageEvent) => {
    const { id, ok, log, ...rest } = e.data as { id: number; ok?: boolean; log?: string; [k: string]: unknown }
    if (log !== undefined) {
      // Always emit to browser console so Playwright and DevTools see it
      // regardless of which panel is active (log callback may be null).
      console.log('[wasm]', log)
      _logCallback?.(log)
      return
    }
    const p = _pending.get(id)
    if (!p) return
    _pending.delete(id)
    if (ok) {
      p.resolve(rest)
    } else {
      const msg = (rest.error as string | undefined) ?? 'Worker error'
      console.error('[worker] task failed:', msg)
      p.reject(new Error(msg))
    }
  }

  w.onerror = (e: ErrorEvent) => {
    console.error('[worker] crashed:', e.message, e)
    const err = new Error(e.message ?? 'Worker crashed')
    for (const p of _pending.values()) p.reject(err)
    _pending.clear()
    _worker = null
  }

  return w
}

function getWorker(): Worker {
  if (!_worker) _worker = createWorker()
  return _worker
}

export function sendToWorker<T = unknown>(type: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++_msgId
    _pending.set(id, { resolve: v => resolve(v as T), reject })
    getWorker().postMessage({ id, type, payload })
  })
}
