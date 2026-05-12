# KoFEM Technical Specification

## System Architecture

### Layers

```
┌─────────────────────────────────────────┐
│  Browser UI (React + Three.js / WebGL)  │
├─────────────────────────────────────────┤
│  Web Worker (solver orchestration)      │
├─────────────────────────────────────────┤
│  kofem-wasm (wasm-bindgen API)          │
├─────────────────────────────────────────┤
│  kofem-core (no_std Rust library)       │
└─────────────────────────────────────────┘
           ↕ (native build)
┌─────────────────────────────────────────┐
│  Python scripting (PyO3 / maturin)      │
└─────────────────────────────────────────┘
```

### Data Flow — Browser Solve

1. User builds model (nodes, elements, materials, BCs, loads) in UI → stored in Zustand store
2. On "Solve": `Toolbar` posts `{ type: 'solve', payload: modelJSON }` to `solver.worker.ts`
3. Worker deserializes JSON → calls `solve_linear_static()` in WASM
4. WASM calls `kofem-core` solver → returns `Float64Array` of displacements
5. Worker posts result back → store updates → viewport re-renders with fringe plot

## Element Library

### Beam2 (3D Euler-Bernoulli beam, 2 nodes, 12 DOF)
- DOF: `[ux, uy, uz, rx, ry, rz]` per node
- Properties: area A, moments of inertia Iy, Iz, torsional constant J
- Stiffness: analytical (no Gauss integration needed)
- Transformation: 3D rotation matrix from nodal coordinates

### Shell4 (MITC4, 4 nodes, 24 DOF)
- Reference: Bathe & Dvorkin, IJNME 21 (1985)
- DOF: `[ux, uy, uz, rx, ry]` per node (drilling DOF `rz` optional via Allman formulation)
- Integration: 2×2 Gauss, reduced for shear terms
- Thickness: constant per element (variable via layered extension)

## Solver

### Linear Static
- Assembly: scatter-add element stiffness into global COO, convert to CSC
- Factorization: Cholesky (SPD guaranteed after BCs) via `faer` crate
- BCs: penalty method (prototype) → Lagrange multipliers (production)
- Scale: direct solver suitable for < 100k DOF; iterative PCG for larger

### Modal (Phase 2)
- Solve generalized eigenvalue problem: `K φ = λ M φ`
- Algorithm: Block Lanczos
- Output: natural frequencies (Hz) and mode shapes

## File Formats

### Import (Phase 1-2)
| Format | Extension | Elements |
|--------|-----------|----------|
| Nastran BDF | `.bdf` | CBEAM, CQUAD4, CQUAD8, CTRIA3 |
| Abaqus INP | `.inp` | B31, S4, S4R, S8R |
| Gmsh MSH v4 | `.msh` | Line2, Quad4, Tri3 |

### Export
| Format | Extension | Purpose |
|--------|-----------|---------|
| VTK Unstructured Grid | `.vtu` | ParaView postprocessing |
| JSON | `.json` | KoFEM native model format |

## UI Layout

```
┌──────────────────────────────────────────────────────────┐
│ [KoFEM]  [Import] [Export] │ [Solve] [Reset]             │ ← header/toolbar
├──────────┬───────────────────────────────┬───────────────┤
│ Model    │                               │ Properties    │
│ Tree     │     3D Viewport               │               │
│          │     (Three.js / WebGL)        │ Results       │
│ ─ Nodes  │                               │               │
│ ─ Elems  │                               │               │
│ ─ Mats   │                               │               │
│ ─ BCs    │                               │               │
│ ─ Loads  │                               │               │
└──────────┴───────────────────────────────┴───────────────┘
```

## Coordinate System & Units

- Coordinate system: right-handed, **Z-up**
- Length: meters (m)
- Force: Newtons (N)
- Stress: Pascals (Pa)
- Angles: radians internally, degrees in UI

## API — WASM Interface

```typescript
// Initialize (call once, awaited)
await init()

// Solve a model described as JSON
// Returns Float64Array of nodal displacements (6 per node)
solve_linear_static(modelJson: string): Float64Array
```

### Model JSON Schema
```json
{
  "nodes": [{ "id": 0, "x": 0.0, "y": 0.0, "z": 0.0 }],
  "elements": [{ "id": 0, "type": "Beam2", "nodeIds": [0, 1], "materialId": 0, "propertyId": 0 }],
  "materials": [{ "id": 0, "young": 210e9, "poisson": 0.3, "density": 7850 }],
  "properties": [{ "id": 0, "type": "BeamSection", "area": 1e-4, "iy": 1e-8, "iz": 1e-8, "j": 1e-8 }],
  "constraints": [{ "nodeId": 0, "dofs": [0,1,2,3,4,5], "values": [0,0,0,0,0,0] }],
  "loads": [{ "nodeId": 1, "dof": 1, "value": -1000 }]
}
```
