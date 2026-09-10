// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Uniform spatial-grid neighbor search — see spatial_grid.h.

#include "spatial_grid.h"

#include <algorithm>
#include <cmath>
#include <functional>
#include <stdexcept>

namespace kofem {

std::size_t SpatialGrid::CellHash::operator()(const Cell& c) const noexcept {
    // boost-style hash_combine over the three cell coordinates. The 0x9e3779b9
    // golden-ratio constant fits a 32-bit size_t (the wasm32 target) as well as a
    // 64-bit host, so the mix is well defined on both.
    std::size_t h = 0;
    for (const std::int64_t v : c)
        h ^= std::hash<std::int64_t>{}(v) + 0x9e3779b9U + (h << 6) + (h >> 2);
    return h;
}

namespace {
// A cell index must stay an exactly-representable integer (< 2^52, comfortably
// inside the double mantissa) so equal coordinates land in the same bucket and
// the floor-then-cast is well defined. This caps the point-cloud extent at
// ~4.5e15 cells per axis — astronomically more than any real mesh needs — while
// turning a pathologically small cell_size into a loud error, not silent
// corruption (the cast of an out-of-range double would otherwise be UB).
constexpr double kMaxCellSpan = 4503599627370496.0;  // 2^52
}  // namespace

SpatialGrid::SpatialGrid(const std::vector<Point3>& points, double cell_size)
    : points_(points), cell_size_(cell_size) {
    if (!(cell_size_ > 0.0))
        throw std::runtime_error("SpatialGrid: cell_size must be positive");

    // Anchor the grid at the minimum corner of the cloud so cell indices are
    // non-negative for typical inputs (the hash tolerates negatives regardless),
    // and track the maximum corner to bound the extent.
    if (points_.empty()) return;
    Point3 hi = points_.front();
    origin_ = points_.front();
    for (const Point3& p : points_)
        for (int d = 0; d < 3; ++d) {
            origin_[d] = std::min(origin_[d], p[d]);
            hi[d] = std::max(hi[d], p[d]);
        }

    for (int d = 0; d < 3; ++d) {
        if ((hi[d] - origin_[d]) / cell_size_ >= kMaxCellSpan)
            throw std::runtime_error(
                "SpatialGrid: cell_size is too small for the point-cloud extent "
                "(the grid would need more cells than are exactly representable); "
                "increase cell_size / the filter radius");
    }

    for (int i = 0; i < static_cast<int>(points_.size()); ++i)
        cells_[cell_of(points_[i])].push_back(i);
}

SpatialGrid::Cell SpatialGrid::cell_of(const Point3& p) const {
    // The constructor guarantees each quotient is in [0, 2^52) (origin is the min
    // corner), so the floor is exactly representable and the int64 cast is well
    // defined.
    Cell c{};
    for (int d = 0; d < 3; ++d)
        c[d] = static_cast<std::int64_t>(std::floor((p[d] - origin_[d]) / cell_size_));
    return c;
}

void SpatialGrid::query_radius(const Point3& query, double radius,
                               std::vector<int>& out) const {
    // A point within `radius` lies at most ceil(radius/cell_size) cells away on
    // each axis; scan at least one ring so a coincident point is always found.
    // Clamp the count to the representable cell span: a radius large enough to
    // exceed it already spans the whole grid, and clamping keeps the double→int64
    // cast (and the ring-offset additions below) well defined for any radius.
    const double rings_d = std::ceil(radius / cell_size_);
    const std::int64_t rings = (std::isfinite(rings_d) && rings_d >= 1.0)
                                   ? static_cast<std::int64_t>(std::min(rings_d, kMaxCellSpan))
                                   : 1;
    const double r2 = radius * radius;
    const Cell qc = cell_of(query);

    Cell c{};
    for (std::int64_t dx = -rings; dx <= rings; ++dx) {
        c[0] = qc[0] + dx;
        for (std::int64_t dy = -rings; dy <= rings; ++dy) {
            c[1] = qc[1] + dy;
            for (std::int64_t dz = -rings; dz <= rings; ++dz) {
                c[2] = qc[2] + dz;
                const auto it = cells_.find(c);
                if (it == cells_.end()) continue;
                for (const int idx : it->second) {
                    const Point3& p = points_[idx];
                    double d2 = 0.0;
                    for (int k = 0; k < 3; ++k) {
                        const double diff = p[k] - query[k];
                        d2 += diff * diff;
                    }
                    if (d2 <= r2) out.push_back(idx);
                }
            }
        }
    }
}

}  // namespace kofem
