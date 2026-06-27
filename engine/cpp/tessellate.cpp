// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// OCCT: STEP / IGES shape → surface tessellation (display + meshing input).
// See tessellate.h.

#include "tessellate.h"

#include "cad_io.h"
#include "geometry_cache.h"
#include "json_util.h"
#include "wasm_util.h"

#include <BRep_Tool.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <Poly_Triangulation.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <vector>

using emscripten::val;

val tessellate_step(val bytes_val, const std::string& opts_json) {
    val opts = parse_json(opts_json);
    // The display chord tolerance must scale with model size: a fixed absolute
    // deflection makes a 900 mm casting ~45x finer than a 20 mm part, producing
    // millions of needless triangles and a multi-second load.  deflection_relative
    // is the chord height as a fraction of the bounding-box diagonal (~0.1% matches
    // the fast browser STEP viewers).  linear_deflection (absolute mm) overrides it
    // when > 0, for callers that want an explicit tolerance.
    double rel_defl     = jdouble(opts, "deflection_relative", 0.001);
    double abs_defl_opt = jdouble(opts, "linear_deflection",   0.0);
    double angular_defl = jdouble(opts, "angular_deflection",  0.5);
    std::string format  = jstring(opts, "format", "step");

    std::vector<uint8_t> bytes = emscripten::vecFromJSArray<uint8_t>(bytes_val);

    // read_cad_shape returns whatever the CAD file stores. IGES (and some STEP)
    // files store only free surfaces, so sew them into a solid here — once, on
    // load — and cache the result for both display and meshing (issue #276).
    TopoDS_Shape shape = sew_faces_into_solid(read_cad_shape(bytes, format));
    set_cached_shape(shape);

    double diag = shape_bbox_diagonal(shape);
    double linear_defl;
    if (abs_defl_opt > 0.0)
        linear_defl = abs_defl_opt;          // explicit absolute tolerance
    else if (diag > 0.0)
        linear_defl = diag * rel_defl;       // scale with model size (~0.1% of diagonal)
    else
        linear_defl = 0.1;                   // degenerate/empty bbox — fixed fallback
    printf("[occt] tessellate: bbox diag=%.3f mm -> linear_defl=%.4f mm\n", diag, linear_defl);
    fflush(stdout);

    BRepMesh_IncrementalMesh mesher(shape, linear_defl, /*relative=*/false, angular_defl);
    mesher.Perform();
    if (!mesher.IsDone())
        throw std::runtime_error("BRepMesh_IncrementalMesh failed");

    // Float32 positions + Uint32 indices: half the bytes of a JSON double array,
    // ample precision for display (~1e-4 mm relative), and zero text formatting.
    std::vector<float>    verts;
    std::vector<uint32_t> tris;

    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
        TopoDS_Face face = TopoDS::Face(exp.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;

        uint32_t base = (uint32_t)(verts.size() / 3);

        for (int i = 1; i <= tri->NbNodes(); ++i) {
            gp_Pnt pt = tri->Node(i).Transformed(loc);
            verts.push_back((float)pt.X());
            verts.push_back((float)pt.Y());
            verts.push_back((float)pt.Z());
        }

        bool rev = (face.Orientation() == TopAbs_REVERSED);
        for (int i = 1; i <= tri->NbTriangles(); ++i) {
            int n1, n2, n3;
            tri->Triangle(i).Get(n1, n2, n3);
            if (rev) std::swap(n2, n3);
            tris.push_back(base + (uint32_t)(n1 - 1));
            tris.push_back(base + (uint32_t)(n2 - 1));
            tris.push_back(base + (uint32_t)(n3 - 1));
        }
    }

    if (verts.empty())
        throw std::runtime_error("shape produced no triangles — try a smaller deflection_relative");

    // {vertices: Float32Array (xyz interleaved), triangles: Uint32Array (3 idx/tri)}
    val result = val::object();
    result.set("vertices",  float32_array(verts));
    result.set("triangles", uint32_array(tris));
    return result;
}

// Re-tessellate the stored STEP shape with parameters tied to the target
// element size.  The visualization tessellation (linear_deflection=0.1)
// produces very many small triangles; passing that directly to Netgen's
// advancing-front mesher can trigger memory-access crashes on complex geometry
// because the size mismatch between surface triangles and volume elements
// confuses Netgen's internal bookkeeping.
//
// Using linear_defl ≈ max_element_size/4 gives surface triangles roughly
// the same scale as the volume elements, which is what Netgen expects.
std::string tessellate_for_meshing(const std::string& opts_json) {
    if (!has_cached_shape())
        throw std::runtime_error(
            "tessellate_for_meshing: no STEP shape loaded — call tessellate_step first");
    const TopoDS_Shape& shape = cached_shape();

    val opts = parse_json(opts_json);
    double max_size = jdouble(opts, "max_element_size", 10.0);

    // Surface triangles at ~1/4 of the target element size; floor at 1.0 to
    // avoid producing a surface finer than the viz tessellation.
    double linear_defl  = std::max(1.0, max_size / 4.0);
    double angular_defl = 0.3;

    // BRepMesh_IncrementalMesh will skip faces whose stored deflection already
    // satisfies the request.  Since we first tessellated with 0.1 (finer than
    // max_size/4 for typical element sizes), we must clear first to force a
    // coarser, more uniform re-tessellation.
    BRepTools::Clean(shape);
    BRepMesh_IncrementalMesh mesher(shape, linear_defl, /*relative=*/false, angular_defl);
    mesher.Perform();
    if (!mesher.IsDone())
        throw std::runtime_error("BRepMesh_IncrementalMesh (mesh-quality) failed");

    std::vector<double> verts;
    std::vector<int>    tris;

    for (TopExp_Explorer exp(shape, TopAbs_FACE); exp.More(); exp.Next()) {
        TopoDS_Face face = TopoDS::Face(exp.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;

        int base = (int)(verts.size() / 3);

        for (int i = 1; i <= tri->NbNodes(); ++i) {
            gp_Pnt pt = tri->Node(i).Transformed(loc);
            verts.push_back(pt.X());
            verts.push_back(pt.Y());
            verts.push_back(pt.Z());
        }

        bool rev = (face.Orientation() == TopAbs_REVERSED);
        for (int i = 1; i <= tri->NbTriangles(); ++i) {
            int n1, n2, n3;
            tri->Triangle(i).Get(n1, n2, n3);
            if (rev) std::swap(n2, n3);
            tris.push_back(base + n1 - 1);
            tris.push_back(base + n2 - 1);
            tris.push_back(base + n3 - 1);
        }
    }

    if (verts.empty())
        throw std::runtime_error("mesh-quality tessellation produced no triangles");

    return "{\"vertices\":" + json_vec3(verts) + ",\"triangles\":" + json_ivec3(tris) + "}";
}
