use std::f64::consts::PI;

use super::{
    add, arg_as_ref, axis2_placement, de_boor_1d, expand_knots, get_arg, get_entity, get_list,
    get_real, get_ref, normalize, point3, scale, Axis2, GeomError,
};
use crate::step::parser::{Arg, StepFile};

pub trait Curve: Send + Sync {
    fn point(&self, t: f64) -> [f64; 3];
    fn t_bounds(&self) -> (f64, f64);
}

// ── Line ─────────────────────────────────────────────────────────────────────

pub struct Line {
    pub origin: [f64; 3],
    pub direction: [f64; 3],
}

impl Curve for Line {
    fn point(&self, t: f64) -> [f64; 3] {
        add(self.origin, scale(self.direction, t))
    }

    fn t_bounds(&self) -> (f64, f64) {
        (f64::NEG_INFINITY, f64::INFINITY)
    }
}

// ── Circle ───────────────────────────────────────────────────────────────────

pub struct Circle {
    pub axis: Axis2,
    pub radius: f64,
}

impl Curve for Circle {
    fn point(&self, t: f64) -> [f64; 3] {
        let y = self.axis.y();
        add(
            self.axis.origin,
            add(
                scale(self.axis.x, self.radius * t.cos()),
                scale(y, self.radius * t.sin()),
            ),
        )
    }

    fn t_bounds(&self) -> (f64, f64) {
        (0.0, 2.0 * PI)
    }
}

// ── BSplineCurveWithKnots ────────────────────────────────────────────────────

pub struct BSplineCurveWithKnots {
    pub degree: usize,
    pub control_points: Vec<[f64; 3]>,
    /// Full knot vector with repetitions expanded.
    pub knots: Vec<f64>,
}

impl Curve for BSplineCurveWithKnots {
    fn point(&self, t: f64) -> [f64; 3] {
        de_boor_1d(&self.control_points, self.degree, &self.knots, t)
    }

    fn t_bounds(&self) -> (f64, f64) {
        let n = self.control_points.len() - 1;
        (self.knots[self.degree], self.knots[n + 1])
    }
}

// ── from_step builder ─────────────────────────────────────────────────────────

pub fn curve_from_step(id: u64, file: &StepFile) -> Result<Box<dyn Curve>, GeomError> {
    let e = get_entity(file, id)?;
    match e.type_name.as_str() {
        "LINE" => {
            // LINE(label, point_ref, vector_ref)
            let pt_id = get_ref(e, 1)?;
            let vec_id = get_ref(e, 2)?;
            let origin = point3(file, pt_id)?;
            // VECTOR(label, direction_ref, magnitude)
            let vec_e = get_entity(file, vec_id)?;
            let dir_id = get_ref(vec_e, 1)?;
            let direction = normalize(point3(file, dir_id)?);
            Ok(Box::new(Line { origin, direction }))
        }

        "CIRCLE" => {
            // CIRCLE(label, axis2_placement_ref, radius)
            let ax_id = get_ref(e, 1)?;
            let radius = get_real(e, 2)?;
            let axis = axis2_placement(file, ax_id)?;
            Ok(Box::new(Circle { axis, radius }))
        }

        "B_SPLINE_CURVE_WITH_KNOTS" => {
            // B_SPLINE_CURVE_WITH_KNOTS(name, degree, (cp_refs), curve_form,
            //   closed, self_intersect, knot_multiplicities, knots, knot_spec)
            let degree = match get_arg(e, 1)? {
                Arg::Integer(v) => *v as usize,
                _ => return Err(GeomError::BadArg(id, 1)),
            };
            let cp_list = get_list(e, 2)?;
            let mut control_points = Vec::with_capacity(cp_list.len());
            for a in cp_list {
                let cp_id = arg_as_ref(a, id)?;
                control_points.push(point3(file, cp_id)?);
            }
            let mults = get_list(e, 6)?;
            let knot_vals = get_list(e, 7)?;
            let knots = expand_knots(mults, knot_vals, id)?;
            Ok(Box::new(BSplineCurveWithKnots {
                degree,
                control_points,
                knots,
            }))
        }

        other => Err(GeomError::Unsupported(other.to_string(), id)),
    }
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circle_full_revolution() {
        let c = Circle {
            axis: Axis2 {
                origin: [0.; 3],
                z: [0., 0., 1.],
                x: [1., 0., 0.],
            },
            radius: 3.,
        };
        let p0 = c.point(0.);
        let p_half = c.point(PI);
        assert!((p0[0] - 3.).abs() < 1e-12);
        assert!(p0[1].abs() < 1e-12);
        assert!((p_half[0] + 3.).abs() < 1e-12);
        assert!(p_half[1].abs() < 1e-12);
    }

    #[test]
    fn bspline_degree1_is_linear() {
        // Degree-1 B-spline = piecewise linear interpolation.
        // Control points: (0,0,0) → (1,0,0) → (1,1,0)
        // Knots: [0, 0, 1, 2, 2]  (open uniform, clamped at both ends)
        let curve = BSplineCurveWithKnots {
            degree: 1,
            control_points: vec![[0., 0., 0.], [1., 0., 0.], [1., 1., 0.]],
            knots: vec![0., 0., 1., 2., 2.],
        };
        // At t=0.5, halfway along first segment
        let p = curve.point(0.5);
        assert!((p[0] - 0.5).abs() < 1e-12, "p[0]={}", p[0]);
        assert!(p[1].abs() < 1e-12, "p[1]={}", p[1]);
        // At t=1.5, halfway along second segment
        let p2 = curve.point(1.5);
        assert!((p2[0] - 1.0).abs() < 1e-12, "p2[0]={}", p2[0]);
        assert!((p2[1] - 0.5).abs() < 1e-12, "p2[1]={}", p2[1]);
        // Endpoints
        let start = curve.point(0.);
        assert!(start[0].abs() < 1e-12 && start[1].abs() < 1e-12);
        let end = curve.point(2.);
        assert!((end[0] - 1.).abs() < 1e-12 && (end[1] - 1.).abs() < 1e-12);
    }

    #[test]
    fn line_point() {
        let line = Line {
            origin: [1., 2., 3.],
            direction: [1., 0., 0.],
        };
        let p = line.point(2.5);
        assert!((p[0] - 3.5).abs() < 1e-12);
        assert!((p[1] - 2.).abs() < 1e-12);
        assert!((p[2] - 3.).abs() < 1e-12);
    }
}
