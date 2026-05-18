# KoFEM Technical Specification

## System Architecture

### Crate / Module Layers

```
┌──────────────────────────────────────────────────────────────┐
│  Browser UI  (React + Three.js / WebGL)                      │
│  Zustand store · Vite · TypeScript                           │
├──────────────────────────────────────────────────────────────┤
│  Web Worker  (solver.worker.ts)                              │
│  Single shared worker; promise-based message routing         │
├─────────────────────┬────────────────────────────────────────┤
│  kofem-wasm         │  wasm-bindgen API surface              │
│  solve_linear_static│  mesh_polygon · extrude_mesh           │
│  parse_inp_model    │  (future: geom_* primitives)           │
├─────────────────────┴────────────────────────────────────────┤
│  kofem-core         │  kofem-geom (planned)  │  kofem-mesh   │
│  no_std solver      │  geometry kernel       │  meshing      │
│  elements · BCs     │  primitives · CSG      │  Delaunay     │
│  assembly · factorize│  B-rep output         │  Ruppert · tet│
└─────────────────────┴────────────────────────────────────────┘
           ↕ (native build)
┌──────────────────────────────────────────────────────────────┐
│  kofem-py  (PyO3 / maturin)  — Python scripting API          │
└──────────────────────────────────────────────────────────────┘
```

### The Geometry / Meshing Separation

These two subsystems have a strict, one-way dependency: geometry produces boundary representations that the meshing engine consumes. Neither knows about the other's internals.

```
  User intent            kofem-geom               kofem-mesh            kofem-core
  ──────────             ──────────               ──────────            ──────────
  "box 1×0.1×0.1"  →    Solid { faces, edges }  →  Mesh2D (triangles)  →  Mesh { nodes
  "fix left face"        BRep boundary loops        Mesh3D (tets)            elements }
  "load right face"                                  quality metrics
```

**kofem-geom** (planned crate, analogous to a basic OpenSCAD kernel):
- Parametric 2D primitives: point, segment, arc, rectangle, polygon
- 2D CSG: union / difference / intersection of closed regions
- 3D primitives: box, cylinder, sphere, wedge
- 3D CSG on solids
- Linear extrusion and revolution of 2D profiles
- Output: boundary representation (B-rep) — ordered loops of edges / faces that the mesher can walk

**kofem-mesh** (exists, analogous to a basic Gmsh meshing engine):
- Input: ordered polygon boundary (`Vec<Point2>`) — eventually a B-rep face from `kofem-geom`
- 2D: Bowyer-Watson incremental Delaunay triangulation → `Mesh2D`
- 2D refinement: Ruppert's algorithm (circumcenter insertion, min-angle guarantee)
- 3D: prism-to-tet extrusion (`Mesh2D × layers → Mesh3D`)  
- Future: advancing-front or Delaunay tet meshing for arbitrary 3D B-rep
- Output: `Mesh3D { points: Vec<Point3>, tets: Vec<Tet> }` → converted to `kofem-core::Mesh`

Until `kofem-geom` exists, the UI store holds parametric `BoxGeometry` structs as a lightweight stand-in. When `kofem-geom` is introduced, those structs will be replaced by proper B-rep objects and the UI store will only hold references.

### Data Flow — Meshing

1. User creates / edits a `BoxGeometry` in the sidebar
2. Sidebar posts `{ type: 'mesh', payload: BoxGeometry }` to the shared worker
3. Worker calls `mesh_polygon` (Ruppert, 25° target) → `Mesh2D` JSON
4. Worker calls `extrude_mesh` (layers = `meshNw`) → `Mesh3D` JSON
5. Worker remaps canonical `(u, v, w)` → world `(x, y, z)` coordinates
6. Worker posts `{ nodes, elements: CTETRA[] }` back
7. Store `applyMeshResult` replaces nodes/elements, clears BCs/loads/result

### Data Flow — Solve

1. User sets BCs and loads via face picking
2. "Solve" button posts `{ type: 'solve', payload: modelJSON }` to shared worker
3. Worker calls `solve_linear_static()` in WASM
4. WASM → `kofem-core` solver → `Float64Array` of displacements (6 per node)
5. Worker posts result → store updates → viewport renders fringe plot

## Element Library

### Currently implemented

| Element | Property | DOF/node | Formulation |
|---------|----------|----------|-------------|
| CBAR / CBEAM | PBAR / PBEAM | 6 | Euler-Bernoulli beam (local K done; global transform TODO) |
| CTRIA3 | PLPLANE | 2 | CST plane stress/strain |
| CQUAD4 | PLPLANE | 2 | Bilinear quad, 2×2 Gauss |
| CTETRA (4-node) | PSOLID | 3 | Linear tet, constant strain |
| CHEXA (8-node) | PSOLID | 3 | Trilinear hex, 2×2×2 Gauss |

### Planned

| Element | Property | Notes |
|---------|----------|-------|
| CTRIA3 | PSHELL | DKT shell formulation |
| CQUAD4 | PSHELL | MITC4 (Bathe & Dvorkin 1985) |

## Solver

### Linear Static
- Assembly: scatter-add element stiffness into global COO, convert to CSC
- Factorization: Cholesky (SPD guaranteed after BCs) via `faer` crate
- BCs: penalty method (prototype) → Lagrange multipliers (production)
- DOF ordering per node: `[ux, uy, uz, rx, ry, rz]` (indices 0–5), fixed globally

## File Formats

### Import
| Format | Extension | Notes |
|--------|-----------|-------|
| Abaqus INP | `.inp` | Implemented — elements, materials, BCs, loads |
| Nastran BDF | `.bdf` | Planned |
| Gmsh MSH v4 | `.msh` | Planned |
| STEP | `.step`, `.stp` | Supported tessellates STEP → STL for downstream meshing |

### Export
| Format | Extension | Purpose |
|--------|-----------|---------|
| VTK Unstructured Grid | `.vtu` | ParaView postprocessing (planned) |
| JSON | `.json` | KoFEM native model format (planned) |

## UI Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ [KoFEM]  [Import] [Export]  ·  Model Name  ·  [Solve] [Reset]   │ ← toolbar
├────────────┬────────────────────────────────────┬────────────────┤
│ Sidebar    │                                    │ Properties     │
│            │     3D Viewport                    │                │
│ Geometry   │     (Three.js / WebGL)             │ Results        │
│  + add     │                                    │                │
│  ⟳ ✎ ×    │     wireframe / fringe plot        │ Face pick      │
│            │                                    │ panel          │
│ Materials  │                                    │                │
│  + add     │                                    │                │
│            │                                    │                │
│ BCs        │                                    │                │
│ Loads      │                                    │                │
└────────────┴────────────────────────────────────┴────────────────┘
```

## Coordinate System & Units

- Coordinate system: right-handed, **Z-up**
- Length: meters (m)
- Force: Newtons (N)
- Stress: Pascals (Pa)
- Angles: radians internally, degrees in UI

## WASM API Surface

```typescript
// Initialize (call once, awaited by the shared worker on first use)
await init()

// FEM solve — returns 6 displacements per node
solve_linear_static(modelJson: string): Float64Array

// Meshing — step 1: triangulate + Ruppert-refine a 2-D polygon
// polygon_json: [{x, y}, …] CCW boundary
// Returns Mesh2D JSON: { points: [{x,y}], triangles: [{v:[a,b,c]}] }
mesh_polygon(polygon_json: string, min_angle_deg: number, max_steiner: number): string

// Meshing — step 2: extrude Mesh2D into a 3-D tet mesh
// Returns Mesh3D JSON: { points: [{x,y,z}], tets: [{v:[a,b,c,d]}] }
extrude_mesh(mesh2d_json: string, dir_x: number, dir_y: number, dir_z: number, layers: number): string

// File import
parse_inp_model(inp_text: string): string  // returns ModelInput JSON
```
