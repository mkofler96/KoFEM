# KoFEM Roadmap

## Milestone 1 — Solver Foundation (target: MVP)

### M1.1 — Global stiffness assembly
- [ ] COO sparse matrix builder in `kofem-core`
- [ ] DOF mapping: node → global DOF index
- [ ] Element scatter-add loop in `LinearStaticSolver::solve`

### M1.2 — Beam2 element complete
- [ ] 3D rotation matrix (local → global)
- [ ] Transformed stiffness assembly
- [ ] Integration test: cantilever beam, error < 1%

### M1.3 — MITC4 shell element
- [ ] Shape functions Ni(ξ, η)
- [ ] Membrane B-matrix (plane stress)
- [ ] Bending B-matrix
- [ ] MITC shear interpolation (tying points)
- [ ] 2×2 Gauss integration loop
- [ ] Transformation to global

### M1.4 — WASM integration
- [ ] JSON model deserialization (`serde` in kofem-wasm)
- [ ] Worker ↔ main thread message protocol
- [ ] Test: solve in browser, compare to Python result

## Milestone 2 — Preprocessor UI

### M2.1 — Mesh rendering
- [ ] `BufferGeometry` from node/element arrays in `MeshScene.tsx`
- [ ] Beam elements: `LineSegments`
- [ ] Shell elements: `Mesh` with indexed triangulation
- [ ] Selection highlight on click

### M2.2 — BC/Load application
- [ ] Node picker in viewport
- [ ] Constraint dialog (fix, pin, prescribed displacement)
- [ ] Load dialog (force, moment, pressure)
- [ ] Visual glyph: arrows for forces, triangles for supports

### M2.3 — Mesh import
- [ ] Nastran BDF parser (GRID, CBEAM, CQUAD4)
- [ ] Drag-and-drop file import in toolbar

## Milestone 3 — Postprocessor UI

### M3.1 — Fringe plots
- [ ] Displacement magnitude colormap
- [ ] Von Mises stress colormap
- [ ] Deformed shape (scale factor)
- [ ] Legend with min/max, probe value on hover

### M3.2 — Modal analysis
- [ ] Mass matrix assembly (consistent)
- [ ] Block Lanczos eigenvalue solver
- [ ] Mode shape animation

## Milestone 4 — Python Scripting

- [ ] `maturin` CI build for Linux/macOS/Windows
- [ ] Complete PyO3 bindings (all element types, all result types)
- [ ] Example notebooks in `python/examples/`
- [ ] Parametric sweep example

## Backlog / Ideas

- Gmsh mesh generation integration (call Gmsh Python API, import result)
- Real-time collaborative editing (WebRTC + CRDTs)
- Cloud solve for large models (>500k DOF) via serverless WASM
- VTK export for ParaView
- Transient dynamic analysis (Newmark-β)
