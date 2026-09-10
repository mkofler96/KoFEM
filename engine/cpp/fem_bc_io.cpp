// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary-condition and load ingestion — see fem_bc_io.h. Relocated from
// solve_mfem.cpp (ADR-0002 decision 2) so the static solve and the SIMP
// topology-optimization loop share one assembler; the logic is unchanged.

#include "fem_bc_io.h"

#include "bc_validation.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

using emscripten::val;

namespace kofem::fem {

namespace {

constexpr int dim = 3;

// Traction coefficient for a uniform pressure load: returns -p·n̂ at each
// boundary quadrature point, where n̂ is the unit outward normal. The integrator
// (VectorBoundaryLFIntegrator) already multiplies by the surface measure, so the
// coefficient must return the *unit* normal scaled by the pressure, not the
// area-weighted one. Positive pressure pushes into the surface (compression).
class PressureCoefficient : public mfem::VectorCoefficient {
    double pressure_;

public:
    PressureCoefficient(int vdim, double pressure)
        : mfem::VectorCoefficient(vdim), pressure_(pressure) {}

    void Eval(mfem::Vector& V, mfem::ElementTransformation& T,
              const mfem::IntegrationPoint& ip) override {
        V.SetSize(vdim);
        mfem::Vector nor(vdim);
        T.SetIntPoint(&ip);
        // CalcOrtho yields the outward normal of a boundary ElementTransformation
        // with magnitude equal to the surface Jacobian; normalize to a unit vector.
        mfem::CalcOrtho(T.Jacobian(), nor);
        double len = nor.Norml2();
        if (len > 0.0)
            nor /= len;
        V.Set(-pressure_, nor);
    }
};

// ── Essential (Dirichlet) DOFs ────────────────────────────────────────────────

// Per-vertex Dirichlet record (component mask + value). Used after the
// vertex-based loops below to extend each condition to the edge-midpoint DOFs
// that order ≥ 2 elements add, so a clamped/prescribed face stays fully
// constrained and not just at its corner nodes.
struct VDir {
    std::array<bool, 3>   set{false, false, false};
    std::array<double, 3> val{0.0, 0.0, 0.0};
};

// fixed_vertices is the full-fixity shorthand: every translational component
// (Ux, Uy, Uz) of the listed vertex is pinned.
void add_fixed_vertices(const val& fixed_js, mfem::FiniteElementSpace& fespace,
                        mfem::Array<int>& ess_tdof, std::map<int, VDir>& vdir) {
    unsigned n_fixed = fixed_js["length"].as<unsigned>();
    const int nv = fespace.GetMesh()->GetNV();
    for (unsigned i = 0; i < n_fixed; ++i) {
        int vi = fixed_js[i].as<int>();
        kofem::bc::require_valid_vertex(vi, nv, "add_fixed_vertices");
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int j = 0; j < vdofs.Size(); ++j)
            ess_tdof.Append(vdofs[j]);
        VDir& vd = vdir[vi];
        for (int d = 0; d < dim && d < vdofs.Size(); ++d) {
            vd.set[d] = true;
            vd.val[d] = 0.0;
        }
    }
}

// fixed_dofs pins only the listed components of a vertex, leaving the others
// free — a single-DOF constraint. This is what a symmetry-plane roller or a
// statically-determinate 3-2-1 restraint needs. Each entry is
// { vertex: int, dofs: int[] } with dofs ⊂ {0=Ux, 1=Uy, 2=Uz}. Optional:
// absent on the full-fixity path, so older payloads keep working unchanged.
void add_fixed_dofs(const val& fdofs_js, mfem::FiniteElementSpace& fespace,
                    mfem::Array<int>& ess_tdof, std::map<int, VDir>& vdir) {
    if (fdofs_js.isUndefined() || fdofs_js.isNull())
        return;
    unsigned n_fdofs = fdofs_js["length"].as<unsigned>();
    const int nv = fespace.GetMesh()->GetNV();
    for (unsigned i = 0; i < n_fdofs; ++i) {
        val entry = fdofs_js[i];
        int vi = entry["vertex"].as<int>();
        val comps = entry["dofs"];
        unsigned nc = comps["length"].as<unsigned>();
        kofem::bc::require_valid_vertex(vi, nv, "add_fixed_dofs");
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (unsigned c = 0; c < nc; ++c) {
            int d = comps[c].as<int>();
            kofem::bc::require_valid_component(d, vdofs.Size(), vi, "add_fixed_dofs");
            ess_tdof.Append(vdofs[d]);
            VDir& vd = vdir[vi];
            vd.set[d] = true;
            vd.val[d] = 0.0;
        }
    }
}

// prescribed_dofs pins a single component of a vertex to a NON-ZERO value —
// an inhomogeneous Dirichlet condition (e.g. a prescribed-displacement
// support that drives the deformation on its own). Each entry is
// { vertex: int, dof: int (0=Ux,1=Uy,2=Uz), value: double }. The DOF is added
// to the essential set like any other fixed DOF, but the value is written
// into the solution GridFunction by the orchestrator so FormLinearSystem
// eliminates it and moves its contribution to the load vector. Optional:
// absent payloads keep the all-zero Dirichlet behaviour unchanged.
void add_prescribed_dofs(const val& pdofs_js, mfem::FiniteElementSpace& fespace,
                         mfem::Array<int>& ess_tdof,
                         std::vector<std::pair<int, double>>& prescribed_vals,
                         std::map<int, VDir>& vdir) {
    if (pdofs_js.isUndefined() || pdofs_js.isNull())
        return;
    unsigned n_pdofs = pdofs_js["length"].as<unsigned>();
    const int nv = fespace.GetMesh()->GetNV();
    for (unsigned i = 0; i < n_pdofs; ++i) {
        val entry = pdofs_js[i];
        int vi = entry["vertex"].as<int>();
        int d  = entry["dof"].as<int>();
        double value = entry["value"].as<double>();
        kofem::bc::require_valid_vertex(vi, nv, "add_prescribed_dofs");
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        kofem::bc::require_valid_component(d, vdofs.Size(), vi, "add_prescribed_dofs");
        ess_tdof.Append(vdofs[d]);
        prescribed_vals.emplace_back(vdofs[d], value);
        VDir& vd = vdir[vi];
        vd.set[d] = true;
        vd.val[d] = value;
    }
}

// Order-2 elements introduce one interior DOF per edge that the vertex-based
// loops above don't reach. Extend each Dirichlet condition to an edge's
// interior DOF when BOTH its endpoints carry that condition (in the same
// component): the midpoint value is the average of the endpoint values —
// exact for a clamped face (0) or a uniform/linear prescribed displacement.
// Edges straddling the border of a constrained region (only one endpoint
// constrained) stay free, the correct treatment of that border. Tetrahedral
// P2 faces carry no face-interior DOF, so this fully constrains a clamped
// face on the tet meshes the mesher produces. (A Q2 hex face's center DOF
// would be left free — negligible here and avoided in practice.)
void extend_dirichlet_to_edge_dofs(mfem::Mesh& mesh, mfem::FiniteElementSpace& fespace,
                                   const std::map<int, VDir>& vdir,
                                   mfem::Array<int>& ess_tdof,
                                   std::vector<std::pair<int, double>>& prescribed_vals) {
    int n_edges = mesh.GetNEdges();
    for (int e = 0; e < n_edges; ++e) {
        mfem::Array<int> ev;
        mesh.GetEdgeVertices(e, ev);
        auto it0 = vdir.find(ev[0]);
        auto it1 = vdir.find(ev[1]);
        if (it0 == vdir.end() || it1 == vdir.end()) continue;
        mfem::Array<int> edofs;
        fespace.GetEdgeInteriorDofs(e, edofs);
        for (int k = 0; k < edofs.Size(); ++k)
            for (int d = 0; d < dim; ++d) {
                if (!it0->second.set[d] || !it1->second.set[d]) continue;
                int vdof = fespace.DofToVDof(edofs[k], d);
                ess_tdof.Append(vdof);
                double avg = 0.5 * (it0->second.val[d] + it1->second.val[d]);
                if (avg != 0.0)
                    prescribed_vals.emplace_back(vdof, avg);
            }
    }
}

// ── Surface (traction / pressure) loads ───────────────────────────────────────

// sorted boundary-face vertex list → boundary element index, over the
// auto-generated boundary mesh (its vertex indices equal the input node
// IDs). Keyed by a sorted vertex vector so it matches both triangular
// (tet) and quadrilateral (hex) boundary faces.
std::map<std::vector<int>, int> build_boundary_face_map(const mfem::Mesh& mesh) {
    std::map<std::vector<int>, int> face_to_be;
    for (int be = 0; be < mesh.GetNBE(); ++be) {
        mfem::Array<int> bv;
        mesh.GetBdrElementVertices(be, bv);
        std::vector<int> key(bv.begin(), bv.end());
        std::sort(key.begin(), key.end());
        face_to_be[key] = be;
    }
    return face_to_be;
}

// The boundary elements covering one load's faces (node-index lists, 3 = tri,
// 4 = quad), sorted and de-duplicated. A face matching no boundary element is
// ignored: it is interior, or a stale selection, and either way contributes
// nothing to a surface integral.
std::vector<int> collect_load_elements(
    const val& faces, const std::map<std::vector<int>, int>& face_to_be) {
    unsigned n_faces = faces["length"].as<unsigned>();
    std::vector<int> bes;
    bes.reserve(n_faces);
    for (unsigned t = 0; t < n_faces; ++t) {
        val face = faces[t];
        unsigned fn = face["length"].as<unsigned>();
        std::vector<int> key(fn);
        for (unsigned k = 0; k < fn; ++k)
            key[k] = face[k].as<int>();
        std::sort(key.begin(), key.end());
        auto it = face_to_be.find(key);
        if (it == face_to_be.end()) continue;
        bes.push_back(it->second);
    }
    std::sort(bes.begin(), bes.end());
    bes.erase(std::unique(bes.begin(), bes.end()), bes.end());
    return bes;
}

// Integrated area of the boundary elements whose attribute is marked — the same
// surface measure the integrator uses, so dividing a total force by it is
// exact for straight-sided faces. Takes the marker rather than a single
// attribute because a load that overlaps another spans several of them.
double integrate_marked_area(mfem::Mesh& mesh, const mfem::Array<int>& marker) {
    double area = 0.0;
    for (int be = 0; be < mesh.GetNBE(); ++be) {
        int attr = mesh.GetBdrAttribute(be);
        if (attr < 1 || attr > marker.Size() || marker[attr - 1] == 0) continue;
        mfem::ElementTransformation* T = mesh.GetBdrElementTransformation(be);
        const mfem::IntegrationRule& ir =
            mfem::IntRules.Get(mesh.GetBdrElementGeometry(be), 4);
        for (int q = 0; q < ir.GetNPoints(); ++q) {
            const mfem::IntegrationPoint& ip = ir.IntPoint(q);
            T->SetIntPoint(&ip);
            area += ip.weight * T->Weight();
        }
    }
    return area;
}

// Build the traction coefficient for one surface-load entry:
//   type "force"    — total force F spread as a uniform traction F / A_total
//   type "traction" — a traction vector applied directly
//   type "pressure" — scalar p applied as -p·n̂ (outward normal; + pushes in)
// `area` is the integrated area of the load's own boundary elements (shared
// ones included) — the measure a total force is spread over; a "force" load
// whose area is not positive throws rather than vanishing from the solve.
std::unique_ptr<mfem::VectorCoefficient> make_surface_load_coefficient(
    const val& entry, const std::string& type, unsigned load_idx, int matched,
    double area) {
    if (type == "pressure") {
        double p = entry["pressure"].as<double>();
        printf("[mfem] surface_load %u: pressure %g over %d bdr elems\n",
               load_idx, p, matched);
        return std::make_unique<PressureCoefficient>(dim, p);
    }
    // "force" or "traction"
    mfem::Vector tvec(3);
    tvec[0] = entry["force"][0].as<double>();
    tvec[1] = entry["force"][1].as<double>();
    tvec[2] = entry["force"][2].as<double>();
    if (type == "force") {
        kofem::bc::require_positive_load_area(area, load_idx, matched);
        tvec /= area;
        printf("[mfem] surface_load %u: force → traction [%g %g %g] over "
               "%d bdr elems (A=%g)\n",
               load_idx, tvec[0], tvec[1], tvec[2], matched, area);
    } else {
        printf("[mfem] surface_load %u: traction [%g %g %g] over %d bdr elems\n",
               load_idx, tvec[0], tvec[1], tvec[2], matched);
    }
    return std::make_unique<mfem::VectorConstantCoefficient>(tvec);
}

}  // namespace

EssentialBcs collect_essential_dofs(const val& bcs_js, mfem::Mesh& mesh,
                                    mfem::FiniteElementSpace& fespace, int order) {
    EssentialBcs bcs;
    std::map<int, VDir> vdir;
    add_fixed_vertices(bcs_js["fixed_vertices"], fespace, bcs.ess_tdof, vdir);
    add_fixed_dofs(bcs_js["fixed_dofs"], fespace, bcs.ess_tdof, vdir);
    add_prescribed_dofs(bcs_js["prescribed_dofs"], fespace, bcs.ess_tdof,
                        bcs.prescribed_vals, vdir);
    if (order >= 2)
        extend_dirichlet_to_edge_dofs(mesh, fespace, vdir, bcs.ess_tdof,
                                      bcs.prescribed_vals);
    bcs.ess_tdof.Sort();
    bcs.ess_tdof.Unique();
    return bcs;
}

// Work-equivalent surface loads applied through MFEM's boundary linear-form
// integrator: f_i = ∫_S N_i · t dS. Unlike splitting a face's total force
// equally across its nodes, this weights each node by the shape-function
// integral of its tributary surface, so (a) corner/edge nodes get the right
// share and (b) the resultant passes through the face's area-centroid no
// matter how non-uniformly the face is meshed — no spurious moment.
//
// Each entry claims the boundary elements covering a set of surface faces
// (matched by sorted node-index list), then a VectorBoundaryLFIntegrator
// restricted to the attributes it owns applies the coefficient built by
// make_surface_load_coefficient above.
//
// Loads may OVERLAP — a pressure and a bolt pull-out force on the same flange
// face, or two selections sharing a strip of elements — and every one of them
// must still be integrated over the shared elements. A boundary element carries
// exactly one attribute, so a per-load attribute cannot express that: tagging in
// load order let a later load overwrite an earlier one's tag, and the
// overwritten load then integrated over nothing and vanished without a word
// (KOF-216). Instead the elements are grouped by the SET of loads covering them,
// each distinct set gets one attribute, and a load's marker selects every
// attribute whose set contains it.
void apply_surface_loads(const val& surf_js, mfem::Mesh& mesh, mfem::LinearForm& b,
                         SurfaceLoadStorage& storage) {
    if (surf_js.isUndefined() || surf_js.isNull())
        return;
    unsigned n_surf = surf_js["length"].as<unsigned>();
    if (n_surf == 0)
        return;

    const std::map<std::vector<int>, int> face_to_be = build_boundary_face_map(mesh);

    std::vector<std::vector<int>> load_elems(n_surf);
    std::map<int, std::vector<unsigned>> loads_of_be;  // bdr elem → covering loads
    for (unsigned i = 0; i < n_surf; ++i) {
        load_elems[i] = collect_load_elements(surf_js[i]["faces"], face_to_be);
        for (int be : load_elems[i])
            loads_of_be[be].push_back(i);
    }

    // One attribute per distinct covering set; attribute 1 stays the default
    // (un-loaded) value.
    std::map<std::vector<unsigned>, int> attr_of_set;
    int next_attr = 2;
    int n_shared = 0;
    for (const auto& [be, covering] : loads_of_be) {
        auto [slot, inserted] = attr_of_set.try_emplace(covering, next_attr);
        if (inserted)
            ++next_attr;
        if (covering.size() > 1)
            ++n_shared;
        mesh.GetBdrElement(be)->SetAttribute(slot->second);
    }
    if (n_shared > 0) {
        printf("[mfem] surface loads overlap on %d boundary element(s) — each "
               "covering load is integrated over them\n", n_shared);
        fflush(stdout);
    }

    // Refresh the mesh attribute tables now that boundary attributes changed,
    // so marker arrays can be sized to bdr_attributes.Max().
    mesh.SetAttributes();
    const int max_attr = mesh.bdr_attributes.Size() ? mesh.bdr_attributes.Max() : 0;

    for (unsigned i = 0; i < n_surf; ++i) {
        val entry = surf_js[i];
        std::string type = entry["type"].as<std::string>();
        const int matched = (int)load_elems[i].size();
        kofem::bc::require_matched_boundary_elements(
            matched, entry["faces"]["length"].as<unsigned>(), i, type.c_str());
        mfem::Array<int> marker(max_attr);
        marker = 0;
        for (const auto& [covering, attr] : attr_of_set) {
            if (std::find(covering.begin(), covering.end(), i) == covering.end())
                continue;
            if (attr >= 1 && attr <= max_attr)
                marker[attr - 1] = 1;
        }

        std::unique_ptr<mfem::VectorCoefficient> coeff =
            make_surface_load_coefficient(entry, type, i, matched,
                                          integrate_marked_area(mesh, marker));
        // Copied into the storage deque only once the load is certain to be
        // applied: the integrator keeps a POINTER to the marker (and a reference
        // to the coefficient), so both must live at a stable address until
        // b.Assemble() — which the caller-owned deques guarantee.
        storage.coeffs.push_back(std::move(coeff));
        storage.markers.emplace_back();
        storage.markers.back() = marker;
        b.AddBoundaryIntegrator(
            new mfem::VectorBoundaryLFIntegrator(*storage.coeffs.back()),
            storage.markers.back());
    }
}

// Concentrated point loads — applied straight to the assembled load vector.
// Still used for explicit nodal forces and for the equivalent nodal forces of
// a moment load. Surface (face) forces flow through apply_surface_loads above.
void apply_point_loads(const val& loads_js, mfem::FiniteElementSpace& fespace,
                       mfem::LinearForm& b) {
    unsigned n_loads = loads_js["length"].as<unsigned>();
    const int nv = fespace.GetMesh()->GetNV();
    for (unsigned i = 0; i < n_loads; ++i) {
        val load  = loads_js[i];
        int vi    = load["vertex"].as<int>();
        val force = load["force"];
        kofem::bc::require_valid_vertex(vi, nv, "apply_point_loads");
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        kofem::bc::require_min_dofs(vdofs.Size(), 3, vi, "apply_point_loads");
        b[vdofs[0]] += force[0].as<double>();
        b[vdofs[1]] += force[1].as<double>();
        b[vdofs[2]] += force[2].as<double>();
    }
}

}  // namespace kofem::fem
