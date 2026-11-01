// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

#ifndef KOFEM_SURFACE_LOAD_SELECTION_H
#define KOFEM_SURFACE_LOAD_SELECTION_H

#include <algorithm>
#include <cstddef>
#include <map>
#include <vector>

namespace kofem::bc {

struct SurfaceLoadSelection {
    std::vector<int> elements;
    std::size_t unmatched_faces = 0;
};

inline SurfaceLoadSelection match_surface_load_faces(
    const std::vector<std::vector<int>>& faces,
    const std::map<std::vector<int>, int>& boundary_faces) {
    SurfaceLoadSelection selection;
    for (auto face : faces) {
        std::sort(face.begin(), face.end());
        const auto found = boundary_faces.find(face);
        if (found == boundary_faces.end()) {
            ++selection.unmatched_faces;
        } else {
            selection.elements.push_back(found->second);
        }
    }
    auto& elements = selection.elements;
    std::sort(elements.begin(), elements.end());
    elements.erase(std::unique(elements.begin(), elements.end()), elements.end());
    return selection;
}

}  // namespace kofem::bc

#endif  // KOFEM_SURFACE_LOAD_SELECTION_H
