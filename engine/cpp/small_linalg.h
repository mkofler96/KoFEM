// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fixed-size 3-vector and 3×3 matrix helpers shared by the MFEM-free element and
// constraint code (shell_element, tet_element, coupling_constraints). Header-only
// and dependency-free so the native test builds stay a plain compiler call.

#ifndef KOFEM_SMALL_LINALG_H
#define KOFEM_SMALL_LINALG_H

#include <array>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <vector>

namespace kofem::shell {

using Vec3 = std::array<double, 3>;
using Mat3 = std::array<std::array<double, 3>, 3>;

inline Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline Vec3 cross(const Vec3& a, const Vec3& b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
inline double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
inline Vec3 scale(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }

// 3×3 inverse (for tet shape-function gradients and the RBE3 inertia solve).
inline Mat3 mat3_inv(const Mat3& m) {
    const double det =
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (det == 0.0) throw std::runtime_error("shell: singular 3×3 matrix");
    const double id = 1.0 / det;
    Mat3 r{};
    r[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * id;
    r[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * id;
    r[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * id;
    r[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * id;
    r[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * id;
    r[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * id;
    r[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * id;
    r[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * id;
    r[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * id;
    return r;
}

// 3×3 product.
inline Mat3 mat3_mul(const Mat3& a, const Mat3& b) {
    Mat3 r{};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int k = 0; k < 3; ++k) r[i][j] += a[i][k] * b[k][j];
    return r;
}

// Skew-symmetric cross-product matrix [a]× (so [a]×·b = a×b).
inline Mat3 skew(const Vec3& a) {
    return {{{0.0, -a[2], a[1]}, {a[2], 0.0, -a[0]}, {-a[1], a[0], 0.0}}};
}

// Node n's coordinates from an xyz-interleaved vertex array.
inline Vec3 vertex(const std::vector<double>& vertices, int n) {
    const size_t b3 = 3 * static_cast<size_t>(n);
    return {vertices[b3], vertices[b3 + 1], vertices[b3 + 2]};
}

}  // namespace kofem::shell

#endif  // KOFEM_SMALL_LINALG_H
