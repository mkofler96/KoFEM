// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Uniform spatial-grid neighbor search — the shared C++ primitive for radius
// queries over a point cloud.
//
// Each point is bucketed into the cell floor((p − origin)/cell_size); a radius
// query scans the (2R+1)³ block of cells around the query point, with
// R = ceil(radius/cell_size), and distance-tests the points it finds. This is
// the O(N)-build, O(1)-amortized-query "hash grid" pattern: with cell_size close
// to the query radius, R = 1 and each query touches a 3×3×3 neighborhood.
//
// KOF-198 tracks that this exact algorithm has been hand-rolled ~4× independently
// in web/src (tie.ts `nearestCrossBodyNeighbours`, three grids in shellize.ts).
// Those are TypeScript and cannot call into this C++ engine; this header is the
// engine-side counterpart, introduced for the SIMP density filter (KOF-229,
// ADR-0002) so the engine grows one grid primitive from the start rather than its
// own ad-hoc fifth copy. Extracting the shared TypeScript helper remains KOF-198.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace kofem {

using Point3 = std::array<double, 3>;

// A uniform-cell spatial hash over a fixed point set. It keeps its own copy of
// the points, so it outlives the container it was built from and stays copyable.
class SpatialGrid {
public:
    // `cell_size` must be > 0; choose it close to the typical query radius so a
    // query touches a 3×3×3 cell block. Throws std::runtime_error if cell_size is
    // not positive, or if it is so small relative to the point-cloud extent that
    // a cell index would no longer be exactly representable (see spatial_grid.cpp)
    // — a loud error beats silently corrupted buckets.
    SpatialGrid(const std::vector<Point3>& points, double cell_size);

    // Append to `out` the indices of every stored point within `radius`
    // (inclusive) of `query`, including a point that coincides with `query`.
    // `out` is not cleared first — the caller owns it, so one scratch vector can
    // be reused across queries. Result order is unspecified.
    void query_radius(const Point3& query, double radius, std::vector<int>& out) const;

private:
    // 64-bit cell coordinates so a realistic extent/cell_size ratio (far beyond
    // what int's ~2.1e9 range allows) maps without overflow; the constructor
    // additionally caps the ratio at the exactly-representable range.
    using Cell = std::array<std::int64_t, 3>;

    struct CellHash {
        std::size_t operator()(const Cell& c) const noexcept;
    };

    Cell cell_of(const Point3& p) const;

    std::vector<Point3> points_;
    double cell_size_;
    Point3 origin_{};
    std::unordered_map<Cell, std::vector<int>, CellHash> cells_;
};

}  // namespace kofem
