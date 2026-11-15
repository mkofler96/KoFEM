// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Split faces or bodies of the loaded CAD shape with a plane, or combine
// bodies with a Boolean operation. See geometry_edit.h.
//
// Both modes run OCCT's General Fuse splitter (BOPAlgo_Splitter), the same
// Boolean framework imprint_touching_solids uses: it rebuilds the whole shape
// consistently, so an edge the cut divides is divided in every face that uses
// it and the solid stays watertight.
//   faces  — the tools are the plane's section curves on the picked faces. An
//            edge lying in a face splits that face; the solid itself is not cut.
//   bodies — the tool is a planar face larger than the model, which cuts every
//            argument solid it crosses into two.
//
// boolean_geometry runs the matching BRepAlgoAPI operation (Fuse, Cut, Common)
// of one target body with tool bodies and puts the result in the target's place.
//
// repair_hinges removes line contacts (see mesh_overlap.h) with a small box along
// each line: fused it welds the two sides, cut out it opens a gap between them.

#include "geometry_edit.h"

#include "cad_io.h"
#include "geometry_cache.h"
#include "json_util.h"
#include "mesh_overlap.h"
#include "wasm_util.h"

#include <BOPAlgo_Splitter.hxx>
#include <BRepAlgoAPI_BooleanOperation.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Defeaturing.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <Bnd_Box.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Geom_Surface.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPControl_Writer.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <stdexcept>
#include <unistd.h>
#include <vector>

using emscripten::val;

namespace {

// A plane normal closer than this to a coordinate axis is reported as "x = …".
constexpr double AXIS_TOLERANCE = 1e-9;
// Two planes whose normals differ by less than this (radians) are parallel.
constexpr double PARALLEL_ANGLE = 1e-6;

std::array<double, 3> vec3(const val& opts, const char* key,
                           const char* caller = "split_geometry") {
    const std::vector<double> v = f64_vector(opts[key], key);
    if (v.size() != 3)
        throw std::runtime_error(std::string(caller) + ": \"" + key +
                                 "\" must be an array of 3 numbers, got " +
                                 std::to_string(v.size()));
    for (const double c : v)
        if (!std::isfinite(c))
            throw std::runtime_error(std::string(caller) + ": \"" + key +
                                     "\" contains a non-finite number");
    return {v[0], v[1], v[2]};
}

gp_Pln plane_from(const val& opts) {
    const std::array<double, 3> origin = vec3(opts, "origin");
    const std::array<double, 3> normal = vec3(opts, "normal");
    if (std::hypot(normal[0], normal[1], normal[2]) < 1e-12)
        throw std::runtime_error(
            "split_geometry: the plane normal is the zero vector — give it a direction");
    return {gp_Pnt(origin[0], origin[1], origin[2]),
            gp_Dir(normal[0], normal[1], normal[2])};
}

// "x = 5 mm" for an axis-aligned plane, the point and normal otherwise — the
// way the user typed it, so an error message reads back their own input.
std::string describe_plane(const gp_Pln& plane) {
    const gp_Dir& n = plane.Axis().Direction();
    const gp_Pnt& o = plane.Location();
    std::ostringstream out;
    out.precision(6);
    constexpr std::array<char, 3> axis_names = {'x', 'y', 'z'};
    for (int k = 0; k < 3; ++k)
        if (std::abs(std::abs(n.Coord(k + 1)) - 1.0) < AXIS_TOLERANCE) {
            out << "the plane " << axis_names.at(k) << " = " << o.Coord(k + 1) << " mm";
            return out.str();
        }
    out << "the plane through (" << o.X() << ", " << o.Y() << ", " << o.Z()
        << ") with normal (" << n.X() << ", " << n.Y() << ", " << n.Z() << ")";
    return out.str();
}

std::vector<int> id_list(const val& opts, const char* key) {
    if (opts[key].isUndefined() || opts[key].isNull())
        return {};
    const std::vector<int32_t> ids = i32_vector(opts[key], key);
    return {ids.begin(), ids.end()};
}

void require_unique_in_range(const char* caller, const std::vector<int>& ids, int count,
                             const char* what) {
    std::set<int> seen;
    for (const int id : ids) {
        if (id < 1 || id > count)
            throw std::runtime_error(std::string(caller) + ": " + what + " " +
                                     std::to_string(id) + " does not exist — the model has " +
                                     std::to_string(count) + " " + what + "s (ids 1–" +
                                     std::to_string(count) + ")");
        if (!seen.insert(id).second)
            throw std::runtime_error(std::string(caller) + ": " + what + " " +
                                     std::to_string(id) + " is listed twice");
    }
}

void run_splitter(BOPAlgo_Splitter& splitter) {
    splitter.SetRunParallel(false);  // single-threaded WASM build
    splitter.Perform();
    if (splitter.HasErrors()) {
        std::ostringstream alerts;
        splitter.DumpErrors(alerts);
        throw std::runtime_error(
            "split_geometry: the OCCT splitter failed — the geometry around the "
            "cut is likely defective. OCCT reports: " + alerts.str());
    }
}

// What a split piece of `shape` became: its images, or the shape itself when
// the splitter left it untouched.
void add_images(BRep_Builder& builder, TopoDS_Compound& out,
                BOPAlgo_Splitter& splitter, const TopoDS_Shape& shape) {
    const TopTools_ListOfShape& images = splitter.Modified(shape);
    if (images.IsEmpty()) {
        builder.Add(out, shape);
        return;
    }
    for (const TopoDS_Shape& image : images)
        builder.Add(out, image);
}

// The splitter returns its result in its own order. Body ids are the solids'
// order in the file (per-body materials hang off them), so rebuild the result
// in the input's solid order: body k's images take k's place.
TopoDS_Shape in_solid_order(const TopoDS_Shape& input, BOPAlgo_Splitter& splitter) {
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(input, TopAbs_SOLID, solids);
    if (solids.IsEmpty())
        return splitter.Shape();  // surface-only geometry: no body order to keep
    BRep_Builder builder;
    TopoDS_Compound out;
    builder.MakeCompound(out);
    for (int i = 1; i <= solids.Extent(); ++i)
        add_images(builder, out, splitter, solids(i));
    return out;
}

// Entry j: the 1-based input solid that solid j+1 of in_solid_order(input,
// splitter) came from — a body cut in two has two entries, both its id. The app
// carries each body's settings to its pieces with it. Surface-only geometry has
// no solids to trace: it is one body before and after.
std::vector<int> solid_sources(const TopoDS_Shape& input, BOPAlgo_Splitter& splitter) {
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(input, TopAbs_SOLID, solids);
    if (solids.IsEmpty())
        return {1};
    std::vector<int> sources;
    for (int i = 1; i <= solids.Extent(); ++i) {
        const int pieces = std::max(1, splitter.Modified(solids(i)).Extent());
        sources.insert(sources.end(), static_cast<size_t>(pieces), i);
    }
    return sources;
}

// A split's result in the input's solid order, and where each solid came from.
struct SplitShape {
    TopoDS_Shape shape;
    std::vector<int> body_sources;  // entry j: the old id of new body j+1
};

SplitShape split_result(const TopoDS_Shape& input, BOPAlgo_Splitter& splitter) {
    return {in_solid_order(input, splitter), solid_sources(input, splitter)};
}

// Why the plane left `face` whole, for an error that tells the user what to
// change rather than just that nothing happened.
std::string why_not_split(const TopoDS_Face& face, const gp_Pln& plane, int n_section_edges) {
    const BRepAdaptor_Surface surface(face);
    if (surface.GetType() == GeomAbs_Plane &&
        surface.Plane().Axis().IsParallel(plane.Axis(), PARALLEL_ANGLE))
        return "is parallel to " + describe_plane(plane) +
               " — choose a plane that crosses the face";
    if (n_section_edges == 0)
        return "is not crossed by " + describe_plane(plane) +
               " — move the plane inside the face";
    return "is only touched by " + describe_plane(plane) +
           " along its boundary — move the plane inside the face";
}

SplitShape split_faces(const TopoDS_Shape& shape, const std::vector<int>& face_ids,
                         const gp_Pln& plane) {
    if (face_ids.empty())
        throw std::runtime_error("split_geometry: no face to split — pick at least one face");
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    require_unique_in_range("split_geometry", face_ids, faces.Extent(), "face");

    BOPAlgo_Splitter splitter;
    splitter.AddArgument(shape);
    std::vector<int> n_edges;
    for (const int id : face_ids) {
        const TopoDS_Face& face = TopoDS::Face(faces(id));
        BRepAlgoAPI_Section section(face, plane, Standard_False);
        section.Approximation(Standard_True);
        section.Build();
        if (!section.IsDone())
            throw std::runtime_error("split_geometry: intersecting face " + std::to_string(id) +
                                     " with " + describe_plane(plane) + " failed");
        int n = 0;
        for (TopExp_Explorer e(section.Shape(), TopAbs_EDGE); e.More(); e.Next()) {
            splitter.AddTool(e.Current());
            ++n;
        }
        n_edges.push_back(n);
    }
    for (size_t k = 0; k < face_ids.size(); ++k)
        if (n_edges[k] == 0)
            throw std::runtime_error(
                "Face " + std::to_string(face_ids[k]) + " " +
                why_not_split(TopoDS::Face(faces(face_ids[k])), plane, 0));

    run_splitter(splitter);

    for (size_t k = 0; k < face_ids.size(); ++k) {
        const TopoDS_Shape& face = faces(face_ids[k]);
        const int pieces = splitter.Modified(face).Extent();
        if (pieces < 2)
            throw std::runtime_error("Face " + std::to_string(face_ids[k]) + " " +
                                     why_not_split(TopoDS::Face(face), plane, n_edges[k]));
        (void)printf("[occt] split: face %d → %d faces by %s\n", face_ids[k], pieces,
                     describe_plane(plane).c_str());
    }
    (void)fflush(stdout);
    return split_result(shape, splitter);
}

SplitShape split_bodies(const TopoDS_Shape& shape, const std::vector<int>& body_ids,
                          const gp_Pln& plane) {
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    if (solids.IsEmpty())
        throw std::runtime_error(
            "split_geometry: the model has no solid body to split — it is surface-only "
            "geometry. Split its faces instead.");
    require_unique_in_range("split_geometry", body_ids, solids.Extent(), "body");

    // A planar face that reaches past the model in every direction: half the
    // model diagonal past the farthest point of the box from the plane origin.
    Bnd_Box box;
    BRepBndLib::Add(shape, box);
    const gp_Pnt centre((box.CornerMin().XYZ() + box.CornerMax().XYZ()) / 2.0);
    const double reach = shape_bbox_diagonal(shape) + centre.Distance(plane.Location());
    const TopoDS_Face tool = BRepBuilderAPI_MakeFace(plane, -reach, reach, -reach, reach).Face();

    std::vector<int> targets = body_ids;
    if (targets.empty())
        for (int i = 1; i <= solids.Extent(); ++i)
            targets.push_back(i);

    BOPAlgo_Splitter splitter;
    for (const int id : targets)
        splitter.AddArgument(solids(id));
    splitter.AddTool(tool);
    run_splitter(splitter);

    int n_split = 0;
    for (const int id : targets) {
        const int pieces = splitter.Modified(solids(id)).Extent();
        if (pieces >= 2) {
            ++n_split;
            (void)printf("[occt] split: body %d → %d bodies by %s\n", id, pieces,
                         describe_plane(plane).c_str());
        } else if (!body_ids.empty()) {
            throw std::runtime_error("Body " + std::to_string(id) + " is not crossed by " +
                                     describe_plane(plane) + " — move the plane inside the body");
        }
    }
    (void)fflush(stdout);
    if (n_split == 0)
        throw std::runtime_error("No body is crossed by " + describe_plane(plane) +
                                 " — move the plane inside the model");
    return split_result(shape, splitter);
}

// STEP AP214 text of `shape`, through Emscripten's in-memory /tmp — the writer,
// like the reader, only speaks file paths.
std::vector<uint8_t> step_bytes(const TopoDS_Shape& shape) {
    STEPControl_Writer writer;
    if (writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone)
        throw std::runtime_error("geometry edit: STEPControl_Writer could not transfer the edited shape");

    std::array<char, 32> path{};
    std::strcpy(path.data(), "/tmp/kofem_XXXXXX.stp");
    const int fd = mkstemps(path.data(), 4);
    if (fd < 0)
        throw std::runtime_error("geometry edit: failed to create a /tmp STEP file");
    close(fd);
    const IFSelect_ReturnStatus status = writer.Write(path.data());
    if (status != IFSelect_RetDone) {
        unlink(path.data());
        throw std::runtime_error("geometry edit: STEPControl_Writer::Write failed");
    }
    std::ifstream file(path.data(), std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                               std::istreambuf_iterator<char>());
    unlink(path.data());
    if (bytes.empty())
        throw std::runtime_error("geometry edit: the written STEP file is empty");
    return bytes;
}

SplitShape split_by_mode(const std::string& mode, const TopoDS_Shape& shape,
                           const val& opts, const gp_Pln& plane) {
    if (mode == "faces")
        return split_faces(shape, id_list(opts, "faceIds"), plane);
    if (mode == "bodies")
        return split_bodies(shape, id_list(opts, "bodyIds"), plane);
    throw std::runtime_error(
        R"(split_geometry: "mode" must be "faces" or "bodies", got ')" + mode + "'");
}

// ── Boolean operations ───────────────────────────────────────────────────────

// Relative volume change below which a Boolean "did nothing" — OCCT rebuilds
// the shape even when the tool misses, so the result is compared, not trusted.
constexpr double VOLUME_UNCHANGED = 1e-9;

double solid_volume(const TopoDS_Shape& shape) {
    GProp_GProps props;
    BRepGProp::VolumeProperties(shape, props);
    return std::abs(props.Mass());
}

std::string body_list(const std::vector<int>& ids) {
    std::string out;
    for (size_t k = 0; k < ids.size(); ++k) {
        if (k > 0)
            out += k + 1 == ids.size() ? " and " : ", ";
        out += "Body " + std::to_string(ids[k]);
    }
    return out;
}

std::unique_ptr<BRepAlgoAPI_BooleanOperation> make_operation(const std::string& op) {
    if (op == "union")
        return std::make_unique<BRepAlgoAPI_Fuse>();
    if (op == "subtract")
        return std::make_unique<BRepAlgoAPI_Cut>();
    if (op == "intersect")
        return std::make_unique<BRepAlgoAPI_Common>();
    throw std::runtime_error(
        R"(boolean_geometry: "op" must be "union", "subtract" or "intersect", got ')" + op + "'");
}

// Refuse a result that leaves the model as it was or with nothing: OCCT reports
// success for a cut whose tool misses, and an empty common is a valid shape.
void check_boolean_result(const std::string& op, const TopoDS_Shape& result, int target,
                          const std::vector<int>& tools, double target_volume) {
    const std::string target_name = "Body " + std::to_string(target);
    const int n_solids = count_solids(result);
    if (op == "union" && n_solids != 1)
        throw std::runtime_error(target_name + " and " + body_list(tools) +
                                 " do not touch or overlap — a union of separate bodies "
                                 "would still be " + std::to_string(n_solids) + " bodies");
    if (op == "intersect" && (n_solids == 0 || solid_volume(result) <= 0.0))
        throw std::runtime_error(target_name + " and " + body_list(tools) +
                                 " do not overlap — their intersection is empty");
    if (op == "subtract") {
        if (n_solids == 0)
            throw std::runtime_error(target_name + " lies entirely inside " + body_list(tools) +
                                     " — subtracting would leave nothing of it");
        if (std::abs(solid_volume(result) - target_volume) <= VOLUME_UNCHANGED * target_volume)
            throw std::runtime_error(body_list(tools) + " does not overlap " + target_name +
                                     " — there is nothing to subtract");
    }
}

TopoDS_Shape combine_bodies(const TopoDS_Shape& shape, const std::string& op, int target,
                            const std::vector<int>& tools, bool keep_tools) {
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    if (solids.Extent() < 2)
        throw std::runtime_error(
            "boolean_geometry: a Boolean needs at least two bodies, the model has " +
            std::to_string(solids.Extent()));
    if (tools.empty())
        throw std::runtime_error("boolean_geometry: no tool body — pick at least one body to " +
                                 op + (op == "subtract" ? " from" : " with") + " Body " +
                                 std::to_string(target));
    std::vector<int> all = tools;
    all.push_back(target);
    require_unique_in_range("boolean_geometry", all, solids.Extent(), "body");

    std::unique_ptr<BRepAlgoAPI_BooleanOperation> operation = make_operation(op);
    TopTools_ListOfShape arguments;
    arguments.Append(solids(target));
    TopTools_ListOfShape tool_shapes;
    for (const int id : tools)
        tool_shapes.Append(solids(id));
    operation->SetArguments(arguments);
    operation->SetTools(tool_shapes);
    operation->SetRunParallel(false);  // single-threaded WASM build
    operation->Build();
    if (operation->HasErrors() || !operation->IsDone()) {
        std::ostringstream alerts;
        operation->DumpErrors(alerts);
        throw std::runtime_error("boolean_geometry: the OCCT " + op +
                                 " failed — the bodies' geometry where they meet is likely "
                                 "defective. OCCT reports: " + alerts.str());
    }
    // Merge the coplanar faces the operation leaves where the bodies met, so a
    // union reads as one clean body rather than a patchwork of its inputs.
    operation->SimplifyResult();
    const TopoDS_Shape result = operation->Shape();
    check_boolean_result(op, result, target, tools, solid_volume(solids(target)));

    // Rebuild in the input's solid order (body ids are that order): the result
    // takes the target's place, consumed tools drop out, the rest stay as is.
    const bool tools_stay = op == "subtract" && keep_tools;
    const std::set<int> tool_set(tools.begin(), tools.end());
    BRep_Builder builder;
    TopoDS_Compound out;
    builder.MakeCompound(out);
    for (int i = 1; i <= solids.Extent(); ++i) {
        if (i == target) {
            for (TopExp_Explorer e(result, TopAbs_SOLID); e.More(); e.Next())
                builder.Add(out, e.Current());
        } else if (tool_set.count(i) == 0 || tools_stay) {
            builder.Add(out, solids(i));
        }
    }
    (void)printf("[occt] boolean: %s of Body %d with %s → %d bodies\n", op.c_str(), target,
                 body_list(tools).c_str(), count_solids(out));
    (void)fflush(stdout);
    return out;
}

// ── Cone tips ───────────────────────────────────────────────────────────────

// Lines from the tip to the rim, away from the seam, open a closed cone face up
// into pieces that Netgen can mesh.
constexpr std::array<double, 2> CONE_CUT_FRACTIONS = {1.0 / 3.0, 2.0 / 3.0};

// ── Hinge repair ─────────────────────────────────────────────────────────────

// How deep the tool reaches to each side of the contact, per unit of its width.
// A weld has to reach into the material on both sides past the thin wedge next
// to the contact; a gap only has to be wide enough to mesh.
constexpr double CONNECT_DEPTH_RATIO = 0.5;
constexpr double SEPARATE_DEPTH_RATIO = 0.1;

struct HingeLine {
    int body;
    gp_Pnt start;
    gp_Pnt end;
    gp_Dir normal;
};

gp_Pnt to_point(const std::array<double, 3>& p) {
    return {p[0], p[1], p[2]};
}

std::vector<HingeLine> hinge_lines(const val& opts) {
    const val list = opts["hinges"];
    if (list.isUndefined() || list.isNull() || list["length"].as<int>() == 0)
        throw std::runtime_error("repair_hinges: no hinge to repair");
    std::vector<HingeLine> hinges;
    for (int i = 0; i < list["length"].as<int>(); ++i) {
        const val hinge = list[i];
        const gp_Pnt start = to_point(vec3(hinge, "start", "repair_hinges"));
        const gp_Pnt end = to_point(vec3(hinge, "end", "repair_hinges"));
        const std::array<double, 3> n = vec3(hinge, "normal", "repair_hinges");
        if (start.Distance(end) < 1e-9)
            throw std::runtime_error("repair_hinges: hinge " + std::to_string(i + 1) +
                                     " has no length");
        // Square the normal up against the line so the box is a true box.
        const gp_Vec along(start, end);
        const gp_Vec normal(n[0], n[1], n[2]);
        const gp_Vec square = normal - along.Normalized() * normal.Dot(along.Normalized());
        if (square.Magnitude() < 1e-9)
            throw std::runtime_error("repair_hinges: the normal of hinge " +
                                     std::to_string(i + 1) + " lies along the hinge");
        hinges.push_back({jint(hinge, "bodyId", 0), start, end, gp_Dir(square)});
    }
    return hinges;
}

TopoDS_Shape hinge_tool(const HingeLine& hinge, double width, double depth) {
    const gp_Vec along(hinge.start, hinge.end);
    const gp_Dir direction(along);
    const gp_Dir side = direction.Crossed(hinge.normal);
    const gp_Pnt corner = hinge.start.Translated(gp_Vec(hinge.normal) * -depth +
                                                 gp_Vec(side) * (-width / 2.0));
    // Box axes: X along the normal, Y across the line, Z along the line.
    return BRepPrimAPI_MakeBox(gp_Ax2(corner, direction, hinge.normal), 2.0 * depth, width,
                               along.Magnitude())
        .Shape();
}

TopoDS_Shape apply_hinge_tool(const TopoDS_Shape& solid, const std::string& op,
                              const TopoDS_Shape& tool) {
    std::unique_ptr<BRepAlgoAPI_BooleanOperation> operation;
    if (op == "connect")
        operation = std::make_unique<BRepAlgoAPI_Fuse>();
    else
        operation = std::make_unique<BRepAlgoAPI_Cut>();
    TopTools_ListOfShape arguments;
    arguments.Append(solid);
    TopTools_ListOfShape tools;
    tools.Append(tool);
    operation->SetArguments(arguments);
    operation->SetTools(tools);
    operation->SetRunParallel(false);  // single-threaded WASM build
    operation->Build();
    if (operation->HasErrors() || !operation->IsDone()) {
        std::ostringstream alerts;
        operation->DumpErrors(alerts);
        throw std::runtime_error("repair_hinges: the OCCT Boolean failed. OCCT reports: " +
                                 alerts.str());
    }
    // The box's sides split the faces it lands on along the contact. Fusing can
    // leave an invalid wire there, whatever the width; merging the faces that lie
    // on one surface removes it. Only then: the merge can itself break a part the
    // fuse left valid.
    if (op == "connect" && !BRepCheck_Analyzer(operation->Shape()).IsValid())
        operation->SimplifyResult();
    const TopoDS_Shape result = operation->Shape();
    if (count_solids(result) == 0 || !BRepCheck_Analyzer(result).IsValid())
        throw std::runtime_error(op == "connect"
                                     ? "Connecting here left invalid geometry. Try another "
                                       "width, or Separate."
                                     : "Separating here left invalid geometry. Try another "
                                       "width, or Connect.");
    return result;
}

struct RepairedShape {
    TopoDS_Shape shape;
    std::vector<int> body_sources;  // entry j: the old id of new body j+1
};

RepairedShape repair_hinge_lines(const TopoDS_Shape& shape, const std::string& op, double width,
                                 const std::vector<HingeLine>& hinges) {
    if (op != "connect" && op != "separate")
        throw std::runtime_error(
            R"(repair_hinges: "op" must be "connect" or "separate", got ')" + op + "'");
    if (!std::isfinite(width) || width <= 0.0)
        throw std::runtime_error("repair_hinges: the width must be a positive number of mm");
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    const double depth =
        width * (op == "connect" ? CONNECT_DEPTH_RATIO : SEPARATE_DEPTH_RATIO);

    std::map<int, std::vector<TopoDS_Shape>> tools_of_body;
    for (const HingeLine& hinge : hinges) {
        if (hinge.body < 1 || hinge.body > solids.Extent())
            throw std::runtime_error("repair_hinges: body " + std::to_string(hinge.body) +
                                     " does not exist — the model has " +
                                     std::to_string(solids.Extent()) + " bodies");
        tools_of_body[hinge.body].push_back(hinge_tool(hinge, width, depth));
    }

    // Body ids are the solids' order in the file: a repaired body keeps its place,
    // and the pieces of one that came apart take that place together.
    BRep_Builder builder;
    TopoDS_Compound out;
    builder.MakeCompound(out);
    std::vector<int> body_sources;
    for (int i = 1; i <= solids.Extent(); ++i) {
        const auto tools = tools_of_body.find(i);
        if (tools == tools_of_body.end()) {
            builder.Add(out, solids(i));
            body_sources.push_back(i);
            continue;
        }
        // One tool at a time: OCCT left invalid geometry when fusing several
        // boxes into a real part in one operation, and valid geometry this way.
        TopoDS_Shape repaired = solids(i);
        for (const TopoDS_Shape& tool : tools->second)
            repaired = apply_hinge_tool(repaired, op, tool);
        for (TopExp_Explorer e(repaired, TopAbs_SOLID); e.More(); e.Next()) {
            builder.Add(out, e.Current());
            body_sources.push_back(i);
        }
    }
    (void)printf("[occt] hinge repair: %s %d hinge(s), width %g mm → %d bodies\n", op.c_str(),
                 static_cast<int>(hinges.size()), width, count_solids(out));
    (void)fflush(stdout);
    return {out, body_sources};
}

}  // namespace

val split_cone_tips(const std::string& opts_json) {
    const val opts = parse_json(opts_json);
    const std::vector<int> face_ids = id_list(opts, "faceIds");
    const TopoDS_Shape& shape = cached_shape();
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    require_unique_in_range("split_cone_tips", face_ids, faces.Extent(), "face");

    BOPAlgo_Splitter splitter;
    splitter.AddArgument(shape);
    int n_cones = 0;
    for (const int id : face_ids) {
        const TopoDS_Face& face = TopoDS::Face(faces(id));
        // An overlap region can reach the faces next to the cone.
        if (!is_closed_cone_tip(face))
            continue;
        ++n_cones;
        const BRepAdaptor_Surface bounds(face);
        const Handle(Geom_Surface) surface = BRep_Tool::Surface(face);
        for (const double fraction : CONE_CUT_FRACTIONS) {
            const double u = bounds.FirstUParameter() +
                             fraction * (bounds.LastUParameter() - bounds.FirstUParameter());
            splitter.AddTool(BRepBuilderAPI_MakeEdge(surface->UIso(u), bounds.FirstVParameter(),
                                                     bounds.LastVParameter())
                                 .Edge());
        }
    }
    if (n_cones == 0)
        throw std::runtime_error("split_cone_tips: none of the given faces is a cone with a tip");
    run_splitter(splitter);
    const TopoDS_Shape edited = in_solid_order(shape, splitter);
    if (!BRepCheck_Analyzer(edited).IsValid())
        throw std::runtime_error(
            "Splitting the cone tips left invalid geometry. Simplify them in CAD and re-import.");
    (void)printf("[occt] split %d cone tip(s)\n", n_cones);
    (void)fflush(stdout);

    const std::vector<uint8_t> bytes = step_bytes(edited);
    // As for a split: the edit lives in the returned file from here on.
    free_geometry_cache();

    val result = val::object();
    result.set("bytes", uint8_array(bytes));
    return result;
}

val remove_faces(const std::string& opts_json) {
    const val opts = parse_json(opts_json);
    const std::vector<int> face_ids = id_list(opts, "faceIds");
    if (face_ids.empty())
        throw std::runtime_error("remove_faces: no faces given");
    const TopoDS_Shape& shape = cached_shape();
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    require_unique_in_range("remove_faces", face_ids, faces.Extent(), "face");
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    if (solids.IsEmpty())
        throw std::runtime_error(
            "remove_faces: the model has no solid body — surface-only geometry has no "
            "neighbouring faces to close the gap with");

    // One body at a time, so the result keeps the input's solid order (body ids
    // carry per-body materials) without relying on defeaturing history.
    BRep_Builder builder;
    TopoDS_Compound edited;
    builder.MakeCompound(edited);
    std::set<int> removed;
    for (int i = 1; i <= solids.Extent(); ++i) {
        const TopoDS_Shape& solid = solids(i);
        TopTools_IndexedMapOfShape solid_faces;
        TopExp::MapShapes(solid, TopAbs_FACE, solid_faces);
        BRepAlgoAPI_Defeaturing defeaturing;
        defeaturing.SetShape(solid);
        defeaturing.SetRunParallel(false);
        std::vector<int> in_solid;
        for (const int id : face_ids)
            if (solid_faces.Contains(faces(id))) {
                defeaturing.AddFaceToRemove(faces(id));
                removed.insert(id);
                in_solid.push_back(id);
            }
        if (in_solid.empty()) {
            builder.Add(edited, solid);
            continue;
        }
        defeaturing.Build();
        if (!defeaturing.IsDone() || defeaturing.HasErrors())
            throw std::runtime_error(
                "Removing the faces didn't work: the faces around them can't be extended to "
                "close the gap. Fix them in CAD and re-import.");
        // Defeaturing can report success and hand the solid back unchanged
        // when it can't extend the neighbours: that is a failure, not an edit.
        for (const int id : in_solid)
            if (!defeaturing.IsDeleted(faces(id)))
                throw std::runtime_error(
                    "Face " + std::to_string(id) +
                    " couldn't be removed: the faces around it can't be extended to close the "
                    "gap. Fix it in CAD and re-import.");
        for (TopExp_Explorer e(defeaturing.Shape(), TopAbs_SOLID); e.More(); e.Next())
            builder.Add(edited, e.Current());
    }
    if (removed.size() != face_ids.size())
        throw std::runtime_error("remove_faces: some faces belong to no solid body");
    if (!BRepCheck_Analyzer(edited).IsValid())
        throw std::runtime_error(
            "Removing the faces left invalid geometry. Fix them in CAD and re-import.");
    (void)printf("[occt] removed %d face(s)\n", (int)face_ids.size());
    (void)fflush(stdout);

    const std::vector<uint8_t> bytes = step_bytes(edited);
    // As for a split: the edit lives in the returned file from here on.
    free_geometry_cache();

    val result = val::object();
    result.set("bytes", uint8_array(bytes));
    return result;
}

val repair_hinges(const std::string& opts_json) {
    const val opts = parse_json(opts_json);
    const std::string op = jstring(opts, "op", "");
    const double width = jdouble(opts, "width", 0.0);
    const std::vector<HingeLine> hinges = hinge_lines(opts);
    const RepairedShape edited = repair_hinge_lines(cached_shape(), op, width, hinges);

    const std::vector<uint8_t> bytes = step_bytes(edited.shape);
    // As for a split: the edit lives in the returned file from here on.
    free_geometry_cache();

    val result = val::object();
    result.set("bytes", uint8_array(bytes));
    result.set("bodySources", val::array(edited.body_sources));
    return result;
}

val boolean_geometry(const std::string& opts_json) {
    const val opts = parse_json(opts_json);
    const std::string op = jstring(opts, "op", "");
    const int target = jint(opts, "target", 0);
    const std::vector<int> tools = id_list(opts, "tools");
    const bool keep_tools = jbool(opts, "keepTools", false);
    const TopoDS_Shape& shape = cached_shape();
    const TopoDS_Shape edited = combine_bodies(shape, op, target, tools, keep_tools);

    const std::vector<uint8_t> bytes = step_bytes(edited);
    // As for a split: the edit lives in the returned file from here on.
    free_geometry_cache();

    val result = val::object();
    result.set("bytes", uint8_array(bytes));
    return result;
}

val split_geometry(const std::string& opts_json) {
    const val opts = parse_json(opts_json);
    // Named in sequence: mode, then plane, then the shape, so a caller always
    // meets the first invalid input — not one of two unsequenced arguments.
    const std::string mode = jstring(opts, "mode", "");
    const gp_Pln plane = plane_from(opts);
    const TopoDS_Shape& shape = cached_shape();
    const SplitShape edited = split_by_mode(mode, shape, opts, plane);

    const std::vector<uint8_t> bytes = step_bytes(edited.shape);
    // The edit lives in the returned file from here on. Drop the pre-edit shape
    // so a caller that forgets to load the bytes fails loudly at the next mesh
    // instead of meshing the geometry the user just changed.
    free_geometry_cache();

    val result = val::object();
    result.set("bytes", uint8_array(bytes));
    result.set("bodySources", val::array(edited.body_sources));
    return result;
}
