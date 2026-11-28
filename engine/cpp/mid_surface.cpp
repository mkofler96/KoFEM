// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The CAD mid-surface of a body marked Shell. See mid_surface.h.

#include "mid_surface.h"

#include "geometry_cache.h"
#include "json_util.h"

#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_BuilderAlgo.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepOffset_MakeSimpleOffset.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <ElCLib.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Geom_Surface.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Ax1.hxx>
#include <gp_Cylinder.hxx>
#include <gp_Lin.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

using emscripten::val;

namespace {

// 1 − |cos θ| below this: two directions are parallel. Opposite faces of a CAD
// wall are exactly parallel planes or exactly coaxial cylinders.
constexpr double kParallel = 1e-9;
// Share of the body's bounding-box diagonal below which two lengths are equal.
constexpr double kRelativeTolerance = 1e-7;

struct FaceInfo {
    int id = 0;
    TopoDS_Face face;  // oriented as in the solid
    GeomAbs_SurfaceType type = GeomAbs_OtherSurface;
    gp_Dir normal;          // plane: outward normal
    double offset = 0.0;    // plane: normal · x on the plane
    gp_Ax1 axis;            // cylinder
    double radius = 0.0;    // cylinder
    bool convex = false;    // cylinder: the outward normal points away from the axis
};

// The surface normal pointing out of the solid at (u, v).
gp_Dir outward_normal(const TopoDS_Face& face, double u, double v) {
    const BRepAdaptor_Surface surface(face);
    gp_Pnt point;
    gp_Vec du;
    gp_Vec dv;
    surface.D1(u, v, point, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() < gp::Resolution())
        throw std::runtime_error("mid-surface: a face has no normal at (" + std::to_string(u) +
                                 ", " + std::to_string(v) + ")");
    if (face.Orientation() == TopAbs_REVERSED)
        normal.Reverse();
    return {normal};
}

gp_Pnt foot_on_axis(const gp_Ax1& axis, const gp_Pnt& point) {
    const gp_Lin line(axis);
    return ElCLib::Value(ElCLib::Parameter(line, point), line);
}

FaceInfo describe_face(const TopoDS_Face& face, int id) {
    FaceInfo info;
    info.id = id;
    info.face = face;
    const BRepAdaptor_Surface surface(face);
    info.type = surface.GetType();
    double u0 = 0.0;
    double u1 = 0.0;
    double v0 = 0.0;
    double v1 = 0.0;
    BRepTools::UVBounds(face, u0, u1, v0, v1);
    const double u = 0.5 * (u0 + u1);
    const double v = 0.5 * (v0 + v1);
    if (info.type == GeomAbs_Plane) {
        info.normal = outward_normal(face, u, v);
        info.offset = info.normal.XYZ().Dot(surface.Value(u, v).XYZ());
    } else if (info.type == GeomAbs_Cylinder) {
        const gp_Cylinder cylinder = surface.Cylinder();
        info.axis = cylinder.Axis();
        info.radius = cylinder.Radius();
        const gp_Pnt point = surface.Value(u, v);
        const gp_Vec radial(foot_on_axis(info.axis, point), point);
        info.convex = radial.Dot(gp_Vec(outward_normal(face, u, v))) > 0.0;
    }
    return info;
}

// Faces on one plane facing one way, or on one cylinder facing one way.
struct Sheet {
    GeomAbs_SurfaceType type = GeomAbs_OtherSurface;
    std::vector<std::size_t> faces;  // indices into the body's FaceInfo list
    gp_Dir normal;
    double offset = 0.0;
    gp_Ax1 axis;
    double radius = 0.0;
    bool convex = false;
};

Sheet sheet_of(const FaceInfo& face, std::size_t index) {
    Sheet sheet;
    sheet.type = face.type;
    sheet.faces = {index};
    sheet.normal = face.normal;
    sheet.offset = face.offset;
    sheet.axis = face.axis;
    sheet.radius = face.radius;
    sheet.convex = face.convex;
    return sheet;
}

bool parallel(const gp_Dir& a, const gp_Dir& b) {
    return 1.0 - std::abs(a.Dot(b)) < kParallel;
}

bool same_axis(const gp_Ax1& a, const gp_Ax1& b, double tolerance) {
    return parallel(a.Direction(), b.Direction()) &&
           gp_Lin(a).Distance(b.Location()) < tolerance;
}

bool on_sheet(const Sheet& sheet, const FaceInfo& face, double tolerance) {
    if (face.type != sheet.type)
        return false;
    if (sheet.type == GeomAbs_Plane)
        return sheet.normal.Dot(face.normal) > 1.0 - kParallel &&
               std::abs(sheet.offset - face.offset) < tolerance;
    return same_axis(sheet.axis, face.axis, tolerance) &&
           std::abs(sheet.radius - face.radius) < tolerance && sheet.convex == face.convex;
}

double distance_to_sheet(const Sheet& sheet, const gp_Pnt& point) {
    if (sheet.type == GeomAbs_Plane)
        return std::abs(sheet.normal.XYZ().Dot(point.XYZ()) - sheet.offset);
    return std::abs(gp_Lin(sheet.axis).Distance(point) - sheet.radius);
}

// The thickness of the wall between two sheets that face away from each other
// with material between them; none when they do not.
std::optional<double> thickness_between(const Sheet& a, const Sheet& b, double tolerance) {
    if (a.type != b.type)
        return std::nullopt;
    double thickness = 0.0;
    if (a.type == GeomAbs_Plane) {
        if (a.normal.Dot(b.normal) > -(1.0 - kParallel))
            return std::nullopt;
        // a: n·x = a.offset, b: −n·x = b.offset; the material lies between.
        thickness = a.offset + b.offset;
    } else {
        if (!same_axis(a.axis, b.axis, tolerance) || a.convex == b.convex)
            return std::nullopt;
        const Sheet& outer = a.convex ? a : b;
        const Sheet& inner = a.convex ? b : a;
        thickness = outer.radius - inner.radius;
    }
    if (thickness <= tolerance)
        return std::nullopt;
    return thickness;
}

// Whether `sheet` is the top side of its wall: for planes the sheet facing +z,
// then +y, then +x; for cylinders the outer sheet.
bool is_top_sheet(const Sheet& sheet) {
    if (sheet.type == GeomAbs_Cylinder)
        return sheet.convex;
    const gp_Dir& n = sheet.normal;
    if (std::abs(n.Z()) > kParallel)
        return n.Z() > 0.0;
    if (std::abs(n.Y()) > kParallel)
        return n.Y() > 0.0;
    return n.X() > 0.0;
}

// Whether every vertex of `face` lies on the top or the bottom sheet, with at
// least one on each: the face spans the wall's thickness.
bool spans(const TopoDS_Face& face, const Sheet& top, const Sheet& bottom, double tolerance) {
    bool on_top = false;
    bool on_bottom = false;
    bool any = false;
    for (TopExp_Explorer e(face, TopAbs_VERTEX); e.More(); e.Next()) {
        any = true;
        const gp_Pnt point = BRep_Tool::Pnt(TopoDS::Vertex(e.Current()));
        const bool top_here = distance_to_sheet(top, point) < tolerance;
        const bool bottom_here = distance_to_sheet(bottom, point) < tolerance;
        if (!top_here && !bottom_here)
            return false;
        on_top = on_top || top_here;
        on_bottom = on_bottom || bottom_here;
    }
    return any && on_top && on_bottom;
}

bool spans_sheet(const Sheet& sheet, const std::vector<FaceInfo>& faces, const Sheet& top,
                 const Sheet& bottom, double tolerance) {
    return std::all_of(sheet.faces.begin(), sheet.faces.end(), [&](std::size_t f) {
        return spans(faces[f].face, top, bottom, tolerance);
    });
}

std::vector<int> face_ids(const Sheet& sheet, const std::vector<FaceInfo>& faces) {
    std::vector<int> ids;
    ids.reserve(sheet.faces.size());
    for (const std::size_t f : sheet.faces)
        ids.push_back(faces[f].id);
    std::sort(ids.begin(), ids.end());
    return ids;
}

// The faces of `sheet` offset `distance` into the material, in sheet order.
// The sheet is offset as one shape, so faces that share an edge still share
// its image.
std::vector<TopoDS_Face> offset_into_material(const Sheet& sheet,
                                              const std::vector<FaceInfo>& faces,
                                              double distance) {
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const std::size_t f : sheet.faces)
        builder.Add(compound, faces[f].face);
    // A positive offset moves a face along its normal, which here points out
    // of the solid.
    BRepOffset_MakeSimpleOffset maker(compound, -distance);
    maker.Perform();
    if (!maker.IsDone())
        throw std::runtime_error("mid-surface: offsetting face " +
                                 std::to_string(faces[sheet.faces.front()].id) +
                                 " by half the wall thickness failed: " +
                                 maker.GetErrorMessage().ToCString());
    std::vector<TopoDS_Face> offset;
    offset.reserve(sheet.faces.size());
    for (const std::size_t f : sheet.faces) {
        const TopoDS_Shape image = maker.Generated(faces[f].face);
        if (image.IsNull() || image.ShapeType() != TopAbs_FACE)
            throw std::runtime_error("mid-surface: the offset of face " +
                                     std::to_string(faces[f].id) + " is not a face");
        offset.push_back(TopoDS::Face(image));
    }
    return offset;
}

TopoDS_Compound compound_of(const std::vector<TopoDS_Face>& faces) {
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const TopoDS_Face& face : faces)
        builder.Add(compound, face);
    return compound;
}

struct WallSheets {
    std::size_t top;
    std::size_t bottom;
    double thickness;
};

// The mid faces of one wall: the General Fuse of its two offset sheets. Each
// face of the result that is an image of a top face AND of a bottom face is a
// mid face with those two sources. A face that is an image of only one side
// lies where the other side has no face: the sides do not cover each other.
// Returns that uncovered source face, or nothing.
std::optional<int> fuse_mid_faces(ShellBodyAnalysis& analysis, std::size_t wall_index,
                                  const WallSheets& wall, const std::vector<Sheet>& sheets,
                                  const std::vector<FaceInfo>& faces) {
    const Sheet& top = sheets[wall.top];
    const Sheet& bottom = sheets[wall.bottom];
    const std::vector<TopoDS_Face> top_offset =
        offset_into_material(top, faces, 0.5 * wall.thickness);
    const std::vector<TopoDS_Face> bottom_offset =
        offset_into_material(bottom, faces, 0.5 * wall.thickness);

    BRepAlgoAPI_BuilderAlgo fuse;
    TopTools_ListOfShape arguments;
    arguments.Append(compound_of(top_offset));
    arguments.Append(compound_of(bottom_offset));
    fuse.SetArguments(arguments);
    fuse.SetFuzzyValue(analysis.tolerance);
    fuse.SetRunParallel(false);
    fuse.Build();
    if (fuse.HasErrors())
        throw std::runtime_error("mid-surface: fusing the offset faces of wall " +
                                 std::to_string(face_ids(top, faces).front()) + "/" +
                                 std::to_string(face_ids(bottom, faces).front()) +
                                 " failed");

    TopTools_IndexedMapOfShape pieces;
    TopExp::MapShapes(fuse.Shape(), TopAbs_FACE, pieces);
    std::vector<int> top_source(static_cast<std::size_t>(pieces.Extent()) + 1, 0);
    std::vector<int> bottom_source(top_source.size(), 0);
    std::vector<TopoDS_Face> top_face(top_source.size());
    auto record = [&](const TopoDS_Face& offset, const FaceInfo& source,
                      std::vector<int>& owner, bool is_top) {
        auto mark = [&](const TopoDS_Shape& piece) {
            const int k = pieces.FindIndex(piece);
            if (k == 0)
                throw std::runtime_error("mid-surface: an image of face " +
                                         std::to_string(source.id) +
                                         " is missing from the fused faces");
            owner[static_cast<std::size_t>(k)] = source.id;
            if (is_top)
                top_face[static_cast<std::size_t>(k)] = source.face;
        };
        const TopTools_ListOfShape& images = fuse.Modified(offset);
        if (images.IsEmpty()) {
            if (!fuse.IsDeleted(offset))
                mark(offset);
            return;
        }
        for (TopTools_ListOfShape::Iterator it(images); it.More(); it.Next())
            mark(it.Value());
    };
    for (std::size_t i = 0; i < top.faces.size(); ++i)
        record(top_offset[i], faces[top.faces[i]], top_source, true);
    for (std::size_t i = 0; i < bottom.faces.size(); ++i)
        record(bottom_offset[i], faces[bottom.faces[i]], bottom_source, false);

    for (int k = 1; k <= pieces.Extent(); ++k) {
        const auto at = static_cast<std::size_t>(k);
        if (top_source[at] == 0 || bottom_source[at] == 0)
            return top_source[at] != 0 ? top_source[at] : bottom_source[at];
        analysis.mid_faces.push_back({TopoDS::Face(pieces(k)), wall_index, top_source[at],
                                      bottom_source[at], top_face[at]});
    }
    return std::nullopt;
}

std::string number_text(double value) {
    if (value == std::floor(value) && std::abs(value) < 1e15)
        return std::to_string(static_cast<long long>(value));
    return std::to_string(value);
}

const char* kind_name(WallKind kind) {
    return kind == WallKind::Planar ? "planar" : "cylindrical";
}

}  // namespace

ThinWallRule thin_wall_rule(const val& opts) {
    const val rule = opts["thin_wall"];
    if (rule.isUndefined() || rule.isNull() || rule.typeOf().as<std::string>() != "object")
        throw std::runtime_error(
            "shell meshing needs opts.thin_wall = { max_wall, body_share, slack }: the "
            "thickest wall that counts as thin");
    auto positive = [&](const char* key) {
        const val value = rule[key];
        if (!value.isNumber() || !(value.as<double>() > 0.0) ||
            !std::isfinite(value.as<double>()))
            throw std::runtime_error(std::string("thin_wall.") + key +
                                     " must be a positive number");
        return value.as<double>();
    };
    const val slack = rule["slack"];
    if (!slack.isNumber() || !(slack.as<double>() >= 0.0) || !std::isfinite(slack.as<double>()))
        throw std::runtime_error("thin_wall.slack must be a number of at least 0");
    return {positive("max_wall"), positive("body_share"), slack.as<double>()};
}

std::vector<int> shell_body_ids(const val& opts, const TopoDS_Shape& shape) {
    const val list = opts["shell_bodies"];
    if (list.isUndefined() || list.isNull())
        return {};
    if (!list.isArray())
        throw std::runtime_error("shell_bodies must be an array of body numbers");
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    const int count = solids.Extent();
    std::vector<int> ids;
    const int length = list["length"].as<int>();
    for (int k = 0; k < length; ++k) {
        const val entry = list[k];
        if (!entry.isNumber())
            throw std::runtime_error("shell_bodies entry " + std::to_string(k) +
                                     " is not a body number");
        const double id = entry.as<double>();
        if (id != std::floor(id) || id < 1.0 || id > count)
            throw std::runtime_error("shell_bodies: body " + number_text(id) +
                                     " is not in the geometry, which has " +
                                     std::to_string(count) + (count == 1 ? " body" : " bodies"));
        const int body = static_cast<int>(id);
        if (std::find(ids.begin(), ids.end(), body) != ids.end())
            throw std::runtime_error("shell_bodies lists body " + std::to_string(body) + " twice");
        ids.push_back(body);
    }
    return ids;
}

ShellBodyAnalysis analyse_shell_body(const TopoDS_Shape& shape, int body,
                                     const ThinWallRule& rule) {
    ShellBodyAnalysis analysis;
    analysis.body = body;
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    if (body < 1 || body > solids.Extent())
        throw std::runtime_error("mid-surface: body " + std::to_string(body) +
                                 " is not in the geometry");
    const TopoDS_Shape& solid = solids(body);
    TopExp::MapShapes(shape, TopAbs_FACE, analysis.shape_faces);
    TopExp::MapShapesAndAncestors(solid, TopAbs_EDGE, TopAbs_FACE, analysis.edge_faces);

    Bnd_Box box;
    BRepBndLib::AddOptimal(solid, box, false, false);
    const double diagonal = std::sqrt(box.SquareExtent());
    const double tolerance = std::max(kRelativeTolerance * diagonal, Precision::Confusion());
    analysis.tolerance = tolerance;
    const double max_wall =
        std::max(rule.max_wall, rule.body_share * diagonal) * (1.0 + rule.slack);

    std::vector<FaceInfo> faces;
    TopTools_IndexedMapOfShape seen;
    for (TopExp_Explorer e(solid, TopAbs_FACE); e.More(); e.Next()) {
        if (seen.Contains(e.Current()))
            continue;
        seen.Add(e.Current());
        faces.push_back(
            describe_face(TopoDS::Face(e.Current()), analysis.shape_faces.FindIndex(e.Current())));
    }
    std::sort(faces.begin(), faces.end(),
              [](const FaceInfo& a, const FaceInfo& b) { return a.id < b.id; });

    std::vector<Sheet> sheets;
    std::vector<int> sheet_of_face(faces.size(), -1);
    for (std::size_t f = 0; f < faces.size(); ++f) {
        if (faces[f].type != GeomAbs_Plane && faces[f].type != GeomAbs_Cylinder)
            continue;
        auto found = std::find_if(sheets.begin(), sheets.end(), [&](const Sheet& sheet) {
            return on_sheet(sheet, faces[f], tolerance);
        });
        if (found == sheets.end()) {
            sheets.push_back(sheet_of(faces[f], f));
            sheet_of_face[f] = static_cast<int>(sheets.size() - 1);
        } else {
            found->faces.push_back(f);
            sheet_of_face[f] = static_cast<int>(found - sheets.begin());
        }
    }

    // Opposite sheets up to the thin-wall limit, thinnest first: a sheet that
    // spans a thinner wall is that wall's side, not a wall face of its own
    // (a narrow plate's long side faces are 50 mm apart, but they are sides).
    struct Pairing {
        std::size_t a;
        std::size_t b;
        double thickness;
    };
    std::vector<Pairing> pairings;
    std::vector<bool> had_partner(sheets.size(), false);
    for (std::size_t a = 0; a < sheets.size(); ++a)
        for (std::size_t b = a + 1; b < sheets.size(); ++b) {
            const std::optional<double> t = thickness_between(sheets[a], sheets[b], tolerance);
            if (!t || *t > max_wall)
                continue;
            pairings.push_back({a, b, *t});
            had_partner[a] = true;
            had_partner[b] = true;
        }
    std::stable_sort(pairings.begin(), pairings.end(), [](const Pairing& x, const Pairing& y) {
        return x.thickness < y.thickness;
    });
    std::vector<WallSheets> walls;
    std::vector<bool> taken(sheets.size(), false);
    for (const Pairing& pairing : pairings) {
        if (taken[pairing.a] || taken[pairing.b])
            continue;
        const bool a_on_top = is_top_sheet(sheets[pairing.a]);
        walls.push_back({a_on_top ? pairing.a : pairing.b, a_on_top ? pairing.b : pairing.a,
                         pairing.thickness});
        taken[pairing.a] = true;
        taken[pairing.b] = true;
        const WallSheets& wall = walls.back();
        for (std::size_t s = 0; s < sheets.size(); ++s)
            if (!taken[s] &&
                spans_sheet(sheets[s], faces, sheets[wall.top], sheets[wall.bottom], tolerance))
                taken[s] = true;
    }
    if (walls.empty()) {
        analysis.unpaired = Unpaired{faces.front().id, "no_thin_wall"};
        return analysis;
    }

    std::vector<int> wall_of_sheet(sheets.size(), -1);
    for (std::size_t w = 0; w < walls.size(); ++w) {
        wall_of_sheet[walls[w].top] = static_cast<int>(w);
        wall_of_sheet[walls[w].bottom] = static_cast<int>(w);
        const Sheet& top = sheets[walls[w].top];
        const Sheet& bottom = sheets[walls[w].bottom];
        const bool planar = top.type == GeomAbs_Plane;
        const double mid_radius = 0.5 * (top.radius + bottom.radius);
        analysis.walls.push_back({planar ? WallKind::Planar : WallKind::Cylindrical,
                                  walls[w].thickness,
                                  planar ? 1.0 : top.radius / mid_radius,
                                  planar ? 1.0 : bottom.radius / mid_radius,
                                  face_ids(top, faces), face_ids(bottom, faces), {}});
    }
    for (std::size_t f = 0; f < faces.size(); ++f) {
        const int sheet = sheet_of_face[f];
        if (sheet >= 0 && wall_of_sheet[static_cast<std::size_t>(sheet)] >= 0)
            continue;
        bool side = false;
        for (std::size_t w = 0; w < walls.size() && !side; ++w)
            if (spans(faces[f].face, sheets[walls[w].top], sheets[walls[w].bottom], tolerance)) {
                analysis.walls[w].sides.push_back(faces[f].id);
                side = true;
            }
        if (side)
            continue;
        const char* reason = "no_opposite_face";
        if (sheet < 0)
            reason = "unsupported_surface";
        else if (had_partner[static_cast<std::size_t>(sheet)])
            reason = "varying_thickness";
        analysis.walls.clear();
        analysis.unpaired = Unpaired{faces[f].id, reason};
        return analysis;
    }

    for (std::size_t w = 0; w < walls.size(); ++w) {
        std::sort(analysis.walls[w].sides.begin(), analysis.walls[w].sides.end());
        if (const std::optional<int> uncovered =
                fuse_mid_faces(analysis, w, walls[w], sheets, faces)) {
            analysis.walls.clear();
            analysis.mid_faces.clear();
            analysis.unpaired = Unpaired{*uncovered, "partial_overlap"};
            return analysis;
        }
    }
    BRep_Builder builder;
    builder.MakeCompound(analysis.mid_shape);
    for (const MidFace& mid : analysis.mid_faces)
        builder.Add(analysis.mid_shape, mid.face);
    return analysis;
}

namespace {

// The side faces whose boundary edge with the top face of mid face `mid_face`
// holds `point`, moved onto that top face: one inside an edge, two at a corner.
std::vector<int> side_faces_at(const ShellBodyAnalysis& analysis, std::size_t mid_face,
                               const gp_Pnt& point) {
    const MidFace& mid = analysis.mid_faces.at(mid_face);
    const Wall& wall = analysis.walls.at(mid.wall);
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(mid.top_face);
    GeomAPI_ProjectPointOnSurf projection(point, surface);
    if (projection.NbPoints() == 0)
        throw std::runtime_error("mid-surface: a rim point does not project onto top face " +
                                 std::to_string(mid.top));
    const TopoDS_Vertex foot = BRepBuilderAPI_MakeVertex(projection.NearestPoint()).Vertex();
    std::vector<int> sides;
    for (TopExp_Explorer e(mid.top_face, TopAbs_EDGE); e.More(); e.Next()) {
        BRepExtrema_DistShapeShape distance(foot, e.Current());
        if (!distance.IsDone() || distance.Value() >= analysis.tolerance)
            continue;
        const TopTools_ListOfShape& owners = analysis.edge_faces.FindFromKey(e.Current());
        for (TopTools_ListOfShape::Iterator it(owners); it.More(); it.Next()) {
            const int id = analysis.shape_faces.FindIndex(it.Value());
            if (std::binary_search(wall.sides.begin(), wall.sides.end(), id) &&
                std::find(sides.begin(), sides.end(), id) == sides.end())
                sides.push_back(id);
        }
    }
    return sides;
}

}  // namespace

int rim_side_face(const ShellBodyAnalysis& analysis, std::size_t mid_face, const gp_Pnt& start,
                  const gp_Pnt& end) {
    const std::vector<int> at_start = side_faces_at(analysis, mid_face, start);
    const std::vector<int> at_end = side_faces_at(analysis, mid_face, end);
    int found = 0;
    for (const int side : at_start)
        if (std::find(at_end.begin(), at_end.end(), side) != at_end.end()) {
            if (found != 0)
                throw std::runtime_error("mid-surface: a rim edge lies on side faces " +
                                         std::to_string(found) + " and " +
                                         std::to_string(side) + " at once");
            found = side;
        }
    return found;
}

gp_Dir top_side_normal(const ShellBodyAnalysis& analysis, std::size_t mid_face,
                       const gp_Pnt& point) {
    const MidFace& mid = analysis.mid_faces.at(mid_face);
    const Handle(Geom_Surface) surface = BRep_Tool::Surface(mid.top_face);
    GeomAPI_ProjectPointOnSurf projection(point, surface);
    if (projection.NbPoints() == 0)
        throw std::runtime_error("mid-surface: a point does not project onto top face " +
                                 std::to_string(mid.top));
    double u = 0.0;
    double v = 0.0;
    projection.LowerDistanceParameters(u, v);
    return outward_normal(mid.top_face, u, v);
}

val shell_route(const ShellBodyAnalysis& analysis) {
    val route = val::object();
    route.set("body", analysis.body);
    if (analysis.unpaired) {
        route.set("path", std::string("mesh"));
        route.set("face", analysis.unpaired->face);
        route.set("reason", analysis.unpaired->reason);
        return route;
    }
    route.set("path", std::string("cad"));
    val walls = val::array();
    for (const Wall& wall : analysis.walls) {
        val entry = val::object();
        entry.set("kind", std::string(kind_name(wall.kind)));
        entry.set("thickness", wall.thickness);
        entry.set("top", val::array(wall.top));
        entry.set("bottom", val::array(wall.bottom));
        entry.set("sides", val::array(wall.sides));
        walls.call<void>("push", entry);
    }
    route.set("walls", walls);
    return route;
}

val plan_shell_bodies(const std::string& opts_json) {
    if (!has_cached_shape())
        throw std::runtime_error("plan_shell_bodies: no geometry loaded — call tessellate_step first");
    const val opts = parse_json(opts_json);
    const ThinWallRule rule = thin_wall_rule(opts);
    const TopoDS_Shape& shape = cached_shape();
    val routes = val::array();
    for (const int body : shell_body_ids(opts, shape))
        routes.call<void>("push", shell_route(analyse_shell_body(shape, body, rule)));
    return routes;
}
