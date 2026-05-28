// Adapter: wraps the Emscripten/Embind module (kofem_wasm_emcc.js) to present
// the same named-export API that solver.worker.ts expects.
//
// kofem_wasm_emcc.js and kofem_wasm.wasm are build outputs written by
// scripts/build-wasm.sh — run that script (or scripts/docker-build-wasm.sh)
// before starting the dev server.

import createModule from './kofem_wasm_emcc.js'

let _m = null

/** Load and initialise the WASM module.  Must be awaited before any other call. */
export default async function init() {
    _m = await createModule({
        // Resolve the .wasm file relative to this module so Vite's asset
        // pipeline can hash/serve it correctly in both dev and production.
        locateFile: (f) => new URL(f, import.meta.url).href,
    })
}

function m() {
    if (!_m) throw new Error('kofem WASM not initialised — await init() first')
    return _m
}

export const tessellate_step      = (...a) => m().tessellate_step(...a)
export const generate_volume_mesh = (...a) => m().generate_volume_mesh(...a)
export const solve_linear_elastic = (...a) => m().solve_linear_elastic(...a)
export const step_to_fem_result   = (...a) => m().step_to_fem_result(...a)
