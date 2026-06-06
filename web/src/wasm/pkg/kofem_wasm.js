// Adapter: wraps the Emscripten/Embind module (kofem_wasm_emcc.js) to present
// the same named-export API that solver.worker.ts expects.
//
// kofem_wasm_emcc.js and kofem_wasm.wasm are build outputs written by
// scripts/build-wasm.sh — run that script (or scripts/docker-build-wasm.sh)
// before starting the dev server.

import _createModule from './kofem_wasm_emcc.js'

// Vite can statically hash the wasm only when referenced via a static URL import.
// We pre-fetch the binary to avoid relying on emcc's locateFile (which uses
// dynamic new URL paths that Vite cannot hash).
import wasmUrl from './kofem_wasm.wasm?url'

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
export const step_to_fem_result   = (...a) => m().step_to_fem_result(...a)
