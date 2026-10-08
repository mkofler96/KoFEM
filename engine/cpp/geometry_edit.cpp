// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Split faces or bodies of the loaded CAD shape with a plane. See geometry_edit.h.
//
// Both modes run OCCT's General Fuse splitter (BOPAlgo_Splitter), the same
// Boolean framework imprint_touching_solids uses: it rebuilds the whole shape
// consistently, so an edge the cut divides is divided in every face that uses
// it and the solid stays watertight.
//   faces  — the tools are the plane's section curves on the picked faces. An
//            edge lying in a face splits that face; the solid itself is not cut.
//   bodies — the tool is a planar face larger than the model, which cuts every
//            argument solid it crosses into two.

#include "geometry_edit.h"

#include "cad_io.h"
#include "geometry_cache.h"
#include "json_util.h"
#include "wasm_util.h"

#include <BOPAlgo_Splitter.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <STEPControl_Writer.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopTools_ListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt.hxx>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
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

std::array<double, 3> vec3(const val& opts, const char* key) {
    const std::vector<double> v = f64_vector(opts[key], key);
    if (v.size() != 3)
        throw std::runtime_error(std::string("split_geometry: \"") + key +
                                 "\" must be an array of 3 numbers, got " +
                                 std::to_string(v.size()));
    for (const double c : v)
        if (!std::isfinite(c))
            throw std::runtime_error(std::string("split_geometry: \"") + key +
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

void require_unique_in_range(const std::vector<int>& ids, int count, const char* what) {
    std::set<int> seen;
    for (const int id : ids) {
        if (id < 1 || id > count)
            throw std::runtime_error(std::string("split_geometry: ") + what + " " +
                                     std::to_string(id) + " does not exist — the model has " +
                                     std::to_string(count) + " " + what + "s (ids 1–" +
                                     std::to_string(count) + ")");
        if (!seen.insert(id).second)
            throw std::runtime_error(std::string("split_geometry: ") + what + " " +
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

TopoDS_Shape split_faces(const TopoDS_Shape& shape, const std::vector<int>& face_ids,
                         const gp_Pln& plane) {
    if (face_ids.empty())
        throw std::runtime_error("split_geometry: no face to split — pick at least one face");
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    require_unique_in_range(face_ids, faces.Extent(), "face");

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
    return in_solid_order(shape, splitter);
}

TopoDS_Shape split_bodies(const TopoDS_Shape& shape, const std::vector<int>& body_ids,
                          const gp_Pln& plane) {
    TopTools_IndexedMapOfShape solids;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    if (solids.IsEmpty())
        throw std::runtime_error(
            "split_geometry: the model has no solid body to split — it is surface-only "
            "geometry. Split its faces instead.");
    require_unique_in_range(body_ids, solids.Extent(), "body");

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
    return in_solid_order(shape, splitter);
}

// STEP AP214 text of `shape`, through Emscripten's in-memory /tmp — the writer,
// like the reader, only speaks file paths.
std::vector<uint8_t> step_bytes(const TopoDS_Shape& shape) {
    STEPControl_Writer writer;
    if (writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone)
        throw std::runtime_error("split_geometry: STEPControl_Writer could not transfer the edited shape");

    std::array<char, 32> path{};
    std::strcpy(path.data(), "/tmp/kofem_XXXXXX.stp");
    const int fd = mkstemps(path.data(), 4);
    if (fd < 0)
        throw std::runtime_error("split_geometry: failed to create a /tmp STEP file");
    close(fd);
    const IFSelect_ReturnStatus status = writer.Write(path.data());
    if (status != IFSelect_RetDone) {
        unlink(path.data());
        throw std::runtime_error("split_geometry: STEPControl_Writer::Write failed");
    }
    std::ifstream file(path.data(), std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                               std::istreambuf_iterator<char>());
    unlink(path.data());
    if (bytes.empty())
        throw std::runtime_error("split_geometry: the written STEP file is empty");
    return bytes;
}

}  // namespace

val split_geometry(const std::string& opts_json) {
    const val opts = parse_json(opts_json);
    const std::string mode = jstring(opts, "mode", "");
    const gp_Pln plane = plane_from(opts);
    const TopoDS_Shape& shape = cached_shape();

    TopoDS_Shape edited;
    if (mode == "faces")
        edited = split_faces(shape, id_list(opts, "faceIds"), plane);
    else if (mode == "bodies")
        edited = split_bodies(shape, id_list(opts, "bodyIds"), plane);
    else
        throw std::runtime_error("split_geometry: \"mode\" must be \"faces\" or \"bodies\", got \"" +
                                 mode + "\"");

    const std::vector<uint8_t> bytes = step_bytes(edited);
    // The edit lives in the returned file from here on. Drop the pre-edit shape
    // so a caller that forgets to load the bytes fails loudly at the next mesh
    // instead of meshing the geometry the user just changed.
    free_geometry_cache();

    val result = val::object();
    result.set("bytes", uint8_array(bytes));
    return result;
}
