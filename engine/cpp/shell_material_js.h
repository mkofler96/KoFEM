// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shell material payload shared by the shell and coupled Embind entry points
// (solve_shell, solve_coupled and their topology optimizers), so all of them
// read per-body shell materials through one contract (issue #389).
#pragma once

#include <emscripten/val.h>

#include <cstddef>
#include <string>
#include <vector>

#include "wasm_util.h"

namespace kofem::shell {

// The shell materials of a solve. `error` is non-empty when the payload is
// invalid; nothing else is meaningful then.
struct ShellMaterialPayload {
    std::string error;
    unsigned n_materials = 0;
    // The first material: the uniform pair when `n_materials` is 1.
    double young = 0.0;
    double poisson = 0.0;
    // One (E, ν) per triangle when the mesh spans several materials; both empty
    // when `n_materials` is 1 (ShellInput / CoupledInput then use the uniform pair).
    std::vector<double> youngs;
    std::vector<double> poissons;
};

// Read the shell material(s). `materials` is one material object
// {young_modulus, poisson_ratio} or an ARRAY of them; `attributes` (named
// `attributes_name` in errors) holds one 1-based index into that array per
// triangle — the same contract solve_linear_elastic uses for solid elements.
// A single material needs no attributes. Several materials require them: there
// is no default material for a facet that names none.
inline ShellMaterialPayload read_shell_materials(const emscripten::val& materials,
                                                 const emscripten::val& attributes,
                                                 const char* attributes_name, int n_tris) {
    using emscripten::val;
    ShellMaterialPayload out;
    if (materials.isUndefined() || materials.isNull()) {
        out.error = "shell material is missing";
        return out;
    }
    const bool is_array = val::global("Array").call<bool>("isArray", materials);
    out.n_materials = is_array ? materials["length"].as<unsigned>() : 1U;
    if (out.n_materials == 0) {
        out.error = "shell materials array is empty — at least one material is required";
        return out;
    }
    std::vector<double> young_by_mat(out.n_materials), poisson_by_mat(out.n_materials);
    for (unsigned k = 0; k < out.n_materials; ++k) {
        val mat = is_array ? materials[k] : materials;
        val E = mat["young_modulus"], nu = mat["poisson_ratio"];
        if (E.isNull() || E.isUndefined()) {
            out.error = "shell material " + std::to_string(k + 1) + " is missing young_modulus";
            return out;
        }
        if (nu.isNull() || nu.isUndefined()) {
            out.error = "shell material " + std::to_string(k + 1) + " is missing poisson_ratio";
            return out;
        }
        young_by_mat[k] = E.as<double>();
        poisson_by_mat[k] = nu.as<double>();
    }
    out.young = young_by_mat[0];
    out.poisson = poisson_by_mat[0];

    std::vector<int> attrs;
    if (!attributes.isUndefined() && !attributes.isNull())
        attrs = i32_vector(attributes, attributes_name);
    if (attrs.empty()) {
        if (out.n_materials > 1 && n_tris > 0)
            out.error = std::to_string(out.n_materials) + " shell materials were given but no " +
                        attributes_name + " to select one per triangle";
        return out;
    }
    if (static_cast<int>(attrs.size()) != n_tris) {
        out.error = std::string(attributes_name) + " has " + std::to_string(attrs.size()) +
                    " entries for " + std::to_string(n_tris) + " triangles";
        return out;
    }
    for (size_t e = 0; e < attrs.size(); ++e)
        if (attrs[e] < 1 || static_cast<unsigned>(attrs[e]) > out.n_materials) {
            out.error = "triangle " + std::to_string(e) + " selects shell material " +
                        std::to_string(attrs[e]) + ", outside 1.." +
                        std::to_string(out.n_materials);
            return out;
        }
    if (out.n_materials == 1) return out;
    out.youngs.resize(attrs.size());
    out.poissons.resize(attrs.size());
    for (size_t e = 0; e < attrs.size(); ++e) {
        const size_t k = static_cast<size_t>(attrs[e]) - 1;
        out.youngs[e] = young_by_mat[k];
        out.poissons[e] = poisson_by_mat[k];
    }
    return out;
}

}  // namespace kofem::shell
