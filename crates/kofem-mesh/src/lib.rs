//! `kofem-mesh` — 2-D Delaunay meshing + 3-D tetrahedral extrusion.
//!
//! # Workflow
//!
//! 1. Describe a closed boundary polygon as `Vec<Point2>` (CCW order).
//! 2. [`triangulate`] produces a coarse Delaunay [`Mesh2D`].
//! 3. [`refine`] improves minimum angles via Ruppert's algorithm.
//! 4. [`extrude`] sweeps the 2-D mesh into a 3-D [`Mesh3D`] of tetrahedra.

pub mod extrude;
pub mod geom;
pub mod quality;
pub mod triangulate;

// ── Convenient re-exports ─────────────────────────────────────────────────────

pub use extrude::{extrude, Mesh3D, Tet};
pub use geom::{Point2, Point3};
pub use quality::refine;
pub use triangulate::{triangulate, Mesh2D, Triangle};
