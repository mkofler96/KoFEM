//! Geometric primitives and exact predicates.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point2 {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Point2 {
    #[inline]
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    #[inline]
    pub fn dist2(self, other: Self) -> f64 {
        (self.x - other.x).powi(2) + (self.y - other.y).powi(2)
    }

    #[inline]
    pub fn midpoint(self, other: Self) -> Self {
        Self {
            x: (self.x + other.x) * 0.5,
            y: (self.y + other.y) * 0.5,
        }
    }
}

impl Point3 {
    #[inline]
    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
}

/// Signed area × 2 of triangle (a, b, c).
/// Positive → CCW, negative → CW, zero → collinear.
#[inline]
pub fn orient2d(a: Point2, b: Point2, c: Point2) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// Returns `true` if point `d` lies strictly inside the circumcircle of
/// triangle `(a, b, c)`.  Triangle must be given in **CCW** order.
///
/// The in-circle determinant is:
/// ```text
/// |ax-dx  ay-dy  (ax-dx)²+(ay-dy)²|
/// |bx-dx  by-dy  (bx-dx)²+(by-dy)²|  > 0
/// |cx-dx  cy-dy  (cx-dx)²+(cy-dy)²|
/// ```
///
/// A relative epsilon guards against IEEE 754 inconsistencies for near-cocircular
/// points: if `det` is positive but smaller than the floating-point error bound,
/// the point is treated as "on the circle" (= not inside), preventing infinite
/// flip cycles in Lawson's Delaunay legalisation algorithm.
#[inline]
pub fn in_circumcircle(pts: &[Point2], a: usize, b: usize, c: usize, d: usize) -> bool {
    let p = pts[d];
    let ax = pts[a].x - p.x;
    let ay = pts[a].y - p.y;
    let bx = pts[b].x - p.x;
    let by = pts[b].y - p.y;
    let cx = pts[c].x - p.x;
    let cy = pts[c].y - p.y;
    let r_a = ax * ax + ay * ay;
    let r_b = bx * bx + by * by;
    let r_c = cx * cx + cy * cy;
    let det = ax * (by * r_c - cy * r_b) - ay * (bx * r_c - cx * r_b) + r_a * (bx * cy - by * cx);
    // Error bound: det is a degree-4 polynomial in the inputs; the absolute
    // rounding error is ≤ 8·ε·max(r_a,r_b,r_c)² where ε = f64::EPSILON.
    // Points within this tolerance are cocircular to machine precision and must
    // not be flipped, otherwise Lawson's algorithm can cycle indefinitely.
    let eps = 8.0 * f64::EPSILON * r_a.max(r_b).max(r_c).powi(2).max(f64::EPSILON);
    det > eps
}

/// Circumcenter of triangle (a, b, c).  Returns `None` for degenerate triangles.
pub fn circumcenter(a: Point2, b: Point2, c: Point2) -> Option<Point2> {
    let ax = b.x - a.x;
    let ay = b.y - a.y;
    let bx = c.x - a.x;
    let by = c.y - a.y;
    let d = 2.0 * (ax * by - ay * bx);
    if d.abs() < 1e-14 {
        return None;
    }
    let ux = (by * (ax * ax + ay * ay) - ay * (bx * bx + by * by)) / d;
    let uy = (ax * (bx * bx + by * by) - bx * (ax * ax + ay * ay)) / d;
    Some(Point2 {
        x: a.x + ux,
        y: a.y + uy,
    })
}

/// Squared circumradius.  Returns `f64::INFINITY` for degenerate triangles.
pub fn circumradius_sq(a: Point2, b: Point2, c: Point2) -> f64 {
    let twice_area = orient2d(a, b, c).abs();
    if twice_area < 1e-14 {
        return f64::INFINITY;
    }
    let la2 = b.dist2(c);
    let lb2 = a.dist2(c);
    let lc2 = a.dist2(b);
    la2 * lb2 * lc2 / (twice_area * twice_area)
}

/// Shortest edge squared length.
pub fn shortest_edge_sq(a: Point2, b: Point2, c: Point2) -> f64 {
    a.dist2(b).min(b.dist2(c)).min(c.dist2(a))
}

/// Minimum interior angle in radians.
pub fn min_angle(a: Point2, b: Point2, c: Point2) -> f64 {
    let la = b.dist2(c).sqrt();
    let lb = a.dist2(c).sqrt();
    let lc = a.dist2(b).sqrt();
    if la < 1e-14 || lb < 1e-14 || lc < 1e-14 {
        return 0.0;
    }
    let cos_a = ((lb * lb + lc * lc - la * la) / (2.0 * lb * lc)).clamp(-1.0, 1.0);
    let cos_b = ((la * la + lc * lc - lb * lb) / (2.0 * la * lc)).clamp(-1.0, 1.0);
    let cos_c = ((la * la + lb * lb - lc * lc) / (2.0 * la * lb)).clamp(-1.0, 1.0);
    cos_a.acos().min(cos_b.acos()).min(cos_c.acos())
}

/// `true` if `p` lies strictly inside the diametral circle of edge `(a, b)`.
/// Used to detect encroachment in Ruppert's algorithm.
#[inline]
pub fn encroaches(p: Point2, a: Point2, b: Point2) -> bool {
    let mx = (a.x + b.x) * 0.5;
    let my = (a.y + b.y) * 0.5;
    let r2 = a.dist2(b) * 0.25;
    (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my) < r2 - 1e-14
}

/// Winding-number point-in-polygon test.
/// Returns `true` if `p` is strictly inside `polygon` (closed, last→first implied).
pub fn point_in_polygon(p: Point2, polygon: &[Point2]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut winding = 0i32;
    let mut j = n - 1;
    for i in 0..n {
        let pi = polygon[i];
        let pj = polygon[j];
        if pj.y <= p.y {
            if pi.y > p.y && orient2d(pj, pi, p) > 0.0 {
                winding += 1;
            }
        } else if pi.y <= p.y && orient2d(pj, pi, p) < 0.0 {
            winding -= 1;
        }
        j = i;
    }
    winding != 0
}

/// Build the super-triangle that contains all `points` with generous margin.
pub fn super_triangle(points: &[Point2]) -> [Point2; 3] {
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in points {
        min_x = min_x.min(p.x);
        max_x = max_x.max(p.x);
        min_y = min_y.min(p.y);
        max_y = max_y.max(p.y);
    }
    let d = ((max_x - min_x).max(max_y - min_y)).max(1e-9) * 10.0;
    let cx = (min_x + max_x) * 0.5;
    let cy = (min_y + max_y) * 0.5;
    [
        Point2::new(cx - 4.0 * d, cy - d),
        Point2::new(cx, cy + 4.0 * d),
        Point2::new(cx + 4.0 * d, cy - d),
    ]
}
