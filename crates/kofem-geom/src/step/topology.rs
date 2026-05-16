use super::parser::{Arg, StepEntity, StepFile};

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
    let edge_loop = entity(file, loop_id)?;
    // EDGE_LOOP(label, (oriented_edge_refs…))
    let oriented_refs = list_arg(edge_loop, 1)?;

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
