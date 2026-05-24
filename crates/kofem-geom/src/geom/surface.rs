use std::f64::consts::PI;

use super::curve::{curve_from_step, Curve};
use super::{
    add, arg_as_ref, axis1_placement, axis2_placement, cross, de_boor_1d, de_boor_1d_4d,
    expand_knots, get_entity, get_real, get_ref, normalize, point3, rodrigues, scale, sub, Axis1,
    Axis2, GeomError,
};
use crate::step::parser::{Arg, StepFile};

pub trait Surface: Send + Sync {
    fn point(&self, u: f64, v: f64) -> [f64; 3];
    fn normal(&self, u: f64, v: f64) -> [f64; 3];
    fn u_bounds(&self) -> (f64, f64);
    fn v_bounds(&self) -> (f64, f64);
}

// ── Plane ─────────────────────────────────────────────────────────────────────

pub struct Plane {
    pub origin: [f64; 3],
    pub normal: [f64; 3],
    pub x_axis: [f64; 3],
}

impl Surface for Plane {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        let y_axis = cross(self.normal, self.x_axis);
        add(self.origin, add(scale(self.x_axis, u), scale(y_axis, v)))
    }

    fn normal(&self, _u: f64, _v: f64) -> [f64; 3] {
        self.normal
    }

    fn u_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }

    fn v_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

// ── CylindricalSurface ────────────────────────────────────────────────────────

pub struct CylindricalSurface {
    pub axis: Axis2,
    pub radius: f64,
}

impl Surface for CylindricalSurface {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        // u = angle around z, v = height along z
        let y = self.axis.y();
        add(
            self.axis.origin,
            add(
                scale(
                    add(scale(self.axis.x, u.cos()), scale(y, u.sin())),
                    self.radius,
                ),
                scale(self.axis.z, v),
            ),
        )
    }

    fn normal(&self, u: f64, _v: f64) -> [f64; 3] {
        let y = self.axis.y();
        normalize(add(scale(self.axis.x, u.cos()), scale(y, u.sin())))
    }

    fn u_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }

    fn v_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

// ── ConicalSurface ────────────────────────────────────────────────────────────

pub struct ConicalSurface {
    pub axis: Axis2,
    /// Radius at the reference plane (v = 0).
    pub radius: f64,
    /// Half-angle of the cone in radians.
    pub semi_angle: f64,
}

impl Surface for ConicalSurface {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        // P(u,v) = origin + (radius + v·sin(φ))·(cos(u)·x + sin(u)·y) + v·cos(φ)·z
        let y = self.axis.y();
        let r = self.radius + v * self.semi_angle.sin();
        let radial = add(scale(self.axis.x, u.cos()), scale(y, u.sin()));
        add(
            self.axis.origin,
            add(
                scale(radial, r),
                scale(self.axis.z, v * self.semi_angle.cos()),
            ),
        )
    }

    fn normal(&self, u: f64, _v: f64) -> [f64; 3] {
        // n = cos(φ)·radial - sin(φ)·z  (outward normal to cone surface)
        let y = self.axis.y();
        let radial = add(scale(self.axis.x, u.cos()), scale(y, u.sin()));
        normalize(add(
            scale(radial, self.semi_angle.cos()),
            scale(self.axis.z, -self.semi_angle.sin()),
        ))
    }

    fn u_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }

    fn v_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

// ── ToroidalSurface ───────────────────────────────────────────────────────────

pub struct ToroidalSurface {
    pub axis: Axis2,
    pub major_radius: f64,
    pub minor_radius: f64,
}

impl Surface for ToroidalSurface {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        // u = angle around z-axis, v = angle around tube
        let y = self.axis.y();
        let tube_dir = add(scale(self.axis.x, u.cos()), scale(y, u.sin()));
        let r = self.major_radius + self.minor_radius * v.cos();
        add(
            self.axis.origin,
            add(
                scale(tube_dir, r),
                scale(self.axis.z, self.minor_radius * v.sin()),
            ),
        )
    }

    fn normal(&self, u: f64, v: f64) -> [f64; 3] {
        let y = self.axis.y();
        let tube_dir = add(scale(self.axis.x, u.cos()), scale(y, u.sin()));
        normalize(add(scale(tube_dir, v.cos()), scale(self.axis.z, v.sin())))
    }

    fn u_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }

    fn v_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }
}

// ── SphericalSurface ──────────────────────────────────────────────────────────

pub struct SphericalSurface {
    pub axis: Axis2,
    pub radius: f64,
}

impl Surface for SphericalSurface {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        // u = longitude (around z), v = latitude (from equatorial plane)
        let y = self.axis.y();
        add(
            self.axis.origin,
            add(
                add(
                    scale(self.axis.x, self.radius * v.cos() * u.cos()),
                    scale(y, self.radius * v.cos() * u.sin()),
                ),
                scale(self.axis.z, self.radius * v.sin()),
            ),
        )
    }

    fn normal(&self, u: f64, v: f64) -> [f64; 3] {
        let y = self.axis.y();
        normalize(add(
            add(
                scale(self.axis.x, v.cos() * u.cos()),
                scale(y, v.cos() * u.sin()),
            ),
            scale(self.axis.z, v.sin()),
        ))
    }

    fn u_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }

    fn v_bounds(&self) -> (f64, f64) {
        (-PI / 2.0, PI / 2.0)
    }
}

// ── BSplineSurfaceWithKnots ───────────────────────────────────────────────────

pub struct BSplineSurfaceWithKnots {
    pub u_degree: usize,
    pub v_degree: usize,
    /// Indexed [u_index][v_index].
    pub control_points: Vec<Vec<[f64; 3]>>,
    pub u_knots: Vec<f64>,
    pub v_knots: Vec<f64>,
}

impl BSplineSurfaceWithKnots {
    fn eval(&self, u: f64, v: f64) -> [f64; 3] {
        // Evaluate along v for each u-row to get iso-u control points,
        // then evaluate along u.
        let u_pts: Vec<[f64; 3]> = self
            .control_points
            .iter()
            .map(|row| de_boor_1d(row, self.v_degree, &self.v_knots, v))
            .collect();
        de_boor_1d(&u_pts, self.u_degree, &self.u_knots, u)
    }
}

impl Surface for BSplineSurfaceWithKnots {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        self.eval(u, v)
    }

    fn normal(&self, u: f64, v: f64) -> [f64; 3] {
        // Numerical normal via central finite differences
        let (u0, u1) = self.u_bounds();
        let (v0, v1) = self.v_bounds();
        let du = (u1 - u0) * 1e-6;
        let dv = (v1 - v0) * 1e-6;
        let pu = sub(self.eval(u + du, v), self.eval(u - du, v));
        let pv = sub(self.eval(u, v + dv), self.eval(u, v - dv));
        normalize(cross(pu, pv))
    }

    fn u_bounds(&self) -> (f64, f64) {
        let n = self.control_points.len() - 1;
        (self.u_knots[self.u_degree], self.u_knots[n + 1])
    }

    fn v_bounds(&self) -> (f64, f64) {
        let n = self.control_points[0].len() - 1;
        (self.v_knots[self.v_degree], self.v_knots[n + 1])
    }
}

// ── NurbsSurface ─────────────────────────────────────────────────────────────

/// Rational B-spline (NURBS) surface with explicit per-control-point weights.
/// Evaluates in homogeneous 4D coordinates for exact rational blending.
pub struct NurbsSurface {
    pub u_degree: usize,
    pub v_degree: usize,
    /// Indexed [u_index][v_index].  Each entry is [w·x, w·y, w·z, w].
    pub control_points_h: Vec<Vec<[f64; 4]>>,
    pub u_knots: Vec<f64>,
    pub v_knots: Vec<f64>,
}

impl NurbsSurface {
    fn eval(&self, u: f64, v: f64) -> [f64; 3] {
        let u_pts: Vec<[f64; 4]> = self
            .control_points_h
            .iter()
            .map(|row| de_boor_1d_4d(row, self.v_degree, &self.v_knots, v))
            .collect();
        let hw = de_boor_1d_4d(&u_pts, self.u_degree, &self.u_knots, u);
        let w = hw[3];
        if w.abs() < 1e-15 {
            [hw[0], hw[1], hw[2]]
        } else {
            [hw[0] / w, hw[1] / w, hw[2] / w]
        }
    }
}

impl Surface for NurbsSurface {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        self.eval(u, v)
    }

    fn normal(&self, u: f64, v: f64) -> [f64; 3] {
        let (u0, u1) = self.u_bounds();
        let (v0, v1) = self.v_bounds();
        let du = (u1 - u0) * 1e-6;
        let dv = (v1 - v0) * 1e-6;
        let pu = sub(self.eval(u + du, v), self.eval(u - du, v));
        let pv = sub(self.eval(u, v + dv), self.eval(u, v - dv));
        normalize(cross(pu, pv))
    }

    fn u_bounds(&self) -> (f64, f64) {
        let n = self.control_points_h.len() - 1;
        (self.u_knots[self.u_degree], self.u_knots[n + 1])
    }

    fn v_bounds(&self) -> (f64, f64) {
        let n = self.control_points_h[0].len() - 1;
        (self.v_knots[self.v_degree], self.v_knots[n + 1])
    }
}

// ── SurfaceOfLinearExtrusion ──────────────────────────────────────────────────

pub struct SurfaceOfLinearExtrusion {
    pub swept_curve: Box<dyn Curve>,
    /// Full extrusion vector (direction × magnitude).
    pub extrusion: [f64; 3],
}

impl Surface for SurfaceOfLinearExtrusion {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        add(self.swept_curve.point(u), scale(self.extrusion, v))
    }

    fn normal(&self, u: f64, v: f64) -> [f64; 3] {
        let (u0, u1) = self.u_bounds();
        let du = (u1 - u0) * 1e-6;
        let pu = sub(self.point(u + du, v), self.point(u - du, v));
        normalize(cross(pu, self.extrusion))
    }

    fn u_bounds(&self) -> (f64, f64) {
        self.swept_curve.t_bounds()
    }

    fn v_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

// ── SurfaceOfRevolution ───────────────────────────────────────────────────────

pub struct SurfaceOfRevolution {
    pub swept_curve: Box<dyn Curve>,
    pub axis: Axis1,
}

impl Surface for SurfaceOfRevolution {
    fn point(&self, u: f64, v: f64) -> [f64; 3] {
        // u = angle around axis, v = parameter along swept curve
        // P(u, v) = rotate(swept_curve.point(v) - axis.origin, axis.direction, u) + axis.origin
        let curve_pt = self.swept_curve.point(v);
        let rel = sub(curve_pt, self.axis.origin);
        let rotated = rodrigues(rel, self.axis.direction, u);
        add(self.axis.origin, rotated)
    }

    fn normal(&self, u: f64, v: f64) -> [f64; 3] {
        // Numerical normal via central finite differences
        let (v0, v1) = self.v_bounds();
        let du = 1e-6;
        let dv = (v1 - v0).abs().max(1.0) * 1e-6;
        let pu = sub(self.point(u + du, v), self.point(u - du, v));
        let pv = sub(self.point(u, v + dv), self.point(u, v - dv));
        normalize(cross(pu, pv))
    }

    fn u_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }

    fn v_bounds(&self) -> (f64, f64) {
        self.swept_curve.t_bounds()
    }
}

// ── from_step builder ─────────────────────────────────────────────────────────

/// Build a surface from the *split* STEP complex-entity form:
///
/// - `base_args`: own attrs of the B_SPLINE_SURFACE component
///   `(u_degree, v_degree, control_points, surface_form, u_closed, v_closed, self_int)`
/// - `knot_args`: own attrs of the B_SPLINE_SURFACE_WITH_KNOTS component
///   `(u_mults, v_mults, u_knots, v_knots, knot_spec)`
/// - `rational_args`: own attrs of the optional RATIONAL_B_SPLINE_SURFACE component
///   `(weights_data,)`
fn bspline_surface_from_split(
    id: u64,
    base_args: &[Arg],
    knot_args: &[Arg],
    rational_args: Option<&[Arg]>,
    file: &StepFile,
) -> Result<Box<dyn Surface>, GeomError> {
    let bad = |idx| GeomError::BadArg(id, idx);

    // B_SPLINE_SURFACE own attrs (no label in complex entity components).
    let u_degree = match base_args.first() {
        Some(Arg::Integer(v)) => *v as usize,
        _ => return Err(bad(0)),
    };
    let v_degree = match base_args.get(1) {
        Some(Arg::Integer(v)) => *v as usize,
        _ => return Err(bad(1)),
    };
    let rows_arg = match base_args.get(2) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(2)),
    };
    let mut control_points: Vec<Vec<[f64; 3]>> = Vec::with_capacity(rows_arg.len());
    for row_arg in rows_arg {
        let col_list = match row_arg {
            Arg::List(v) => v,
            _ => return Err(bad(2)),
        };
        let mut row: Vec<[f64; 3]> = Vec::with_capacity(col_list.len());
        for a in col_list {
            let cp_id = arg_as_ref(a, id)?;
            row.push(point3(file, cp_id)?);
        }
        control_points.push(row);
    }

    // B_SPLINE_SURFACE_WITH_KNOTS own attrs.
    let u_mults = match knot_args.first() {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(0)),
    };
    let v_mults = match knot_args.get(1) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(1)),
    };
    let u_knot_vals = match knot_args.get(2) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(2)),
    };
    let v_knot_vals = match knot_args.get(3) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(3)),
    };
    let u_knots = expand_knots(u_mults, u_knot_vals, id)?;
    let v_knots = expand_knots(v_mults, v_knot_vals, id)?;

    // RATIONAL_B_SPLINE_SURFACE own attrs: weights_data = LIST OF LIST OF REAL.
    let weights = if let Some(rat) = rational_args {
        match rat.first() {
            Some(Arg::List(rows)) => {
                let mut w: Vec<Vec<f64>> = Vec::with_capacity(rows.len());
                for row_arg in rows {
                    match row_arg {
                        Arg::List(cols) => {
                            let row: Vec<f64> = cols
                                .iter()
                                .map(|a| match a {
                                    Arg::Real(v) => *v,
                                    Arg::Integer(v) => *v as f64,
                                    _ => 1.0,
                                })
                                .collect();
                            w.push(row);
                        }
                        _ => return Err(bad(0)),
                    }
                }
                Some(w)
            }
            _ => None,
        }
    } else {
        None
    };

    if let Some(w) = weights {
        // Build homogeneous control points [w·x, w·y, w·z, w].
        let n_u = control_points.len();
        let n_v = if n_u > 0 { control_points[0].len() } else { 0 };
        let mut h: Vec<Vec<[f64; 4]>> = Vec::with_capacity(n_u);
        for (i, row) in control_points.iter().enumerate() {
            let mut hrow: Vec<[f64; 4]> = Vec::with_capacity(n_v);
            for (j, &p) in row.iter().enumerate() {
                let wij = w.get(i).and_then(|r| r.get(j)).copied().unwrap_or(1.0);
                hrow.push([p[0] * wij, p[1] * wij, p[2] * wij, wij]);
            }
            h.push(hrow);
        }
        Ok(Box::new(NurbsSurface {
            u_degree,
            v_degree,
            control_points_h: h,
            u_knots,
            v_knots,
        }))
    } else {
        Ok(Box::new(BSplineSurfaceWithKnots {
            u_degree,
            v_degree,
            control_points,
            u_knots,
            v_knots,
        }))
    }
}

/// Parse a B_SPLINE_SURFACE_WITH_KNOTS from a raw arg slice.
///
/// Works for both a standalone entity (where `args` = `entity.args`) and a
/// TypedValue component inside a complex entity instance.
fn bspline_surface_from_args(
    id: u64,
    args: &[Arg],
    file: &StepFile,
) -> Result<Box<dyn Surface>, GeomError> {
    let bad = |idx| GeomError::BadArg(id, idx);

    let u_degree = match args.get(1) {
        Some(Arg::Integer(v)) => *v as usize,
        _ => return Err(bad(1)),
    };
    let v_degree = match args.get(2) {
        Some(Arg::Integer(v)) => *v as usize,
        _ => return Err(bad(2)),
    };
    let rows_arg = match args.get(3) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(3)),
    };
    let mut control_points: Vec<Vec<[f64; 3]>> = Vec::with_capacity(rows_arg.len());
    for row_arg in rows_arg {
        let col_list = match row_arg {
            Arg::List(v) => v,
            _ => return Err(bad(3)),
        };
        let mut row: Vec<[f64; 3]> = Vec::with_capacity(col_list.len());
        for a in col_list {
            let cp_id = arg_as_ref(a, id)?;
            row.push(point3(file, cp_id)?);
        }
        control_points.push(row);
    }
    let u_mults = match args.get(8) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(8)),
    };
    let v_mults = match args.get(9) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(9)),
    };
    let u_knot_vals = match args.get(10) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(10)),
    };
    let v_knot_vals = match args.get(11) {
        Some(Arg::List(v)) => v,
        _ => return Err(bad(11)),
    };
    let u_knots = expand_knots(u_mults, u_knot_vals, id)?;
    let v_knots = expand_knots(v_mults, v_knot_vals, id)?;
    Ok(Box::new(BSplineSurfaceWithKnots {
        u_degree,
        v_degree,
        control_points,
        u_knots,
        v_knots,
    }))
}

pub fn surface_from_step(id: u64, file: &StepFile) -> Result<Box<dyn Surface>, GeomError> {
    let e = get_entity(file, id)?;

    // Complex entity instance: type_name is empty, args are TypedValue components.
    // Scan for a recognised surface type among them.
    if e.type_name.is_empty() {
        // Collect the component pieces we care about.
        let mut bspline_base_args: Option<&[Arg]> = None; // B_SPLINE_SURFACE own attrs
        let mut bspline_knot_args: Option<&[Arg]> = None; // B_SPLINE_SURFACE_WITH_KNOTS own attrs
        let mut rational_args: Option<&[Arg]> = None; // RATIONAL_B_SPLINE_SURFACE own attrs
        let mut full_bspline_with_knots: Option<&[Arg]> = None; // legacy full-args form

        for arg in &e.args {
            if let Arg::TypedValue {
                name,
                args: sub_args,
            } = arg
            {
                match name.as_str() {
                    "B_SPLINE_SURFACE" => bspline_base_args = Some(sub_args),
                    "B_SPLINE_SURFACE_WITH_KNOTS" => {
                        // Detect "full" form (includes label + inherited attrs at index 1/2)
                        // vs. "split" form (only own attrs: u_mults at index 0).
                        let is_full = matches!(sub_args.get(1), Some(Arg::Integer(_)));
                        if is_full {
                            full_bspline_with_knots = Some(sub_args);
                        } else {
                            bspline_knot_args = Some(sub_args);
                        }
                    }
                    "RATIONAL_B_SPLINE_SURFACE" => rational_args = Some(sub_args),
                    _ => {}
                }
            }
        }

        // Legacy full-args form: single B_SPLINE_SURFACE_WITH_KNOTS component that
        // carries all inherited + own attributes.
        // Layout: [label, u_deg, v_deg, ctrl_pts, form, u_closed, v_closed, self_int,
        //          u_mults, v_mults, u_knots, v_knots, knot_spec]
        // Map to split form so that any RATIONAL_B_SPLINE_SURFACE weights are honoured.
        if let Some(full) = full_bspline_with_knots {
            if full.len() >= 13 {
                return bspline_surface_from_split(id, &full[1..], &full[8..], rational_args, file);
            }
            return bspline_surface_from_args(id, full, file);
        }

        // Split form: B_SPLINE_SURFACE (base) + B_SPLINE_SURFACE_WITH_KNOTS (knots)
        // + optional RATIONAL_B_SPLINE_SURFACE (weights).
        if let (Some(base), Some(knots)) = (bspline_base_args, bspline_knot_args) {
            return bspline_surface_from_split(id, base, knots, rational_args, file);
        }

        return Err(GeomError::Unsupported(
            "complex entity with no recognised surface component".to_string(),
            id,
        ));
    }

    match e.type_name.as_str() {
        "PLANE" => {
            // PLANE(label, axis2_placement_ref)
            let ax_id = get_ref(e, 1)?;
            let axis = axis2_placement(file, ax_id)?;
            Ok(Box::new(Plane {
                origin: axis.origin,
                normal: axis.z,
                x_axis: axis.x,
            }))
        }

        "CYLINDRICAL_SURFACE" => {
            // CYLINDRICAL_SURFACE(label, axis2_placement_ref, radius)
            let ax_id = get_ref(e, 1)?;
            let radius = get_real(e, 2)?;
            let axis = axis2_placement(file, ax_id)?;
            Ok(Box::new(CylindricalSurface { axis, radius }))
        }

        "CONICAL_SURFACE" => {
            // CONICAL_SURFACE(label, axis2_placement_ref, radius, semi_angle_deg)
            let ax_id = get_ref(e, 1)?;
            let radius = get_real(e, 2)?;
            let semi_angle = get_real(e, 3)?.to_radians();
            let axis = axis2_placement(file, ax_id)?;
            Ok(Box::new(ConicalSurface {
                axis,
                radius,
                semi_angle,
            }))
        }

        "TOROIDAL_SURFACE" => {
            // TOROIDAL_SURFACE(label, axis2_placement_ref, major_radius, minor_radius)
            let ax_id = get_ref(e, 1)?;
            let major_radius = get_real(e, 2)?;
            let minor_radius = get_real(e, 3)?;
            let axis = axis2_placement(file, ax_id)?;
            Ok(Box::new(ToroidalSurface {
                axis,
                major_radius,
                minor_radius,
            }))
        }

        "SPHERICAL_SURFACE" => {
            // SPHERICAL_SURFACE(label, axis2_placement_ref, radius)
            let ax_id = get_ref(e, 1)?;
            let radius = get_real(e, 2)?;
            let axis = axis2_placement(file, ax_id)?;
            Ok(Box::new(SphericalSurface { axis, radius }))
        }

        "B_SPLINE_SURFACE_WITH_KNOTS" => bspline_surface_from_args(id, &e.args, file),

        "SURFACE_OF_LINEAR_EXTRUSION" => {
            // SURFACE_OF_LINEAR_EXTRUSION(label, swept_curve_ref, extrusion_axis_ref)
            let curve_id = get_ref(e, 1)?;
            let vec_id = get_ref(e, 2)?;
            let swept_curve = curve_from_step(curve_id, file)?;
            // VECTOR(label, direction_ref, magnitude)
            let vec_e = get_entity(file, vec_id)?;
            let dir_id = get_ref(vec_e, 1)?;
            let magnitude = get_real(vec_e, 2)?;
            let dir_raw = point3(file, dir_id)?;
            let dir = super::normalize(dir_raw);
            let extrusion = scale(dir, magnitude);
            Ok(Box::new(SurfaceOfLinearExtrusion {
                swept_curve,
                extrusion,
            }))
        }

        "SURFACE_OF_REVOLUTION" => {
            // SURFACE_OF_REVOLUTION(label, swept_curve_ref, axis1_placement_ref)
            let curve_id = get_ref(e, 1)?;
            let axis_id = get_ref(e, 2)?;
            let swept_curve = curve_from_step(curve_id, file)?;
            let axis = axis1_placement(file, axis_id)?;
            Ok(Box::new(SurfaceOfRevolution { swept_curve, axis }))
        }

        other => Err(GeomError::Unsupported(other.to_string(), id)),
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plane_origin() {
        let plane = Plane {
            origin: [1., 2., 3.],
            normal: [0., 0., 1.],
            x_axis: [1., 0., 0.],
        };
        let p = plane.point(0., 0.);
        assert!((p[0] - 1.).abs() < 1e-12);
        assert!((p[1] - 2.).abs() < 1e-12);
        assert!((p[2] - 3.).abs() < 1e-12);
    }

    #[test]
    fn plane_xy_parametrisation() {
        let plane = Plane {
            origin: [0.; 3],
            normal: [0., 0., 1.],
            x_axis: [1., 0., 0.],
        };
        let p = plane.point(2., 3.);
        assert!((p[0] - 2.).abs() < 1e-12);
        assert!((p[1] - 3.).abs() < 1e-12);
        assert!(p[2].abs() < 1e-12);
    }

    #[test]
    fn cylinder_point_at_zero() {
        let cyl = CylindricalSurface {
            axis: Axis2 {
                origin: [0.; 3],
                z: [0., 0., 1.],
                x: [1., 0., 0.],
            },
            radius: 5.,
        };
        let p = cyl.point(0., 0.);
        assert!((p[0] - 5.).abs() < 1e-12, "p[0]={}", p[0]);
        assert!(p[1].abs() < 1e-12, "p[1]={}", p[1]);
        assert!(p[2].abs() < 1e-12, "p[2]={}", p[2]);
    }

    #[test]
    fn cylinder_normal_is_radial() {
        let cyl = CylindricalSurface {
            axis: Axis2 {
                origin: [0.; 3],
                z: [0., 0., 1.],
                x: [1., 0., 0.],
            },
            radius: 5.,
        };
        let n = cyl.normal(0., 10.);
        assert!((n[0] - 1.).abs() < 1e-12);
        assert!(n[1].abs() < 1e-12);
        assert!(n[2].abs() < 1e-12);
    }

    #[test]
    fn sphere_point_on_equator() {
        let sph = SphericalSurface {
            axis: Axis2 {
                origin: [0.; 3],
                z: [0., 0., 1.],
                x: [1., 0., 0.],
            },
            radius: 4.,
        };
        let p = sph.point(0., 0.);
        assert!((p[0] - 4.).abs() < 1e-12);
        assert!(p[1].abs() < 1e-12);
        assert!(p[2].abs() < 1e-12);
    }

    #[test]
    fn torus_point_at_zero() {
        let tor = ToroidalSurface {
            axis: Axis2 {
                origin: [0.; 3],
                z: [0., 0., 1.],
                x: [1., 0., 0.],
            },
            major_radius: 10.,
            minor_radius: 2.,
        };
        // u=0, v=0 → outer equator, tube front
        let p = tor.point(0., 0.);
        assert!((p[0] - 12.).abs() < 1e-12);
        assert!(p[1].abs() < 1e-12);
        assert!(p[2].abs() < 1e-12);
    }

    #[test]
    fn revolution_line_around_z_gives_cylinder() {
        use super::super::curve::Line;

        // Vertical line at x=5 (from z=0 to z=10)
        let line = Line {
            origin: [5., 0., 0.],
            direction: [0., 0., 1.],
        };
        let surf = SurfaceOfRevolution {
            swept_curve: Box::new(line),
            axis: Axis1 {
                origin: [0., 0., 0.],
                direction: [0., 0., 1.],
            },
        };

        // At u=0, v=0: point should be at (5, 0, 0)
        let p0 = surf.point(0., 0.);
        assert!((p0[0] - 5.).abs() < 1e-12, "p0[0]={}", p0[0]);
        assert!(p0[1].abs() < 1e-12, "p0[1]={}", p0[1]);
        assert!(p0[2].abs() < 1e-12, "p0[2]={}", p0[2]);

        // At u=π/2, v=0: point should be at (0, 5, 0) - rotated 90° around Z
        let p1 = surf.point(PI / 2., 0.);
        assert!(p1[0].abs() < 1e-12, "p1[0]={}", p1[0]);
        assert!((p1[1] - 5.).abs() < 1e-12, "p1[1]={}", p1[1]);
        assert!(p1[2].abs() < 1e-12, "p1[2]={}", p1[2]);

        // At u=π, v=0: point should be at (-5, 0, 0)
        let p2 = surf.point(PI, 0.);
        assert!((p2[0] + 5.).abs() < 1e-12, "p2[0]={}", p2[0]);
        assert!(p2[1].abs() < 1e-12, "p2[1]={}", p2[1]);
        assert!(p2[2].abs() < 1e-12, "p2[2]={}", p2[2]);

        // At u=0, v=3: point should be at (5, 0, 3) - moved along the line
        let p3 = surf.point(0., 3.);
        assert!((p3[0] - 5.).abs() < 1e-12, "p3[0]={}", p3[0]);
        assert!(p3[1].abs() < 1e-12, "p3[1]={}", p3[1]);
        assert!((p3[2] - 3.).abs() < 1e-12, "p3[2]={}", p3[2]);

        // All points should be at radius 5 from the Z-axis (cylinder property)
        for u in [0.0, PI / 4., PI / 2., PI, 3. * PI / 2.] {
            for v in [0., 2., 5., 10.] {
                let p = surf.point(u, v);
                let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
                assert!((r - 5.).abs() < 1e-12, "radius at u={}, v={}: {}", u, v, r);
            }
        }
    }

    /// Verify that `surface_from_step` can build a B-spline surface from a
    /// STEP complex entity instance (empty `type_name`, args are TypedValues).
    ///
    /// The surface is a 3×3 quadratic B-spline tent: all control points have
    /// z=0 except the centre point at z=1.  At u=v=0.5 the surface evaluates
    /// to z ≈ 0.25 (tensor-product basis).
    #[test]
    fn bspline_from_complex_entity() {
        use crate::step::parser::{parse, StepFile};

        // Build a minimal STEP file where the B-spline surface is stored as a
        // complex entity instance:  #100=(BOUNDED_SURFACE()B_SPLINE_SURFACE_WITH_KNOTS(...))
        let step_text = "
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(0.5,0.,0.));
#3=CARTESIAN_POINT('',(1.,0.,0.));
#4=CARTESIAN_POINT('',(0.,0.5,0.));
#5=CARTESIAN_POINT('',(0.5,0.5,1.));
#6=CARTESIAN_POINT('',(1.,0.5,0.));
#7=CARTESIAN_POINT('',(0.,1.,0.));
#8=CARTESIAN_POINT('',(0.5,1.,0.));
#9=CARTESIAN_POINT('',(1.,1.,0.));
#100=(BOUNDED_SURFACE()B_SPLINE_SURFACE_WITH_KNOTS('',2,2,((#1,#2,#3),(#4,#5,#6),(#7,#8,#9)),.UNSPECIFIED.,.F.,.F.,.F.,(3,3),(3,3),(0.,1.),(0.,1.),.UNSPECIFIED.));
ENDSEC;
END-ISO-10303-21;
";
        let file: StepFile = parse(step_text).unwrap();
        let surface = surface_from_step(100, &file).expect("should parse complex B-spline entity");

        // At (u=0, v=0) the surface must be at the corner control point (0,0,0).
        let p00 = surface.point(0.0, 0.0);
        assert!(
            p00[2].abs() < 1e-10,
            "corner z should be 0, got {:.6}",
            p00[2]
        );

        // At the centre the tent peaks at z=0.25 (quadratic tensor-product blend).
        let p_mid = surface.point(0.5, 0.5);
        assert!(
            (p_mid[2] - 0.25).abs() < 1e-6,
            "centre z should be 0.25, got {:.6}",
            p_mid[2]
        );
    }
}
