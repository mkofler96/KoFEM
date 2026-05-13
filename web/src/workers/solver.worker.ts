/// <reference lib="webworker" />
// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

import init, { solve_linear_static, parse_inp_model } from '../wasm/pkg/kofem_wasm'

let initialized = false

async function ensureInit() {
  if (!initialized) {
    await init()
    initialized = true
  }
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data

  try {
    await ensureInit()

    if (type === 'solve') {
      const modelJson = JSON.stringify(payload)
      const displacements = solve_linear_static(modelJson)
      self.postMessage({ id, ok: true, displacements: Array.from(displacements) })
    } else if (type === 'parse') {
      const modelJson = parse_inp_model(payload.text)
      self.postMessage({ id, ok: true, model: JSON.parse(modelJson) })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}
