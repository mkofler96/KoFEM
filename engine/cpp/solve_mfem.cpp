// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// MFEM: linear-elastic FEM solve. See solve_mfem.h.
//
// solve_linear_elastic is a thin orchestrator over the pipeline stages below
// (issue #293): copy in the mesh typed arrays → build the MFEM mesh → collect essential
// (Dirichlet) DOFs → assemble loads → CG solve → recover displacements and
// von Mises stress. A model with tie constraints (issue #357) takes the same
// stages but solves the master-slave reduced system TᵀKT instead — see
// solve_tied_system. Two orderings are load-bearing and owned by the
// orchestrator, not the helpers: the surface-load coefficient/marker storage
// must outlive b.Assemble(), and prescribed displacement values must be seeded
// into the solution GridFunction before FormLinearSystem.

#include "solve_mfem.h"

#include "bc_validation.h"
#include "cg_browser.h"
#include "cg_mfem.h"
#include "fem_bc_io.h"
#include "fem_mesh_io.h"
#include "json_util.h"
#include "tie_constraints.h"
#include "wasm_util.h"

#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <deque>
#include <limits>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using emscripten::val;

namespace {

constexpr int dim = 3;

// ── Solve / post-processing ───────────────────────────────────────────────────

void run_cg_solve(mfem::SparseMatrix& A_mat, const mfem::Vector& B, mfem::Vector& X) {
    printf("[mfem] starting CG solve (%d rows)…\n", A_mat.Height()); fflush(stdout);
    log_mem("solve: before CG solve");
    kofem::solve_mfem_cg(A_mat, B, X, browser_cg_control());
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
// displacement gradient, Cauchy stress via the Lamé constants of the element's
// material (attribute = 1-based index into lam/mu), then the deviatoric second
// invariant √(3/2 s:s).
std::vector<double> compute_von_mises(mfem::Mesh& mesh, const mfem::GridFunction& x,
                                      const mfem::Vector& lam_by_mat,
                                      const mfem::Vector& mu_by_mat) {
    int n_elems = mesh.GetNE();
    std::vector<double> von_mises(n_elems);
    for (int e = 0; e < n_elems; ++e) {
        const double lam = lam_by_mat(mesh.GetAttribute(e) - 1);
        const double mu  = mu_by_mat(mesh.GetAttribute(e) - 1);
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

// ── Tie constraints (issue #357) ──────────────────────────────────────────────

// Plain JSON number array → vector. `what` names the field in the error.
template <typename T>
std::vector<T> json_array(const val& array_js, const char* what) {
    if (!val::global("Array").call<bool>("isArray", array_js))
        throw std::runtime_error(std::string("solve: ") + what + " must be an array");
    const unsigned n = array_js["length"].as<unsigned>();
    std::vector<T> out(n);
    for (unsigned i = 0; i < n; ++i) out[i] = array_js[i].as<T>();
    return out;
}

// bcs.tie_constraints = { slave, offsets, master, weights } — CSR node ties
// over mesh vertices, see tie_constraints.h and fe_node_ties for how the
// weights are read at each element order. Optional: a model with no constraint
// tie omits it.
kofem::fem::NodeTies parse_tie_constraints(const val& ties_js) {
    kofem::fem::NodeTies ties;
    if (ties_js.isUndefined() || ties_js.isNull()) return ties;
    ties.slave   = json_array<int>(ties_js["slave"], "tie_constraints.slave");
    ties.offsets = json_array<int>(ties_js["offsets"], "tie_constraints.offsets");
    ties.master  = json_array<int>(ties_js["master"], "tie_constraints.master");
    ties.weights = json_array<double>(ties_js["weights"], "tie_constraints.weights");
    return ties;
}

// Turn the vertex ties of the payload into ties between the NODES of the FE
// space (its scalar DOFs: vertices, and for a quadratic space edge midpoints
// and quadrilateral face centres).
//
// Linear elements (order 1): the payload's weights ARE the tie — the dual
// mortar weights the frontend integrates over the interface
// (web/src/lib/tieMortar.ts) — and are applied as sent.
//
// Quadratic elements (order 2): the payload names, per tied vertex, the
// vertices of the face it projects onto and the linear weights of the
// projection (node-to-surface). The vertex must follow the face's displacement
// FIELD, so the projection point is mapped back into the face and the face's
// own shape functions are evaluated there — bilinear on a quadrilateral,
// quadratic on a second-order face. (Interpolating a quadratic face from its
// corners alone would load it at the corners only and leave the joint soft.)
//
// A quadratic space also has nodes ON the tied surface that no vertex tie
// reaches. Where every vertex of an edge or quadrilateral face is tied, that
// edge/face node follows the master field too, at the mean of its vertices'
// projections — so the whole surface follows, not just its corners.
kofem::fem::NodeTies fe_node_ties(mfem::FiniteElementSpace& fespace,
                                  const kofem::fem::NodeTies& vertex_ties, int order) {
    mfem::Mesh& mesh = *fespace.GetMesh();
    const int n_verts = mesh.GetNV();
    kofem::fem::validate_node_ties(vertex_ties, n_verts);
    if (order > 2)
        throw std::runtime_error(
            "tie constraints support linear and quadratic elements, not order " +
            std::to_string(order));

    std::vector<int> vertex_node((size_t)n_verts);
    mfem::Array<int> dofs;
    for (int vi = 0; vi < n_verts; ++vi) {
        fespace.GetVertexDofs(vi, dofs);
        vertex_node[vi] = dofs[0];
    }
    if (order == 1) {
        kofem::fem::NodeTies out = vertex_ties;
        for (int& slave : out.slave) slave = vertex_node[slave];
        for (int& master : out.master) master = vertex_node[master];
        return out;
    }
    // Boundary faces around each vertex, to find the face a tie projects onto.
    std::vector<std::vector<int>> faces_of((size_t)n_verts);
    mfem::Array<int> face_vertices;
    for (int be = 0; be < mesh.GetNBE(); ++be) {
        mesh.GetBdrElementVertices(be, face_vertices);
        for (int v : face_vertices) faces_of[v].push_back(be);
    }

    kofem::fem::NodeTies out;
    out.offsets.push_back(0);
    // Tie the FE node `slave_dof` to the master surface's displacement field at
    // `target`: of the candidate free faces, the one the point projects onto
    // most closely, with that face's own shape functions (bilinear,
    // quadratic, …) evaluated at the projection.
    mfem::Vector shape, mapped(dim);
    const auto tie_to_field = [&](int slave_dof, const mfem::Vector& target,
                                  const std::vector<int>& candidates, int what) {
        int best_face = -1;
        double best_distance = std::numeric_limits<double>::infinity();
        mfem::IntegrationPoint best_ip;
        for (int be : candidates) {
            mfem::ElementTransformation* transformation = mesh.GetBdrElementTransformation(be);
            mfem::IntegrationPoint ip;
            transformation->TransformBack(target, ip);
            mfem::Geometry::ProjectPoint(mesh.GetBdrElementGeometry(be), ip);
            transformation->SetIntPoint(&ip);
            transformation->Transform(ip, mapped);
            const double distance = mapped.DistanceTo(target);
            if (distance < best_distance) {
                best_distance = distance;
                best_face = be;
                best_ip = ip;
            }
        }
        if (best_face < 0)
            throw std::runtime_error("tie constraints: no master face for tied node " +
                                     std::to_string(what));
        const mfem::FiniteElement* element = fespace.GetBE(best_face);
        shape.SetSize(element->GetDof());
        element->CalcShape(best_ip, shape);
        fespace.GetBdrElementDofs(best_face, dofs);
        out.slave.push_back(slave_dof);
        double sum = 0.0;
        const size_t first = out.master.size();
        for (int i = 0; i < dofs.Size(); ++i) {
            if (std::abs(shape[i]) < 1e-12) continue;
            out.master.push_back(dofs[i]);
            out.weights.push_back(shape[i]);
            sum += shape[i];
        }
        // Shape functions sum to one; dropping the negligible ones must not
        // break that, or the tie would resist a rigid motion.
        for (size_t i = first; i < out.weights.size(); ++i) out.weights[i] /= sum;
        out.offsets.push_back((int)out.master.size());
        return best_face;
    };

    // Per tied vertex: the point it projects onto, and the master faces around
    // the face it lands on — where its edge and face neighbours land too.
    std::vector<char> tied((size_t)n_verts, 0);
    std::vector<mfem::Vector> projected((size_t)n_verts);
    std::vector<std::vector<int>> nearby_faces((size_t)n_verts);
    for (size_t k = 0; k < vertex_ties.slave.size(); ++k) {
        const int slave = vertex_ties.slave[k];
        const int begin = vertex_ties.offsets[k];
        const int end = vertex_ties.offsets[k + 1];
        tied[slave] = 1;

        // The free faces that hold every master of this tie.
        std::vector<int> holding;
        for (int be : faces_of[vertex_ties.master[begin]]) {
            mesh.GetBdrElementVertices(be, face_vertices);
            bool holds_all = true;
            for (int i = begin; i < end && holds_all; ++i)
                holds_all = face_vertices.Find(vertex_ties.master[i]) >= 0;
            if (holds_all) holding.push_back(be);
        }
        if (holding.empty())
            throw std::runtime_error(
                "tie constraints: the nodes vertex " + std::to_string(slave) +
                " is tied to do not lie on one free element face");
        mfem::Vector& point = projected[slave];
        point.SetSize(dim);
        point = 0.0;
        for (int i = begin; i < end; ++i)
            for (int c = 0; c < dim; ++c)
                point[c] += vertex_ties.weights[i] * mesh.GetVertex(vertex_ties.master[i])[c];
        const int face = tie_to_field(vertex_node[slave], point, holding, slave);

        mesh.GetBdrElementVertices(face, face_vertices);
        std::vector<int>& around = nearby_faces[slave];
        for (int v : face_vertices)
            for (int be : faces_of[v])
                if (std::find(around.begin(), around.end(), be) == around.end())
                    around.push_back(be);
    }

    if (order == 2) {
        // An edge midpoint or quadrilateral face centre whose vertices are all
        // tied follows the master field at the mean of their projections —
        // the master's quadratic field, not the mean of the slave vertices,
        // which would open a gap wherever the master face curves.
        const auto tie_interior = [&](const mfem::Array<int>& vertices,
                                      const mfem::Array<int>& interior) {
            if (interior.Size() != 1) return;
            for (int v : vertices)
                if (tied[v] == 0) return;
            mfem::Vector target(dim);
            target = 0.0;
            std::vector<int> candidates;
            for (int v : vertices) {
                target.Add(1.0 / vertices.Size(), projected[v]);
                for (int be : nearby_faces[v])
                    if (std::find(candidates.begin(), candidates.end(), be) == candidates.end())
                        candidates.push_back(be);
            }
            tie_to_field(interior[0], target, candidates, vertices[0]);
        };
        mfem::Array<int> vertices, interior;
        for (int e = 0; e < mesh.GetNEdges(); ++e) {
            mesh.GetEdgeVertices(e, vertices);
            fespace.GetEdgeInteriorDofs(e, interior);
            tie_interior(vertices, interior);
        }
        for (int f = 0; f < mesh.GetNFaces(); ++f) {
            mesh.GetFaceVertices(f, vertices);
            fespace.GetFaceInteriorDofs(f, interior);
            tie_interior(vertices, interior);
        }
    }
    return out;
}

// Impose q[i] = values[i] on the rows marked essential: the known columns move
// to the right-hand side and each essential row/column becomes the identity,
// which keeps the system symmetric. One pass over the stored entries;
// SparseMatrix::EliminateRowCol is not used because it aborts unless every
// stored entry has a stored transpose, and finalizing the assembled stiffness
// drops exact zeros whose transpose is round-off (seen on hexahedra).
void eliminate_essential(mfem::SparseMatrix& A, mfem::Vector& rhs,
                         const std::vector<char>& is_essential, const mfem::Vector& values) {
    const int* I = A.GetI();
    const int* J = A.GetJ();
    mfem::real_t* data = A.GetData();
    for (int row = 0; row < A.Height(); ++row) {
        if (is_essential[row] != 0) {
            for (int k = I[row]; k < I[row + 1]; ++k) data[k] = J[k] == row ? 1.0 : 0.0;
            rhs[row] = values[row];
            continue;
        }
        for (int k = I[row]; k < I[row + 1]; ++k) {
            if (is_essential[J[k]] == 0) continue;
            rhs[row] -= data[k] * values[J[k]];
            data[k] = 0.0;
        }
    }
}

// Solve K·u = f under the tie constraints u = T·q and the essential BCs, and
// write u into `x`.
//
// The slave DOFs are eliminated first (K_r = TᵀKT, f_r = Tᵀf) and the essential
// BCs are applied to the reduced system — in that order, so a prescribed value
// on a master reaches its slaves through T, and a slave that is itself
// prescribed simply keeps its BC (build_tie_reduction leaves it untied).
// Takes ownership of the assembled stiffness so K and K_r are not both alive
// during the CG solve.
void solve_tied_system(std::unique_ptr<mfem::SparseMatrix> K, const mfem::Vector& f,
                       const kofem::fem::NodeTies& vertex_ties,
                       const kofem::fem::EssentialBcs& ess,
                       mfem::FiniteElementSpace& fespace, int order, mfem::GridFunction& x) {
    const int n_nodes = fespace.GetNDofs();
    const int n_dofs = fespace.GetVSize();

    const kofem::fem::NodeTies ties = fe_node_ties(fespace, vertex_ties, order);
    std::vector<int> node_dof(3 * (size_t)n_nodes);
    for (int node = 0; node < n_nodes; ++node)
        for (int c = 0; c < dim; ++c) node_dof[3 * (size_t)node + c] = fespace.DofToVDof(node, c);
    std::vector<char> essential((size_t)n_dofs, 0);
    for (int i = 0; i < ess.ess_tdof.Size(); ++i) essential[ess.ess_tdof[i]] = 1;

    const kofem::fem::TieReduction reduction =
        kofem::fem::build_tie_reduction(ties, n_nodes, node_dof, essential);
    printf("[mfem] tie constraints: %zu tied node(s), %d DOF(s) eliminated → %d unknowns\n",
           vertex_ties.slave.size(), reduction.n_eliminated, reduction.n_reduced);
    if (reduction.n_prescribed > 0)
        printf("[mfem] %d tied DOF(s) are also fixed or prescribed — the boundary "
               "condition applies there\n", reduction.n_prescribed);
    fflush(stdout);

    mfem::SparseMatrix T(n_dofs, reduction.n_reduced);
    for (int dof = 0; dof < n_dofs; ++dof) {
        if (reduction.reduced_of[dof] >= 0) {
            T.Add(dof, reduction.reduced_of[dof], 1.0);
            continue;
        }
        for (const auto& [index, weight] : reduction.rows[dof]) T.Add(dof, index, weight);
    }
    T.Finalize();

    std::unique_ptr<mfem::SparseMatrix> K_reduced(mfem::RAP(T, *K, T));
    K.reset();
    K_reduced->SortColumnIndices();
    mfem::Vector f_reduced(reduction.n_reduced);
    T.MultTranspose(f, f_reduced);
    log_mem("solve: after tie reduction");

    // Essential DOFs are never eliminated, so each has a reduced index.
    std::map<int, double> prescribed(ess.prescribed_vals.begin(), ess.prescribed_vals.end());
    std::vector<char> is_essential((size_t)reduction.n_reduced, 0);
    mfem::Vector q(reduction.n_reduced);
    q = 0.0;
    for (int i = 0; i < ess.ess_tdof.Size(); ++i) {
        const int dof = ess.ess_tdof[i];
        const auto found = prescribed.find(dof);
        const int index = reduction.reduced_of[dof];
        is_essential[index] = 1;
        q[index] = found == prescribed.end() ? 0.0 : found->second;
    }
    eliminate_essential(*K_reduced, f_reduced, is_essential, q);

    run_cg_solve(*K_reduced, f_reduced, q);
    T.Mult(q, x);
}

}  // namespace

namespace {
// Explicit error object for input validation, mirroring the previous JSON
// {"error": ...} contract (issue #344) — the worker checks for the key and
// surfaces the message without tripping the C++-exception decode path.
val error_result(const char* message) {
    val err = val::object();
    err.set("error", std::string(message));
    return err;
}
}  // namespace

val solve_linear_elastic(
    val mesh_js,
    const std::string& mat_json,
    const std::string& bcs_json,
    int order)
{
    using namespace mfem;

    log_mem("solve: start");
    printf("[mfem] solve_linear_elastic: parsing inputs\n"); fflush(stdout);
    val mat_js  = parse_json(mat_json);
    val bcs_js  = parse_json(bcs_json);

    kofem::fem::MeshArrays mesh_arrays = kofem::fem::parse_mesh(mesh_js);

    // mat_json is either an array of materials — element attribute k selects
    // the k-th entry (multibody per-body materials, issue #353) — or a single
    // material object, the pre-#353 contract still used by direct callers.
    const bool is_mat_array =
        val::global("Array").call<bool>("isArray", mat_js);
    const unsigned n_mats =
        is_mat_array ? mat_js["length"].as<unsigned>() : 1U;
    if (n_mats == 0) {
        return error_result("materials array is empty — at least one material is required");
    }
    std::vector<double> E_by_mat(n_mats);
    std::vector<double> nu_by_mat(n_mats);
    for (unsigned k = 0; k < n_mats; ++k) {
        val mat    = is_mat_array ? mat_js[k] : mat_js;
        val E_val  = mat["young_modulus"];
        val nu_val = mat["poisson_ratio"];
        if (E_val.isNull() || E_val.isUndefined()) {
            return error_result(
                ("material " + std::to_string(k + 1) + " is missing young_modulus").c_str());
        }
        if (nu_val.isNull() || nu_val.isUndefined()) {
            return error_result(
                ("material " + std::to_string(k + 1) + " is missing poisson_ratio").c_str());
        }
        E_by_mat[k]  = E_val.as<double>();
        nu_by_mat[k] = nu_val.as<double>();
    }
    for (int a : mesh_arrays.attrs) {
        if ((unsigned)a > n_mats) {
            return error_result(
                ("mesh.attributes references material " + std::to_string(a) +
                 " but only " + std::to_string(n_mats) + " material(s) were provided").c_str());
        }
    }

    val loads_js = bcs_js["point_loads"];
    printf("[mfem] BCs: %u fixed vertices, %u point loads\n",
           bcs_js["fixed_vertices"]["length"].as<unsigned>(),
           loads_js["length"].as<unsigned>());
    fflush(stdout);
    log_mem("solve: after extracting mesh data");

    Mesh mfem_mesh = kofem::fem::build_mfem_mesh(mesh_arrays);

    order = std::max(1, order);
    // Lamé constants per material, indexed by (element attribute − 1) — the
    // layout PWConstCoefficient expects.
    Vector lam_by_mat((int)n_mats), mu_by_mat((int)n_mats);
    for (unsigned k = 0; k < n_mats; ++k) {
        const double E  = E_by_mat[k];
        const double nu = nu_by_mat[k];
        lam_by_mat((int)k) = E * nu / ((1.0 + nu) * (1.0 - 2.0*nu));
        mu_by_mat((int)k)  = E / (2.0 * (1.0 + nu));
    }
    if (n_mats > 1) {
        printf("[mfem] %u materials (per-element attributes)\n", n_mats);
        fflush(stdout);
    }

    printf("[mfem] setting up H1 FE space (order=%d, dim=%d)…\n", order, dim);
    fflush(stdout);
    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mfem_mesh, &fec, dim);
    printf("[mfem] FE space: %d dofs\n", fespace.GetTrueVSize());
    fflush(stdout);
    log_mem("solve: after FE space setup");

    kofem::fem::EssentialBcs ess =
        kofem::fem::collect_essential_dofs(bcs_js, mfem_mesh, fespace, order);
    const kofem::fem::NodeTies ties = parse_tie_constraints(bcs_js["tie_constraints"]);

    GridFunction x(&fespace);
    x = 0.0;
    // Seed the prescribed components before FormLinearSystem so the eliminated
    // essential DOFs carry the requested displacement instead of zero.
    for (const auto& pv : ess.prescribed_vals)
        x[pv.first] = pv.second;

    LinearForm b(&fespace);
    // Coefficients/markers referenced by b's integrators — must outlive
    // b.Assemble(), hence owned here rather than inside apply_surface_loads.
    kofem::fem::SurfaceLoadStorage surf_storage;
    kofem::fem::apply_surface_loads(bcs_js["surface_loads"], mfem_mesh, b, surf_storage);

    b.Assemble();

    kofem::fem::apply_point_loads(loads_js, fespace, b);

    BilinearForm a(&fespace);
    // Piecewise-constant over element attributes: attribute k reads entry k−1.
    // With a single material every element has attribute 1, reproducing the
    // former ConstantCoefficient behaviour exactly.
    PWConstCoefficient lam_c(lam_by_mat), mu_c(mu_by_mat);
    a.AddDomainIntegrator(new ElasticityIntegrator(lam_c, mu_c));
    printf("[mfem] assembling stiffness matrix…\n"); fflush(stdout);
    a.Assemble();
    printf("[mfem] assembly done\n"); fflush(stdout);
    log_mem("solve: after stiffness assembly");

    if (ties.empty()) {
        OperatorPtr A;
        Vector B, X;
        a.FormLinearSystem(ess.ess_tdof, x, b, A, X, B);

        run_cg_solve(*A.As<SparseMatrix>(), B, X);
        a.RecoverFEMSolution(X, b, x);
    } else {
        a.Finalize();
        solve_tied_system(std::unique_ptr<SparseMatrix>(a.LoseMat()), b, ties, ess,
                          fespace, order, x);
    }
    printf("[mfem] CG done — computing von Mises stress…\n"); fflush(stdout);
    log_mem("solve: after CG solve");

    std::vector<double> displacements =
        extract_displacements(fespace, x, mfem_mesh.GetNV());
    std::vector<double> von_mises =
        compute_von_mises(mfem_mesh, x, lam_by_mat, mu_by_mat);

    printf("[mfem] solve complete: %d vertex displacements, %d element stresses\n",
           mfem_mesh.GetNV(), mfem_mesh.GetNE());
    fflush(stdout);
    log_mem("solve: complete");

    // Flat typed arrays instead of JSON text (issue #166): three Float64
    // displacement components per vertex, one Float64 von Mises value per
    // element. The worker transfers both buffers to the main thread zero-copy.
    val result = val::object();
    result.set("displacements", float64_array(displacements));
    result.set("von_mises",     float64_array(von_mises));
    return result;
}
