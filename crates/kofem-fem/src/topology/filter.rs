// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The mesh-independence filter of SIMP: a radius-r_min linear ("cone")
//! weighting over element centroids — Sigmund's filter in the form of
//! Andreassen et al. (2011), "Efficient topology optimization in MATLAB using
//! 88 lines of code", Struct. Multidisc. Optim. 43:1–16 (their H and Hs).
//! Port of the C++ engine's `topology_filter.cpp`.
//!
//! One symmetric weight matrix `H_ei = max(0, r_min − ‖x_e − x_i‖)` backs two
//! modes:
//!
//! * the sensitivity filter (without a stress limit):
//!   `d̃c_e = Σ_i H_ei·ρ_i·dc_i / (Hs_e · max(ρ_e, γ))`, γ = 1e-3;
//! * the density filter (with one): the analysed density is
//!   `ρ̃_e = Σ_i H_ei·ρ_i / Hs_e`, and a sensitivity taken w.r.t. ρ̃ is chained
//!   back with `∂f/∂ρ_j = Σ_i (H_ij / Hs_i)·∂f/∂ρ̃_i`.

use std::collections::HashMap;

use crate::error::FemError;

use super::topology_error;

/// Floor γ on `ρ_e` in the sensitivity-filter denominator (Andreassen et al.).
const RHO_FLOOR: f64 = 1e-3;

/// More grid cells than this means a radius absurdly small for the extent.
const MAX_CELLS: f64 = 1e12;

/// Mean element size: the cube root of the mean element volume.
///
/// # Errors
/// No volumes, or a volume that is not positive.
pub fn mean_element_size(volumes: &[f64]) -> Result<f64, FemError> {
    if volumes.is_empty() {
        return Err(topology_error("the mean element size needs elements"));
    }
    if volumes
        .iter()
        .any(|&volume| !(volume > 0.0 && volume.is_finite()))
    {
        return Err(topology_error("an element volume is not positive"));
    }
    #[allow(
        clippy::cast_precision_loss,
        reason = "an element count, far below 2^52"
    )]
    let mean = volumes.iter().sum::<f64>() / volumes.len() as f64;
    Ok(mean.cbrt())
}

/// The default filter radius: 1.5 mean element sizes (ADR-0002).
///
/// # Errors
/// As [`mean_element_size`].
pub fn default_filter_radius(volumes: &[f64]) -> Result<f64, FemError> {
    Ok(1.5 * mean_element_size(volumes)?)
}

/// One non-zero of H.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Neighbour {
    pub index: usize,
    pub weight: f64,
}

/// The cone weights of every element, precomputed once per run.
#[derive(Debug, Clone)]
pub struct DensityFilter {
    /// H in sparse rows, each sorted by element index.
    neighbours: Vec<Vec<Neighbour>>,
    /// `Hs_e = Σ_i H_ei` (> 0: an element is its own neighbour, `H_ee = r_min`).
    row_sums: Vec<f64>,
}

impl DensityFilter {
    /// Weights for every centroid within `radius` of every other.
    ///
    /// # Errors
    /// A radius that is not positive (or too small for the extent of the
    /// points to grid), or no points.
    pub fn new(centroids: &[[f64; 3]], radius: f64) -> Result<Self, FemError> {
        if !(radius > 0.0 && radius.is_finite()) {
            return Err(topology_error(format!(
                "the filter radius must be positive and finite, got {radius}"
            )));
        }
        if centroids.is_empty() {
            return Err(topology_error("the filter needs element centroids"));
        }
        // Uniform grid with cells of the radius: every neighbour of a point
        // lies in the 3×3×3 cells around its own.
        let mut lower = centroids[0];
        let mut upper = centroids[0];
        for point in centroids {
            for axis in 0..3 {
                lower[axis] = lower[axis].min(point[axis]);
                upper[axis] = upper[axis].max(point[axis]);
            }
        }
        let cells: f64 = (0..3)
            .map(|axis| ((upper[axis] - lower[axis]) / radius).floor() + 1.0)
            .product();
        if cells.is_nan() || cells > MAX_CELLS {
            return Err(topology_error(format!(
                "the filter radius {radius} is too small for the model's extent: it would \
                 need {cells:e} search cells"
            )));
        }
        #[allow(
            clippy::cast_possible_truncation,
            reason = "the cell count is capped at MAX_CELLS, so each index fits in i64"
        )]
        let cell_of = |point: &[f64; 3]| -> [i64; 3] {
            std::array::from_fn(|axis| ((point[axis] - lower[axis]) / radius).floor() as i64)
        };
        let mut grid: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
        for (index, point) in centroids.iter().enumerate() {
            grid.entry(cell_of(point)).or_default().push(index);
        }

        let mut neighbours = Vec::with_capacity(centroids.len());
        let mut row_sums = Vec::with_capacity(centroids.len());
        let mut candidates = Vec::new();
        for point in centroids {
            let home = cell_of(point);
            candidates.clear();
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if let Some(list) = grid.get(&[home[0] + dx, home[1] + dy, home[2] + dz]) {
                            candidates.extend_from_slice(list);
                        }
                    }
                }
            }
            candidates.sort_unstable();
            let mut row = Vec::new();
            let mut sum = 0.0;
            for &index in &candidates {
                let other = centroids[index];
                let distance = (0..3)
                    .map(|axis| (point[axis] - other[axis]).powi(2))
                    .sum::<f64>()
                    .sqrt();
                let weight = radius - distance;
                if weight > 0.0 {
                    row.push(Neighbour { index, weight });
                    sum += weight;
                }
            }
            neighbours.push(row);
            row_sums.push(sum);
        }
        Ok(Self {
            neighbours,
            row_sums,
        })
    }

    #[must_use]
    pub fn element_count(&self) -> usize {
        self.row_sums.len()
    }

    /// `Hs_e = Σ_i H_ei`.
    #[must_use]
    pub fn row_sum(&self, element: usize) -> f64 {
        self.row_sums[element]
    }

    /// Row e of H, sorted by element index.
    #[must_use]
    pub fn neighbours(&self, element: usize) -> &[Neighbour] {
        &self.neighbours[element]
    }

    fn check_length(&self, what: &str, len: usize) -> Result<(), FemError> {
        if len == self.element_count() {
            Ok(())
        } else {
            Err(topology_error(format!(
                "the filter got {len} {what} for {} elements",
                self.element_count()
            )))
        }
    }

    /// Sensitivity filter: replace `sensitivity` (dc/dρ) by its filtered form
    /// at the densities `rho`.
    ///
    /// # Errors
    /// Either array does not have one entry per element.
    pub fn filter_sensitivity(&self, rho: &[f64], sensitivity: &mut [f64]) -> Result<(), FemError> {
        self.check_length("densities", rho.len())?;
        self.check_length("sensitivities", sensitivity.len())?;
        let filtered: Vec<f64> = self
            .neighbours
            .iter()
            .enumerate()
            .map(|(element, row)| {
                let numerator: f64 = row
                    .iter()
                    .map(|neighbour| {
                        neighbour.weight * rho[neighbour.index] * sensitivity[neighbour.index]
                    })
                    .sum();
                numerator / (self.row_sums[element] * rho[element].max(RHO_FLOOR))
            })
            .collect();
        sensitivity.copy_from_slice(&filtered);
        Ok(())
    }

    /// Density filter: the physical densities ρ̃ = H·ρ / Hs.
    ///
    /// # Errors
    /// `rho` does not have one entry per element.
    pub fn filter_density(&self, rho: &[f64]) -> Result<Vec<f64>, FemError> {
        self.check_length("densities", rho.len())?;
        Ok(self
            .neighbours
            .iter()
            .zip(&self.row_sums)
            .map(|(row, sum)| {
                row.iter()
                    .map(|neighbour| neighbour.weight * rho[neighbour.index])
                    .sum::<f64>()
                    / sum
            })
            .collect())
    }

    /// Chain rule of the density filter: turn a sensitivity w.r.t. ρ̃ into one
    /// w.r.t. the design variable ρ, in place.
    ///
    /// # Errors
    /// `sensitivity` does not have one entry per element.
    pub fn chain_density_sensitivity(&self, sensitivity: &mut [f64]) -> Result<(), FemError> {
        self.check_length("sensitivities", sensitivity.len())?;
        let mut chained = vec![0.0; sensitivity.len()];
        for ((row, sum), &value) in self
            .neighbours
            .iter()
            .zip(&self.row_sums)
            .zip(&*sensitivity)
        {
            let scaled = value / sum;
            for neighbour in row {
                chained[neighbour.index] += neighbour.weight * scaled;
            }
        }
        sensitivity.copy_from_slice(&chained);
        Ok(())
    }
}
