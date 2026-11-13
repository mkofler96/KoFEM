// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The mixed solid + shell solve (solid tets and Kirchhoff shell facets in one
//! system, joined by couplings) against the cases and tolerances of the C++
//! engine's `engine/tests/shell_validation.cpp` (`solve_solid_shell_core`):
//! moment transfer through distributing and relaxed-MPC couplings, the
//! shell-footprint transition under rigid and affine motion, prescribed
//! drives through a coupling, the seam-order independence of KOF-212, per-tet
//! solid materials, and the conditions both solvers refuse.

#![allow(
    clippy::expect_used,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "test fixtures: small structured meshes whose indices fit any integer type, \
              and a fixture that fails to build should abort the test"
)]

#[allow(
    dead_code,
    reason = "this suite takes only the Kuhn split from the shared fixtures"
)]
mod support;

use kofem_fem::{
    assemble_shell_stiffness, assemble_stiffness, shell_von_mises, solve_mixed_static, von_mises,
    AmgSettings, CgSettings, CoupledSolution, Coupling, CouplingKind, CsrMatrix, ElementOrder,
    FemError, Isotropic, MixedPreconditioner, PreconditionerChoice, ShellMesh, ShellPart,
    StoppingRule, TetMesh, DOFS_PER_NODE,
};
use support::KUHN;

const SETTINGS: CgSettings = CgSettings {
    relative_tolerance: 1e-10,
    max_iterations: 100_000,
    stopping: StoppingRule::ResidualNorm,
};

/// The three preconditioners the mixed solve offers; every case runs under
/// each, so they must agree with each other as well as with the reference.
fn preconditioners() -> [MixedPreconditioner; 3] {
    [
        MixedPreconditioner::IncompleteCholesky,
        MixedPreconditioner::Choice(PreconditionerChoice::SymmetricGaussSeidel),
        MixedPreconditioner::Choice(PreconditionerChoice::SmoothedAggregation(AmgSettings {
            strength_threshold: 0.0,
            coarse_size: 60,
            max_levels: 10,
        })),
    ]
}

fn material(young: f64, poisson: f64, index: usize) -> Isotropic {
    Isotropic::new(index, young, poisson).expect("valid material")
}

/// A mixed model under construction over one node pool: tets, shell facets,
/// couplings, supports and loads, with DOFs numbered 6·node + component.
#[derive(Clone, Default)]
struct Mixed {
    points: Vec<[f64; 3]>,
    tets: Vec<u32>,
    material_of_tet: Vec<u32>,
    solid_materials: Vec<Isotropic>,
    triangles: Vec<u32>,
    thickness: Vec<f64>,
    material_of_triangle: Vec<u32>,
    shell_materials: Vec<Isotropic>,
    couplings: Vec<Coupling>,
    fixed: Vec<u32>,
    values: Vec<f64>,
    loads: Vec<(usize, f64)>,
}

#[derive(Debug)]
struct Solved {
    solid: TetMesh,
    shell: Option<ShellMesh>,
    solution: CoupledSolution,
}

/// Node numbering of a structured block: `(i, j, k)` → pool index.
struct Grid {
    first: usize,
    counts: [usize; 3],
}

impl Grid {
    fn at(&self, i: usize, j: usize, k: usize) -> usize {
        self.first + (i * self.counts[1] + j) * self.counts[2] + k
    }
}

impl Mixed {
    fn add_point(&mut self, point: [f64; 3]) -> usize {
        self.points.push(point);
        self.points.len() - 1
    }

    /// A block of Kuhn tets over the given node coordinates along x, y, z;
    /// each tet's material from `material_of(i)`, i its cell along x.
    fn add_block(&mut self, axes: [&[f64]; 3], material_of: impl Fn(usize) -> u32) -> Grid {
        let grid = Grid {
            first: self.points.len(),
            counts: axes.map(<[f64]>::len),
        };
        for &along_x in axes[0] {
            for &along_y in axes[1] {
                for &along_z in axes[2] {
                    self.add_point([along_x, along_y, along_z]);
                }
            }
        }
        let [nx, ny, nz] = grid.counts.map(|count| count - 1);
        for i in 0..nx {
            for j in 0..ny {
                for k in 0..nz {
                    let corner = |bits: usize| {
                        grid.at(i + (bits & 1), j + ((bits >> 1) & 1), k + (bits >> 2))
                    };
                    for tet in KUHN {
                        self.tets.extend(tet.map(|bits| corner(bits) as u32));
                        self.material_of_tet.push(material_of(i));
                    }
                }
            }
        }
        grid
    }

    /// A planar shell grid of two facets per cell: node (i, j) at
    /// `origin + i·steps[0] + j·steps[1]`. Returns node (i, j) → pool index.
    fn add_shell_grid(
        &mut self,
        origin: [f64; 3],
        steps: [[f64; 3]; 2],
        cells: [usize; 2],
        thickness: f64,
    ) -> impl Fn(usize, usize) -> usize + use<> {
        let first = self.points.len();
        let rows = cells[1] + 1;
        for i in 0..=cells[0] {
            for j in 0..=cells[1] {
                self.add_point(std::array::from_fn(|axis| {
                    origin[axis] + i as f64 * steps[0][axis] + j as f64 * steps[1][axis]
                }));
            }
        }
        let node = move |i: usize, j: usize| first + i * rows + j;
        for i in 0..cells[0] {
            for j in 0..cells[1] {
                let corners = [
                    node(i, j),
                    node(i + 1, j),
                    node(i + 1, j + 1),
                    node(i, j + 1),
                ];
                for facet in [[0, 1, 2], [0, 2, 3]] {
                    self.triangles
                        .extend(facet.map(|corner| corners[corner] as u32));
                    self.thickness.push(thickness);
                    self.material_of_triangle.push(0);
                }
            }
        }
        node
    }

    fn prescribe(&mut self, node: usize, component: usize, value: f64) {
        self.fixed.push((DOFS_PER_NODE * node + component) as u32);
        self.values.push(value);
    }

    fn fix(&mut self, node: usize, components: &[usize]) {
        for &component in components {
            self.prescribe(node, component, 0.0);
        }
    }

    fn load(&mut self, node: usize, component: usize, value: f64) {
        self.loads.push((DOFS_PER_NODE * node + component, value));
    }

    fn meshes(&self) -> Result<(TetMesh, Option<ShellMesh>), FemError> {
        let flat: Vec<f64> = self.points.iter().flatten().copied().collect();
        let solid = TetMesh::new(
            &flat,
            &self.tets,
            &self.material_of_tet,
            self.solid_materials.clone(),
        )?;
        let shell = if self.triangles.is_empty() {
            None
        } else {
            Some(ShellMesh::new(
                &flat,
                &self.triangles,
                &self.thickness,
                &self.material_of_triangle,
                self.shell_materials.clone(),
            )?)
        };
        Ok((solid, shell))
    }

    fn solve(&self, preconditioner: MixedPreconditioner) -> Result<Solved, FemError> {
        let (solid, shell) = self.meshes()?;
        let solid_stiffness = assemble_stiffness(&solid);
        let shell_stiffness: Option<CsrMatrix> = shell.as_ref().map(assemble_shell_stiffness);
        let mut forces = vec![0.0; DOFS_PER_NODE * self.points.len()];
        for &(dof, value) in &self.loads {
            forces[dof] += value;
        }
        let shell_part = shell
            .as_ref()
            .zip(shell_stiffness.as_ref())
            .map(|(mesh, stiffness)| ShellPart { mesh, stiffness });
        let solution = solve_mixed_static(
            &solid,
            &solid_stiffness,
            shell_part,
            &self.couplings,
            &self.fixed,
            &self.values,
            &forces,
            SETTINGS,
            preconditioner,
        )?;
        Ok(Solved {
            solid,
            shell,
            solution,
        })
    }

    fn refuse(&self, preconditioner: MixedPreconditioner) -> FemError {
        self.solve(preconditioner)
            .expect_err("the model should be refused")
    }
}

/// The C++ `coupled_moment_transfer` cantilever: a shell strip L × b in the
/// z = 0 plane whose root nodes are each coupled to three fixed anchor nodes.
/// The anchors are corners of one tet with a clamped apex (the C++ test
/// gives them no element at all; here they carry the solid domain).
const STRIP_L: f64 = 2.0;
const STRIP_B: f64 = 0.3;
const STRIP_T: f64 = 0.01;
const STRIP_E: f64 = 2.1e11;
const STRIP_NU: f64 = 0.3;
const STRIP_P: f64 = 100.0;

struct Strip {
    model: Mixed,
    root: Vec<usize>,
    tip: Vec<usize>,
    anchors: [usize; 3],
    apex: usize,
}

fn strip_on_anchors(cells: [usize; 2]) -> Strip {
    let mut model = Mixed::default();
    let node = model.add_shell_grid(
        [0.0; 3],
        [
            [STRIP_L / cells[0] as f64, 0.0, 0.0],
            [0.0, STRIP_B / cells[1] as f64, 0.0],
        ],
        cells,
        STRIP_T,
    );
    model.shell_materials = vec![material(STRIP_E, STRIP_NU, 0)];
    let anchors = [
        model.add_point([-0.1, 0.0, 0.0]),
        model.add_point([-0.1, STRIP_B, 0.0]),
        model.add_point([-0.1, STRIP_B / 2.0, 0.1]),
    ];
    let apex = model.add_point([-0.3, STRIP_B / 2.0, 0.03]);
    model
        .tets
        .extend([anchors[0], anchors[1], anchors[2], apex].map(|index| index as u32));
    model.material_of_tet = vec![0];
    model.solid_materials = vec![material(STRIP_E, STRIP_NU, 0)];
    model.fix(apex, &[0, 1, 2]);
    Strip {
        root: (0..=cells[1]).map(|j| node(0, j)).collect(),
        tip: (0..=cells[1]).map(|j| node(cells[0], j)).collect(),
        model,
        anchors,
        apex,
    }
}

impl Strip {
    fn couple_root(&mut self, kind: CouplingKind) {
        for &reference in &self.root {
            self.model.couplings.push(Coupling {
                reference,
                nodes: self.anchors.to_vec(),
                weights: Vec::new(),
                kind,
            });
        }
    }
}

fn tip_deflection(solved: &Solved, tip: &[usize]) -> f64 {
    tip.iter()
        .map(|&node| solved.solution.dofs[DOFS_PER_NODE * node + 2])
        .sum::<f64>()
        / tip.len() as f64
}

fn clamped_cantilever_reference() -> f64 {
    let inertia = STRIP_B * STRIP_T.powi(3) / 12.0;
    STRIP_P * STRIP_L.powi(3) / (3.0 * STRIP_E * inertia)
}

/// The strip with its root coupled to the clamped anchors and the tip load.
fn root_coupled_cantilever(kind: CouplingKind) -> Strip {
    let mut strip = strip_on_anchors([20, 4]);
    strip.couple_root(kind);
    for anchor in strip.anchors {
        strip.model.fix(anchor, &[0, 1, 2]);
    }
    for &node in &strip.tip {
        strip.model.load(node, 2, STRIP_P / strip.tip.len() as f64);
    }
    strip
}

#[test]
fn distributing_coupling_transfers_the_root_moment() {
    // A hinge would be off by an order of magnitude; the C++ test allows 6 %.
    let strip = root_coupled_cantilever(CouplingKind::Distributing);
    for preconditioner in preconditioners() {
        let solved = strip
            .model
            .solve(preconditioner)
            .expect("the cantilever solves");
        let ratio = tip_deflection(&solved, &strip.tip) / clamped_cantilever_reference();
        assert!(
            (ratio - 1.0).abs() < 0.06,
            "{preconditioner:?}: w/w_ref = {ratio}"
        );
    }
}

#[test]
fn relaxed_mpc_clamps_the_root_for_both_relaxations() {
    for relaxation in [1.0, 0.5] {
        let strip = root_coupled_cantilever(CouplingKind::RelaxedMpc { relaxation });
        for preconditioner in preconditioners() {
            let solved = strip
                .model
                .solve(preconditioner)
                .expect("the cantilever solves");
            let ratio = tip_deflection(&solved, &strip.tip) / clamped_cantilever_reference();
            assert!(
                (ratio - 1.0).abs() < 0.06,
                "ψ = {relaxation}, {preconditioner:?}: w/w_ref = {ratio}"
            );
        }
    }
}

#[test]
fn prescribed_anchor_drive_moves_the_shell_rigidly() {
    // C++ coupled_prescribed_rigid_translation: no load, anchors driven
    // uz = δ; the RBE3 root follows, and the whole strip rides along.
    let delta = 1.0e-3;
    let mut strip = strip_on_anchors([20, 4]);
    strip.couple_root(CouplingKind::Distributing);
    // The apex follows the anchors, so the tet moves as a rigid body.
    strip.model.fixed.clear();
    strip.model.values.clear();
    for node in strip.anchors.into_iter().chain([strip.apex]) {
        strip.model.fix(node, &[0, 1]);
        strip.model.prescribe(node, 2, delta);
    }
    for preconditioner in preconditioners() {
        let solved = strip.model.solve(preconditioner).expect("the strip solves");
        let tip_w = tip_deflection(&solved, &strip.tip);
        assert!(
            (tip_w / delta - 1.0).abs() < 0.01,
            "{preconditioner:?}: tip w {tip_w}"
        );
    }
}

#[test]
fn a_support_on_a_coupling_dependent_node_is_refused() {
    let mut strip = strip_on_anchors([4, 2]);
    strip.couple_root(CouplingKind::Distributing);
    for anchor in strip.anchors {
        strip.model.fix(anchor, &[0, 1, 2]);
    }
    let root = strip.root[0];
    let mut fixed = strip.model.clone();
    fixed.fix(root, &[0]);
    let error = fixed.refuse(MixedPreconditioner::IncompleteCholesky);
    assert!(
        matches!(error, FemError::ConstraintOnCoupledDof { node, component: 0, what: "fixed" } if node == root),
        "{error}"
    );
    let mut driven = strip.model.clone();
    driven.prescribe(root, 0, 1e-3);
    let error = driven.refuse(MixedPreconditioner::IncompleteCholesky);
    assert!(
        matches!(
            error,
            FemError::ConstraintOnCoupledDof {
                what: "prescribed",
                ..
            }
        ),
        "{error}"
    );
}

/// Motion `motion` at `position`: 0..2 translate along an axis, 3..5 rotate
/// about one, 6 stretches along x. Returns the translation and rotation.
fn footprint_motion(motion: usize, position: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let theta: [f64; 3] = std::array::from_fn(|axis| f64::from(u8::from(motion == 3 + axis)));
    let translation = std::array::from_fn(|component| {
        if motion == 6 {
            return if component == 0 { position[0] } else { 0.0 };
        }
        f64::from(u8::from(motion == component))
            + theta[(component + 1) % 3] * position[(component + 2) % 3]
            - theta[(component + 2) % 3] * position[(component + 1) % 3]
    });
    (translation, theta)
}

/// The C++ `footprint_rigid_motion` model: shell facet (0, 1, 2) and solid
/// node 3 at (1, 1, 0), whose translations follow the shell edge 0–1 at its
/// midpoint with Kirchhoff section kinematics. Node 3 is a corner of a tet
/// whose other corners are driven with the same motion.
#[test]
fn shell_footprint_follows_rigid_and_affine_motion() {
    let mut model = Mixed::default();
    for point in [
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [0.0, 0.0, 2.0],
        [1.0, 1.0, 0.0],
        [1.0, 2.0, 0.0],
        [2.0, 1.5, 0.0],
        [1.5, 1.5, 1.0],
    ] {
        model.add_point(point);
    }
    model.triangles = vec![0, 1, 2];
    model.thickness = vec![0.1];
    model.material_of_triangle = vec![0];
    model.shell_materials = vec![material(1e5, 0.3, 0)];
    model.tets = vec![3, 4, 5, 6];
    model.material_of_tet = vec![0];
    model.solid_materials = vec![material(1e5, 0.3, 0)];
    model.couplings.push(Coupling {
        reference: 3,
        nodes: vec![0, 1],
        weights: vec![0.5, 0.5],
        kind: CouplingKind::ShellFootprint,
    });
    for motion in 0..7 {
        let mut case = model.clone();
        for node in [0, 1, 2, 4, 5, 6] {
            let (translation, theta) = footprint_motion(motion, case.points[node]);
            for component in 0..3 {
                case.prescribe(node, component, translation[component]);
                if node < 3 {
                    case.prescribe(node, 3 + component, theta[component]);
                }
            }
        }
        let (expected, _) = footprint_motion(motion, [1.0, 1.0, 0.0]);
        for preconditioner in preconditioners() {
            let solved = case.solve(preconditioner).expect("the footprint solves");
            for (component, &want) in expected.iter().enumerate() {
                let actual = solved.solution.dofs[DOFS_PER_NODE * 3 + component];
                assert!(
                    (actual - want).abs() < 1e-8,
                    "motion {motion}, {preconditioner:?}: u{component} = {actual}, expected {want}"
                );
            }
        }
    }
}

/// Node coordinates `0, size/cells, …, size`.
fn spaced(size: f64, cells: usize) -> Vec<f64> {
    (0..=cells)
        .map(|index| size * index as f64 / cells as f64)
        .collect()
}

/// The C++ `mpc_seam_peak` model: a solid block [0, 60]×[0, 40]×[0, 6]
/// cantilevered in its own plane, with a shell wall hanging below it on the
/// mid-surface y = 20, tied by relaxed MPCs to solid footprint nodes at
/// y = 19 and 21 — equidistant from the shell node. `order` lists the y − t/2
/// node first (0), the y + t/2 node first (1), or alternates (2). Returns the
/// peak shell von Mises.
fn seam_peak(order: usize) -> f64 {
    const WIDTH: f64 = 40.0;
    const WALL_T: f64 = 2.0;
    let cells_x = 12;
    let mut ys = spaced(WIDTH, 8);
    ys.retain(|&row| (row - WIDTH / 2.0).abs() > 1e-12);
    ys.extend([WIDTH / 2.0 - WALL_T / 2.0, WIDTH / 2.0 + WALL_T / 2.0]);
    ys.sort_by(f64::total_cmp);

    let mut model = Mixed::default();
    let block = model.add_block([&spaced(60.0, cells_x), &ys, &spaced(6.0, 2)], |_| 0);
    model.solid_materials = vec![material(210e3, 0.3, 0)];
    let solid_count = model.points.len();
    let wall = model.add_shell_grid(
        [0.0, WIDTH / 2.0, 0.0],
        [[60.0 / cells_x as f64, 0.0, 0.0], [0.0, 0.0, -3.0]],
        [cells_x, 10],
        WALL_T,
    );
    model.shell_materials = vec![material(210e3, 0.3, 0)];

    let radius = 1.6 * (60.0 / cells_x as f64);
    for i in 0..=cells_x {
        let reference = wall(i, 0);
        let origin = model.points[reference];
        let mut patch: Vec<usize> = (0..solid_count)
            .filter(|&node| {
                let point = model.points[node];
                (0..3)
                    .map(|axis| (point[axis] - origin[axis]).powi(2))
                    .sum::<f64>()
                    <= radius * radius
            })
            .collect();
        let plus_first = order == 1 || (order == 2 && i % 2 == 0);
        patch.sort_by_key(|&node| {
            let point = model.points[node];
            let offset = point[1] - WIDTH / 2.0;
            if (offset.abs() - WALL_T / 2.0).abs() > 1e-9 || point[2].abs() > 1e-9 {
                2
            } else {
                usize::from((offset > 0.0) != plus_first)
            }
        });
        model.couplings.push(Coupling {
            reference,
            nodes: patch,
            weights: Vec::new(),
            kind: CouplingKind::RelaxedMpc { relaxation: 1.0 },
        });
    }
    let [_, rows, layers] = block.counts;
    for j in 0..rows {
        for k in 0..layers {
            model.fix(block.at(0, j, k), &[0, 1, 2]);
            model.load(block.at(cells_x, j, k), 1, 5000.0 / (rows * layers) as f64);
        }
    }
    let solved = model
        .solve(MixedPreconditioner::IncompleteCholesky)
        .expect("the seam model solves");
    let shell = solved.shell.as_ref().expect("the model has shells");
    shell_von_mises(shell, &solved.solution.dofs)
        .expect("dofs fit the shell mesh")
        .into_iter()
        .fold(0.0, f64::max)
}

#[test]
fn seam_stress_does_not_depend_on_which_equidistant_partner_comes_first() {
    let peaks = [seam_peak(0), seam_peak(1), seam_peak(2)];
    let low = peaks.iter().copied().fold(f64::INFINITY, f64::min);
    let high = peaks.iter().copied().fold(0.0, f64::max);
    assert!(low > 0.0, "{peaks:?}");
    assert!(high / low - 1.0 < 1e-6, "{peaks:?}");
}

/// Mean x-displacement of plane `i` of a block.
fn mean_axial(solved: &Solved, block: &Grid, i: usize) -> f64 {
    let [_, rows, layers] = block.counts;
    let mut sum = 0.0;
    for j in 0..rows {
        for k in 0..layers {
            sum += solved.solution.dofs[DOFS_PER_NODE * block.at(i, j, k)];
        }
    }
    sum / (rows * layers) as f64
}

#[test]
fn per_tet_solid_materials_set_the_solid_stiffness() {
    // A bar [0, 8]×[0, 1]² of steel then aluminium in series, pulled by a
    // uniform end load, with a soft unloaded shell flap held at its edge and
    // tied to the bar's top by a distributing coupling. Linear tets are exact
    // for uniform stress, so each unit span stretches by σ/E_i.
    let (cells_x, force) = (16, 1.0e4);
    let mut model = Mixed::default();
    let bar = model.add_block(
        [&spaced(8.0, cells_x), &spaced(1.0, 2), &spaced(1.0, 2)],
        |i| u32::from(i >= cells_x / 2),
    );
    model.solid_materials = vec![material(210e9, 0.0, 0), material(70e9, 0.0, 1)];
    let flap = [
        model.add_point([1.0, 0.0, 2.0]),
        model.add_point([1.5, 0.0, 2.0]),
        model.add_point([1.25, 0.5, 2.5]),
    ];
    model.triangles = flap.map(|node| node as u32).to_vec();
    model.thickness = vec![0.01];
    model.material_of_triangle = vec![0];
    model.shell_materials = vec![material(1e3, 0.3, 0)];
    model.fix(flap[1], &[0, 1, 2, 3, 4, 5]);
    model.fix(flap[2], &[0, 1, 2, 3, 4, 5]);
    model.couplings.push(Coupling {
        reference: flap[0],
        nodes: vec![bar.at(2, 0, 2), bar.at(2, 2, 2), bar.at(3, 1, 2)],
        weights: Vec::new(),
        kind: CouplingKind::Distributing,
    });
    // Rollers that leave the section free to contract; the section is 1 × 1,
    // so the stress is the force.
    for j in 0..3 {
        for k in 0..3 {
            model.fix(bar.at(0, j, k), &[0]);
            model.load(bar.at(cells_x, j, k), 0, force / 9.0);
        }
    }
    model.fix(bar.at(0, 0, 0), &[1, 2]);
    model.fix(bar.at(0, 2, 0), &[2]);
    for preconditioner in preconditioners() {
        let solved = model.solve(preconditioner).expect("the bar solves");
        // Interior planes, two section widths clear of the lumped end load
        // and the material interface: steel between planes 2 and 4,
        // aluminium between planes 10 and 12, each 1.0 apart.
        let steel = mean_axial(&solved, &bar, 4) - mean_axial(&solved, &bar, 2);
        let aluminium = mean_axial(&solved, &bar, 12) - mean_axial(&solved, &bar, 10);
        for (label, actual, young) in [("steel", steel, 210e9), ("aluminium", aluminium, 70e9)] {
            let expected = force / young;
            assert!(
                (actual / expected - 1.0).abs() < 2e-3,
                "{preconditioner:?}: {label} span stretches {actual}, expected {expected}"
            );
        }
        let translations: Vec<f64> = solved
            .solution
            .dofs
            .chunks(DOFS_PER_NODE)
            .flat_map(|dofs| [dofs[0], dofs[1], dofs[2]])
            .collect();
        let solid_stress = von_mises(&solved.solid, &translations).expect("displacements fit");
        // A tet in the aluminium half, between planes 11 and 12.
        let interior = solid_stress[11 * 4 * KUHN.len()];
        assert!(
            (interior / force - 1.0).abs() < 2e-3,
            "{preconditioner:?}: σ_vM {interior}"
        );
    }
}

#[test]
fn a_moment_on_a_solid_only_node_is_refused() {
    let mut strip = root_coupled_cantilever(CouplingKind::Distributing);
    // A moment on a shell node is fine: shell nodes have rotations.
    strip.model.load(strip.tip[0], 3, 1.0);
    assert!(strip
        .model
        .solve(MixedPreconditioner::IncompleteCholesky)
        .is_ok());
    // A second tet on the anchors, with a free corner that only the solid
    // stiffens.
    let lone = strip.model.add_point([-0.2, 0.0, 0.2]);
    strip
        .model
        .tets
        .extend([strip.anchors[0], strip.anchors[1], strip.apex, lone].map(|index| index as u32));
    strip.model.material_of_tet.push(0);
    strip.model.load(lone, 4, 1.0);
    let error = strip.model.refuse(MixedPreconditioner::IncompleteCholesky);
    assert!(
        matches!(error, FemError::RotationWithoutDof { node, component: 4, what: "moment" } if node == lone),
        "{error}"
    );
}

#[test]
fn the_shell_mesh_must_share_the_solid_node_pool() {
    let strip = root_coupled_cantilever(CouplingKind::Distributing);
    let model = &strip.model;
    let (solid, _) = model.meshes().expect("valid meshes");
    let solid_stiffness = assemble_stiffness(&solid);
    let forces = vec![0.0; DOFS_PER_NODE * solid.vertex_count()];
    let solve = |points: &[[f64; 3]]| {
        let flat: Vec<f64> = points.iter().flatten().copied().collect();
        let shell = ShellMesh::new(
            &flat,
            &model.triangles,
            &model.thickness,
            &model.material_of_triangle,
            model.shell_materials.clone(),
        )
        .expect("valid shell mesh");
        let shell_stiffness = assemble_shell_stiffness(&shell);
        solve_mixed_static(
            &solid,
            &solid_stiffness,
            Some(ShellPart {
                mesh: &shell,
                stiffness: &shell_stiffness,
            }),
            &[],
            &[],
            &[],
            &forces,
            SETTINGS,
            MixedPreconditioner::IncompleteCholesky,
        )
    };
    // One vertex more than the solid mesh.
    let mut longer = model.points.clone();
    longer.push([9.0, 9.0, 9.0]);
    let result = solve(&longer);
    assert!(
        matches!(result, Err(FemError::CouplingInput { .. })),
        "{result:?}"
    );
    // The same count, but one vertex elsewhere.
    let mut moved = model.points.clone();
    let last = moved.len() - 1;
    moved[last][0] += 1.0;
    let result = solve(&moved);
    assert!(
        matches!(&result, Err(FemError::CouplingInput { reason }) if reason.contains(&format!("vertex {last}"))),
        "{result:?}"
    );
}

#[test]
fn shells_over_a_quadratic_mesh_are_refused() {
    // The engine's coupled solve joins shells to linear tets only; the
    // all-solid coupled solve takes quadratic tets, the mixed one does not.
    let strip = root_coupled_cantilever(CouplingKind::Distributing);
    let model = &strip.model;
    let (solid, shell) = model.meshes().expect("valid meshes");
    let shell = shell.expect("the strip has shell facets");
    let quadratic = solid
        .with_order(ElementOrder::Quadratic)
        .expect("quadratic mesh");
    let solid_stiffness = assemble_stiffness(&quadratic);
    let shell_stiffness = assemble_shell_stiffness(&shell);
    let result = solve_mixed_static(
        &quadratic,
        &solid_stiffness,
        Some(ShellPart {
            mesh: &shell,
            stiffness: &shell_stiffness,
        }),
        &model.couplings,
        &model.fixed,
        &model.values,
        &vec![0.0; DOFS_PER_NODE * quadratic.node_count()],
        SETTINGS,
        MixedPreconditioner::IncompleteCholesky,
    );
    assert!(
        matches!(result, Err(FemError::ShellOnQuadraticMesh)),
        "{result:?}"
    );
}
