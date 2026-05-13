# STEP Import Pipeline — Implementation Plan

Goal: given a `.step` / `.stp` file, produce a quality tetrahedral mesh ready for `kofem-core`.

The pipeline has six discrete stages. Each stage is independently shippable and testable.
Work proceeds left-to-right; later stages depend on earlier ones but earlier stages
can be released and used standalone.

```
.step file
    │
    ▼ Stage 1
ISO 10303-21 parser  ──► entity registry  (HashMap<id, RawEntity>)
    │
    ▼ Stage 2
B-rep extractor      ──► topology graph   (Solid → Shells → Faces → Edges → Vertices)
    │
    ▼ Stage 3
Geometry evaluator   ──► surface/curve impl  (eval point, normal, parameter bounds)
    │
    ▼ Stage 4
Face tessellator     ──► surface triangulation  (watertight, per-face 2D → 3D)
    │
    ▼ Stage 5
Volume mesher        ──► Mesh3D (tets)   (Delaunay refinement on closed surface)
    │
    ▼ Stage 6
WASM + UI wiring     ──► browser can import .step and mesh it
```

---

## Stage 1 — ISO 10303-21 Text Parser

**Crate:** `kofem-geom` (new)  
**Module:** `kofem-geom::step::parser`

### What to build

Parse the ASCII exchange format that all STEP files use:

```
ISO-10303-21;
HEADER; … ENDSEC;
DATA;
#1 = CARTESIAN_POINT('origin', (0., 0., 0.));
#5 = DIRECTION('', (1., 0., 0.));
…
ENDSEC;
END-ISO-10303-21;
```

Each line in the `DATA` section is one entity instance:
`#<id> = <TYPE>(<arg>, <arg>, …);`

Arguments can be: strings `'text'`, floats `1.0`, integers `1`, entity refs `#42`,
lists `(#1, #2, #3)`, enums `.FORWARD.`, omitted values `$`.

**Output type:**

```rust
pub struct RawEntity {
    pub id: u64,
    pub type_name: String,       // e.g. "CARTESIAN_POINT"
    pub args: Vec<StepArg>,
}

pub enum StepArg {
    String(String),
    Float(f64),
    Int(i64),
    Ref(u64),
    List(Vec<StepArg>),
    Enum(String),
    Omitted,
}

pub type StepFile = HashMap<u64, RawEntity>;
```

**Deliverable test:** parse a minimal STEP file (cube exported from FreeCAD / Fusion 360);
assert that the entity count and a handful of known entity types are present.

---

## Stage 2 — B-rep Topology Extractor

**Module:** `kofem-geom::brep`

### What to build

Walk the `StepFile` entity map and build a typed topology graph. Focus on
AP203 / AP214 entities that appear in every solid model:

| STEP entity | B-rep concept |
|-------------|---------------|
| `ADVANCED_BREP_SHAPE_REPRESENTATION` | top-level solid |
| `MANIFOLD_SOLID_BREP` | closed solid |
| `CLOSED_SHELL` | list of faces |
| `ADVANCED_FACE` | surface + oriented boundary loops |
| `FACE_OUTER_BOUND` / `FACE_BOUND` | outer / inner edge loop |
| `EDGE_LOOP` | ordered list of oriented edges |
| `ORIENTED_EDGE` | edge with direction flag |
| `EDGE_CURVE` | two vertex refs + underlying curve geometry |
| `VERTEX_POINT` | point geometry |
| `CARTESIAN_POINT` | `(x, y, z)` |

**Output types:**

```rust
pub struct BRep {
    pub solids: Vec<Solid>,
}
pub struct Solid {
    pub shells: Vec<Shell>,
}
pub struct Shell {
    pub faces: Vec<Face>,
}
pub struct Face {
    pub surface: SurfaceRef,   // index into geometry store
    pub outer_loop: EdgeLoop,
    pub inner_loops: Vec<EdgeLoop>,
    pub same_sense: bool,
}
pub struct EdgeLoop {
    pub edges: Vec<OrientedEdge>,
}
pub struct OrientedEdge {
    pub curve: CurveRef,
    pub start: Point3,
    pub end: Point3,
    pub reversed: bool,
}
```

**Deliverable test:** extract all faces of a known STEP cube; assert 6 faces,
24 oriented edges, 8 unique vertices.

---

## Stage 3 — Geometry Evaluator

**Module:** `kofem-geom::geom`

### What to build

Implement the surface and curve types that appear in real STEP files.
Start with the subset that covers >90% of mechanical parts:

**Surfaces:**

| STEP entity | Geometry | Parameter space |
|-------------|----------|-----------------|
| `PLANE` | flat face | (u, v) → point on plane |
| `CYLINDRICAL_SURFACE` | cylinder | (u=angle, v=height) |
| `CONICAL_SURFACE` | cone | (u=angle, v=height) |
| `TOROIDAL_SURFACE` | torus | (u, v) both angular |
| `B_SPLINE_SURFACE_WITH_KNOTS` | NURBS | (u, v) → DeBoor evaluation |

**Curves:**

| STEP entity | Geometry |
|-------------|----------|
| `LINE` | point + direction |
| `CIRCLE` | centre, radius, placement |
| `ELLIPSE` | semi-axes, placement |
| `B_SPLINE_CURVE_WITH_KNOTS` | NURBS curve |

**Required trait:**

```rust
pub trait Surface: Send + Sync {
    /// 3-D point at parameter (u, v).
    fn point(&self, u: f64, v: f64) -> Point3;
    /// Unit normal at (u, v).
    fn normal(&self, u: f64, v: f64) -> [f64; 3];
    /// Natural parameter bounds.
    fn bounds(&self) -> (f64, f64, f64, f64);  // (u_min, u_max, v_min, v_max)
}

pub trait Curve: Send + Sync {
    fn point(&self, t: f64) -> Point3;
    fn bounds(&self) -> (f64, f64);
}
```

**Deliverable test:** evaluate a `Plane`, `CylindricalSurface`, and `Circle` at several
parameter values; compare against analytically known points.

---

## Stage 4 — Face Tessellator

**Module:** `kofem-geom::tess`

This is the hardest stage. It must produce a *watertight* triangulated surface mesh —
adjacent faces must share exactly the same edge nodes, with no gaps or T-junctions.

### Algorithm

For each face:

1. **Sample the boundary loops in parameter space.**  
   Walk each `OrientedEdge`, evaluate the underlying curve at uniform chord-length
   steps in `(u, v)` space.  The result is a polygon in the face's 2D parameter space.

2. **Triangulate the parameter-space polygon.**  
   Re-use `kofem-mesh::triangulate` (Bowyer-Watson) with the boundary polygon.
   Apply Ruppert refinement with a user-specified max-edge-length.

3. **Map triangulation back to 3D.**  
   For each triangle vertex `(u, v)` call `surface.point(u, v)` to get the 3D position.

4. **Stitch shared edges.**  
   Faces sharing an edge must produce identical 3D points along that edge.
   Strategy: after tessellating all faces, merge vertices within a tolerance ε
   (≈ 1e-6 × model bounding-box diagonal).

**Output:** `SurfaceMesh { points: Vec<Point3>, triangles: Vec<[usize; 3]> }`

**Deliverable test:**
- Tessellate a STEP cube → assert 12 triangles, 8 unique vertices (clean stitching)
- Tessellate a STEP cylinder → assert no cracks along the seam edge

### Known difficulty: parameter-space distortion

For strongly curved surfaces (large cylinder radius, thin torus), uniform sampling
in `(u, v)` produces distorted triangles in 3D. Fix: use arc-length-parametrised
sampling along each edge, and add curvature-based interior points.

---

## Stage 5 — Volume Mesher

**Module:** `kofem-mesh::volume`

Given a closed, watertight `SurfaceMesh`, fill the interior with tetrahedra.

### Algorithm: Constrained Delaunay Tetrahedralization (CDT)

This extends the existing 2D Bowyer-Watson to 3D:

1. **Super-tetrahedron.** Start with a tet that contains all surface vertices.

2. **Insert surface vertices** one by one using 3D Bowyer-Watson:
   - Find all tets whose circumsphere contains the new point (cavity).
   - Delete them; re-triangulate the star-shaped cavity around the new point.

3. **Recover constrained faces.** The surface triangles must appear as faces in
   the tetrahedralization. Use face recovery via edge flips or Steiner insertions
   on missing faces.

4. **Remove exterior tets.** Any tet whose centroid lies outside the surface mesh
   (tested with a ray-casting point-in-solid test) is deleted.

5. **Refinement.** Insert circumcentres of tets with bad quality metrics
   (radius-edge ratio > threshold) until the mesh meets a quality target.
   This is the 3D analogue of Ruppert's 2D algorithm.

**Output:** `Mesh3D { points: Vec<Point3>, tets: Vec<Tet> }` — the existing type in `kofem-mesh`.

**Deliverable test:**
- Volume-mesh a sphere surface triangulation; assert all tets have positive volume
  and the radius-edge ratio is below 2.0 for >95% of tets.
- Volume-mesh a cube; compare total volume of tets against analytical 1³ = 1.

### Note on scope

A correct CDT with face recovery is a significant algorithm (~1,000–2,000 lines of
careful Rust). It is the only stage that cannot be built in days. A realistic
estimate is 2–4 weeks for a robust first version. Reference: Shewchuk (1998),
"Tetrahedral Mesh Generation by Delaunay Refinement."

---

## Stage 6 — WASM + UI Wiring

**Crate:** `kofem-wasm`  
**UI:** `solver.worker.ts`, `Sidebar.tsx`

### New WASM functions

```rust
/// Parse a STEP file and return its B-rep as JSON.
#[wasm_bindgen]
pub fn parse_step(step_text: &str) -> Result<String, JsError>

/// Tessellate a B-rep (JSON from parse_step) into a surface mesh.
/// max_edge_len controls tessellation density.
#[wasm_bindgen]
pub fn tessellate_brep(brep_json: &str, max_edge_len: f64) -> Result<String, JsError>

/// Volume-mesh a closed surface mesh (JSON from tessellate_brep).
#[wasm_bindgen]
pub fn volume_mesh(surface_json: &str, quality: f64) -> Result<String, JsError>
```

### Worker messages

| type | payload | response |
|------|---------|----------|
| `parse_step` | `{ text: string }` | `{ brep: BRepJSON }` |
| `tessellate` | `{ brep, maxEdgeLen }` | `{ surfaceMesh: SurfaceMeshJSON }` |
| `volume_mesh` | `{ surfaceMesh, quality }` | `{ nodes, elements: CTETRA[] }` |

Breaking it into three separate messages lets the UI show progress ("Parsing…",
"Tessellating…", "Meshing…") and lets the user inspect the surface mesh before
committing to volume meshing.

### UI changes

- Toolbar: accept `.step` / `.stp` in the file input
- Sidebar: show geometry name from STEP product name
- Viewport: display surface tessellation as an intermediate result (grey shaded,
  before volume meshing is run)
- Sidebar: "Mesh volume" button that triggers the volume meshing step

---

## Dependency summary

```
Stage 1 (parser)        →  no dependencies outside std
Stage 2 (B-rep)         →  Stage 1
Stage 3 (geometry)      →  Stage 2 (for STEP entity mapping)
Stage 4 (tessellation)  →  Stage 3 + kofem-mesh (Bowyer-Watson already exists)
Stage 5 (volume mesh)   →  Stage 4 + kofem-mesh (extends existing 2D algorithm to 3D)
Stage 6 (WASM/UI)       →  Stages 1–5 + kofem-wasm
```

## Suggested work order

| Sprint | Deliverable |
|--------|-------------|
| 1 | Stage 1: STEP parser + unit tests on real files |
| 2 | Stage 2: B-rep extraction + topology tests |
| 3 | Stage 3: Plane + Cylinder + Line + Circle geometry |
| 4 | Stage 4: Face tessellator for planes + cylinders |
| 5 | Stage 4 cont.: edge stitching, watertight verification |
| 6 | Stage 3 cont.: B-spline curves + surfaces (NURBS) |
| 7 | Stage 5: 3D Bowyer-Watson + super-tet + exterior removal |
| 8 | Stage 5 cont.: constrained face recovery |
| 9 | Stage 5 cont.: Delaunay refinement, quality metrics |
| 10 | Stage 6: WASM bindings + UI wiring + end-to-end test |
