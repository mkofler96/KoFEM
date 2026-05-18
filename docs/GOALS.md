# KoFEM — Project Goals

## Vision

KoFEM is an open, browser-native finite element analysis platform — powerful enough for real engineering problems, accessible enough to run from a URL without installation. Think Ansys Mechanical for pre/post-processing UX, but running entirely in a browser via WebAssembly.

The pre-processing stack is modelled on two well-known open-source tools:

- **Geometry kernel — like a basic OpenSCAD.** Users describe geometry through parametric primitives and constructive solid geometry (CSG). The geometry layer knows nothing about meshes; it only produces boundary representations that the meshing engine can consume.
- **Meshing engine — like a basic Gmsh.** Takes a boundary representation from the geometry layer and produces a quality finite-element mesh. 2D triangulation (Bowyer-Watson + Ruppert refinement) and 3D tetrahedral meshing (prism extrusion → tetrahedra) are first-class operations.

These two concerns must stay strictly separated. Geometry code never generates mesh nodes; mesh code never defines shapes.

## Success Criteria

### Phase 1 — Proof of Concept ✓
- [x] Solve a cantilever beam problem in the browser with < 5% error vs. analytical solution
- [x] Visualize mesh and displacement field in the 3D viewport
- [x] Load a simple Abaqus INP mesh file

### Phase 2 — Interactive Pre/Postprocessor (current)
- [x] Geometry builder: parametric box primitive with sketch-plane + extrusion workflow
- [x] Material editing via sidebar (E, ν, ρ)

### Phase 3 — Geometry Kernel (`kofem-geom`)
Goal: a parametric geometry crate that produces B-rep output consumed by the meshing engine.
No mesh generation in this layer.

- [ ] 2D primitives: point, segment, arc, rectangle, polygon
- [ ] 2D CSG: union, difference, intersection of closed regions
- [ ] 2D → 3D: linear extrusion and revolution around axis
- [ ] 3D primitives: box, cylinder, sphere, wedge
- [ ] 3D CSG on solids
- [ ] Boundary representation (B-rep) types: `Solid → Shells → Faces → Edges → Vertices`
- [ ] Surface geometry evaluators: `Plane`, `Cylinder`, `Cone`, `Torus`, `BSplineSurface`
- [ ] Curve geometry evaluators: `Line`, `Circle`, `Ellipse`, `BSplineCurve`


### Phase 4 — STEP Import + Volume Meshing
Goal: import any STEP file and produce a tet mesh.

| Stage | What | Done? |
|-------|------|-------|
| 1 | ISO 10303-21 text parser → entity registry | [ ] |
| 2 | B-rep topology extraction (shells, faces, edge loops) | [ ] |
| 3 | Geometry evaluators for Plane, Cylinder, Line, Circle, B-spline | [ ] |
| 4 | Face tessellator: parameter-space triangulation → watertight 3D surface mesh | [ ] |
| 5 | Volume mesher: 3D Constrained Delaunay Tetrahedralization (CDT) | [ ] |
| 6 | WASM bindings + UI (file input, progress display, viewport preview) | [ ] |

### Phase 5 — Meshing Engine (advanced)
- [ ] Constrained Delaunay triangulation (CDT) with internal features / holes
- [ ] Mesh sizing fields (curvature-adaptive, feature-size-adaptive)
- [ ] Hex-dominant meshing for structured regions
- [ ] Mesh quality statistics and refinement controls in UI
- [ ] Export to Gmsh `.msh` v4, VTK `.vtu`

### Phase 6 — Production Solver
- [ ] Large model support (>500k DOF) via iterative solvers (PCG + AMG preconditioner)
- [ ] Modal analysis (eigenvalue solver via Lanczos)
- [ ] Python scripting for batch analysis and parametric studies
- [ ] Full MITC4 shell + Beam2 global transform
- [ ] Colormap legend with min/max probe
- [ ] Section cuts and hidden-line removal
- [ ] BC and load application via interactive face picking in the 3D viewport

## Non-Goals (explicitly out of scope for v1)
- Full NURBS / B-spline surface kernel
- Fluid dynamics / CFD
- Electromagnetic simulation
- Explicit dynamics / crash simulation
- Paid SaaS model or user accounts
