// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MFEM: linear-elastic FEM solve. See solve_mfem.h.

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

// Traction coefficient for a uniform pressure load: returns -p·n̂ at each
// boundary quadrature point, where n̂ is the unit outward normal. The integrator
// (VectorBoundaryLFIntegrator) already multiplies by the surface measure, so the
// coefficient must return the *unit* normal scaled by the pressure, not the
// area-weighted one. Positive pressure pushes into the surface (compression).
class PressureCoefficient : public mfem::VectorCoefficient {
    double pressure_;

public:
    PressureCoefficient(int dim, double pressure)
        : mfem::VectorCoefficient(dim), pressure_(pressure) {}

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
    std::vector<double> vertices;
    vertices.reserve(3 * nv);
    for (unsigned i = 0; i < nv; ++i) {
        val v = verts_js[i];
        vertices.push_back(v[0].as<double>());
        vertices.push_back(v[1].as<double>());
        vertices.push_back(v[2].as<double>());
    }

    printf("[mfem] extracting %u tets\n", nt); fflush(stdout);
    std::vector<int> tets;
    tets.reserve(4 * nt);
    for (unsigned i = 0; i < nt; ++i) {
        val t = tets_js[i];
        tets.push_back(t[0].as<int>());
        tets.push_back(t[1].as<int>());
        tets.push_back(t[2].as<int>());
        tets.push_back(t[3].as<int>());
    }

    printf("[mfem] extracting %u hexs\n", nh); fflush(stdout);
    std::vector<int> hexs;
    hexs.reserve(8 * nh);
    for (unsigned i = 0; i < nh; ++i) {
        val h = hexs_js[i];
        for (int k = 0; k < 8; ++k)
            hexs.push_back(h[k].as<int>());
    }

    double E  = jdouble(mat_js, "young_modulus", 210e9);
    double nu = jdouble(mat_js, "poisson_ratio",   0.3);

    val fixed_js = bcs_js["fixed_vertices"];
    unsigned n_fixed = fixed_js["length"].as<unsigned>();

    val loads_js  = bcs_js["point_loads"];
    unsigned n_loads = loads_js["length"].as<unsigned>();

    printf("[mfem] BCs: %u fixed vertices, %u point loads\n", n_fixed, n_loads); fflush(stdout);
    log_mem("solve: after extracting mesh data");

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
    printf("[mfem] building mesh (%u verts, %u tets, %u hexs)\n", nv, nt, nh); fflush(stdout);
    log_mem("solve: before MFEM mesh build");
    constexpr int dim = 3;
    Mesh mfem_mesh(dim, (int)nv, (int)(nt + nh), /*NBdrElem=*/0, /*spaceDim=*/dim);

    printf("[mfem] mesh shell ok\n"); fflush(stdout);
    for (unsigned i = 0; i < nv; ++i)
        mfem_mesh.AddVertex(vertices[3*i], vertices[3*i+1], vertices[3*i+2]);
    printf("[mfem] vertices added\n"); fflush(stdout);

    for (unsigned i = 0; i < nt; ++i)
        mfem_mesh.AddTet(tets[4*i], tets[4*i+1], tets[4*i+2], tets[4*i+3], /*attr=*/1);
    printf("[mfem] tets added\n"); fflush(stdout);

    for (unsigned i = 0; i < nh; ++i)
        mfem_mesh.AddHex(hexs[8*i], hexs[8*i+1], hexs[8*i+2], hexs[8*i+3],
                         hexs[8*i+4], hexs[8*i+5], hexs[8*i+6], hexs[8*i+7], /*attr=*/1);
    printf("[mfem] hexs added\n"); fflush(stdout);

    // generate_bdr=true: boundary Triangle/Quad elements auto-generated from
    // exposed faces of volume elements (correct for a watertight Netgen mesh).
    mfem_mesh.FinalizeTopology(/*generate_bdr=*/true);
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
    mfem_mesh.Finalize(/*refine=*/false, /*fix_orientation=*/true);
    printf("[mfem] Finalize done\n"); fflush(stdout);

    printf("[mfem] mesh ready: %d vertices, %d elements, %d boundary elems\n",
           mfem_mesh.GetNV(), mfem_mesh.GetNE(), mfem_mesh.GetNBE());
    fflush(stdout);
    log_mem("solve: after MFEM mesh build");

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

    // Essential (Dirichlet) DOFs from fixed vertices.
    // fixed_vertices is the full-fixity shorthand: every translational component
    // (Ux, Uy, Uz) of the listed vertex is pinned.
    Array<int> ess_tdof;
    // Per-vertex Dirichlet record (component mask + value). Used after the
    // vertex-based loops below to extend each condition to the edge-midpoint DOFs
    // that order ≥ 2 elements add, so a clamped/prescribed face stays fully
    // constrained and not just at its corner nodes.
    struct VDir {
        std::array<bool, 3>   set{false, false, false};
        std::array<double, 3> val{0.0, 0.0, 0.0};
    };
    std::map<int, VDir> vdir;
    for (unsigned i = 0; i < n_fixed; ++i) {
        int vi = fixed_js[i].as<int>();
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int j = 0; j < vdofs.Size(); ++j)
            ess_tdof.Append(vdofs[j]);
        VDir& vd = vdir[vi];
        for (int d = 0; d < dim && d < vdofs.Size(); ++d) {
            vd.set[d] = true;
            vd.val[d] = 0.0;
        }
    }

    // fixed_dofs pins only the listed components of a vertex, leaving the others
    // free — a single-DOF constraint. This is what a symmetry-plane roller or a
    // statically-determinate 3-2-1 restraint needs. Each entry is
    // { vertex: int, dofs: int[] } with dofs ⊂ {0=Ux, 1=Uy, 2=Uz}. Optional:
    // absent on the full-fixity path, so older payloads keep working unchanged.
    val fdofs_js = bcs_js["fixed_dofs"];
    if (!fdofs_js.isUndefined() && !fdofs_js.isNull()) {
        unsigned n_fdofs = fdofs_js["length"].as<unsigned>();
        for (unsigned i = 0; i < n_fdofs; ++i) {
            val entry = fdofs_js[i];
            int vi = entry["vertex"].as<int>();
            val comps = entry["dofs"];
            unsigned nc = comps["length"].as<unsigned>();
            Array<int> vdofs;
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
    // into the solution GridFunction below so FormLinearSystem eliminates it and
    // moves its contribution to the load vector. Optional: absent payloads keep
    // the all-zero Dirichlet behaviour unchanged.
    std::vector<std::pair<int, double>> prescribed_vals;
    val pdofs_js = bcs_js["prescribed_dofs"];
    if (!pdofs_js.isUndefined() && !pdofs_js.isNull()) {
        unsigned n_pdofs = pdofs_js["length"].as<unsigned>();
        for (unsigned i = 0; i < n_pdofs; ++i) {
            val entry = pdofs_js[i];
            int vi = entry["vertex"].as<int>();
            int d  = entry["dof"].as<int>();
            double value = entry["value"].as<double>();
            Array<int> vdofs;
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
    if (order >= 2) {
        int n_edges = mfem_mesh.GetNEdges();
        for (int e = 0; e < n_edges; ++e) {
            Array<int> ev;
            mfem_mesh.GetEdgeVertices(e, ev);
            auto it0 = vdir.find(ev[0]);
            auto it1 = vdir.find(ev[1]);
            if (it0 == vdir.end() || it1 == vdir.end()) continue;
            Array<int> edofs;
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

    ess_tdof.Sort();
    ess_tdof.Unique();

    GridFunction x(&fespace);
    x = 0.0;
    // Seed the prescribed components before FormLinearSystem so the eliminated
    // essential DOFs carry the requested displacement instead of zero.
    for (const auto& pv : prescribed_vals)
        x[pv.first] = pv.second;

    LinearForm b(&fespace);

    // ── Surface (traction / pressure) loads ──────────────────────────────────
    // Work-equivalent surface loads applied through MFEM's boundary linear-form
    // integrator: f_i = ∫_S N_i · t dS. Unlike splitting a face's total force
    // equally across its nodes, this weights each node by the shape-function
    // integral of its tributary surface, so (a) corner/edge nodes get the right
    // share and (b) the resultant passes through the face's area-centroid no
    // matter how non-uniformly the face is meshed — no spurious moment.
    //
    // Each entry tags the boundary elements covering a set of surface faces
    // (matched by sorted node-index list) with a unique boundary attribute,
    // then a VectorBoundaryLFIntegrator restricted to that attribute applies:
    //   type "force"    — total force F spread as a uniform traction F / A_total
    //   type "traction" — a traction vector applied directly
    //   type "pressure" — scalar p applied as -p·n̂ (outward normal; + pushes in)
    //
    // The integrators take ownership of their coefficient by reference and the
    // marker arrays by pointer, so both must outlive b.Assemble(); they are held
    // in stable-address containers below.
    std::deque<std::unique_ptr<VectorCoefficient>> surf_coeffs;
    std::deque<Array<int>> surf_markers;

    val surf_js = bcs_js["surface_loads"];
    if (!surf_js.isUndefined() && !surf_js.isNull()) {
        unsigned n_surf = surf_js["length"].as<unsigned>();

        // sorted boundary-face vertex list → boundary element index, over the
        // auto-generated boundary mesh (its vertex indices equal the input node
        // IDs). Keyed by a sorted vertex vector so it matches both triangular
        // (tet) and quadrilateral (hex) boundary faces.
        std::map<std::vector<int>, int> face_to_be;
        for (int be = 0; be < mfem_mesh.GetNBE(); ++be) {
            Array<int> bv;
            mfem_mesh.GetBdrElementVertices(be, bv);
            std::vector<int> key(bv.begin(), bv.end());
            std::sort(key.begin(), key.end());
            face_to_be[key] = be;
        }

        struct PendingLoad { int attr; std::unique_ptr<VectorCoefficient> coeff; };
        std::vector<PendingLoad> pending;
        int next_attr = 2;  // attribute 1 stays the default (un-loaded) value

        for (unsigned i = 0; i < n_surf; ++i) {
            val entry = surf_js[i];
            std::string type = entry["type"].as<std::string>();
            val faces = entry["faces"];  // node-index lists (3 = tri, 4 = quad)
            unsigned n_faces = faces["length"].as<unsigned>();

            int attr = next_attr;
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
                mfem_mesh.GetBdrElement(it->second)->SetAttribute(attr);
                ++matched;
            }
            if (matched == 0) {
                printf("[mfem] surface_load %u (%s): no boundary elements matched "
                       "%u faces — skipped\n", i, type.c_str(), n_faces);
                continue;
            }
            // This load owns `attr` (its elements are now tagged); reserve the
            // next number so a later skip can't make two loads share an attribute.
            ++next_attr;

            std::unique_ptr<VectorCoefficient> coeff;
            if (type == "pressure") {
                double p = entry["pressure"].as<double>();
                coeff = std::make_unique<PressureCoefficient>(dim, p);
                printf("[mfem] surface_load %u: pressure %g over %d bdr elems\n",
                       i, p, matched);
            } else {  // "force" or "traction"
                Vector tvec(3);
                tvec[0] = entry["force"][0].as<double>();
                tvec[1] = entry["force"][1].as<double>();
                tvec[2] = entry["force"][2].as<double>();
                if (type == "force") {
                    // Total force → uniform traction: divide by the integrated area
                    // of the matched boundary elements — the same surface measure
                    // the integrator uses, so it is exact for straight-sided faces.
                    double area = 0.0;
                    for (int be = 0; be < mfem_mesh.GetNBE(); ++be) {
                        if (mfem_mesh.GetBdrAttribute(be) != attr) continue;
                        ElementTransformation* T =
                            mfem_mesh.GetBdrElementTransformation(be);
                        const IntegrationRule& ir =
                            IntRules.Get(mfem_mesh.GetBdrElementGeometry(be), 4);
                        for (int q = 0; q < ir.GetNPoints(); ++q) {
                            const IntegrationPoint& ip = ir.IntPoint(q);
                            T->SetIntPoint(&ip);
                            area += ip.weight * T->Weight();
                        }
                    }
                    if (area <= 0.0) {
                        printf("[mfem] surface_load %u: zero matched area — skipped\n", i);
                        continue;
                    }
                    tvec /= area;
                    printf("[mfem] surface_load %u: force → traction [%g %g %g] over "
                           "%d bdr elems (A=%g)\n",
                           i, tvec[0], tvec[1], tvec[2], matched, area);
                } else {
                    printf("[mfem] surface_load %u: traction [%g %g %g] over %d bdr elems\n",
                           i, tvec[0], tvec[1], tvec[2], matched);
                }
                coeff = std::make_unique<VectorConstantCoefficient>(tvec);
            }
            pending.push_back({ attr, std::move(coeff) });
        }

        // Refresh the mesh attribute tables now that boundary attributes changed,
        // so marker arrays can be sized to bdr_attributes.Max().
        mfem_mesh.SetAttributes();
        int max_attr = mfem_mesh.bdr_attributes.Size()
                           ? mfem_mesh.bdr_attributes.Max() : 0;
        for (auto& pl : pending) {
            surf_coeffs.push_back(std::move(pl.coeff));
            surf_markers.emplace_back(max_attr);
            Array<int>& marker = surf_markers.back();
            marker = 0;
            if (pl.attr >= 1 && pl.attr <= max_attr)
                marker[pl.attr - 1] = 1;
            b.AddBoundaryIntegrator(
                new VectorBoundaryLFIntegrator(*surf_coeffs.back()), marker);
        }
    }

    b.Assemble();

    // Concentrated point loads — applied straight to the assembled load vector.
    // Still used for explicit nodal forces and for the equivalent nodal forces of
    // a moment load. Surface (face) forces now flow through surface_loads above.
    for (unsigned i = 0; i < n_loads; ++i) {
        val load  = loads_js[i];
        int vi    = load["vertex"].as<int>();
        val force = load["force"];
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        if (vdofs.Size() >= 3) {
            b[vdofs[0]] += force[0].as<double>();
            b[vdofs[1]] += force[1].as<double>();
            b[vdofs[2]] += force[2].as<double>();
        }
    }

    BilinearForm a(&fespace);
    ConstantCoefficient lam_c(lam), mu_c(mu);
    a.AddDomainIntegrator(new ElasticityIntegrator(lam_c, mu_c));
    printf("[mfem] assembling stiffness matrix…\n"); fflush(stdout);
    a.Assemble();
    printf("[mfem] assembly done\n"); fflush(stdout);
    log_mem("solve: after stiffness assembly");

    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess_tdof, x, b, A, X, B);

    SparseMatrix& A_mat = *A.As<SparseMatrix>();
    // GSSmoother (Gauss-Seidel) is numerically robust for 3D elasticity after
    // Dirichlet BC elimination.  DSmoother (Jacobi) diverges on ill-conditioned
    // tet systems, producing NaN residuals that crash the WASM worker.
    GSSmoother prec(A_mat);
    CGSolver cg;
    // Order 1: a loose 1e-1 tolerance is enough for a visual linear-FEM field and
    // converges in ~20 iterations (vs ~1000+ for 1e-6), keeping showcase solves
    // under 60 s in WASM. Order ≥ 2: the quadratic field is only worth its extra
    // DOFs if it's actually converged — a loose tolerance leaves visible noise in
    // the recovered stress — so tighten to 1e-6 and allow more iterations. The
    // user opts into this slower, more accurate solve via the element-order setting.
    if (order >= 2) {
        cg.SetRelTol(1e-6);
        cg.SetMaxIter(5000);
    } else {
        cg.SetRelTol(1e-6);
        cg.SetMaxIter(1000);
    }
    cg.SetPrintLevel(1);  // print final iteration count to help diagnose convergence
    cg.SetPreconditioner(prec);
    cg.SetOperator(A_mat);
    printf("[mfem] starting CG solve (%d rows)…\n", A_mat.Height()); fflush(stdout);
    log_mem("solve: before CG solve");
    cg.Mult(B, X);
    a.RecoverFEMSolution(X, b, x);
    printf("[mfem] CG done — computing von Mises stress…\n"); fflush(stdout);
    log_mem("solve: after CG solve");

    int n_verts = mfem_mesh.GetNV();
    int n_elems = mfem_mesh.GetNE();

    std::vector<double> displacements(3 * n_verts, 0.0);
    for (int vi = 0; vi < n_verts; ++vi) {
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c)
            displacements[3*vi + c] = x[vdofs[c]];
    }

    std::vector<double> von_mises(n_elems);
    for (int e = 0; e < n_elems; ++e) {
        ElementTransformation* T = mfem_mesh.GetElementTransformation(e);
        const IntegrationRule& ir = IntRules.Get(mfem_mesh.GetElementGeometry(e), 1);
        T->SetIntPoint(&ir.IntPoint(0));

        DenseMatrix grad_u;
        x.GetVectorGradient(*T, grad_u);

        double eps[3][3];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                eps[i][j] = 0.5 * (grad_u(i,j) + grad_u(j,i));

        double tr_eps = eps[0][0] + eps[1][1] + eps[2][2];
        double s[3][3];
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

    printf("[mfem] solve complete: %d vertex displacements, %d element stresses\n",
           n_verts, n_elems);
    fflush(stdout);
    log_mem("solve: complete");

    return "{\"displacements\":" + json_doubles(displacements) +
           ",\"von_mises\":"     + json_doubles(von_mises)     + "}";
}
