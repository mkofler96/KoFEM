// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Density-based topology optimization (SIMP) — engine API contract.
//
// DESIGN SPIKE ONLY (KOF-227). This header records the `optimize_topology`
// Embind signature and its data contract so the Phase-A sub-issues can be built
// against a stable interface. It is a declaration, not an implementation: there
// is no topology_simp.cpp yet, the entry is deliberately NOT registered in
// engine.cpp, and no product behaviour ships from KOF-227. The loop, assembly,
// filter and MMA optimizer land in later sub-issues (KOF-228…KOF-231), at which
// point topology_simp.cpp is added to engine/CMakeLists.txt and the entry is
// wired into engine.cpp and the solver worker.
//
// The decisions this contract encodes are recorded in Linear ADR-0002
// ("SIMP topology optimization runs as an in-engine loop"). In brief:
//   * The optimization loop runs INSIDE this WASM engine — mesh, FE space and
//     per-element base stiffnesses k0_e are built once and reused across the
//     ~50–200 iterations, so the JS↔WASM boundary is crossed twice per
//     optimization, not per iteration.
//   * A SIMP iteration is the existing linear-elastic solve (solve_mfem.cpp)
//     with each element's modulus scaled by E(ρ_e) = E_min + ρ_e^p·(E_0 − E_min),
//     E_min ≈ E_0·1e-9 to keep the operator positive-definite as ρ→0. Because
//     k_e is linear in E, k_e(ρ_e) = (E_e/E_0)·k0_e — one scalar per element, no
//     per-iteration re-integration. The reusable assembly pieces of
//     solve_mfem.cpp are factored into shared helpers both paths call, leaving
//     solve_linear_elastic's observable behaviour byte-identical.
//   * MMA (Svanberg 1987) is the single optimizer for every objective/constraint
//     combination in scope; there is no optimizer choice in the payload.
//   * Iteration progress streams to the browser over the same printf→worker log
//     channel the mesher and solver already use; the worker owns cancellation.
#pragma once

#include <emscripten/val.h>

#include <string>

// Run SIMP topology optimization on a solid volume mesh and return the optimized
// per-element density field plus its iteration history.
//
// Arguments mirror solve_linear_elastic's shapes so the worker can reuse the
// same mesh/material/BC packing (the design domain in v1 is automatic — the whole
// solid mesh, with supported and loaded elements kept solid):
//   mesh        JS object of flat typed arrays {vertices: Float64Array,
//               tetrahedra: Int32Array, hexahedra?: Int32Array,
//               attributes?: Int32Array} — identical to the solve input.
//   mat_json    materials array (or legacy single-material object) — as solve.
//   bcs_json    constraints/loads/surface_loads — as solve.
//   topopt_json TO-settings block (objective, constraints, penalty p,
//               filterRadius r_min, moveLimit, maxIterations, tolerance, and a
//               reserved passive solid/void region). See the TopOptSettings TS
//               type in web/src/wasm/pkg/kofem_wasm.d.ts for the field contract.
//
// Returns, as binary typed arrays (no JSON text — issue #166):
//   { density: Float64Array (one per element, in solve/element order),
//     history: [{ it, objective, volume, max_change, stress? }, …] }
// or { error: string } when the inputs are incomplete or the problem is
// ill-posed, matching solve_linear_elastic's error contract.
emscripten::val optimize_topology(emscripten::val mesh,
                                  const std::string& mat_json,
                                  const std::string& bcs_json,
                                  const std::string& topopt_json);
