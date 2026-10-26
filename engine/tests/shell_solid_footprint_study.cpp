// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-215: physical-footprint shell/solid transition, using existing kinematic
// constraints, not a change to generic remote RBE3 couplings. A conforming seam
// section follows Kirchhoff kinematics u(x,y) = u_mid(x) + theta(x) x offset(y).
// Compare a tie at the joint with one placed 3 or 6 mm up a retained solid wall.
// Refine x/y/z, wall height and wall thickness together. The sharp T-junction
// peak is mesh-dependent: also compare fixed-volume averages and the block vM
// field, and check global force/moment balance. This is a model study, not a
// general non-conforming interface implementation or an absolute peak accuracy gate.

#include "shell_core.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

using namespace kofem::shell;

namespace {
using Vec3 = std::array<double, 3>;
constexpr double L = 60, W = 40, H = 6, Hw = 30, t = 2;
constexpr double E = 210e3, nu = 0.3, P = 100;

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error("footprint study: " + message);
}

Vec3 cross(const Vec3& a, const Vec3& b) {
    return {a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]};
}

double norm(const Vec3& a) { return std::sqrt(a[0]*a[0]+a[1]*a[1]+a[2]*a[2]); }

Vec3 point(const std::vector<double>& vertices, int n) {
    const size_t b = 3 * static_cast<size_t>(n);
    return {vertices[b], vertices[b+1], vertices[b+2]};
}

double tet_volume(const std::vector<double>& vertices, const std::vector<int>& tets, size_t e) {
    const auto a = point(vertices, tets[4*e]);
    std::array<Vec3, 3> d{};
    for (int j = 0; j < 3; ++j) {
        const auto b = point(vertices, tets[4*e+j+1]);
        for (int c = 0; c < 3; ++c) d[j][c] = b[c]-a[c];
    }
    const auto product = cross(d[1], d[2]);
    return std::abs(d[0][0]*product[0]+d[0][1]*product[1]+d[0][2]*product[2])/6;
}

struct Result {
    double peak = 0, tip = 0, near = 0, gauge = 0;
    double force_error = 0, moment_error = 0;
    std::vector<double> block_vm, block_volume;
};

// collar_height < 0: all-solid reference; 0: shell starts at the block top;
// 3/6: retain that much of the wall as solid, then transition to shell.
Result junction(int refinement, int collar_height, int load_axis) {
    const int nx = 12*refinement, nz = 3*refinement, nt = refinement, nzw = 10*refinement;
    const int solid_layers = collar_height < 0 ? nzw : collar_height*refinement/3;
    const std::array<double, 10> base_y = {0, 5, 10, 15, 19, 21, 25, 30, 35, 40};
    std::vector<double> ys;
    for (size_t j = 0; j+1 < base_y.size(); ++j)
        for (int k = 0; k < refinement; ++k)
            ys.push_back(base_y[j]+(base_y[j+1]-base_y[j])*k/refinement);
    ys.push_back(W);
    const int ny = static_cast<int>(ys.size())-1;
    std::vector<double> vertices;
    std::vector<int> tets, top_layer;
    auto sid = [&](int i, int j, int k) { return (i*(ny+1)+j)*(nz+1)+k; };
    for (int i = 0; i <= nx; ++i)
        for (double y : ys)
            for (int k = 0; k <= nz; ++k)
                vertices.insert(vertices.end(), {L*i/nx, y, H*k/nz});
    auto cube = [&](const std::array<int, 8>& nodes, bool is_top) {
        constexpr std::array<std::array<int, 4>, 6> decomposition = {{
            {0,1,2,6}, {0,2,3,6}, {0,3,7,6}, {0,7,4,6}, {0,4,5,6}, {0,5,1,6}}};
        for (const auto& tet : decomposition) {
            if (is_top) top_layer.push_back(static_cast<int>(tets.size()/4));
            for (int n : tet) tets.push_back(nodes[n]);
        }
    };
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < ny; ++j)
            for (int k = 0; k < nz; ++k)
                cube({sid(i,j,k), sid(i+1,j,k), sid(i+1,j+1,k), sid(i,j+1,k),
                      sid(i,j,k+1), sid(i+1,j,k+1), sid(i+1,j+1,k+1), sid(i,j+1,k+1)},
                     k == nz-1);
    const size_t n_block_tets = tets.size()/4;
    const int n_block_nodes = static_cast<int>(vertices.size()/3);
    auto wid = [&](int i, int j, int k) {
        return k == 0 ? sid(i,4*refinement+j,nz) :
               n_block_nodes+(i*(nt+1)+j)*solid_layers+k-1;
    };
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= nt; ++j)
            for (int k = 1; k <= solid_layers; ++k)
                vertices.insert(vertices.end(), {L*i/nx, W/2-t/2+t*j/nt, H+Hw*k/nzw});
    for (int i = 0; i < nx; ++i)
        for (int j = 0; j < nt; ++j)
            for (int k = 0; k < solid_layers; ++k)
                cube({wid(i,j,k), wid(i+1,j,k), wid(i+1,j+1,k), wid(i,j+1,k),
                      wid(i,j,k+1), wid(i+1,j,k+1), wid(i+1,j+1,k+1), wid(i,j+1,k+1)}, false);
    CoupledInput in;
    in.shell_young = E;
    in.shell_poisson = nu;
    in.thickness = t;
    if (collar_height < 0) {
        for (int i = 0; i <= nx; ++i)
            for (int j = 0; j <= nt; ++j) {
                const double wx = (i == 0 || i == nx) ? 0.5 : 1;
                const double wy = (j == 0 || j == nt) ? 0.5 : 1;
                in.loads.emplace_back(6*wid(i,j,nzw)+load_axis, P*wx*wy/(nx*nt));
            }
    } else {
        const int shell_start = static_cast<int>(vertices.size()/3);
        const int nh = nzw-solid_layers;
        auto shid = [&](int i, int k) { return shell_start+i*(nh+1)+k; };
        for (int i = 0; i <= nx; ++i)
            for (int k = 0; k <= nh; ++k)
                vertices.insert(vertices.end(), {L*i/nx, W/2, H+Hw*(k+solid_layers)/nzw});
        for (int i = 0; i < nx; ++i)
            for (int k = 0; k < nh; ++k) {
                const int a = shid(i,k), b = shid(i+1,k), c = shid(i+1,k+1), d = shid(i,k+1);
                in.triangles.insert(in.triangles.end(), {a,b,c, a,c,d});
            }
        for (int i = 0; i <= nx; ++i) {
            Coupling cp;
            cp.kind = CouplingKind::Kinematic;
            cp.ref_node = shid(i,0);
            // A section across the physical wall thickness, not a search ball.
            // Each solid node belongs to one section; no shared dependent DOFs.
            for (int j = 0; j <= nt; ++j) cp.solid_nodes.push_back(wid(i,j,solid_layers));
            in.couplings.push_back(std::move(cp));
            const double wx = (i == 0 || i == nx) ? 0.5 : 1;
            in.loads.emplace_back(6*shid(i,nh)+load_axis, P*wx/nx);
        }
    }
    in.vertices = vertices;
    in.n_nodes = static_cast<int>(vertices.size()/3);
    in.solid_stiffness = tet_solid_stiffness(vertices, tets, E, nu);
    for (int i = 0; i <= nx; ++i)
        for (int j = 0; j <= ny; ++j)
            for (int c = 0; c < 3; ++c) in.fixed_dofs.push_back(6*sid(i,j,0)+c);
    const auto solution = solve_solid_shell_core(in);
    require(solution.converged && std::isfinite(solution.rel_residual), "solve did not converge");
    const auto vm = tet_von_mises(vertices, tets, E, nu, solution.dofs);
    Result result;
    for (int e : top_layer) result.peak = std::max(result.peak, vm[e]);
    for (const auto& [dof, force] : in.loads) result.tip += force*solution.dofs[dof]/P;
    result.block_vm.assign(vm.begin(), vm.begin()+n_block_tets);
    double near_volume = 0, gauge_volume = 0;
    for (size_t e = 0; e < n_block_tets; ++e) {
        const double volume = tet_volume(vertices, tets, e);
        result.block_volume.push_back(volume);
        Vec3 centroid{};
        for (int j = 0; j < 4; ++j) {
            const auto p = point(vertices, tets[4*e+j]);
            for (int c = 0; c < 3; ++c) centroid[c] += p[c]/4;
        }
        if (centroid[1] < 19 || centroid[1] > 21) continue;
        // Fixed boxes, with boundaries aligned to every refinement:
        // x=[0,L], y=[19,21]; near z=[4,6], gauge z=[2,4] (mm).
        if (centroid[2] >= 4) {
            result.near += volume*vm[e];
            near_volume += volume;
        } else if (centroid[2] >= 2) {
            result.gauge += volume*vm[e];
            gauge_volume += volume;
        }
    }
    require(std::abs(near_volume-240) < 1e-8 && std::abs(gauge_volume-240) < 1e-8,
            "fixed stress-gauge volumes changed with refinement");
    result.near /= near_volume;
    result.gauge /= gauge_volume;

    std::vector<Vec3> reactions(static_cast<size_t>(in.n_nodes));
    for (const auto& entry : in.solid_stiffness) {
        const int node = entry.i/3;
        if (vertices[3*node+2] == 0)
            reactions[node][entry.i%3] += entry.v*solution.dofs[6*(entry.j/3)+entry.j%3];
    }
    Vec3 force{}, moment{};
    for (int n = 0; n < in.n_nodes; ++n) {
        const auto m = cross(point(vertices,n), reactions[n]);
        for (int c = 0; c < 3; ++c) { force[c] += reactions[n][c]; moment[c] += m[c]; }
    }
    for (const auto& [dof, value] : in.loads) {
        Vec3 applied{};
        applied[dof%6] = value;
        const auto m = cross(point(vertices,dof/6), applied);
        for (int c = 0; c < 3; ++c) { force[c] += applied[c]; moment[c] += m[c]; }
    }
    result.force_error = norm(force)/P;
    result.moment_error = norm(moment)/(P*(L+W+H+Hw));
    require(result.force_error < 1e-6 && result.moment_error < 1e-6,
            "support reactions do not balance the applied force/moment");
    for (double value : {result.peak, result.tip, result.near, result.gauge})
        require(std::isfinite(value) && value > 0, "invalid stress/displacement result");
    return result;
}

double relative_field_error(const Result& result, const Result& reference) {
    require(result.block_vm.size() == reference.block_vm.size(), "block fields do not match");
    double difference = 0, magnitude = 0;
    for (size_t e = 0; e < reference.block_vm.size(); ++e) {
        const double d = result.block_vm[e]-reference.block_vm[e];
        difference += reference.block_volume[e]*d*d;
        magnitude += reference.block_volume[e]*reference.block_vm[e]*reference.block_vm[e];
    }
    return std::sqrt(difference/magnitude);
}

// Six force/moment load cases on an asymmetric patch offset from its reference.
// Unit translational springs give independent nodal forces directly from u.
// Prescribing each rigid motion also checks the assembled constraint map.
void check_kinematic_patch() {
    CoupledInput in;
    in.n_nodes = 5;
    in.vertices = {-1,-2,0, 2,-1,0, 1,3,0, -2,1,0, 0,0,2};
    Coupling cp;
    cp.kind = CouplingKind::Kinematic;
    cp.ref_node = 4;
    cp.solid_nodes = {0,1,2,3};
    in.couplings.push_back(cp);
    for (int n = 0; n < 4; ++n)
        for (int c = 0; c < 3; ++c) in.solid_stiffness.push_back({3*n+c, 3*n+c, 1});
    double max_error = 0;
    for (int j = 0; j < 6; ++j) {
        in.loads = {{24+j,1}};
        const auto response = solve_solid_shell_core(in);
        require(response.converged, "asymmetric patch solve failed");
        Vec3 force{}, moment{};
        for (int n = 0; n < 4; ++n) {
            Vec3 offset{}, nodal{};
            for (int c = 0; c < 3; ++c) {
                offset[c] = in.vertices[3*n+c]-in.vertices[12+c];
                nodal[c] = response.dofs[6*n+c];
                force[c] += nodal[c];
            }
            const auto m = cross(offset,nodal);
            for (int c = 0; c < 3; ++c) moment[c] += m[c];
        }
        for (int c = 0; c < 3; ++c) {
            max_error = std::max(max_error,std::abs(force[c]-(j == c ? 1 : 0)));
            max_error = std::max(max_error,std::abs(moment[c]-(j == c+3 ? 1 : 0)));
        }
        in.loads.clear();
        in.prescribed_dofs.clear();
        for (int c = 0; c < 6; ++c) in.prescribed_dofs.emplace_back(24+c,j == c ? 1 : 0);
        const auto rigid = solve_solid_shell_core(in);
        require(rigid.converged, "prescribed rigid-motion solve failed");
        for (int n = 0; n < 4; ++n) {
            Vec3 offset{}, theta{};
            for (int c = 0; c < 3; ++c) {
                offset[c] = in.vertices[3*n+c]-in.vertices[12+c];
                theta[c] = j == c+3 ? 1 : 0;
            }
            const auto rotation = cross(theta,offset);
            for (int c = 0; c < 3; ++c)
                max_error = std::max(max_error,std::abs(rigid.dofs[6*n+c]-rotation[c]-(j == c ? 1 : 0)));
        }
        in.prescribed_dofs.clear();
    }
    require(max_error < 1e-10, "asymmetric patch fails rigid motion or resultant transfer");
    std::printf("CHECK,asymmetric-patch-six-loads-six-rigid-motions,max_error,%.9g\n",max_error);
}

}  // namespace

int main(int argc, char** argv) {
    try {
        int max_refinement = 4;
        if (argc == 2) {
            const std::string value(argv[1]);
            require(value.size() == 1 && value[0] >= '1' && value[0] <= '6',
                    "maximum refinement must be an integer from 1 to 6");
            max_refinement = value[0]-'0';
        } else require(argc == 1, "usage: shell_solid_footprint_study [maximum refinement: 1..6]");
        check_kinematic_patch();
        std::puts("Physical footprint study: N/mm/MPa. All-solid, direct tie, 3/6 mm solid collar.");
        std::puts("CSV,load,refinement,collar_mm,peak_vm,work_tip_u,near_vm,gauge_vm,peak_ratio,tip_ratio,near_ratio,gauge_ratio,block_vm_l2_error,force_error,moment_error");
        for (int axis : {2,0}) {
            Result previous;
            for (int r = 1; r <= max_refinement; ++r) {
                const auto reference = junction(r,-1,axis);
                for (int collar : {-1,0,3,6}) {
                    const auto result = collar < 0 ? reference : junction(r,collar,axis);
                    const double field_error = relative_field_error(result,reference);
                    std::printf("CSV,%s,%d,%d,%.9g,%.9g,%.9g,%.9g,%.6f,%.6f,%.6f,%.6f,%.9g,%.9g,%.9g\n",
                                axis == 2 ? "tension" : "in-plane-bending",r,collar,
                                result.peak,result.tip,result.near,result.gauge,
                                result.peak/reference.peak,result.tip/reference.tip,
                                result.near/reference.near,result.gauge/reference.gauge,
                                field_error,result.force_error,result.moment_error);
                    // Same-mesh model comparison, not a bound on the sharp-corner peak.
                    if (collar == 6) {
                        require(std::abs(result.peak/reference.peak-1) < 0.03,
                                "6 mm collar peak differs from same-mesh solid by more than 3%");
                        require(std::abs(result.tip/reference.tip-1) < 0.02 && field_error < 0.03,
                                "6 mm collar displacement or block vM field exceeds tolerance");
                        require(std::abs(result.near/reference.near-1) < 0.01 &&
                                std::abs(result.gauge/reference.gauge-1) < 0.01,
                                "6 mm collar fixed-volume stress differs from solid by more than 1%");
                    }
                }
                if (r > 1)
                    std::printf("REFINEMENT,%s,%d,near_change,%.6f,gauge_change,%.6f,tip_change,%.6f\n",
                                axis == 2 ? "tension" : "in-plane-bending",r,
                                reference.near/previous.near-1,reference.gauge/previous.gauge-1,
                                reference.tip/previous.tip-1);
                previous = reference;
            }
        }
        std::puts("PASS: rigid motion, force/moment balance and 6 mm collar same-mesh comparisons.");
        std::puts("LIMIT: conforming planar footprint, in-plane loads; sharp-corner peak is mesh-dependent.");
    } catch (const std::exception& error) {
        std::fprintf(stderr,"%s\n",error.what());
        return 1;
    }
    return 0;
}
