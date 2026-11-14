// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The data the solve and optimize paths exchange: the packed meshes the Rust
// solves take, the topology-optimization settings and history, and the CG
// budget prompt. These were the C++ engine's solver contracts; the solvers
// moved to the Rust module (KOF-309), which takes the same shapes.

/** Volume mesh as the solid solve packs it: flat typed arrays, the layout of
 *  the engine's FemMesh.
 *  `hexahedra` is eight 0-based vertex indices per hex and may be omitted.
 *  `attributes` is one 1-based material index per element (tets first, then
 *  hexs) for multi-material models (issue #353); omitted means every element
 *  uses material 1. */
export interface SolveMesh {
  vertices: Float64Array;
  tetrahedra: Int32Array;
  hexahedra?: Int32Array;
  attributes?: Int32Array;
}

/** Topology-optimization settings: what the Optimize panel sends the worker's
 *  `optimize_topology` message and the Rust optimizer reads (topOptRust.ts).
 *  The KOF-227 design contract (ADR-0002). `passive` holds the keep-in and
 *  keep-out element indices. */
export interface TopOptSettings {
  /** "simp" (default): per-element densities, MMA. "level_set": nodal level set
   *  φ updated by a reaction–diffusion equation (Yamada et al. 2010) — solid
   *  models and min_compliance only; `filterRadius` is then the regularization
   *  length ℓ, and `penalty`/`moveLimit` are unused. */
  method?: "simp" | "level_set";
  objective: "min_compliance" | "min_volume";
  /** `volumeFraction` bounds a min_compliance run; `complianceLimit` and/or
   *  `maxStress` bound a min_volume run. `maxStress` (KOF-236) is the von Mises
   *  limit σ_allow in the material's stress units, on the qp-relaxed element
   *  stress; it can also be added to a min_compliance run. All-solid models
   *  only — shell and coupled models refuse it. */
  constraints: {
    volumeFraction?: number;
    complianceLimit?: number;
    maxStress?: number;
  };
  /** Aggregation of the stress constraint (only with `maxStress`): P-norm or KS,
   *  the parameter P (default 8 for pnorm, 40 for ks) and the qp-relaxation
   *  exponent q, 0 ≤ q < penalty (default penalty − 0.5, i.e. the ρ^½ stress
   *  interpolation; 2.5 at the default p = 3). */
  stress?: { aggregation?: "pnorm" | "ks"; p?: number; q?: number };
  penalty?: number; // SIMP penalty p, default 3 (SIMP only)
  filterRadius: number; // r_min, model length units
  moveLimit?: number; // MMA move limit, default 0.2 (SIMP only)
  maxIterations: number;
  tolerance: number; // convergence on max |Δρ|, default 0.01
  passive?: { solid?: number[]; void?: number[] }; // reserved, element indices
  streamEvery?: number; // live density every N iterations (KOF-240), default 1
}

/** One optimizer iteration in the returned history. `objective` is the value
 *  being minimized (compliance for min_compliance, volume fraction for
 *  min_volume); `compliance` is always the structural compliance c = fᵀu (the
 *  constraint of a min_volume run); `volume` is the current volume fraction;
 *  `max_change` is max |Δρ| over the design variables. With a stress constraint
 *  (KOF-236) `stress` is the normalized aggregate the constraint bounds and
 *  `max_stress` the true max relaxed von Mises it tracks; both are absent
 *  otherwise. */
export interface TopOptHistoryEntry {
  it: number;
  objective: number;
  compliance: number;
  volume: number;
  max_change: number;
  stress?: number;
  max_stress?: number;
}

/** Triangle SURFACE mesh input to the Kirchhoff shell solve (shellRust.ts): `vertices` is xyz
 *  interleaved (length 3·nNodes); `triangles` is three 0-based vertex indices
 *  per triangle (length 3·nTris). `thicknesses` is an optional per-triangle
 *  thickness field (length nTris) for walls of differing gauge; when omitted the
 *  scalar thickness in the material JSON is used. `attributes` is one 1-based
 *  material index per triangle for shell bodies of different materials; it is
 *  required when the material JSON is an array of more than one material. */
export interface ShellMesh {
  vertices: Float64Array;
  triangles: Int32Array;
  thicknesses?: Float64Array;
  attributes?: Int32Array;
}

/** Where a CG solve stands when it reaches its iteration budget: what the
 *  "continue?" prompt shows (cgRun.ts, cgContinuation.ts). */
export interface CgLimitProgress {
  iterations: number;
  relativeResidual: number;
  target: number;
  elapsedSeconds: number;
  suggestedIterations: number;
}
