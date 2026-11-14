// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Dual mortar weights for a constraint tie between linear element faces,
//! ported from the app's `tieMortar.ts` (PR #547).
//!
//! A node-to-surface tie makes each slave node follow the point of the
//! master surface it projects onto. That is exact at the slave nodes, but
//! between them the two faces interpolate differently, so the work a traction
//! does on one side is not the work it does on the other: a constant traction
//! does not cross the tie exactly, and the patch test fails wherever the
//! slave nodes fall inside master faces.
//!
//! The mortar method imposes the tie weakly instead, over the interface:
//!
//! ```text
//! ∫_Γ ψⱼ · (u_slave − u_master) dΓ = 0     for every slave node j,
//! ```
//!
//! with ψⱼ a multiplier basis on the slave surface. Choosing ψⱼ dual to the
//! slave shape functions Nᵢ — ∫ ψⱼ Nᵢ dΓ = δᵢⱼ ∫ Nⱼ dΓ (Wohlmuth 2000) —
//! makes the slave block diagonal, so each equation still solves for one
//! slave node,
//!
//! ```text
//! uⱼ = Σₖ wⱼₖ uₖ,   wⱼₖ = ∫ ψⱼ Nₖ(master) dΓ / ∫ ψⱼ dΓ,
//! ```
//!
//! and the master–slave elimination ([`crate::tie`]) is unchanged. Because
//! Σⱼ ψⱼ = 1, the sum of the equations is ∫ (`u_slave` − `u_master`) dΓ = 0: a
//! constant traction is transferred exactly. A linear displacement field
//! satisfies every equation, so the patch test is passed to round-off.
//!
//! The integrals are taken over the overlap of each slave face with each
//! master face (segmentation, Puso & Laursen 2004): the master face is
//! projected along the slave face's normal into its plane, the two polygons
//! are clipped, and the clipped polygon is integrated with a degree-5
//! triangle rule. Without the clipping, the kinks of the master shape
//! functions inside a slave face would leave a small error.
//!
//! Faces are 3-node triangles (tetrahedra) or 4-node quadrilaterals
//! (hexahedra), with linear / bilinear shape functions — linear elements.
//! Quadratic elements keep the node-to-surface projection ([`crate::tie`]).
//!
//! References: B. I. Wohlmuth, "A mortar finite element method using dual
//! spaces for the Lagrange multiplier", SIAM J. Numer. Anal. 38 (2000)
//! 989–1012; M. A. Puso, "A 3D mortar method for solid mechanics", IJNME 59
//! (2004) 315–336; A. Popp, M. W. Gee, W. A. Wall, "A finite deformation
//! mortar contact formulation using a primal–dual active set strategy",
//! IJNME 79 (2009).

use std::collections::{BTreeMap, HashMap};

use crate::error::FemError;

/// One element face on a tied surface: its nodes in cyclic order (3 or 4),
/// their positions, and the centroid of the element it bounds (to orient its
/// normal outwards — the face lists of the elements are not consistently
/// wound).
#[derive(Debug, Clone)]
pub struct MortarFace {
    pub nodes: Vec<usize>,
    pub points: Vec<[f64; 3]>,
    pub element_centroid: [f64; 3],
}

/// The weights of one slave node, and how much of its multiplier support the
/// master surface covers (1 = all of it).
#[derive(Debug, Clone, PartialEq)]
pub struct MortarRow {
    pub slave: usize,
    pub masters: Vec<usize>,
    pub weights: Vec<f64>,
    pub coverage: f64,
}

/// Faces whose normals are less opposed than this are not treated as facing
/// each other across the tie (e.g. the far wall of a cylinder seen through
/// the bore).
const FACING: f64 = -0.3;

/// A slave node is tied only where the master surface covers at least this
/// much of its multiplier support; at the ragged edge of a partial contact
/// the normalisation ∫ψⱼ over a sliver would be ill-conditioned.
const MIN_COVERAGE: f64 = 0.5;

type Point2 = [f64; 2];

/// A face with its outward normal and an orthonormal frame in its plane.
struct FaceFrame<'a> {
    face: &'a MortarFace,
    centroid: [f64; 3],
    normal: [f64; 3],
    axis_u: [f64; 3],
    axis_v: [f64; 3],
    radius: f64,
}

fn frame_of(face: &MortarFace) -> Result<FaceFrame<'_>, FemError> {
    let count = face.points.len();
    if !(count == 3 || count == 4) || face.nodes.len() != count {
        return Err(FemError::Tie {
            reason: format!(
                "a mortar face needs 3 or 4 nodes and as many points, got {} nodes and {count} \
                 points",
                face.nodes.len()
            ),
        });
    }
    let centroid = average(&face.points);
    // Newell's normal: robust for a slightly warped quadrilateral.
    let mut normal = [0.0; 3];
    for (index, point) in face.points.iter().enumerate() {
        let next = face.points[(index + 1) % count];
        normal[0] += (point[1] - next[1]) * (point[2] + next[2]);
        normal[1] += (point[2] - next[2]) * (point[0] + next[0]);
        normal[2] += (point[0] - next[0]) * (point[1] + next[1]);
    }
    let length = norm(normal);
    if !(length.is_finite() && length > 0.0) {
        return Err(FemError::Tie {
            reason: format!(
                "the face of nodes {:?} on a tied surface has zero area",
                face.nodes
            ),
        });
    }
    normal = scale(normal, 1.0 / length);
    if dot(normal, sub(centroid, face.element_centroid)) < 0.0 {
        normal = scale(normal, -1.0);
    }
    let edge = sub(face.points[1], face.points[0]);
    let axis_u = unit(sub(edge, scale(normal, dot(edge, normal))));
    let axis_v = cross(normal, axis_u);
    let radius = face
        .points
        .iter()
        .map(|&point| norm(sub(point, centroid)))
        .fold(0.0, f64::max);
    Ok(FaceFrame {
        face,
        centroid,
        normal,
        axis_u,
        axis_v,
        radius,
    })
}

/// A point projected into a frame's plane, as 2-D coordinates.
fn in_plane(frame: &FaceFrame<'_>, point: [f64; 3]) -> Point2 {
    let offset = sub(point, frame.centroid);
    [dot(offset, frame.axis_u), dot(offset, frame.axis_v)]
}

fn signed_area(polygon: &[Point2]) -> f64 {
    let mut twice = 0.0;
    for (index, point) in polygon.iter().enumerate() {
        let next = polygon[(index + 1) % polygon.len()];
        twice += point[0] * next[1] - next[0] * point[1];
    }
    twice / 2.0
}

/// Shape-function values of a triangle or bilinear quadrilateral with 2-D
/// `corners`, at the point `q` of their plane. The quadrilateral is inverted
/// by Newton's method on its bilinear map; a point outside the face is not an
/// error (round-off at a clipped edge), its values just extrapolate.
fn shape_at(corners: &[Point2], point: Point2) -> Vec<f64> {
    if let [p0, p1, p2] = *corners {
        let det = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
        let l1 =
            ((point[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (point[1] - p0[1])) / det;
        let l2 =
            ((p1[0] - p0[0]) * (point[1] - p0[1]) - (point[0] - p0[0]) * (p1[1] - p0[1])) / det;
        return vec![1.0 - l1 - l2, l1, l2];
    }
    let quad = [corners[0], corners[1], corners[2], corners[3]];
    let (mut along_s, mut along_t) = (0.5, 0.5);
    for _ in 0..30 {
        let shape = bilinear(along_s, along_t);
        let mapped: [f64; 2] = std::array::from_fn(|axis| {
            (0..4)
                .map(|corner| shape[corner] * quad[corner][axis])
                .sum()
        });
        let [xs, xt, ys, yt] = bilinear_jacobian(&quad, along_s, along_t);
        let det = xs * yt - xt * ys;
        let (rx, ry) = (point[0] - mapped[0], point[1] - mapped[1]);
        let step_s = (yt * rx - xt * ry) / det;
        let step_t = (-ys * rx + xs * ry) / det;
        along_s += step_s;
        along_t += step_t;
        if step_s.abs() + step_t.abs() < 1e-14 {
            break;
        }
    }
    bilinear(along_s, along_t).to_vec()
}

fn bilinear(along_s: f64, along_t: f64) -> [f64; 4] {
    [
        (1.0 - along_s) * (1.0 - along_t),
        along_s * (1.0 - along_t),
        along_s * along_t,
        (1.0 - along_s) * along_t,
    ]
}

/// ∂x/∂s, ∂x/∂t, ∂y/∂s, ∂y/∂t of a bilinear map.
fn bilinear_jacobian(corners: &[Point2; 4], along_s: f64, along_t: f64) -> [f64; 4] {
    let [p0, p1, p2, p3] = *corners;
    [
        (1.0 - along_t) * (p1[0] - p0[0]) + along_t * (p2[0] - p3[0]),
        (1.0 - along_s) * (p3[0] - p0[0]) + along_s * (p2[0] - p1[0]),
        (1.0 - along_t) * (p1[1] - p0[1]) + along_t * (p2[1] - p3[1]),
        (1.0 - along_s) * (p3[1] - p0[1]) + along_s * (p2[1] - p1[1]),
    ]
}

/// Gauss–Legendre points on [0, 1], three per direction: exact for the
/// biquadratic integrands of a parallelogram's mass matrix.
fn gauss_01() -> [(f64, f64); 3] {
    let offset = 0.15_f64.sqrt();
    [
        (0.5 - offset, 5.0 / 18.0),
        (0.5, 8.0 / 18.0),
        (0.5 + offset, 5.0 / 18.0),
    ]
}

/// Inverse of a small dense matrix (Gauss–Jordan with partial pivoting).
fn inverse(matrix: &[Vec<f64>]) -> Result<Vec<Vec<f64>>, FemError> {
    let size = matrix.len();
    let mut work: Vec<Vec<f64>> = matrix
        .iter()
        .enumerate()
        .map(|(row, values)| {
            let mut extended = values.clone();
            extended.extend((0..size).map(|column| if row == column { 1.0 } else { 0.0 }));
            extended
        })
        .collect();
    for column in 0..size {
        let pivot = (column..size)
            .max_by(|&first, &second| {
                work[first][column]
                    .abs()
                    .total_cmp(&work[second][column].abs())
            })
            .unwrap_or(column);
        work.swap(column, pivot);
        let lead = work[column][column];
        if lead == 0.0 || !lead.is_finite() {
            return Err(FemError::Tie {
                reason: "degenerate slave face (zero area) on a tied surface".into(),
            });
        }
        for value in &mut work[column] {
            *value /= lead;
        }
        let pivot_row = work[column].clone();
        for (row, values) in work.iter_mut().enumerate() {
            if row == column {
                continue;
            }
            let factor = values[column];
            for (value, &lead_value) in values.iter_mut().zip(&pivot_row) {
                *value -= factor * lead_value;
            }
        }
    }
    Ok(work.into_iter().map(|row| row[size..].to_vec()).collect())
}

/// The coefficients A of the dual basis ψⱼ = Σᵢ Aⱼᵢ Nᵢ of a slave face,
/// and ∫ Nⱼ over it. Biorthogonality ∫ ψⱼ Nᵢ = δᵢⱼ ∫ Nⱼ gives A = D·M⁻¹,
/// with M the face's mass matrix and D = diag(∫ Nⱼ).
fn dual_basis(corners: &[Point2]) -> Result<(Vec<Vec<f64>>, Vec<f64>), FemError> {
    let count = corners.len();
    let mut mass = vec![vec![0.0; count]; count];
    let mut integrals = vec![0.0; count];
    if count == 3 {
        let area = signed_area(corners).abs();
        for (row, line) in mass.iter_mut().enumerate() {
            integrals[row] = area / 3.0;
            for (column, value) in line.iter_mut().enumerate() {
                *value = area * if row == column { 2.0 } else { 1.0 } / 12.0;
            }
        }
    } else {
        let quad = [corners[0], corners[1], corners[2], corners[3]];
        for (along_s, weight_s) in gauss_01() {
            for (along_t, weight_t) in gauss_01() {
                let [xs, xt, ys, yt] = bilinear_jacobian(&quad, along_s, along_t);
                let measure = weight_s * weight_t * (xs * yt - xt * ys).abs();
                let shape = bilinear(along_s, along_t);
                for (row, line) in mass.iter_mut().enumerate() {
                    integrals[row] += measure * shape[row];
                    for (column, value) in line.iter_mut().enumerate() {
                        *value += measure * shape[row] * shape[column];
                    }
                }
            }
        }
    }
    let mass_inverse = inverse(&mass)?;
    let coefficients = mass_inverse
        .iter()
        .enumerate()
        .map(|(index, row)| row.iter().map(|&value| integrals[index] * value).collect())
        .collect();
    Ok((coefficients, integrals))
}

/// Sutherland–Hodgman: `subject` clipped by the convex, counter-clockwise
/// polygon `clip`.
fn clip_polygon(subject: &[Point2], clip: &[Point2]) -> Vec<Point2> {
    let mut output = subject.to_vec();
    for index in 0..clip.len() {
        if output.is_empty() {
            break;
        }
        let from_edge = clip[index];
        let to_edge = clip[(index + 1) % clip.len()];
        // Signed distance (times |b − a|) of a point from the clip edge's
        // line: ≥ 0 inside. The crossing is interpolated from these values,
        // which stay well defined when an edge of the subject runs along the
        // clip edge.
        let side = |point: Point2| {
            (to_edge[0] - from_edge[0]) * (point[1] - from_edge[1])
                - (to_edge[1] - from_edge[1]) * (point[0] - from_edge[0])
        };
        let crossing = |from: Point2, to: Point2| {
            let side_from = side(from);
            let along = side_from / (side_from - side(to));
            [
                from[0] + along * (to[0] - from[0]),
                from[1] + along * (to[1] - from[1]),
            ]
        };
        let input = std::mem::take(&mut output);
        for (position, &current) in input.iter().enumerate() {
            let previous = input[(position + input.len() - 1) % input.len()];
            if side(current) >= 0.0 {
                if side(previous) < 0.0 {
                    output.push(crossing(previous, current));
                }
                output.push(current);
            } else if side(previous) >= 0.0 {
                output.push(crossing(previous, current));
            }
        }
    }
    output
}

/// Dunavant's 7-point rule on a triangle (degree 5): barycentric points and
/// weights summing to one.
const DUNAVANT_7: [[f64; 4]; 7] = {
    const A1: f64 = 0.059_715_871_789_769_8;
    const B1: f64 = 0.470_142_064_105_115_1;
    const A2: f64 = 0.797_426_985_353_087_3;
    const B2: f64 = 0.101_286_507_323_456_3;
    const W1: f64 = 0.132_394_152_788_506_2;
    const W2: f64 = 0.125_939_180_544_827_1;
    [
        [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0, 0.225],
        [A1, B1, B1, W1],
        [B1, A1, B1, W1],
        [B1, B1, A1, W1],
        [A2, B2, B2, W2],
        [B2, A2, B2, W2],
        [B2, B2, A2, W2],
    ]
};

/// Master faces binned by centroid, for the ring search around a slave face.
struct FaceGrid {
    cell: f64,
    buckets: HashMap<[i64; 3], Vec<usize>>,
}

impl FaceGrid {
    fn key(&self, point: [f64; 3]) -> [i64; 3] {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a cell index of a finite model coordinate fits in i64"
        )]
        point.map(|value| (value / self.cell).floor() as i64)
    }

    /// The faces in the cells at Chebyshev distance exactly `ring`.
    fn ring(&self, point: [f64; 3], ring: i64, visit: &mut impl FnMut(usize)) {
        let [cx, cy, cz] = self.key(point);
        for dx in -ring..=ring {
            for dy in -ring..=ring {
                for dz in -ring..=ring {
                    if dx.abs().max(dy.abs()).max(dz.abs()) < ring {
                        continue;
                    }
                    if let Some(bucket) = self.buckets.get(&[cx + dx, cy + dy, cz + dz]) {
                        for &face in bucket {
                            visit(face);
                        }
                    }
                }
            }
        }
    }
}

/// The master faces with their frames, binned for the ring search around a
/// slave face.
struct MasterSurface<'a> {
    frames: Vec<FaceFrame<'a>>,
    grid: FaceGrid,
    max_radius: f64,
    /// Rings needed to reach every master from anywhere near the surface.
    max_ring: i64,
}

impl<'a> MasterSurface<'a> {
    fn new(master_faces: &'a [MortarFace], slave_faces: &[MortarFace]) -> Result<Self, FemError> {
        let frames = master_faces
            .iter()
            .map(frame_of)
            .collect::<Result<Vec<_>, _>>()?;
        let max_radius = frames
            .iter()
            .map(|master| master.radius)
            .fold(0.0, f64::max);
        let mut grid = FaceGrid {
            cell: (2.0 * max_radius).max(1e-9),
            buckets: HashMap::new(),
        };
        for (index, master) in frames.iter().enumerate() {
            let key = grid.key(master.centroid);
            grid.buckets.entry(key).or_default().push(index);
        }
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for face in master_faces.iter().chain(slave_faces) {
            for point in &face.points {
                for axis in 0..3 {
                    low[axis] = low[axis].min(point[axis]);
                    high[axis] = high[axis].max(point[axis]);
                }
            }
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "the ring count of a finite model fits in i64"
        )]
        let max_ring = if frames.is_empty() {
            -1
        } else {
            (norm(sub(high, low)) / grid.cell).ceil() as i64 + 2
        };
        Ok(Self {
            frames,
            grid,
            max_radius,
            max_ring,
        })
    }

    /// The master faces near enough to overlap `slave` — within the search
    /// reach, or for a full-surface tie (infinite `limit`) within one face
    /// size of the nearest — and the gap beyond which a quadrature point
    /// does not count.
    fn nearby(&self, slave: &FaceFrame<'_>, limit: f64) -> (Vec<usize>, f64) {
        let mut nearby: Vec<usize> = Vec::new();
        let mut nearest = f64::INFINITY;
        let reach = if limit.is_finite() {
            limit + slave.radius + self.max_radius
        } else {
            f64::INFINITY
        };
        for ring in 0..=self.max_ring {
            self.grid.ring(slave.centroid, ring, &mut |index| {
                let master = &self.frames[index];
                if dot(master.normal, slave.normal) > FACING {
                    return;
                }
                let gap = norm(sub(master.centroid, slave.centroid));
                if gap > reach {
                    return;
                }
                nearby.push(index);
                nearest = nearest.min(gap);
            });
            // Every master not yet scanned is at least this far away.
            #[allow(clippy::cast_precision_loss, reason = "a ring count is far below 2^52")]
            let scanned = ring as f64 * self.grid.cell - self.max_radius;
            if scanned > reach || scanned > nearest + 2.0 * (slave.radius + self.max_radius) {
                break;
            }
        }
        let gap_limit = if limit.is_finite() {
            limit
        } else {
            nearest + slave.radius + self.max_radius
        };
        (nearby, gap_limit)
    }
}

/// A slave face counter-clockwise in its own frame, which the clipping
/// relies on, with its dual basis.
struct SlaveFace {
    corners: Vec<Point2>,
    nodes: Vec<usize>,
    points: Vec<[f64; 3]>,
    coefficients: Vec<Vec<f64>>,
}

/// Running sums of the mortar integrals: ∫ ψⱼ Nₖ per slave node j and master
/// node k, and ∫ Nⱼ over the slave faces.
#[derive(Default)]
struct MortarSums {
    coupling: BTreeMap<usize, BTreeMap<usize, f64>>,
    integral_of: BTreeMap<usize, f64>,
}

impl MortarSums {
    /// Add the integrals over the overlap of `slave` with `master`, both in
    /// the slave frame, at quadrature points within `gap_limit` across.
    fn add_overlap(
        &mut self,
        slave: &SlaveFace,
        slave_radius: f64,
        master: &FaceFrame<'_>,
        master_corners: &[Point2],
        gap_limit: f64,
    ) {
        let mut clip = master_corners.to_vec();
        if signed_area(&clip) < 0.0 {
            clip.reverse();
        }
        let overlap = clip_polygon(&slave.corners, &clip);
        if overlap.len() < 3 || signed_area(&overlap).abs() < 1e-14 * slave_radius.powi(2) {
            return;
        }
        for corner in 1..overlap.len() - 1 {
            let [p0, p1, p2] = [overlap[0], overlap[corner], overlap[corner + 1]];
            let area = signed_area(&[p0, p1, p2]).abs();
            for [l0, l1, l2, weight] in DUNAVANT_7 {
                let quadrature = [
                    l0 * p0[0] + l1 * p1[0] + l2 * p2[0],
                    l0 * p0[1] + l1 * p1[1] + l2 * p2[1],
                ];
                let slave_shape = shape_at(&slave.corners, quadrature);
                let master_shape = shape_at(master_corners, quadrature);
                let on_slave = combine(&slave.points, &slave_shape);
                let on_master = combine(&master.face.points, &master_shape);
                if norm(sub(on_master, on_slave)) > gap_limit {
                    continue;
                }
                let measure = weight * area;
                for (coefficients, &slave_node) in slave.coefficients.iter().zip(&slave.nodes) {
                    let psi: f64 = coefficients
                        .iter()
                        .zip(&slave_shape)
                        .map(|(coefficient, shape)| coefficient * shape)
                        .sum();
                    let row = self.coupling.entry(slave_node).or_default();
                    for (&master_node, &shape) in master.face.nodes.iter().zip(&master_shape) {
                        *row.entry(master_node).or_default() += measure * psi * shape;
                    }
                }
            }
        }
    }

    /// The normalised weights of every slave node the master surface covers
    /// enough of.
    fn into_rows(self) -> Result<Vec<MortarRow>, FemError> {
        let mut rows = Vec::with_capacity(self.coupling.len());
        for (slave, row) in self.coupling {
            let total: f64 = row.values().sum();
            let full = self.integral_of.get(&slave).copied().unwrap_or(0.0);
            if !(full > 0.0 && total.is_finite()) {
                return Err(FemError::Tie {
                    reason: format!(
                        "the mortar integrals of node {slave} are not finite — a degenerate face \
                         on the tied surface?"
                    ),
                });
            }
            let coverage = total / full;
            if coverage < MIN_COVERAGE {
                continue;
            }
            let (masters, mut weights): (Vec<usize>, Vec<f64>) = row
                .into_iter()
                .map(|(master, value)| (master, value / total))
                .filter(|&(_, weight)| weight.abs() >= 1e-12)
                .unzip();
            let sum: f64 = weights.iter().sum();
            for weight in &mut weights {
                *weight /= sum;
            }
            rows.push(MortarRow {
                slave,
                masters,
                weights,
                coverage,
            });
        }
        Ok(rows)
    }
}

/// Mortar weights of every slave node on the slave faces, over the master
/// faces within `limit` of them (infinity for the whole surface), sorted by
/// slave node. A node whose multiplier support the master surface covers
/// less than half of gets no row.
///
/// # Errors
/// [`FemError::Tie`] for a negative search distance, or a face that is not a
/// triangle or quadrilateral, has zero area, or whose integrals are not
/// finite.
pub fn mortar_weights(
    slave_faces: &[MortarFace],
    master_faces: &[MortarFace],
    limit: f64,
) -> Result<Vec<MortarRow>, FemError> {
    if limit.is_nan() || limit < 0.0 {
        return Err(FemError::Tie {
            reason: format!("the tie search distance must be non-negative, got {limit}"),
        });
    }
    let surface = MasterSurface::new(master_faces, slave_faces)?;
    let mut sums = MortarSums::default();
    for original in slave_faces {
        let frame = frame_of(original)?;
        let mut corners: Vec<Point2> = original
            .points
            .iter()
            .map(|&point| in_plane(&frame, point))
            .collect();
        let mut nodes = original.nodes.clone();
        let mut points = original.points.clone();
        if signed_area(&corners) < 0.0 {
            corners.reverse();
            nodes.reverse();
            points.reverse();
        }
        let (coefficients, integrals) = dual_basis(&corners)?;
        for (&node, &integral) in nodes.iter().zip(&integrals) {
            *sums.integral_of.entry(node).or_default() += integral;
        }
        let slave = SlaveFace {
            corners,
            nodes,
            points,
            coefficients,
        };
        let (nearby, gap_limit) = surface.nearby(&frame, limit);
        for index in nearby {
            let master = &surface.frames[index];
            let master_corners: Vec<Point2> = master
                .face
                .points
                .iter()
                .map(|&point| in_plane(&frame, point))
                .collect();
            sums.add_overlap(&slave, frame.radius, master, &master_corners, gap_limit);
        }
    }
    sums.into_rows()
}

fn combine(points: &[[f64; 3]], weights: &[f64]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for (point, &weight) in points.iter().zip(weights) {
        for axis in 0..3 {
            out[axis] += weight * point[axis];
        }
    }
    out
}

fn average(points: &[[f64; 3]]) -> [f64; 3] {
    #[allow(clippy::cast_precision_loss, reason = "a face has 3 or 4 points")]
    let share = 1.0 / points.len() as f64;
    combine(points, &vec![share; points.len()])
}

fn sub(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [lhs[0] - rhs[0], lhs[1] - rhs[1], lhs[2] - rhs[2]]
}

fn dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn cross(lhs: [f64; 3], rhs: [f64; 3]) -> [f64; 3] {
    [
        lhs[1] * rhs[2] - lhs[2] * rhs[1],
        lhs[2] * rhs[0] - lhs[0] * rhs[2],
        lhs[0] * rhs[1] - lhs[1] * rhs[0],
    ]
}

fn scale(vector: [f64; 3], factor: f64) -> [f64; 3] {
    vector.map(|component| factor * component)
}

fn norm(vector: [f64; 3]) -> f64 {
    dot(vector, vector).sqrt()
}

fn unit(vector: [f64; 3]) -> [f64; 3] {
    scale(vector, 1.0 / norm(vector))
}
