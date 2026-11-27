// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Element sizes per solid, face and edge. See mesh_sizes.h.

#include "mesh_sizes.h"

#include <BRepAdaptor_Curve.hxx>
#include <BRep_Tool.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>

#include <algorithm>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>

namespace {

constexpr double kNoLimit = std::numeric_limits<double>::infinity();

std::map<int, double> face_size_by_id(const MeshSizes& sizes) {
    std::map<int, double> by_id;
    for (const KofemFaceMaxSize& sized : sizes.face_max) {
        const auto [entry, added] = by_id.emplace(sized.face, sized.max_size);
        if (!added)
            entry->second = std::min(entry->second, sized.max_size);
    }
    return by_id;
}

double size_of_face(const std::map<int, double>& by_id, int face) {
    const auto found = by_id.find(face);
    return found == by_id.end() ? kNoLimit : found->second;
}

// Accumulates the smallest size each shape is given.
class SizeTable {
public:
    void limit(const TopoDS_Shape& shape, double size) {
        if (!(size < kNoLimit))
            return;
        const int index = shapes_.FindIndex(shape);
        if (index == 0) {
            shapes_.Add(shape);
            sizes_.push_back(size);
        } else {
            double& current = sizes_[static_cast<size_t>(index - 1)];
            current = std::min(current, size);
        }
    }
    void limit_edges(const TopoDS_Shape& shape, double size) {
        for (TopExp_Explorer e(shape, TopAbs_EDGE); e.More(); e.Next())
            limit(e.Current(), size);
    }
    [[nodiscard]] std::vector<KofemShapeMaxSize> entries() const {
        std::vector<KofemShapeMaxSize> out;
        out.reserve(sizes_.size());
        for (int i = 1; i <= shapes_.Extent(); ++i)
            out.push_back({shapes_(i), sizes_[static_cast<size_t>(i - 1)]});
        return out;
    }

private:
    TopTools_IndexedMapOfShape shapes_;
    std::vector<double> sizes_;
};

}  // namespace

std::vector<KofemShapeMaxSize> solid_mesh_sizes(const TopoDS_Shape& shape,
                                                const TopoDS_Shape& part,
                                                const MeshSizes& sizes) {
    TopTools_IndexedMapOfShape shape_solids;
    TopTools_IndexedMapOfShape shape_faces;
    TopTools_IndexedMapOfShape part_faces;
    TopExp::MapShapes(shape, TopAbs_SOLID, shape_solids);
    TopExp::MapShapes(shape, TopAbs_FACE, shape_faces);
    TopExp::MapShapes(part, TopAbs_FACE, part_faces);
    SizeTable table;
    if (!sizes.solid_max.empty())
        for (TopExp_Explorer s(part, TopAbs_SOLID); s.More(); s.Next()) {
            const int body = shape_solids.FindIndex(s.Current());
            const double size = sizes.solid_max.at(static_cast<size_t>(body - 1));
            table.limit(s.Current(), size);
            for (TopExp_Explorer f(s.Current(), TopAbs_FACE); f.More(); f.Next())
                table.limit(f.Current(), size);
            table.limit_edges(s.Current(), size);
        }
    for (const KofemFaceMaxSize& sized : sizes.face_max) {
        const TopoDS_Shape& face = shape_faces(sized.face);
        if (!part_faces.Contains(face))
            continue;
        table.limit(face, sized.max_size);
        table.limit_edges(face, sized.max_size);
    }
    return table.entries();
}

std::vector<KofemShapeMaxSize> mid_surface_mesh_sizes(const ShellBodyAnalysis& analysis,
                                                      const MeshSizes& sizes) {
    const std::map<int, double> face_size = face_size_by_id(sizes);
    const double body_size =
        sizes.solid_max.empty() ? kNoLimit
                                : sizes.solid_max.at(static_cast<size_t>(analysis.body - 1));
    TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
    TopExp::MapShapesAndAncestors(analysis.mid_shape, TopAbs_EDGE, TopAbs_FACE, edge_faces);
    SizeTable table;
    for (size_t k = 0; k < analysis.mid_faces.size(); ++k) {
        const MidFace& mid = analysis.mid_faces[k];
        const double size = std::min({body_size, size_of_face(face_size, mid.top),
                                      size_of_face(face_size, mid.bottom)});
        table.limit(mid.face, size);
        table.limit_edges(mid.face, size);
        for (TopExp_Explorer e(mid.face, TopAbs_EDGE); e.More(); e.Next()) {
            const TopoDS_Edge& edge = TopoDS::Edge(e.Current());
            if (BRep_Tool::Degenerated(edge) || BRep_Tool::IsClosed(edge, mid.face))
                continue;
            TopTools_IndexedMapOfShape owners;
            for (TopTools_ListOfShape::Iterator it(edge_faces.FindFromKey(edge)); it.More();
                 it.Next())
                owners.Add(it.Value());
            if (owners.Extent() != 1)
                continue;
            const BRepAdaptor_Curve curve(edge);
            const gp_Pnt middle =
                curve.Value(0.5 * (curve.FirstParameter() + curve.LastParameter()));
            const int side = rim_side_face(analysis, k, middle);
            if (side == 0)
                throw std::runtime_error("mid-surface: a rim edge of body " +
                                         std::to_string(analysis.body) +
                                         " lies on no side face of top face " +
                                         std::to_string(mid.top));
            table.limit(edge, size_of_face(face_size, side));
        }
    }
    return table.entries();
}
