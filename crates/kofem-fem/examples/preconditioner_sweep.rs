// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Compare the Gauss–Seidel and multigrid preconditioners on meshes dumped
//! from the engine (raw little-endian `<name>.verts` as f64 x,y,z and
//! `<name>.tets` as u32 quadruples).
//!
//! The load case follows the KOF-300 sweep: clamp the nodes in the first 2 %
//! of the longest axis, and pull the last 2 % along the shortest axis.
//!
//! Dump meshes with `examples/dump_mesh.mjs`, then run
//! `cargo run --release -p kofem-fem --example preconditioner_sweep -- <prefix>...`
//! (`AMG_THETA` overrides the strength threshold, `SWEEP_MEMORY=1` prints peak RSS).

#![allow(
    clippy::expect_used,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::print_stdout,
    clippy::too_many_lines,
    reason = "a linear benchmark script: a bad input file should abort, and it reports on stdout"
)]

use std::time::Instant;

use kofem_fem::{
    apply_dirichlet, assemble_stiffness, solve_static, AmgSettings, CgSettings, Dirichlet,
    Isotropic, PreconditionerChoice, SmoothedAggregation, TetMesh,
};

/// Peak resident memory in MB (Linux), for a rough comparison of the two runs.
fn peak_megabytes() -> String {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<f64>().ok())
        })
        .map_or_else(|| "n/a".to_owned(), |kb| format!("{:.0}", kb / 1024.0))
}

fn read_f64(path: &str) -> Vec<f64> {
    std::fs::read(path)
        .expect("readable vertex file")
        .chunks_exact(8)
        .map(|bytes| f64::from_le_bytes(bytes.try_into().expect("8 bytes")))
        .collect()
}

fn read_u32(path: &str) -> Vec<u32> {
    std::fs::read(path)
        .expect("readable tet file")
        .chunks_exact(4)
        .map(|bytes| u32::from_le_bytes(bytes.try_into().expect("4 bytes")))
        .collect()
}

fn main() {
    let settings = CgSettings {
        relative_tolerance: 1e-6,
        max_iterations: 50_000,
    };
    let threshold: f64 = std::env::var("AMG_THETA")
        .ok()
        .map_or(AmgSettings::default().strength_threshold, |text| {
            text.parse().expect("AMG_THETA is a number")
        });
    for prefix in std::env::args().skip(1) {
        let vertices = read_f64(&format!("{prefix}.verts"));
        let tets = read_u32(&format!("{prefix}.tets"));
        let material = Isotropic::new(0, 210_000.0, 0.3).expect("steel");
        let mesh = TetMesh::new(&vertices, &tets, &vec![0; tets.len() / 4], vec![material])
            .expect("valid mesh");
        let points = mesh.vertices();
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for point in points {
            for axis in 0..3 {
                low[axis] = low[axis].min(point[axis]);
                high[axis] = high[axis].max(point[axis]);
            }
        }
        let extent = [0, 1, 2].map(|axis| high[axis] - low[axis]);
        let longest = (0..3)
            .max_by(|&lhs, &rhs| extent[lhs].total_cmp(&extent[rhs]))
            .expect("three axes");
        let shortest = (0..3)
            .min_by(|&lhs, &rhs| extent[lhs].total_cmp(&extent[rhs]))
            .expect("three axes");
        let band = 0.02 * extent[longest];
        let mut fixed = Vec::new();
        let mut loaded = Vec::new();
        for (node, point) in points.iter().enumerate() {
            if !mesh.is_used(node) {
                continue;
            }
            if point[longest] <= low[longest] + band {
                fixed.extend((0..3).map(|component| (3 * node + component) as u32));
            } else if point[longest] >= high[longest] - band {
                loaded.push(node);
            }
        }
        let mut forces = vec![0.0; 3 * mesh.vertex_count()];
        for &node in &loaded {
            forces[3 * node + shortest] = -1000.0 / loaded.len() as f64;
        }
        let values = vec![0.0; fixed.len()];

        let start = Instant::now();
        let stiffness = assemble_stiffness(&mesh);
        let assembly = start.elapsed().as_secs_f64();
        println!(
            "\n{prefix}: {} nodes, {} tets, {} DOFs, {} nnz, assembly {assembly:.2} s",
            mesh.vertex_count(),
            tets.len() / 4,
            stiffness.rows(),
            stiffness.nnz()
        );

        // Hierarchy alone, to separate setup from iteration time.
        let constraints =
            Dirichlet::new(stiffness.rows(), &fixed, &values).expect("valid constraints");
        let mut eliminated = stiffness.clone();
        let mut rhs = forces.clone();
        apply_dirichlet(&mut eliminated, &mut rhs, &constraints);
        let constrained: Vec<bool> = (0..stiffness.rows())
            .map(|dof| constraints.value(dof).is_some())
            .collect();
        let start = Instant::now();
        let amg = SmoothedAggregation::new(
            &eliminated,
            mesh.vertices(),
            &constrained,
            AmgSettings {
                strength_threshold: threshold,
                ..AmgSettings::default()
            },
        )
        .expect("hierarchy builds");
        println!(
            "  AMG setup {:.2} s, operator complexity {:.2}",
            start.elapsed().as_secs_f64(),
            amg.operator_complexity()
        );
        drop(amg);
        drop(eliminated);

        let mut reference: Option<Vec<f64>> = None;
        let choices = [
            ("Gauss–Seidel", PreconditionerChoice::SymmetricGaussSeidel),
            (
                "SA-AMG",
                PreconditionerChoice::SmoothedAggregation(AmgSettings {
                    strength_threshold: threshold,
                    ..AmgSettings::default()
                }),
            ),
        ];
        for (name, choice) in choices {
            let start = Instant::now();
            let solution = solve_static(
                &mesh, &stiffness, &fixed, &values, &forces, settings, choice,
            )
            .expect("solves");
            let seconds = start.elapsed().as_secs_f64();
            // True residual of the unconstrained rows: ‖f − K·u‖ / ‖f‖ there.
            let mut product = vec![0.0; forces.len()];
            stiffness.mul_vec(&solution.displacements, &mut product);
            let mut is_fixed = vec![false; forces.len()];
            for &dof in &fixed {
                is_fixed[dof as usize] = true;
            }
            let (mut residual, mut load) = (0.0, 0.0);
            for dof in 0..forces.len() {
                if !is_fixed[dof] && mesh.is_used(dof / 3) {
                    residual += (forces[dof] - product[dof]).powi(2);
                    load += forces[dof].powi(2);
                }
            }
            let peak = solution
                .displacements
                .iter()
                .fold(0.0f64, |acc, value| acc.max(value.abs()));
            let difference = reference.as_ref().map_or(0.0, |base| {
                base.iter()
                    .zip(&solution.displacements)
                    .fold(0.0f64, |acc, (lhs, rhs)| acc.max((lhs - rhs).abs()))
                    / peak
            });
            let levels: Vec<String> = solution
                .levels
                .iter()
                .map(|level| level.unknowns.to_string())
                .collect();
            println!(
                "  {name:<13} {:>6} it  {seconds:>7.2} s  true residual {:.1e}  max|u| {peak:.4e}  \
                 vs GS {difference:.1e}  levels [{}]",
                solution.iterations,
                (residual / load).sqrt(),
                levels.join(", ")
            );
            if std::env::var("SWEEP_MEMORY").is_ok() {
                println!("  peak RSS so far {} MB", peak_megabytes());
            }
            if reference.is_none() {
                reference = Some(solution.displacements);
            }
        }
    }
}
