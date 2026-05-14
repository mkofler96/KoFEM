use std::f64::consts::PI;

use super::curve::{curve_from_step, Curve};
use super::{
    add, arg_as_ref, axis1_placement, axis2_placement, cross, de_boor_1d, expand_knots, get_arg,
    get_entity, get_list, get_real, get_ref, normalize, point3, rodrigues, scale, sub, Axis1,
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

pub fn surface_from_step(id: u64, file: &StepFile) -> Result<Box<dyn Surface>, GeomError> {
    let e = get_entity(file, id)?;
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
            // CONICAL_SURFACE(label, axis2_placement_ref, radius, semi_angle)
            let ax_id = get_ref(e, 1)?;
            let radius = get_real(e, 2)?;
            let semi_angle = get_real(e, 3)?;
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

        "B_SPLINE_SURFACE_WITH_KNOTS" => {
            // B_SPLINE_SURFACE_WITH_KNOTS(name, u_degree, v_degree,
            //   ((cp_refs)), surface_form, u_closed, v_closed, self_intersect,
            //   u_multiplicities, v_multiplicities, u_knots, v_knots, knot_spec)
            let u_degree = match get_arg(e, 1)? {
                Arg::Integer(v) => *v as usize,
                _ => return Err(GeomError::BadArg(id, 1)),
            };
            let v_degree = match get_arg(e, 2)? {
                Arg::Integer(v) => *v as usize,
                _ => return Err(GeomError::BadArg(id, 2)),
            };
            let rows_arg = get_list(e, 3)?;
            let mut control_points: Vec<Vec<[f64; 3]>> = Vec::with_capacity(rows_arg.len());
            for row_arg in rows_arg {
                let col_list = match row_arg {
                    Arg::List(v) => v,
                    _ => return Err(GeomError::BadArg(id, 3)),
                };
                let mut row: Vec<[f64; 3]> = Vec::with_capacity(col_list.len());
                for a in col_list {
                    let cp_id = arg_as_ref(a, id)?;
                    row.push(point3(file, cp_id)?);
                }
                control_points.push(row);
            }
            let u_mults = get_list(e, 8)?;
            let v_mults = get_list(e, 9)?;
            let u_knot_vals = get_list(e, 10)?;
            let v_knot_vals = get_list(e, 11)?;
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
}
