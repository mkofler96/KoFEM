// Adapter: wraps the Emscripten/Embind module (kofem_wasm_emcc.js) to present
// the same named-export API that solver.worker.ts expects.
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

let _m = null

/** Load and initialise the WASM module.  Must be awaited before any other call. */
export default async function init(moduleOverrides = {}) {
    const res = await fetch(wasmUrl)
    const wasmBinary = await res.arrayBuffer()
    _m = await _createModule({
        ...moduleOverrides,
        wasmBinary,
    })
    return _m
}

function m() {
    if (!_m) throw new Error('kofem WASM not initialised — await init() first')
    return _m
}

export const tessellate_step      = (...a) => m().tessellate_step(...a)
export const generate_volume_mesh = (...a) => m().generate_volume_mesh(...a)
export const generate_fem_mesh    = (...a) => m().generate_fem_mesh(...a)
export const free_geometry_cache  = ()     => m().free_geometry_cache()
export const solve_linear_elastic = (...a) => m().solve_linear_elastic(...a)
