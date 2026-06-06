// Reproduces the memory error seen on the wall bracket STEP file.
// Runs the full pipeline: tessellate → tessellate_for_meshing → generate_volume_mesh → solve
// using the existing compiled WASM (Node.js v18+ required).
// Note: existing WASM uses the older surface-mesh path; the OCC path (generate_fem_mesh)
// is only available after rebuilding with docker-build-wasm.sh.
//
// Usage:  node test_wall_bracket.mjs [max_element_size]

import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const maxElementSize = parseFloat(process.argv[2] ?? '10.0')

const wasmPkg = join(__dirname, 'web/src/wasm/pkg')
const wasmBinary = readFileSync(join(wasmPkg, 'kofem_wasm.wasm')).buffer

const { default: createModule } = await import(join(wasmPkg, 'kofem_wasm_emcc.js'))

const Module = await createModule({
  wasmBinary,
  print:    (t) => console.log('[wasm]', t),
  printErr: (t) => console.error('[wasm:err]', t),
})

const stepBytes = new Uint8Array(readFileSync(join(__dirname, 'test_files/Wall Bracket.stp')))
console.log(`\nWall bracket: ${stepBytes.length} bytes, max_element_size=${maxElementSize}\n`)

const hasFn = (name) => typeof Module[name] === 'function'
console.log('Pipeline mode:', hasFn('generate_fem_mesh') ? 'OCC (generate_fem_mesh)' : 'surface (tessellate_for_meshing)')
console.log()

// ── Step 1: Tessellate STEP ───────────────────────────────────────────────────
console.log('=== tessellate_step ===')
const tessOpts = JSON.stringify({ linear_deflection: 0.1, angular_deflection: 0.5 })
const tessJson = Module.tessellate_step(stepBytes, tessOpts)
const tess = JSON.parse(tessJson)
console.log(`  ${tess.vertices.length} vertices, ${tess.triangles.length} triangles\n`)

let mesh

if (hasFn('generate_fem_mesh')) {
  // ── OCC path (new) ──────────────────────────────────────────────────────────
  console.log('=== generate_fem_mesh (OCC) ===')
  const meshOpts = JSON.stringify({
    max_element_size: maxElementSize, min_element_size: 0.0, grading: 0.3,
    second_order: false, elementsperedge: 2.0, elementspercurve: 2.0,
    optsteps_2d: 3, optsteps_3d: 3,
  })
  const meshJson = Module.generate_fem_mesh(meshOpts)
  mesh = JSON.parse(meshJson)

  if (hasFn('free_geometry_cache')) {
    console.log('  (freeing geometry cache before solve)')
    Module.free_geometry_cache()
  }
} else {
  // ── Surface path (old, present in pre-built WASM) ───────────────────────────
  console.log('=== tessellate_for_meshing ===')
  const tessForMeshOpts = JSON.stringify({ max_element_size: maxElementSize })
  const surfJson = Module.tessellate_for_meshing(tessForMeshOpts)
  const surf = JSON.parse(surfJson)
  console.log(`  ${surf.vertices.length} vertices, ${surf.triangles.length} triangles\n`)

  console.log('=== generate_volume_mesh ===')
  const volOpts = JSON.stringify({
    max_element_size: maxElementSize, min_element_size: 0.0, grading: 0.3,
    second_order: false, elementsperedge: 2.0, elementspercurve: 2.0,
    optsteps_2d: 3, optsteps_3d: 3,
  })
  const meshJson = Module.generate_volume_mesh(surfJson, volOpts)
  mesh = JSON.parse(meshJson)
}

console.log(`  ${mesh.vertices.length} nodes, ${mesh.tetrahedra.length} tetrahedra\n`)

// ── Step 3: Solve ─────────────────────────────────────────────────────────────
console.log('=== solve_linear_elastic ===')
const solveInput = JSON.stringify({
  vertices:   mesh.vertices,
  tetrahedra: mesh.tetrahedra,
  hexahedra:  [],
})

// Fix the first 10 nodes as a stand-in for mounting surface.
const fixedVertices = Array.from({ length: Math.min(10, mesh.vertices.length) }, (_, i) => i)
const lastNode = mesh.vertices.length - 1
const bcs = JSON.stringify({
  fixed_vertices: fixedVertices,
  point_loads: [{ vertex: lastNode, force: [0, -10000, 0] }],
})
const mat = JSON.stringify({ young_modulus: 210e9, poisson_ratio: 0.3 })

try {
  const resultJson = Module.solve_linear_elastic(solveInput, mat, bcs, 1)
  const result = JSON.parse(resultJson)
  const vm = result.von_mises
  console.log(`  Solve OK — ${result.displacements.length / 3} displacements, ${vm.length} stresses`)
  console.log(`  Max von Mises: ${Math.max(...vm).toExponential(3)} Pa`)
} catch (e) {
  const isWasmTrap = e.name === 'RuntimeError' && (
    e.message.includes('memory access out of bounds') ||
    e.message.includes('null function') ||
    e.message.includes('unreachable') ||
    e.message.includes('table index is out of bounds')
  )
  console.error(`\n  FAILED: ${e.name}: ${e.message}`)
  if (isWasmTrap) console.error('  → WASM trap (code bug, not OOM)')
  else            console.error('  → runtime error (may be OOM or logic error)')
  process.exit(1)
}
