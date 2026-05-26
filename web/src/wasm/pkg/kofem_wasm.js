// Stub module — replaced by the real Emscripten/wasm-bindgen output when
// scripts/build-wasm.sh is run.  Exports throw at runtime so the app can
// start and show UI; WASM-dependent features will surface clear errors.
const NOT_BUILT = () => { throw new Error('WASM module not built. Run scripts/build-wasm.sh first.') }
export default async function init() { NOT_BUILT() }
export const tessellate_step = NOT_BUILT
export const generate_volume_mesh = NOT_BUILT
export const solve_linear_elastic = NOT_BUILT
export const step_to_fem_result = NOT_BUILT
