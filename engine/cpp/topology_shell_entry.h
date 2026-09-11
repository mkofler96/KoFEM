// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// SIMP topology-optimization Embind entries for the shell and coupled
// shell/solid design domains (KOF-237, Phase B of the KOF-226 epic; ADR-0002).
//
// These are the JS↔WASM boundary for the shell/coupled optimizer, mirroring
// solve_shell / solve_coupled's payloads so the worker reuses the same
// mesh/material/BC packing, plus the TO-settings block optimize_topology takes.
// Like the solid entry (topology_simp.h) they cross the boundary only twice per
// optimization: all iterations run in C++ (topology_shell.h) and stream progress
// over the printf→worker log channel.
//
// The numerical loop, its self-adjoint sensitivities and the finite-difference
// verification live in topology_shell.{h,cpp}; this file only parses inputs,
// rejects unsupported settings with a clear message, and packs the result.
#pragma once

#include <emscripten/val.h>

#include <string>

// Pure-shell (all-CTRIA3) minimum-compliance topology optimization. `mesh`,
// `mat_json` and `bcs_json` are exactly solve_shell's payloads; `topopt_json` is
// the TopOptSettings block optimize_topology takes. Returns
//   { density: Float64Array (one per shell facet, triangle order),
//     history: [{ it, objective, volume, max_change }, …] }
// or { error: string } on incomplete/ill-posed input.
emscripten::val optimize_topology_shell(emscripten::val mesh, const std::string& mat_json,
                                        const std::string& bcs_json,
                                        const std::string& topopt_json);

// Coupled shell/solid minimum-compliance topology optimization. `mesh`,
// `coupling`, `bcs` and `mat_json` are exactly solve_coupled's payloads;
// `topopt_json` is the TopOptSettings block. The single density field spans the
// solid tets and shell facets both; the couplings are constraints, not design
// variables. Returns
//   { density: Float64Array (solid tets first in tet order, then shell facets in
//     triangle order), history: [...] }  or  { error: string }.
emscripten::val optimize_topology_coupled(emscripten::val mesh, emscripten::val coupling,
                                          emscripten::val bcs, const std::string& mat_json,
                                          const std::string& topopt_json);
