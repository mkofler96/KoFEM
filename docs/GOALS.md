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
- [x] BC and load application via interactive face picking in the 3D viewport
- [x] Own meshing library (`kofem-mesh`): Delaunay triangulation, Ruppert quality refinement, tet extrusion
- [ ] Full MITC4 shell + Beam2 global transform
- [ ] Colormap legend with min/max probe
- [ ] Section cuts and hidden-line removal

### Phase 3 — Geometry Kernel
- [ ] Dedicated geometry crate (`kofem-geom`) separate from the UI store
- [ ] 2D primitives: point, line segment, arc, rectangle, polygon
- [ ] 2D CSG: union, difference, intersection of closed regions
- [ ] 2D → 3D: linear extrusion, revolution around axis
- [ ] 3D primitives: box, cylinder, sphere, wedge
- [ ] 3D CSG: union, difference, intersection
- [ ] Boundary representation (B-rep) output consumed by `kofem-mesh`
- [ ] Python API for parametric models (`kofem-py` binding)

### Phase 4 — Meshing Engine
- [ ] Mesh sizing fields (uniform, curvature-adaptive, feature-size-adaptive)
- [ ] Constrained Delaunay triangulation (CDT) preserving internal features / holes
- [ ] Advancing-front or Delaunay-based 3D tet meshing (not just extrusion)
- [ ] Hex-dominant meshing for structured regions
- [ ] Mesh quality statistics and refinement controls exposed in UI
- [ ] Export to Gmsh `.msh` v4, VTK `.vtu`

### Phase 5 — Production Quality
- [ ] Large model support (>500k DOF) via iterative solvers (PCG + AMG preconditioner)
- [ ] Modal analysis (eigenvalue solver via Lanczos)
- [ ] Python scripting for batch analysis and parametric studies

## Non-Goals (explicitly out of scope for v1)
- Full NURBS / B-spline surface kernel
- Fluid dynamics / CFD
- Electromagnetic simulation
- Explicit dynamics / crash simulation
- Paid SaaS model or user accounts
