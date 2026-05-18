use super::curve::Curve;
use super::surface::Surface;

pub struct Vertex {
    pub position: [f64; 3],
}

/// A single boundary edge holding an owned curve evaluator and the pre-computed
/// parameter interval `[t0, t1]` that traces from `start` to `end`.
pub struct Edge {
    pub curve: Box<dyn Curve>,
    pub start: [f64; 3],
    pub end: [f64; 3],
    pub reversed: bool,
    pub t0: f64,
    pub t1: f64,
}

pub struct Wire {
    pub edges: Vec<Edge>,
}

pub struct Face {
    pub surface: Box<dyn Surface>,
    pub same_sense: bool,
    /// `FACE_OUTER_BOUND.orientation` — when `false` the stored loop must be
    /// traversed in reverse to get the outward-facing CCW winding.
    pub outer_loop_orientation: bool,
    pub outer_loop: Wire,
    pub inner_loops: Vec<Wire>,
}

pub struct Shell {
    pub faces: Vec<Face>,
}

pub struct Solid {
    pub shells: Vec<Shell>,
}
