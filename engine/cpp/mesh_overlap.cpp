// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Group overlapping surface elements into regions and tell hinges (exact line
// contacts on the CAD model) from other overlaps. See mesh_overlap.h.

#include "mesh_overlap.h"

#include "wasm_util.h"

#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepGProp.hxx>
#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <GeomAbs_CurveType.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Poly_Triangulation.hxx>
#include <TopLoc_Location.hxx>
#include <GeomLProp_SLProps.hxx>
#include <Geom_Surface.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <numeric>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using emscripten::val;

namespace {

// Normals closer than this (radians) to opposite count as two faces touching.
constexpr double TANGENT_ANGLE = 1e-3;
// Line segments this far apart (mm) or this far off direction count as one line.
constexpr double COLLINEAR_DISTANCE = 1e-5;
constexpr double COLLINEAR_ANGLE = 1e-5;
// A contact shorter than this is a point for meshing purposes, not a hinge (mm).
constexpr double MIN_HINGE_LENGTH = 1e-3;
// Past this many faces in one region it is not a contact between two surfaces.
constexpr size_t MAX_REGION_FACES = 16;

struct Hinge {
    gp_Pnt start;
    gp_Pnt end;
    gp_Dir normal;
};

class UnionFind {
public:
    explicit UnionFind(size_t n) : parent_(n) {
        std::iota(parent_.begin(), parent_.end(), size_t{0});
    }
    size_t find(size_t x) {
        while (parent_[x] != x) {
            parent_[x] = parent_[parent_[x]];
            x = parent_[x];
        }
        return x;
    }
    void join(size_t a, size_t b) { parent_[find(a)] = find(b); }

private:
    std::vector<size_t> parent_;
};

using Box = std::array<double, 6>;  // min xyz, max xyz

Box box_of(const KofemSurfaceTriangle& triangle) {
    Box box{};
    for (size_t c = 0; c < 3; ++c) {
        box.at(c) = std::min({triangle.points[0].at(c), triangle.points[1].at(c),
                              triangle.points[2].at(c)});
        box.at(c + 3) = std::max({triangle.points[0].at(c), triangle.points[1].at(c),
                                  triangle.points[2].at(c)});
    }
    return box;
}

bool boxes_touch(const Box& a, const Box& b) {
    for (size_t c = 0; c < 3; ++c)
        if (a.at(c) > b.at(c + 3) || b.at(c) > a.at(c + 3))
            return false;
    return true;
}

// Flagged elements in one region: an overlapping pair always touches, so this
// keeps both sides of a contact together and separate contacts apart.
std::vector<std::vector<size_t>> regions_of(const std::vector<KofemSurfaceTriangle>& triangles) {
    std::vector<Box> boxes;
    boxes.reserve(triangles.size());
    for (const KofemSurfaceTriangle& triangle : triangles)
        boxes.push_back(box_of(triangle));
    UnionFind sets(triangles.size());
    for (size_t i = 0; i < triangles.size(); ++i)
        for (size_t j = i + 1; j < triangles.size(); ++j)
            if (boxes_touch(boxes[i], boxes[j]))
                sets.join(i, j);
    std::map<size_t, std::vector<size_t>> by_root;
    for (size_t i = 0; i < triangles.size(); ++i)
        by_root[sets.find(i)].push_back(i);
    std::vector<std::vector<size_t>> regions;
    regions.reserve(by_root.size());
    for (auto& [root, members] : by_root)
        regions.push_back(std::move(members));
    return regions;
}

// The face's outward normal at a point on it.
std::optional<gp_Dir> normal_at(const TopoDS_Face& face, const gp_Pnt& point) {
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
    GeomAPI_ProjectPointOnSurf projection(point, surface);
    if (projection.NbPoints() == 0)
        return std::nullopt;
    double u = 0.0;
    double v = 0.0;
    projection.LowerDistanceParameters(u, v);
    GeomLProp_SLProps props(surface, u, v, 1, 1e-9);
    if (!props.IsNormalDefined())
        return std::nullopt;
    return face.Orientation() == TopAbs_REVERSED ? props.Normal().Reversed() : props.Normal();
}

struct Segment {
    gp_Pnt start;
    gp_Pnt end;
};

std::vector<Segment> straight_sections(const TopoDS_Face& a, const TopoDS_Face& b) {
    BRepAlgoAPI_Section section(a, b, Standard_False);
    section.Approximation(Standard_True);
    section.SetRunParallel(false);  // single-threaded WASM build
    section.Build();
    std::vector<Segment> segments;
    if (!section.IsDone())
        return segments;
    for (TopExp_Explorer e(section.Shape(), TopAbs_EDGE); e.More(); e.Next()) {
        const TopoDS_Edge& edge = TopoDS::Edge(e.Current());
        if (BRepAdaptor_Curve(edge).GetType() != GeomAbs_Line)
            continue;
        TopoDS_Vertex v0;
        TopoDS_Vertex v1;
        TopExp::Vertices(edge, v0, v1);
        if (!v0.IsNull() && !v1.IsNull())
            segments.push_back({BRep_Tool::Pnt(v0), BRep_Tool::Pnt(v1)});
    }
    return segments;
}

// The longest segment, extended by every segment on the same line — a face split
// along the contact gives one segment per piece.
std::optional<Segment> merged_line(const std::vector<Segment>& segments) {
    const auto longest =
        std::max_element(segments.begin(), segments.end(), [](const Segment& p, const Segment& q) {
            return p.start.Distance(p.end) < q.start.Distance(q.end);
        });
    if (longest == segments.end() || longest->start.Distance(longest->end) < MIN_HINGE_LENGTH)
        return std::nullopt;
    const gp_Dir direction(gp_Vec(longest->start, longest->end));
    const gp_Pnt origin = longest->start;
    double lo = 0.0;
    double hi = longest->start.Distance(longest->end);
    for (const Segment& segment : segments) {
        if (segment.start.Distance(segment.end) < MIN_HINGE_LENGTH)
            continue;
        const gp_Dir other(gp_Vec(segment.start, segment.end));
        if (!direction.IsParallel(other, COLLINEAR_ANGLE))
            continue;
        const gp_Vec offset(origin, segment.start);
        const double t0 = offset.Dot(gp_Vec(direction));
        const double t1 = gp_Vec(origin, segment.end).Dot(gp_Vec(direction));
        if ((offset - gp_Vec(direction) * t0).Magnitude() > COLLINEAR_DISTANCE)
            continue;
        lo = std::min({lo, t0, t1});
        hi = std::max({hi, t0, t1});
    }
    return Segment{origin.Translated(gp_Vec(direction) * lo),
                   origin.Translated(gp_Vec(direction) * hi)};
}

// The straight tangent contact between two faces of a region, if they have one.
// Their outward normals oppose along it: the two surfaces face each other, with
// material behind both. That also holds when CAD stored the line as an edge they
// share, and tells it apart from a fillet running into a plane, whose outward
// normals agree, and from an ordinary corner, whose normals are at an angle.
std::optional<Hinge> hinge_between(const TopoDS_Face& a, const TopoDS_Face& b) {
    const std::optional<Segment> line = merged_line(straight_sections(a, b));
    if (!line)
        return std::nullopt;
    const gp_Pnt middle((line->start.XYZ() + line->end.XYZ()) / 2.0);
    const std::optional<gp_Dir> normal_a = normal_at(a, middle);
    const std::optional<gp_Dir> normal_b = normal_at(b, middle);
    if (!normal_a || !normal_b || !normal_a->IsOpposite(*normal_b, TANGENT_ANGLE))
        return std::nullopt;
    return Hinge{line->start, line->end, *normal_a};
}

std::optional<Hinge> find_hinge(const std::vector<int>& face_ids,
                                const TopTools_IndexedMapOfShape& faces) {
    if (face_ids.size() > MAX_REGION_FACES)
        return std::nullopt;
    std::optional<Hinge> best;
    for (size_t i = 0; i < face_ids.size(); ++i)
        for (size_t j = i + 1; j < face_ids.size(); ++j) {
            const std::optional<Hinge> hinge = hinge_between(
                TopoDS::Face(faces(face_ids[i])), TopoDS::Face(faces(face_ids[j])));
            if (hinge && (!best || hinge->start.Distance(hinge->end) >
                                       best->start.Distance(best->end)))
                best = hinge;
        }
    return best;
}

val point_array(const gp_XYZ& p) {
    return float64_array({p.X(), p.Y(), p.Z()});
}

}  // namespace

bool is_closed_cone_tip(const TopoDS_Face& face) {
    const BRepAdaptor_Surface surface(face);
    if (surface.GetType() != GeomAbs_Cone || !surface.IsUClosed())
        return false;
    for (TopExp_Explorer e(face, TopAbs_EDGE); e.More(); e.Next())
        if (BRep_Tool::Degenerated(TopoDS::Edge(e.Current())))
            return true;
    return false;
}

val describe_mesh_overlaps(const std::vector<KofemSurfaceTriangle>& triangles,
                           const TopoDS_Shape& shape) {
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    TopTools_IndexedDataMapOfShapeListOfShape face_solids;
    TopExp::MapShapesAndAncestors(shape, TopAbs_FACE, TopAbs_SOLID, face_solids);

    val overlaps = val::array();
    int count = 0;
    for (const std::vector<size_t>& region : regions_of(triangles)) {
        std::set<int> face_set;
        std::vector<double> positions;
        positions.reserve(9 * region.size());
        for (const size_t index : region) {
            const KofemSurfaceTriangle& triangle = triangles[index];
            if (triangle.face < 1 || triangle.face > faces.Extent())
                throw std::runtime_error("describe_mesh_overlaps: surface element on face " +
                                         std::to_string(triangle.face) +
                                         ", but the shape has " +
                                         std::to_string(faces.Extent()) + " faces");
            face_set.insert(triangle.face);
            for (const std::array<double, 3>& point : triangle.points)
                positions.insert(positions.end(), point.begin(), point.end());
        }
        const std::vector<int> face_ids(face_set.begin(), face_set.end());
        const TopTools_ListOfShape& owners = face_solids.FindFromKey(faces(face_ids.front()));
        const int body = owners.IsEmpty() ? 0 : solids.FindIndex(owners.First());
        const std::optional<Hinge> hinge = body > 0 ? find_hinge(face_ids, faces) : std::nullopt;

        const bool has_cone_tip =
            std::any_of(face_ids.begin(), face_ids.end(),
                        [&](int id) { return is_closed_cone_tip(TopoDS::Face(faces(id))); });

        val overlap = val::object();
        overlap.set("kind", hinge ? "hinge" : has_cone_tip ? "cone" : "surface");
        overlap.set("faceIds", int32_array(face_ids));
        overlap.set("bodyId", body);
        overlap.set("positions", float64_array(positions));
        if (hinge) {
            val line = val::object();
            line.set("start", point_array(hinge->start.XYZ()));
            line.set("end", point_array(hinge->end.XYZ()));
            line.set("normal", point_array(hinge->normal.XYZ()));
            line.set("length", hinge->start.Distance(hinge->end));
            overlap.set("hinge", line);
        }
        overlaps.set(count++, overlap);
    }
    return overlaps;
}

namespace {

// Append a face's display tessellation (xyz of 3 corners per triangle).
void append_display_triangles(const TopoDS_Face& face, int id, std::vector<double>& positions) {
    TopLoc_Location location;
    const Handle(Poly_Triangulation) triangulation = BRep_Tool::Triangulation(face, location);
    if (triangulation.IsNull())
        throw std::runtime_error("describe_unmeshed_faces: face " + std::to_string(id) +
                                 " has no display tessellation to highlight");
    positions.reserve(positions.size() + 9 * triangulation->NbTriangles());
    for (int t = 1; t <= triangulation->NbTriangles(); ++t) {
        std::array<int, 3> nodes{};
        triangulation->Triangle(t).Get(nodes[0], nodes[1], nodes[2]);
        for (const int node : nodes) {
            const gp_Pnt point = triangulation->Node(node).Transformed(location.Transformation());
            positions.insert(positions.end(), {point.X(), point.Y(), point.Z()});
        }
    }
}

bool share_an_edge(const TopoDS_Face& a, const TopoDS_Face& b) {
    for (TopExp_Explorer ea(a, TopAbs_EDGE); ea.More(); ea.Next())
        for (TopExp_Explorer eb(b, TopAbs_EDGE); eb.More(); eb.Next())
            if (ea.Current().IsSame(eb.Current()))
                return true;
    return false;
}

}  // namespace

double face_width(const TopoDS_Face& face) {
    GProp_GProps area;
    BRepGProp::SurfaceProperties(face, area);
    GProp_GProps perimeter;
    BRepGProp::LinearProperties(face, perimeter);
    if (perimeter.Mass() <= 0.0)
        throw std::runtime_error("face_width: the face has no boundary length");
    return 2.0 * area.Mass() / perimeter.Mass();
}

val describe_unmeshed_faces(const std::vector<int>& face_ids, const TopoDS_Shape& shape) {
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    TopTools_IndexedDataMapOfShapeListOfShape face_solids;
    TopExp::MapShapesAndAncestors(shape, TopAbs_FACE, TopAbs_SOLID, face_solids);
    for (const int id : face_ids)
        if (id < 1 || id > faces.Extent())
            throw std::runtime_error("describe_unmeshed_faces: face " + std::to_string(id) +
                                     ", but the shape has " + std::to_string(faces.Extent()) +
                                     " faces");
    auto face_of = [&](int id) { return TopoDS::Face(faces(id)); };
    auto body_of = [&](int id) {
        const TopTools_ListOfShape& owners = face_solids.FindFromKey(faces(id));
        return owners.IsEmpty() ? 0 : solids.FindIndex(owners.First());
    };

    val described = val::array();
    int count = 0;
    std::set<int> reported;

    // A hinge makes Netgen give up on the two faces touching along it, and often
    // on faces next to them: report those as the hinge, so it can be repaired
    // like one the volume fill's overlap check found.
    if (face_ids.size() <= MAX_REGION_FACES)
        for (size_t i = 0; i < face_ids.size(); ++i)
            for (size_t j = i + 1; j < face_ids.size(); ++j) {
                const int a = face_ids[i];
                const int b = face_ids[j];
                if (reported.count(a) > 0 || reported.count(b) > 0)
                    continue;
                const std::optional<Hinge> hinge = hinge_between(face_of(a), face_of(b));
                if (!hinge)
                    continue;
                std::vector<int> region{a, b};
                for (const int other : face_ids)
                    if (other != a && other != b && reported.count(other) == 0 &&
                        (share_an_edge(face_of(other), face_of(a)) ||
                         share_an_edge(face_of(other), face_of(b))))
                        region.push_back(other);
                std::sort(region.begin(), region.end());
                std::vector<double> positions;
                for (const int id : region) {
                    append_display_triangles(face_of(id), id, positions);
                    reported.insert(id);
                }
                val line = val::object();
                line.set("start", point_array(hinge->start.XYZ()));
                line.set("end", point_array(hinge->end.XYZ()));
                line.set("normal", point_array(hinge->normal.XYZ()));
                line.set("length", hinge->start.Distance(hinge->end));
                val entry = val::object();
                entry.set("kind", "hinge");
                entry.set("faceIds", int32_array(region));
                entry.set("bodyId", body_of(a));
                entry.set("positions", float64_array(positions));
                entry.set("hinge", line);
                described.set(count++, entry);
            }

    for (const int id : face_ids) {
        if (reported.count(id) > 0)
            continue;
        const TopoDS_Face face = face_of(id);
        std::vector<double> positions;
        append_display_triangles(face, id, positions);
        // A closed cone tip is a face Netgen fails on at any size, and one the
        // cone split repairs: report it as a cone, exactly like the overlaps
        // it caused before this check stopped the volume fill.
        val entry = val::object();
        entry.set("kind", is_closed_cone_tip(face) ? "cone" : "unmeshed");
        // The faces Netgen gives up on are mostly slivers far narrower than an
        // element, and the width is what tells the user so.
        entry.set("width", face_width(face));
        entry.set("faceIds", int32_array(std::vector<int>{id}));
        entry.set("bodyId", body_of(id));
        entry.set("positions", float64_array(positions));
        described.set(count++, entry);
    }
    return described;
}
