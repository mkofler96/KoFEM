// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Membrane triangle with corner drilling rotations: Felippa's optimal ANDES
//! triangle "OPT", an Allman-type element whose drilling DOF θz at each
//! corner is the in-plane rotation ½(∂v/∂x − ∂u/∂y) of the displacement
//! field. On a curved shell of flat facets that rotation is shared with the
//! neighbours' bending rotations, so it must carry real stiffness, not a
//! fictitious spring, or the facets lock as the mesh is refined (KOF-453).
//!
//! The stiffness is `K = K_b + K_h`. The basic part `K_b = L·D·Lᵀ/(A·t)`
//! gives the constant strain the patch test needs; the higher-order part
//! `K_h` stiffens the deviatoric corner rotations θ̃ = θ − θ₀ (θ₀ the rotation
//! of the constant-strain field) through linear natural strains that average
//! to zero, so it leaves the patch test intact. OPT's free parameters
//! (`α_b` = 3/2, β₀ = (1 − 4ν²)/2 and β₁…β₉) make the in-plane bending energy
//! of rectangular mesh units exact at any aspect ratio.
//!
//! Reference: C. A. Felippa, "A study of optimal membrane triangles with
//! drilling freedoms", Comput. Methods Appl. Mech. Engrg. 192 (2003)
//! 2125–2168: the matrices of its Fig. 10 (`LST39RMembTemplateStiffness`),
//! the OPT parameters of eq. (42) and the strain recovery of eq. (49).

use crate::shell::element::FacetFrame;

/// Membrane DOFs in local order: (u, v, θz) per corner.
pub(crate) const MEMBRANE_DOFS: usize = 9;

/// Weight of the corner rotations in the basic strain lumping.
const ALPHA_B: f64 = 1.5;
/// The smallest β₀ OPT allows: (1 − 4ν²)/2 vanishes at ν = 1/2.
const BETA0_FLOOR: f64 = 0.01;
/// β₁…β₉ of OPT.
const BETA: [f64; 9] = [1.0, 2.0, 1.0, 0.0, 1.0, -1.0, -1.0, -1.0, -2.0];
/// Felippa's mid-side quadrature weight of the higher-order stiffness.
const HIGHER_ORDER_WEIGHT: f64 = 0.75;
/// The higher-order strain's scale in stress recovery: eq. (49) with the
/// least-squares value Felippa recommends for isotropic material.
const RECOVERY_BETA0: f64 = 1.5;

/// The OPT matrices of one facet, in the facet's own frame (corner order 1,
/// 2, 3 = the facet's corners 0, 1, 2).
pub(crate) struct OptMembrane {
    area: f64,
    /// L/t: the basic strain lumping matrix per unit thickness, 9×3.
    lumping: [[f64; 3]; MEMBRANE_DOFS],
    /// `T_θu`: θ̃ = `T_θu`·u, 3×9.
    deviatoric_rotation: [[f64; MEMBRANE_DOFS]; 3],
    /// Q₁, Q₂, Q₃: the natural strains at the corners from θ̃.
    corner_natural: [[[f64; 3]; 3]; 3],
    /// `T_e`: Cartesian strains from natural (side) strains.
    natural_to_cartesian: [[f64; 3]; 3],
}

impl OptMembrane {
    pub(crate) fn new(frame: &FacetFrame) -> Self {
        let (xs, ys) = (frame.local_x, frame.local_y);
        let area = frame.area;
        // xij = xi − xj with the corners numbered 1..3 as in the paper.
        let (x12, x23, x31) = (xs[0] - xs[1], xs[1] - xs[2], xs[2] - xs[0]);
        let (y12, y23, y31) = (ys[0] - ys[1], ys[1] - ys[2], ys[2] - ys[0]);
        let (x21, x32, x13) = (-x12, -x23, -x31);
        let (y21, y32, y13) = (-y12, -y23, -y31);

        let corner_part =
            |dy_a: f64, dy_b: f64, dy_c: f64, dx_a: f64, dx_b: f64, dx_c: f64, shear: f64| {
                [
                    ALPHA_B / 12.0 * dy_a * (dy_b - dy_c),
                    ALPHA_B / 12.0 * dx_a * (dx_b - dx_c),
                    ALPHA_B / 6.0 * shear,
                ]
            };
        let lumping = [
            [0.5 * y23, 0.0, 0.5 * x32],
            [0.0, 0.5 * x32, 0.5 * y23],
            corner_part(y23, y13, y21, x32, x31, x12, x31 * y13 - x12 * y21),
            [0.5 * y31, 0.0, 0.5 * x13],
            [0.0, 0.5 * x13, 0.5 * y31],
            corner_part(y31, y21, y32, x13, x12, x23, x12 * y21 - x23 * y32),
            [0.5 * y12, 0.0, 0.5 * x21],
            [0.0, 0.5 * x21, 0.5 * y12],
            corner_part(y12, y32, y13, x21, x23, x31, x23 * y32 - x31 * y13),
        ];

        // θ̃ᵢ = θᵢ − θ₀ with θ₀ = ½(∂v/∂x − ∂u/∂y) of the linear field.
        let four_area = 4.0 * area;
        let translations = [x32, y32, x13, y13, x21, y21];
        let deviatoric_rotation = std::array::from_fn(|corner| {
            std::array::from_fn(|dof| {
                let (node, component) = (dof / 3, dof % 3);
                if component < 2 {
                    translations[2 * node + component] / four_area
                } else if node == corner {
                    1.0
                } else {
                    0.0
                }
            })
        });

        let side = [
            x21 * x21 + y21 * y21,
            x32 * x32 + y32 * y32,
            x13 * x13 + y13 * y13,
        ];
        let scale = 2.0 * area / 3.0;
        let natural = |order: [usize; 9]| -> [[f64; 3]; 3] {
            std::array::from_fn(|row| {
                std::array::from_fn(|col| scale * BETA[order[3 * row + col]] / side[row])
            })
        };
        // Q₁ has the rows (β₁ β₂ β₃), (β₄ β₅ β₆), (β₇ β₈ β₉); Q₂ and Q₃
        // carry the same β's cyclically to the other corners.
        let corner_natural = [
            natural([0, 1, 2, 3, 4, 5, 6, 7, 8]),
            natural([8, 6, 7, 2, 0, 1, 5, 3, 4]),
            natural([4, 5, 3, 7, 8, 6, 1, 2, 0]),
        ];

        let inverse = 1.0 / (four_area * area);
        let [l21, l32, l13] = side;
        let natural_to_cartesian = [
            [y23 * y13 * l21, y31 * y21 * l32, y12 * y32 * l13],
            [x23 * x13 * l21, x31 * x21 * l32, x12 * x32 * l13],
            [
                (y23 * x31 + x32 * y13) * l21,
                (y31 * x12 + x13 * y21) * l32,
                (y12 * x23 + x21 * y32) * l13,
            ],
        ]
        .map(|row| row.map(|entry| entry * inverse));

        Self {
            area,
            lumping,
            deviatoric_rotation,
            corner_natural,
            natural_to_cartesian,
        }
    }

    /// The 9×9 membrane stiffness for thickness `thickness`, plane-stress law
    /// `law` = E/(1−ν²)·[[1, ν, 0], [ν, 1, 0], [0, 0, (1−ν)/2]] and Poisson's
    /// ratio `poisson`.
    pub(crate) fn stiffness(
        &self,
        thickness: f64,
        law: &[[f64; 3]; 3],
        poisson: f64,
    ) -> [[f64; MEMBRANE_DOFS]; MEMBRANE_DOFS] {
        // K_b = L·D·Lᵀ/(A·t) with L = t·lumping.
        let basic_weight = thickness / self.area;
        let mut matrix: [[f64; MEMBRANE_DOFS]; MEMBRANE_DOFS] = std::array::from_fn(|row| {
            let left = mul_row(&self.lumping[row], law);
            std::array::from_fn(|col| basic_weight * dot3(&left, &self.lumping[col]))
        });

        // K_h = T_θuᵀ·K_θ·T_θu, K_θ = (3/4)·β₀·t·A·Σ Qₘᵀ·T_eᵀ·D·T_e·Qₘ over
        // the mid-sides (Q₄ = (Q₁ + Q₂)/2, Q₅ = (Q₂ + Q₃)/2, Q₆ = (Q₃ + Q₁)/2).
        let beta0 = (0.5 * (1.0 - 4.0 * poisson * poisson)).max(BETA0_FLOOR);
        let natural_law = congruence(&self.natural_to_cartesian, law);
        let [first, second, third] = &self.corner_natural;
        let mut rotation_stiffness = [[0.0; 3]; 3];
        for (start, end) in [(first, second), (second, third), (third, first)] {
            let midside: [[f64; 3]; 3] = std::array::from_fn(|row| {
                std::array::from_fn(|col| f64::midpoint(start[row][col], end[row][col]))
            });
            let part = congruence(&midside, &natural_law);
            for (total, add) in rotation_stiffness.iter_mut().zip(&part) {
                for (entry, value) in total.iter_mut().zip(add) {
                    *entry += value;
                }
            }
        }
        let weight = HIGHER_ORDER_WEIGHT * beta0 * thickness * self.area;
        let higher = congruence_wide(&self.deviatoric_rotation, &rotation_stiffness);
        for (row, entries) in matrix.iter_mut().enumerate() {
            for (col, entry) in entries.iter_mut().enumerate() {
                *entry += weight * higher[row][col];
            }
        }
        matrix
    }

    /// The membrane strain [εx, εy, γxy] at barycentric point `weights`
    /// (ζ₁, ζ₂, ζ₃), eq. (49): the basic constant strain plus the
    /// higher-order strain `T_e`·(ζ₁Q₁ + ζ₂Q₂ + ζ₃Q₃)·θ̃, which averages to zero
    /// over the facet, scaled by the recovery β₀.
    pub(crate) fn strain(&self, dofs: &[f64; MEMBRANE_DOFS], weights: [f64; 3]) -> [f64; 3] {
        let deviatoric = self.deviatoric_rotation.map(|row| {
            row.iter()
                .zip(dofs)
                .map(|(entry, value)| entry * value)
                .sum::<f64>()
        });
        let natural: [f64; 3] = std::array::from_fn(|row| {
            weights
                .iter()
                .zip(&self.corner_natural)
                .map(|(weight, corner)| weight * dot3(&corner[row], &deviatoric))
                .sum()
        });
        std::array::from_fn(|component| {
            let basic = self
                .lumping
                .iter()
                .zip(dofs)
                .map(|(row, value)| row[component] * value)
                .sum::<f64>()
                / self.area;
            basic + RECOVERY_BETA0 * dot3(&self.natural_to_cartesian[component], &natural)
        })
    }
}

fn dot3(lhs: &[f64; 3], rhs: &[f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

/// rowᵀ·M for a 3-vector and a 3×3 matrix.
fn mul_row(row: &[f64; 3], matrix: &[[f64; 3]; 3]) -> [f64; 3] {
    std::array::from_fn(|col| (0..3).map(|k| row[k] * matrix[k][col]).sum())
}

/// Aᵀ·M·A for 3×3 matrices.
fn congruence(outer: &[[f64; 3]; 3], inner: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|row| {
        std::array::from_fn(|col| {
            (0..3)
                .map(|i| outer[i][row] * dot3(&inner[i], &outer.map(|line| line[col])))
                .sum()
        })
    })
}

/// Tᵀ·M·T for a 3×9 T and a 3×3 M.
fn congruence_wide(
    outer: &[[f64; MEMBRANE_DOFS]; 3],
    inner: &[[f64; 3]; 3],
) -> [[f64; MEMBRANE_DOFS]; MEMBRANE_DOFS] {
    std::array::from_fn(|row| {
        std::array::from_fn(|col| {
            let column = outer.map(|line| line[col]);
            (0..3)
                .map(|i| outer[i][row] * dot3(&inner[i], &column))
                .sum()
        })
    })
}
