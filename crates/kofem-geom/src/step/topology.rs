use super::parser::{Arg, StepEntity, StepFile};
use crate::geom::brep::{Edge as BrepEdge, Face as BrepFace, Shell, Solid, Wire};
use crate::geom::curve::{curve_from_step, Curve};
use crate::geom::surface::{surface_from_step, Surface};

#[derive(Debug)]
pub struct BRep {
    pub faces: Vec<TopoFace>,
}

#[derive(Debug)]
pub struct TopoFace {
    pub surface_id: u64,
    pub same_sense: bool,
    /// `FACE_OUTER_BOUND.orientation` — when `false` the stored loop must be
    /// traversed in reverse to get the outward-facing CCW winding.
    pub outer_loop_orientation: bool,
    pub outer_loop: Vec<TopoEdge>,
    pub inner_loops: Vec<Vec<TopoEdge>>,
}

#[derive(Debug)]
pub struct TopoEdge {
    pub curve_id: u64,
    pub start: [f64; 3],
    pub end: [f64; 3],
    pub reversed: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum TopologyError {
    #[error("entity #{0} not found in STEP file")]
    MissingEntity(u64),
    #[error("entity #{id}: expected type '{expected}', got '{got}'")]
    WrongType {
        id: u64,
        expected: &'static str,
        got: String,
    },
    #[error("entity #{0}: missing arg at index {1}")]
    MissingArg(u64, usize),
    #[error("entity #{0}: unexpected arg type at index {1}")]
    BadArg(u64, usize),
    #[error("ADVANCED_FACE #{0} has no FACE_OUTER_BOUND")]
    NoOuterBound(u64),
}

impl BRep {
    pub fn extract(file: &StepFile) -> Result<BRep, TopologyError> {
        let mut face_ids: Vec<u64> = file
            .values()
            .filter(|e| e.type_name == "ADVANCED_FACE")
            .map(|e| e.id)
            .collect();
        face_ids.sort_unstable();

        let mut faces = Vec::with_capacity(face_ids.len());
        for id in face_ids {
            faces.push(extract_face(file, id)?);
        }
        Ok(BRep { faces })
    }

    /// Resolve ID-based topology into owned evaluator-holding types.
    ///
    /// Each [`TopoFace`] becomes a [`geom::brep::Face`] with a `Box<dyn Surface>`
    /// and each [`TopoEdge`] becomes a [`geom::brep::Edge`] with a `Box<dyn Curve>`
    /// and pre-computed parameter interval `[t0, t1]`.
    ///
    /// Geometry that cannot be loaded (unsupported curve/surface types) falls back
    /// to linear interpolation / a flat-projection surface so that the tessellator
    /// can still produce a valid mesh via its Delaunay fallback path.
    pub fn resolve(&self, file: &StepFile) -> Result<Solid, TopologyError> {
        let faces = self
            .faces
            .iter()
            .map(|tf| resolve_topo_face(tf, file))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Solid {
            shells: vec![Shell { faces }],
        })
    }
}

// ── fallback geometry types ──────────────────────────────────────────────────

/// Linear interpolation curve used when the STEP curve type is unsupported.
struct LinearInterp {
    start: [f64; 3],
    end: [f64; 3],
}

impl Curve for LinearInterp {
    fn point(&self, t: f64) -> [f64; 3] {
        [
            self.start[0] + (self.end[0] - self.start[0]) * t,
            self.start[1] + (self.end[1] - self.start[1]) * t,
            self.start[2] + (self.end[2] - self.start[2]) * t,
        ]
    }

    fn t_bounds(&self) -> (f64, f64) {
        (0.0, 1.0)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// Flat fallback surface used when the STEP surface type is unsupported.
/// The tessellator will not recognize this type and will fall through to
/// its general Delaunay path, preserving the existing fallback behaviour.
struct FlatFallbackSurface;

impl Surface for FlatFallbackSurface {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        [u, v, 0.0]
    }

    fn normal(&self, _u: f64, _v: f64) -> [f64; 3] {
        [0.0, 0.0, 1.0]
    }

    fn u_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }

    fn v_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ── resolve helpers ──────────────────────────────────────────────────────────

fn resolve_topo_face(tf: &TopoFace, file: &StepFile) -> Result<BrepFace, TopologyError> {
    let surface: Box<dyn Surface> =
        surface_from_step(tf.surface_id, file).unwrap_or_else(|_| Box::new(FlatFallbackSurface));

    let outer_loop = resolve_wire(&tf.outer_loop, file)?;
    let inner_loops = tf
        .inner_loops
        .iter()
        .map(|edges| resolve_wire(edges, file))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(BrepFace {
        surface,
        same_sense: tf.same_sense,
        outer_loop_orientation: tf.outer_loop_orientation,
        outer_loop,
        inner_loops,
    })
}

fn resolve_wire(edges: &[TopoEdge], file: &StepFile) -> Result<Wire, TopologyError> {
    let resolved = edges
        .iter()
        .map(|e| resolve_topo_edge(e, file))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Wire { edges: resolved })
}

fn resolve_topo_edge(edge: &TopoEdge, file: &StepFile) -> Result<BrepEdge, TopologyError> {
    let curve: Box<dyn Curve> = curve_from_step(edge.curve_id, file).unwrap_or_else(|_| {
        Box::new(LinearInterp {
            start: edge.start,
            end: edge.end,
        })
    });

    let (t0, t1) = curve.t_range(edge.start, edge.end, edge.reversed);

    Ok(BrepEdge {
        curve,
        start: edge.start,
        end: edge.end,
        reversed: edge.reversed,
        t0,
        t1,
    })
}

// ── entity helpers ──────────────────────────────────────────────────────────

fn entity(file: &StepFile, id: u64) -> Result<&StepEntity, TopologyError> {
    file.get(&id).ok_or(TopologyError::MissingEntity(id))
}

fn arg(e: &StepEntity, idx: usize) -> Result<&Arg, TopologyError> {
    e.args.get(idx).ok_or(TopologyError::MissingArg(e.id, idx))
}

fn ref_arg(e: &StepEntity, idx: usize) -> Result<u64, TopologyError> {
    match arg(e, idx)? {
        Arg::Ref(id) => Ok(*id),
        _ => Err(TopologyError::BadArg(e.id, idx)),
    }
}

fn list_arg(e: &StepEntity, idx: usize) -> Result<&Vec<Arg>, TopologyError> {
    match arg(e, idx)? {
        Arg::List(v) => Ok(v),
        _ => Err(TopologyError::BadArg(e.id, idx)),
    }
}

fn enum_arg(e: &StepEntity, idx: usize) -> Result<&str, TopologyError> {
    match arg(e, idx)? {
        Arg::Enum(s) => Ok(s.as_str()),
        _ => Err(TopologyError::BadArg(e.id, idx)),
    }
}

fn real_from_arg(a: &Arg, entity_id: u64) -> Result<f64, TopologyError> {
    match a {
        Arg::Real(v) => Ok(*v),
        Arg::Integer(v) => Ok(*v as f64),
        _ => Err(TopologyError::BadArg(entity_id, 0)),
    }
}

// ── extraction ───────────────────────────────────────────────────────────────

fn extract_face(file: &StepFile, face_id: u64) -> Result<TopoFace, TopologyError> {
    let face = entity(file, face_id)?;
    // ADVANCED_FACE(label, (bound_refs…), surface_ref, same_sense)
    let bounds = list_arg(face, 1)?;
    let surface_id = ref_arg(face, 2)?;
    let same_sense = enum_arg(face, 3)? == "T";

    let mut outer_loop: Option<Vec<TopoEdge>> = None;
    let mut outer_loop_orientation = true;
    // Orientation of the first FACE_BOUND, used as fallback outer orientation.
    let mut first_bound_orientation = true;
    let mut inner_loops: Vec<Vec<TopoEdge>> = Vec::new();

    for b_arg in bounds {
        let bound_id = match b_arg {
            Arg::Ref(id) => *id,
            _ => continue,
        };
        let bound = entity(file, bound_id)?;
        // FACE_OUTER_BOUND or FACE_BOUND: (label, edge_loop_ref, orientation)
        let loop_id = ref_arg(bound, 1)?;
        let orientation = enum_arg(bound, 2).map(|s| s == "T").unwrap_or(true);
        let edges = extract_edge_loop(file, loop_id)?;

        if bound.type_name == "FACE_OUTER_BOUND" {
            outer_loop = Some(edges);
            outer_loop_orientation = orientation;
        } else {
            if inner_loops.is_empty() {
                first_bound_orientation = orientation;
            }
            inner_loops.push(edges);
        }
    }

    // Some exporters omit FACE_OUTER_BOUND and use plain FACE_BOUND for every
    // loop.  The AP242 convention is that the first bound is the outer one.
    if outer_loop.is_none() && !inner_loops.is_empty() {
        outer_loop = Some(inner_loops.remove(0));
        outer_loop_orientation = first_bound_orientation;
    }

    let outer_loop = outer_loop.ok_or(TopologyError::NoOuterBound(face_id))?;
    Ok(TopoFace {
        surface_id,
        same_sense,
        outer_loop_orientation,
        outer_loop,
        inner_loops,
    })
}

fn extract_edge_loop(file: &StepFile, loop_id: u64) -> Result<Vec<TopoEdge>, TopologyError> {
    let loop_ent = entity(file, loop_id)?;

    // VERTEX_LOOP(label, vertex_point_ref) — degenerate loop at a single point
    // (e.g., cone apex, sphere pole). Return empty edge list.
    if loop_ent.type_name == "VERTEX_LOOP" {
        return Ok(Vec::new());
    }

    // EDGE_LOOP(label, (oriented_edge_refs…))
    let oriented_refs = list_arg(loop_ent, 1)?;

    let mut edges = Vec::with_capacity(oriented_refs.len());
    for or_arg in oriented_refs {
        let or_id = match or_arg {
            Arg::Ref(id) => *id,
            _ => continue,
        };
        edges.push(extract_oriented_edge(file, or_id)?);
    }
    Ok(edges)
}

fn extract_oriented_edge(file: &StepFile, oe_id: u64) -> Result<TopoEdge, TopologyError> {
    let oe = entity(file, oe_id)?;
    // ORIENTED_EDGE(label, *, *, edge_curve_ref, orientation)
    let ec_id = ref_arg(oe, 3)?;
    let reversed = enum_arg(oe, 4)? == "F";

    let ec = entity(file, ec_id)?;
    // EDGE_CURVE(label, start_vertex_ref, end_vertex_ref, curve_geometry_ref, same_sense)
    let curve_id = ref_arg(ec, 3)?;
    let start_vp_id = ref_arg(ec, 1)?;
    let end_vp_id = ref_arg(ec, 2)?;

    let start_coords = extract_vertex_coords(file, start_vp_id)?;
    let end_coords = extract_vertex_coords(file, end_vp_id)?;

    let (start, end) = if reversed {
        (end_coords, start_coords)
    } else {
        (start_coords, end_coords)
    };

    Ok(TopoEdge {
        curve_id,
        start,
        end,
        reversed,
    })
}

fn extract_vertex_coords(file: &StepFile, vp_id: u64) -> Result<[f64; 3], TopologyError> {
    let vp = entity(file, vp_id)?;
    // VERTEX_POINT(label, cartesian_point_ref)
    let cp_id = ref_arg(vp, 1)?;

    let cp = entity(file, cp_id)?;
    // CARTESIAN_POINT(label, (x, y, z))
    let coords = list_arg(cp, 1)?;
    if coords.len() < 2 {
        return Err(TopologyError::BadArg(cp.id, 1));
    }
    let x = real_from_arg(&coords[0], cp.id)?;
    let y = real_from_arg(&coords[1], cp.id)?;
    let z = if coords.len() >= 3 {
        real_from_arg(&coords[2], cp.id)?
    } else {
        0.0
    };
    Ok([x, y, z])
}
