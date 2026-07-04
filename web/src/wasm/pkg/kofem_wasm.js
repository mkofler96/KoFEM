// Adapter: wraps the Emscripten/Embind module (kofem_wasm_emcc.js) behind a
// single default `init()` export; solver.worker.ts calls methods on the
// returned module instance (see KofemModule in kofem_wasm.d.ts).
//
// kofem_wasm_emcc.js and kofem_wasm_emcc.wasm are build outputs written by
// scripts/build-wasm.sh — run that script (or scripts/docker-build-wasm.sh)
// before starting the dev server.

import _createModule from './kofem_wasm_emcc.js'

// Vite hashes the wasm via this static URL import. The filename matches the one
// the emcc loader self-references (new URL("kofem_wasm_emcc.wasm", ...)), so both
// references resolve to the same hashed asset at build time. We pre-fetch and pass
// the bytes as `wasmBinary` so emcc never has to locate the file itself at runtime.
import wasmUrl from './kofem_wasm_emcc.wasm?url'

/** Load and initialise the WASM module.  Must be awaited before any other call. */
export default async function init(moduleOverrides = {}) {
    const res = await fetch(wasmUrl)
    const wasmBinary = await res.arrayBuffer()
    return _createModule({
        ...moduleOverrides,
        wasmBinary,
    })
}
