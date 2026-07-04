// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MFEM: linear-elastic FEM solve. See solve_mfem.h.
//
// solve_linear_elastic is a thin orchestrator over the pipeline stages below
// (issue #293): parse mesh JSON → build the MFEM mesh → collect essential
// (Dirichlet) DOFs → assemble loads → CG solve → recover displacements and
// von Mises stress. Two orderings are load-bearing and owned by the
// orchestrator, not the helpers: the surface-load coefficient/marker storage
// must outlive b.Assemble(), and prescribed displacement values must be seeded
// into the solution GridFunction before FormLinearSystem.

#include "solve_mfem.h"

#include "json_util.h"
#include "wasm_util.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <deque>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using emscripten::val;

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

// Streams CG convergence to the browser log panel (issue #278), giving the
// solve the same live progress feed the mesher has. MFEM's own per-iteration
// report goes to mfem::out (C++ iostreams), which this build avoids (see the
// mesh-construction note below) — printf matches the rest of the pipeline and
// reliably reaches the worker's log stream. The norm MFEM hands the monitor is
// (B·r, r), the squared preconditioned residual, so the relative residual
// shown is √(norm / norm₀).
class CGLogMonitor : public mfem::IterativeSolverMonitor {
    double norm0_ = 0.0;
    int stride_;

public:
    explicit CGLogMonitor(int stride) : stride_(stride) {}

    void MonitorResidual(int it, mfem::real_t norm, const mfem::Vector& /*r*/,
                         bool final) override {
        if (it == 0)
            norm0_ = (double)norm;
        // The final call repeats the last in-loop iteration; the summary
        // printed after cg.Mult reports it instead.
        if (final || it % stride_ != 0)
            return;
        double rel = norm0_ > 0.0 ? std::sqrt((double)norm / norm0_) : 0.0;
        printf("[mfem] CG iteration %4d: relative residual %.3e\n", it, rel);
        fflush(stdout);
    }
};

// ── Mesh parsing / construction ───────────────────────────────────────────────

// Flat volume-mesh arrays extracted from the mesh JSON: xyz per vertex, four
// vertex indices per tet, eight per hex.
struct MeshArrays {
    std::vector<double> vertices;
    std::vector<int> tets;
    std::vector<int> hexs;
};

MeshArrays parse_mesh(const val& mesh_js) {
    val verts_js = mesh_js["vertices"];
    val tets_js  = mesh_js["tetrahedra"];
    val hexs_js  = mesh_js["hexahedra"];
    unsigned nv  = verts_js["length"].as<unsigned>();
    unsigned nt  = tets_js ["length"].as<unsigned>();
    unsigned nh  = hexs_js ["length"].as<unsigned>();

    printf("[mfem] mesh counts: nv=%u nt=%u nh=%u\n", nv, nt, nh); fflush(stdout);

    if (nt == 0 && nh == 0)
        throw std::runtime_error(
            "Mesh has no elements. Send at least one CTETRA or CHEXA element.");

    log_mem("solve: after JSON parse");
    printf("[mfem] extracting %u vertices\n", nv); fflush(stdout);
    MeshArrays m;
    m.vertices.reserve(3 * nv);
    for (unsigned i = 0; i < nv; ++i) {
        val v = verts_js[i];
        m.vertices.push_back(v[0].as<double>());
        m.vertices.push_back(v[1].as<double>());
        m.vertices.push_back(v[2].as<double>());
    }

    printf("[mfem] extracting %u tets\n", nt); fflush(stdout);
    m.tets.reserve(4 * nt);
    for (unsigned i = 0; i < nt; ++i) {
        val t = tets_js[i];
        m.tets.push_back(t[0].as<int>());
        m.tets.push_back(t[1].as<int>());
        m.tets.push_back(t[2].as<int>());
        m.tets.push_back(t[3].as<int>());
    }

    printf("[mfem] extracting %u hexs\n", nh); fflush(stdout);
    m.hexs.reserve(8 * nh);
    for (unsigned i = 0; i < nh; ++i) {
        val h = hexs_js[i];
        for (int k = 0; k < 8; ++k)
            m.hexs.push_back(h[k].as<int>());
    }
    return m;
}

// Build MFEM mesh programmatically to avoid C++ iostream file I/O.
//
// The file-based path (Mesh(filename, ...)) opens an ifstream and reads
// through basic_filebuf / basic_streambuf virtual dispatch.  In the WASM
// (Emscripten) build the locale/codec facet pointer inside the streambuf
// object is null, so the first virtual call through it traps with
// "Out of bounds memory access" via invoke_iiiiii.
//
// The programmatic path calls no iostream code at all: AddVertex / AddTet /
// AddHex populate in-memory arrays directly, and FinalizeTopology builds all
// connectivity (faces, boundary elements, edge table) without file I/O.
// In 3D, FinalizeTopology always builds the edge table, which is required by
// H1_FECollection for DOF numbering.
mfem::Mesh build_mfem_mesh(const MeshArrays& m) {
    unsigned nv = (unsigned)(m.vertices.size() / 3);
    unsigned nt = (unsigned)(m.tets.size() / 4);
    unsigned nh = (unsigned)(m.hexs.size() / 8);

    printf("[mfem] building mesh (%u verts, %u tets, %u hexs)\n", nv, nt, nh); fflush(stdout);
    log_mem("solve: before MFEM mesh build");
    mfem::Mesh mesh(dim, (int)nv, (int)(nt + nh), /*NBdrElem=*/0, /*spaceDim=*/dim);

    printf("[mfem] mesh shell ok\n"); fflush(stdout);
    for (unsigned i = 0; i < nv; ++i)
        mesh.AddVertex(m.vertices[3*i], m.vertices[3*i+1], m.vertices[3*i+2]);
    printf("[mfem] vertices added\n"); fflush(stdout);

    for (unsigned i = 0; i < nt; ++i)
        mesh.AddTet(m.tets[4*i], m.tets[4*i+1], m.tets[4*i+2], m.tets[4*i+3], /*attr=*/1);
    printf("[mfem] tets added\n"); fflush(stdout);

    for (unsigned i = 0; i < nh; ++i)
        mesh.AddHex(m.hexs[8*i], m.hexs[8*i+1], m.hexs[8*i+2], m.hexs[8*i+3],
                    m.hexs[8*i+4], m.hexs[8*i+5], m.hexs[8*i+6], m.hexs[8*i+7], /*attr=*/1);
    printf("[mfem] hexs added\n"); fflush(stdout);

    // generate_bdr=true: boundary Triangle/Quad elements auto-generated from
    // exposed faces of volume elements (correct for a watertight Netgen mesh).
    mesh.FinalizeTopology(/*generate_bdr=*/true);
    printf("[mfem] FinalizeTopology done\n"); fflush(stdout);

    // Netgen uses the opposite tet vertex-winding convention from MFEM.
    // Without fixing orientation every tet has a negative Jacobian, making
    // the assembled stiffness matrix non-positive-definite.  CG then fails
    // at iteration 0 ("preconditioner not positive definite") and returns the
    // zero initial guess, giving physically meaningless results.
    // fix_orientation=true calls CheckElementOrientation(true) which swaps
    // two vertices per tet to correct the sign — this uses only GetVertices()
    // (int* overload, already anchored) and direct array swaps, no new virtual
    // calls.
    mesh.Finalize(/*refine=*/false, /*fix_orientation=*/true);
    printf("[mfem] Finalize done\n"); fflush(stdout);

    printf("[mfem] mesh ready: %d vertices, %d elements, %d boundary elems\n",
           mesh.GetNV(), mesh.GetNE(), mesh.GetNBE());
    fflush(stdout);
    log_mem("solve: after MFEM mesh build");
    return mesh;
}

// ── Essential (Dirichlet) DOFs ────────────────────────────────────────────────

// Per-vertex Dirichlet record (component mask + value). Used after the
// vertex-based loops below to extend each condition to the edge-midpoint DOFs
// that order ≥ 2 elements add, so a clamped/prescribed face stays fully
// constrained and not just at its corner nodes.
struct VDir {
    std::array<bool, 3>   set{false, false, false};
    std::array<double, 3> val{0.0, 0.0, 0.0};
};

struct EssentialBcs {
    mfem::Array<int> ess_tdof;
    // vdof → prescribed displacement, seeded into the solution GridFunction by
    // the orchestrator before FormLinearSystem.
    std::vector<std::pair<int, double>> prescribed_vals;
};

// fixed_vertices is the full-fixity shorthand: every translational component
// (Ux, Uy, Uz) of the listed vertex is pinned.
void add_fixed_vertices(const val& fixed_js, mfem::FiniteElementSpace& fespace,
                        mfem::Array<int>& ess_tdof, std::map<int, VDir>& vdir) {
    unsigned n_fixed = fixed_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n_fixed; ++i) {
        int vi = fixed_js[i].as<int>();
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
    for (unsigned i = 0; i < n_fdofs; ++i) {
        val entry = fdofs_js[i];
        int vi = entry["vertex"].as<int>();
        val comps = entry["dofs"];
        unsigned nc = comps["length"].as<unsigned>();
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (unsigned c = 0; c < nc; ++c) {
            int d = comps[c].as<int>();
            if (d >= 0 && d < vdofs.Size()) {
                ess_tdof.Append(vdofs[d]);
                VDir& vd = vdir[vi];
                vd.set[d] = true;
                vd.val[d] = 0.0;
            }
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
    for (unsigned i = 0; i < n_pdofs; ++i) {
        val entry = pdofs_js[i];
        int vi = entry["vertex"].as<int>();
        int d  = entry["dof"].as<int>();
        double value = entry["value"].as<double>();
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        if (d >= 0 && d < vdofs.Size()) {
            ess_tdof.Append(vdofs[d]);
            prescribed_vals.emplace_back(vdofs[d], value);
            VDir& vd = vdir[vi];
            vd.set[d] = true;
            vd.val[d] = value;
        }
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

// ── Surface (traction / pressure) loads ───────────────────────────────────────

// The integrators take ownership of their coefficient by reference and the
// marker arrays by pointer, so both must outlive b.Assemble(); they are held
// in these stable-address containers, owned by the orchestrator.
struct SurfaceLoadStorage {
    std::deque<std::unique_ptr<mfem::VectorCoefficient>> coeffs;
    std::deque<mfem::Array<int>> markers;
};

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

// Tag the boundary elements covering the given faces (node-index lists,
// 3 = tri, 4 = quad) with the boundary attribute `attr`; returns how many
// boundary elements matched.
int tag_load_faces(mfem::Mesh& mesh, const val& faces,
                   const std::map<std::vector<int>, int>& face_to_be, int attr) {
    unsigned n_faces = faces["length"].as<unsigned>();
    int matched = 0;
    for (unsigned t = 0; t < n_faces; ++t) {
        val face = faces[t];
        unsigned fn = face["length"].as<unsigned>();
        std::vector<int> key(fn);
        for (unsigned k = 0; k < fn; ++k)
            key[k] = face[k].as<int>();
        std::sort(key.begin(), key.end());
        auto it = face_to_be.find(key);
        if (it == face_to_be.end()) continue;
        mesh.GetBdrElement(it->second)->SetAttribute(attr);
        ++matched;
    }
    return matched;
}

// Integrated area of the boundary elements tagged with `attr` — the same
// surface measure the integrator uses, so dividing a total force by it is
// exact for straight-sided faces.
double integrate_tagged_area(mfem::Mesh& mesh, int attr) {
    double area = 0.0;
    for (int be = 0; be < mesh.GetNBE(); ++be) {
        if (mesh.GetBdrAttribute(be) != attr) continue;
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
// Returns nullptr for a "force" load whose matched area is zero (skipped).
std::unique_ptr<mfem::VectorCoefficient> make_surface_load_coefficient(
    const val& entry, const std::string& type, mfem::Mesh& mesh,
    int attr, unsigned load_idx, int matched) {
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
        double area = integrate_tagged_area(mesh, attr);
        if (area <= 0.0) {
            printf("[mfem] surface_load %u: zero matched area — skipped\n", load_idx);
            return nullptr;
        }
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

// Work-equivalent surface loads applied through MFEM's boundary linear-form
// integrator: f_i = ∫_S N_i · t dS. Unlike splitting a face's total force
// equally across its nodes, this weights each node by the shape-function
// integral of its tributary surface, so (a) corner/edge nodes get the right
// share and (b) the resultant passes through the face's area-centroid no
// matter how non-uniformly the face is meshed — no spurious moment.
//
// Each entry tags the boundary elements covering a set of surface faces
// (matched by sorted node-index list) with a unique boundary attribute, then a
// VectorBoundaryLFIntegrator restricted to that attribute applies the
// coefficient built by make_surface_load_coefficient above.
void apply_surface_loads(const val& surf_js, mfem::Mesh& mesh, mfem::LinearForm& b,
                         SurfaceLoadStorage& storage) {
    if (surf_js.isUndefined() || surf_js.isNull())
        return;
    unsigned n_surf = surf_js["length"].as<unsigned>();

    std::map<std::vector<int>, int> face_to_be = build_boundary_face_map(mesh);

    struct PendingLoad { int attr; std::unique_ptr<mfem::VectorCoefficient> coeff; };
    std::vector<PendingLoad> pending;
    int next_attr = 2;  // attribute 1 stays the default (un-loaded) value

    for (unsigned i = 0; i < n_surf; ++i) {
        val entry = surf_js[i];
        std::string type = entry["type"].as<std::string>();
        val faces = entry["faces"];  // node-index lists (3 = tri, 4 = quad)

        int attr = next_attr;
        int matched = tag_load_faces(mesh, faces, face_to_be, attr);
        if (matched == 0) {
            printf("[mfem] surface_load %u (%s): no boundary elements matched "
                   "%u faces — skipped\n",
                   i, type.c_str(), faces["length"].as<unsigned>());
            continue;
        }
        // This load owns `attr` (its elements are now tagged); reserve the
        // next number so a later skip can't make two loads share an attribute.
        ++next_attr;

        std::unique_ptr<mfem::VectorCoefficient> coeff =
            make_surface_load_coefficient(entry, type, mesh, attr, i, matched);
        if (!coeff)
            continue;
        pending.push_back({ attr, std::move(coeff) });
    }

    // Refresh the mesh attribute tables now that boundary attributes changed,
    // so marker arrays can be sized to bdr_attributes.Max().
    mesh.SetAttributes();
    int max_attr = mesh.bdr_attributes.Size() ? mesh.bdr_attributes.Max() : 0;
    for (auto& pl : pending) {
        storage.coeffs.push_back(std::move(pl.coeff));
        storage.markers.emplace_back(max_attr);
        mfem::Array<int>& marker = storage.markers.back();
        marker = 0;
        if (pl.attr >= 1 && pl.attr <= max_attr)
            marker[pl.attr - 1] = 1;
        b.AddBoundaryIntegrator(
            new mfem::VectorBoundaryLFIntegrator(*storage.coeffs.back()), marker);
    }
}

// Concentrated point loads — applied straight to the assembled load vector.
// Still used for explicit nodal forces and for the equivalent nodal forces of
// a moment load. Surface (face) forces flow through apply_surface_loads above.
void apply_point_loads(const val& loads_js, mfem::FiniteElementSpace& fespace,
                       mfem::LinearForm& b) {
    unsigned n_loads = loads_js["length"].as<unsigned>();
    for (unsigned i = 0; i < n_loads; ++i) {
        val load  = loads_js[i];
        int vi    = load["vertex"].as<int>();
        val force = load["force"];
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        if (vdofs.Size() >= 3) {
            b[vdofs[0]] += force[0].as<double>();
            b[vdofs[1]] += force[1].as<double>();
            b[vdofs[2]] += force[2].as<double>();
        }
    }
}

// ── Solve / post-processing ───────────────────────────────────────────────────

void run_cg_solve(mfem::SparseMatrix& A_mat, const mfem::Vector& B, mfem::Vector& X) {
    // GSSmoother (Gauss-Seidel) is numerically robust for 3D elasticity after
    // Dirichlet BC elimination.  DSmoother (Jacobi) diverges on ill-conditioned
    // tet systems, producing NaN residuals that crash the WASM worker.
    mfem::GSSmoother prec(A_mat);
    mfem::CGSolver cg;
    // 1e-6 for both element orders: anything looser leaves visible noise in the
    // recovered stress field (#192, #306). MaxIter 5000 gives large or
    // ill-conditioned meshes room to actually reach that tolerance; hitting the
    // cap without converging is an error (checked after Mult below), not a
    // silently returned best iterate (#313).
    cg.SetRelTol(1e-6);
    cg.SetMaxIter(5000);
    // Errors/warnings only: iteration progress is streamed by CGLogMonitor via
    // printf so it reaches the browser log panel (mfem::out iostream output
    // does not survive this WASM build — see the mesh-construction note above).
    cg.SetPrintLevel(0);
    CGLogMonitor cg_monitor(/*stride=*/10);
    cg.SetMonitor(cg_monitor);
    cg.SetPreconditioner(prec);
    cg.SetOperator(A_mat);
    printf("[mfem] starting CG solve (%d rows)…\n", A_mat.Height()); fflush(stdout);
    log_mem("solve: before CG solve");
    cg.Mult(B, X);
    // MFEM's CGSolver does not throw on hitting MaxIter — it returns the best
    // iterate. Using that under-converged field would silently show wrong
    // displacements/stresses, so fail the solve instead (#192, #313). The
    // worker decodes this exception and the UI shows it in the error banner.
    if (!cg.GetConverged()) {
        std::array<char, 192> msg;
        snprintf(msg.data(), msg.size(),
                 "CG solver did not converge: relative residual %g after %d "
                 "iterations (target 1e-6). The partial result was discarded — "
                 "check that the model is fully constrained, or refine the mesh.",
                 (double)cg.GetFinalRelNorm(), cg.GetNumIterations());
        throw std::runtime_error(msg.data());
    }
    printf("[mfem] CG converged: %d iterations, relative residual %.3e\n",
           cg.GetNumIterations(), (double)cg.GetFinalRelNorm());
    fflush(stdout);
}

std::vector<double> extract_displacements(mfem::FiniteElementSpace& fespace,
                                          const mfem::GridFunction& x, int n_verts) {
    std::vector<double> displacements(3 * (size_t)n_verts, 0.0);
    for (int vi = 0; vi < n_verts; ++vi) {
        mfem::Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c)
            displacements[3*vi + c] = x[vdofs[c]];
    }
    return displacements;
}

// Per-element von Mises stress at the element center: strain from the
// displacement gradient, Cauchy stress via the Lamé constants, then the
// deviatoric second invariant √(3/2 s:s).
std::vector<double> compute_von_mises(mfem::Mesh& mesh, const mfem::GridFunction& x,
                                      double lam, double mu) {
    int n_elems = mesh.GetNE();
    std::vector<double> von_mises(n_elems);
    for (int e = 0; e < n_elems; ++e) {
        mfem::ElementTransformation* T = mesh.GetElementTransformation(e);
        const mfem::IntegrationRule& ir =
            mfem::IntRules.Get(mesh.GetElementGeometry(e), 1);
        T->SetIntPoint(&ir.IntPoint(0));

        mfem::DenseMatrix grad_u;
        x.GetVectorGradient(*T, grad_u);

        std::array<std::array<double, 3>, 3> eps;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                eps[i][j] = 0.5 * (grad_u(i,j) + grad_u(j,i));

        double tr_eps = eps[0][0] + eps[1][1] + eps[2][2];
        std::array<std::array<double, 3>, 3> s;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s[i][j] = (i == j ? lam * tr_eps : 0.0) + 2.0 * mu * eps[i][j];

        double tr_s = s[0][0] + s[1][1] + s[2][2];
        double vm2  = 0.0;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
                double dev = s[i][j] - (i == j ? tr_s / 3.0 : 0.0);
                vm2 += dev * dev;
            }
        von_mises[e] = std::sqrt(1.5 * vm2);
    }
    return von_mises;
}

}  // namespace

std::string solve_linear_elastic(
    const std::string& mesh_json,
    const std::string& mat_json,
    const std::string& bcs_json,
    int order)
{
    using namespace mfem;

    log_mem("solve: start");
    printf("[mfem] solve_linear_elastic: parsing inputs\n"); fflush(stdout);
    val mesh_js = parse_json(mesh_json);
    val mat_js  = parse_json(mat_json);
    val bcs_js  = parse_json(bcs_json);

    MeshArrays mesh_arrays = parse_mesh(mesh_js);

    val E_val  = mat_js["young_modulus"];
    val nu_val = mat_js["poisson_ratio"];

    if (E_val.isNull() || E_val.isUndefined()) {
        return R"({"error":"material is missing young_modulus"})";
    }
    if (nu_val.isNull() || nu_val.isUndefined()) {
        return R"({"error":"material is missing poisson_ratio"})";
    }

    double E  = E_val.as<double>();
    double nu = nu_val.as<double>();

    val loads_js = bcs_js["point_loads"];
    printf("[mfem] BCs: %u fixed vertices, %u point loads\n",
           bcs_js["fixed_vertices"]["length"].as<unsigned>(),
           loads_js["length"].as<unsigned>());
    fflush(stdout);
    log_mem("solve: after extracting mesh data");

    Mesh mfem_mesh = build_mfem_mesh(mesh_arrays);

    order = std::max(1, order);
    double lam = E * nu / ((1.0 + nu) * (1.0 - 2.0*nu));
    double mu  = E / (2.0 * (1.0 + nu));

    printf("[mfem] setting up H1 FE space (order=%d, dim=%d)…\n", order, dim);
    fflush(stdout);
    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mfem_mesh, &fec, dim);
    printf("[mfem] FE space: %d dofs\n", fespace.GetTrueVSize());
    fflush(stdout);
    log_mem("solve: after FE space setup");

    EssentialBcs ess = collect_essential_dofs(bcs_js, mfem_mesh, fespace, order);

    GridFunction x(&fespace);
    x = 0.0;
    // Seed the prescribed components before FormLinearSystem so the eliminated
    // essential DOFs carry the requested displacement instead of zero.
    for (const auto& pv : ess.prescribed_vals)
        x[pv.first] = pv.second;

    LinearForm b(&fespace);
    // Coefficients/markers referenced by b's integrators — must outlive
    // b.Assemble(), hence owned here rather than inside apply_surface_loads.
    SurfaceLoadStorage surf_storage;
    apply_surface_loads(bcs_js["surface_loads"], mfem_mesh, b, surf_storage);

    b.Assemble();

    apply_point_loads(loads_js, fespace, b);

    BilinearForm a(&fespace);
    ConstantCoefficient lam_c(lam), mu_c(mu);
    a.AddDomainIntegrator(new ElasticityIntegrator(lam_c, mu_c));
    printf("[mfem] assembling stiffness matrix…\n"); fflush(stdout);
    a.Assemble();
    printf("[mfem] assembly done\n"); fflush(stdout);
    log_mem("solve: after stiffness assembly");

    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess.ess_tdof, x, b, A, X, B);

    run_cg_solve(*A.As<SparseMatrix>(), B, X);
    a.RecoverFEMSolution(X, b, x);
    printf("[mfem] CG done — computing von Mises stress…\n"); fflush(stdout);
    log_mem("solve: after CG solve");

    std::vector<double> displacements =
        extract_displacements(fespace, x, mfem_mesh.GetNV());
    std::vector<double> von_mises = compute_von_mises(mfem_mesh, x, lam, mu);

    printf("[mfem] solve complete: %d vertex displacements, %d element stresses\n",
           mfem_mesh.GetNV(), mfem_mesh.GetNE());
    fflush(stdout);
    log_mem("solve: complete");

    return "{\"displacements\":" + json_doubles(displacements) +
           ",\"von_mises\":"     + json_doubles(von_mises)     + "}";
}
