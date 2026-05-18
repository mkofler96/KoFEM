pub mod brep;
pub mod curve;
pub mod surface;

pub use brep::{Edge, Face, Shell, Solid, Vertex, Wire};
pub use curve::{curve_from_step, BSplineCurveWithKnots, Circle, Curve, Ellipse, Line};
pub use surface::{
    surface_from_step, BSplineSurfaceWithKnots, ConicalSurface, CylindricalSurface, Plane,
    SphericalSurface, Surface, SurfaceOfLinearExtrusion, SurfaceOfRevolution, ToroidalSurface,
};

use crate::step::parser::{Arg, StepEntity, StepFile};

#[derive(Debug, thiserror::Error)]
pub enum GeomError {
    #[error("entity #{0} not found")]
    MissingEntity(u64),
    #[error("entity #{id}: expected type '{expected}', got '{got}'")]
    WrongType {
        id: u64,
        expected: &'static str,
        got: String,
    },
    #[error("entity #{0}: missing or bad arg at index {1}")]
    BadArg(u64, usize),
    #[error("unsupported geometry type '{0}' on entity #{1}")]
    Unsupported(String, u64),
}

/// Coordinate system from AXIS2_PLACEMENT_3D.
#[derive(Debug, Clone)]
pub struct Axis2 {
    pub origin: [f64; 3],
    pub z: [f64; 3],
    pub x: [f64; 3],
}

impl Axis2 {
    pub fn y(&self) -> [f64; 3] {
        cross(self.z, self.x)
    }
}

/// Axis from AXIS1_PLACEMENT (origin + direction, no x_ref).
#[derive(Debug, Clone)]
pub struct Axis1 {
    pub origin: [f64; 3],
    pub direction: [f64; 3],
}

// ── math helpers ──────────────────────────────────────────────────────────────

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn normalize(v: [f64; 3]) -> [f64; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len < 1e-15 {
        return v;
    }
    [v[0] / len, v[1] / len, v[2] / len]
}

pub(crate) fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn scale(v: [f64; 3], s: f64) -> [f64; 3] {
    [v[0] * s, v[1] * s, v[2] * s]
}

pub(crate) fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Rodrigues' rotation: rotate vector `v` around unit axis `k` by angle `theta`.
pub(crate) fn rodrigues(v: [f64; 3], k: [f64; 3], theta: f64) -> [f64; 3] {
    let c = theta.cos();
    let s = theta.sin();
    let k_dot_v = dot(k, v);
    let k_cross_v = cross(k, v);
    add(
        add(scale(v, c), scale(k_cross_v, s)),
        scale(k, k_dot_v * (1.0 - c)),
    )
}

// ── STEP entity helpers ───────────────────────────────────────────────────────

pub(crate) fn get_entity(file: &StepFile, id: u64) -> Result<&StepEntity, GeomError> {
    file.get(&id).ok_or(GeomError::MissingEntity(id))
}

pub(crate) fn get_arg(e: &StepEntity, idx: usize) -> Result<&Arg, GeomError> {
    e.args.get(idx).ok_or(GeomError::BadArg(e.id, idx))
}

pub(crate) fn get_ref(e: &StepEntity, idx: usize) -> Result<u64, GeomError> {
    match get_arg(e, idx)? {
        Arg::Ref(id) => Ok(*id),
        _ => Err(GeomError::BadArg(e.id, idx)),
    }
}

pub(crate) fn get_real(e: &StepEntity, idx: usize) -> Result<f64, GeomError> {
    match get_arg(e, idx)? {
        Arg::Real(v) => Ok(*v),
        Arg::Integer(v) => Ok(*v as f64),
        _ => Err(GeomError::BadArg(e.id, idx)),
    }
}

pub(crate) fn get_list(e: &StepEntity, idx: usize) -> Result<&Vec<Arg>, GeomError> {
    match get_arg(e, idx)? {
        Arg::List(v) => Ok(v),
        _ => Err(GeomError::BadArg(e.id, idx)),
    }
}

pub(crate) fn arg_as_real(a: &Arg, entity_id: u64) -> Result<f64, GeomError> {
    match a {
        Arg::Real(v) => Ok(*v),
        Arg::Integer(v) => Ok(*v as f64),
        _ => Err(GeomError::BadArg(entity_id, 0)),
    }
}

pub(crate) fn arg_as_ref(a: &Arg, entity_id: u64) -> Result<u64, GeomError> {
    match a {
        Arg::Ref(id) => Ok(*id),
        _ => Err(GeomError::BadArg(entity_id, 0)),
    }
}

pub(crate) fn arg_as_integer(a: &Arg, entity_id: u64) -> Result<i64, GeomError> {
    match a {
        Arg::Integer(v) => Ok(*v),
        _ => Err(GeomError::BadArg(entity_id, 0)),
    }
}

/// Parse a CARTESIAN_POINT or DIRECTION entity into [f64; 3].
pub(crate) fn point3(file: &StepFile, id: u64) -> Result<[f64; 3], GeomError> {
    let e = get_entity(file, id)?;
    let coords = get_list(e, 1)?;
    if coords.is_empty() {
        return Err(GeomError::BadArg(id, 1));
    }
    let x = arg_as_real(&coords[0], id)?;
    let y = if coords.len() > 1 {
        arg_as_real(&coords[1], id)?
    } else {
        0.0
    };
    let z = if coords.len() > 2 {
        arg_as_real(&coords[2], id)?
    } else {
        0.0
    };
    Ok([x, y, z])
}

/// Parse AXIS2_PLACEMENT_3D into Axis2.
pub(crate) fn axis2_placement(file: &StepFile, id: u64) -> Result<Axis2, GeomError> {
    let e = get_entity(file, id)?;
    // AXIS2_PLACEMENT_3D(label, location_ref, axis_ref, ref_dir_ref)
    let origin_id = get_ref(e, 1)?;
    let origin = point3(file, origin_id)?;

    let z = match get_arg(e, 2)? {
        Arg::Ref(axis_id) => normalize(point3(file, *axis_id)?),
        Arg::Omitted => [0.0, 0.0, 1.0],
        _ => return Err(GeomError::BadArg(id, 2)),
    };

    let x_raw = match get_arg(e, 3)? {
        Arg::Ref(ref_id) => normalize(point3(file, *ref_id)?),
        Arg::Omitted => [1.0, 0.0, 0.0],
        _ => return Err(GeomError::BadArg(id, 3)),
    };

    // Re-orthogonalize x against z
    let dot = x_raw[0] * z[0] + x_raw[1] * z[1] + x_raw[2] * z[2];
    let x = normalize([
        x_raw[0] - dot * z[0],
        x_raw[1] - dot * z[1],
        x_raw[2] - dot * z[2],
    ]);

    Ok(Axis2 { origin, z, x })
}

/// Parse AXIS1_PLACEMENT into Axis1.
pub(crate) fn axis1_placement(file: &StepFile, id: u64) -> Result<Axis1, GeomError> {
    let e = get_entity(file, id)?;
    // AXIS1_PLACEMENT(label, location_ref, axis_ref)
    let origin_id = get_ref(e, 1)?;
    let origin = point3(file, origin_id)?;

    let direction = match get_arg(e, 2)? {
        Arg::Ref(axis_id) => normalize(point3(file, *axis_id)?),
        Arg::Omitted => [0.0, 0.0, 1.0],
        _ => return Err(GeomError::BadArg(id, 2)),
    };

    Ok(Axis1 { origin, direction })
}

/// Expand (multiplicities, knot_values) into the full repeated knot vector.
pub(crate) fn expand_knots(
    mults: &[Arg],
    vals: &[Arg],
    entity_id: u64,
) -> Result<Vec<f64>, GeomError> {
    let mut knots = Vec::new();
    for (m, v) in mults.iter().zip(vals.iter()) {
        let mult = arg_as_integer(m, entity_id)? as usize;
        let val = arg_as_real(v, entity_id)?;
        for _ in 0..mult {
            knots.push(val);
        }
    }
    Ok(knots)
}

/// De Boor evaluation of a 1-D B-spline at parameter `t`.
pub(crate) fn de_boor_1d(pts: &[[f64; 3]], degree: usize, knots: &[f64], t: f64) -> [f64; 3] {
    let n = pts.len() - 1; // index of last control point
    let t = t.clamp(knots[degree], knots[n + 1]);

    // Find knot span k: largest index in [degree, n] where knots[k] <= t
    let k = if t >= knots[n + 1] {
        n
    } else {
        let mut lo = degree;
        let mut hi = n;
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if knots[mid] <= t {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    };

    // d[j] = P[k-degree+j]  for j in 0..=degree
    let mut d: Vec<[f64; 3]> = (0..=degree).map(|j| pts[k - degree + j]).collect();

    for r in 1..=degree {
        for j in (r..=degree).rev() {
            let idx = j + k - degree;
            let denom = knots[idx + degree - r + 1] - knots[idx];
            let alpha = if denom.abs() < 1e-15 {
                0.0
            } else {
                (t - knots[idx]) / denom
            };
            d[j] = [
                (1.0 - alpha) * d[j - 1][0] + alpha * d[j][0],
                (1.0 - alpha) * d[j - 1][1] + alpha * d[j][1],
                (1.0 - alpha) * d[j - 1][2] + alpha * d[j][2],
            ];
        }
    }

    d[degree]
}
