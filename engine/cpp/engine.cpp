// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KoFEM WASM engine — C++ pipeline exposed to JavaScript via Emscripten Embind.
//
// Pipeline:  STEP bytes → OCCT tessellation (display) → Netgen OCC surface+volume mesh → MFEM FEM solve
//
// All four stages are exposed as individual JS functions plus a convenience
// full-pipeline function.  Every function takes / returns JSON strings so the
// interface is identical to the previous wasm-bindgen build — solver.worker.ts
// needs no changes.
//
// Build:  emcmake cmake engine/  &&  cmake --build .
// (see scripts/build-wasm.sh for the full incantation)

#include <emscripten/bind.h>
#include <emscripten/val.h>

// OCCT
#include <BRep_Tool.hxx>
#include <BRepBndLib.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <Bnd_Box.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPControl_Reader.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>

// Netgen (C API)
#include <nglib.h>

// Netgen internal-API glue (face indices, geometry from shape) — see netgen_glue.h
#include "netgen_glue.h"

// MFEM
#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <deque>
#include <malloc.h>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <utility>
#include <vector>

#include <emscripten.h>

using emscripten::val;

// ── Memory diagnostics ────────────────────────────────────────────────────────
// Reports total WASM linear-memory size (grows with ALLOW_MEMORY_GROWTH) and
// the approximate amount of that memory currently in-use by malloc.
static void log_mem(const char* label) {
    struct mallinfo mi = mallinfo();
    // HEAP8.length == current WASM linear-memory size in bytes.
    int wasm_mb = EM_ASM_INT({ return HEAP8.length >> 20; });
    // uordblks is bytes allocated by malloc (does not include mmap'd regions).
    int used_mb = (int)((unsigned)mi.uordblks >> 20);
    printf("[mem] %-44s  wasm=%d MB  alloc~%d MB\n", label, wasm_mb, used_mb);
    fflush(stdout);
}

// ── Minimal JSON output helpers ───────────────────────────────────────────────
// We build JSON manually to avoid a third-party parser dependency.  The output
// format is machine-generated and tightly controlled so this is safe.

static std::string json_vec3(const std::vector<double>& d) {
    std::ostringstream ss;
    ss << '[';
    size_t n = d.size() / 3;
    for (size_t i = 0; i < n; ++i) {
        if (i) ss << ',';
        ss << '[' << d[3*i] << ',' << d[3*i+1] << ',' << d[3*i+2] << ']';
    }
    ss << ']';
    return ss.str();
}

static std::string json_ivec3(const std::vector<int>& d) {
    std::ostringstream ss;
    ss << '[';
    size_t n = d.size() / 3;
    for (size_t i = 0; i < n; ++i) {
        if (i) ss << ',';
        ss << '[' << d[3*i] << ',' << d[3*i+1] << ',' << d[3*i+2] << ']';
    }
    ss << ']';
    return ss.str();
}

static std::string json_ivec4(const std::vector<int>& d) {
    std::ostringstream ss;
    ss << '[';
    size_t n = d.size() / 4;
    for (size_t i = 0; i < n; ++i) {
        if (i) ss << ',';
        ss << '[' << d[4*i] << ',' << d[4*i+1] << ',' << d[4*i+2] << ',' << d[4*i+3] << ']';
    }
    ss << ']';
    return ss.str();
}

static std::string json_ints(const std::vector<int>& d) {
    std::ostringstream ss;
    ss << '[';
    for (size_t i = 0; i < d.size(); ++i) {
        if (i != 0) ss << ',';
        ss << d[i];
    }
    ss << ']';
    return ss.str();
}

static std::string json_doubles(const std::vector<double>& d) {
    std::ostringstream ss;
    ss << '[';
    for (size_t i = 0; i < d.size(); ++i) {
        if (i) ss << ',';
        ss << d[i];
    }
    ss << ']';
    return ss.str();
}

// ── JSON input helpers (delegate parsing to the JS engine via emscripten::val) ─

static val parse_json(const std::string& s) {
    return val::global("JSON").call<val>("parse", s);
}

static double jdouble(const val& o, const char* k, double def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? def : v.as<double>();
}

static int jint(const val& o, const char* k, int def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? def : v.as<int>();
}

static bool jbool(const val& o, const char* k, bool def) {
    val v = o[k];
    return (v.isNull() || v.isUndefined()) ? def : v.as<bool>();
}

// ── Binary output helpers ─────────────────────────────────────────────────────
// Return tessellation data as JS typed arrays instead of a JSON text string.
// The string path built a multi-MB buffer with ostringstream — formatting every
// coordinate to decimal text — which JS then re-parsed with JSON.parse.  Both are
// O(triangles) and dominated STEP-load time on large parts.  new Float32Array(view)
// copies the WASM-heap view into a JS-owned buffer synchronously (no intervening
// allocation under ALLOW_MEMORY_GROWTH), so the data survives the source vector's
// destruction when the function returns.

static val float32_array(const std::vector<float>& v) {
    return val::global("Float32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

static val uint32_array(const std::vector<uint32_t>& v) {
    return val::global("Uint32Array")
        .new_(val(emscripten::typed_memory_view(v.size(), v.data())));
}

// Longest diagonal of the shape's axis-aligned bounding box (mm), or 0 if empty.
// Used to scale the tessellation chord tolerance with model size.
static double shape_bbox_diagonal(const TopoDS_Shape& shape) {
    Bnd_Box box;
    BRepBndLib::Add(shape, box);
    if (box.IsVoid())
        return 0.0;
    return std::sqrt(box.SquareExtent());
}

// ── OCCT: STEP → surface mesh ─────────────────────────────────────────────────

// Stored after tessellate_step for reuse by generate_fem_mesh, which builds
// the Netgen OCC geometry directly from this shape (no STEP re-read).
static TopoDS_Shape              g_step_shape;
static bool                      g_has_step_shape = false;

// Release the OCCT shape cache.  Call this from JS after meshing is
// done so the memory is available for the MFEM solve.
static void free_geometry_cache() {
    log_mem("free_geometry_cache: before");
    BRepTools::Clean(g_step_shape);  // detach BRepMesh triangulations from faces
    g_step_shape     = TopoDS_Shape();
    g_has_step_shape = false;
    printf("[kofem] geometry cache freed\n");
    fflush(stdout);
    log_mem("free_geometry_cache: after");
}

static val tessellate_step(val bytes_val, const std::string& opts_json) {
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

    std::vector<uint8_t> bytes = emscripten::vecFromJSArray<uint8_t>(bytes_val);

    // OCCT ReadFile requires a filesystem path; write to Emscripten's in-memory /tmp.
    char tmppath[] = "/tmp/kofem_XXXXXX.stp";
    int fd = mkstemps(tmppath, 4);
    if (fd < 0)
        throw std::runtime_error("failed to create /tmp STEP file");
    if (write(fd, bytes.data(), bytes.size()) != (ssize_t)bytes.size()) {
        close(fd); unlink(tmppath);
        throw std::runtime_error("failed to write STEP bytes to /tmp");
    }
    close(fd);

    STEPControl_Reader reader;
    IFSelect_ReturnStatus status = reader.ReadFile(tmppath);
    unlink(tmppath);

    if (status != IFSelect_RetDone)
        throw std::runtime_error("STEPControl_Reader::ReadFile failed — invalid STEP file");

    if (reader.TransferRoots() == 0 || reader.NbShapes() == 0)
        throw std::runtime_error("STEP file contains no transferable shapes");

    TopoDS_Shape shape = reader.OneShape();
    g_step_shape     = shape;
    g_has_step_shape = true;

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
static std::string tessellate_for_meshing(const std::string& opts_json) {
    if (!g_has_step_shape)
        throw std::runtime_error(
            "tessellate_for_meshing: no STEP shape loaded — call tessellate_step first");

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
    BRepTools::Clean(g_step_shape);
    BRepMesh_IncrementalMesh mesher(g_step_shape, linear_defl, /*relative=*/false, angular_defl);
    mesher.Perform();
    if (!mesher.IsDone())
        throw std::runtime_error("BRepMesh_IncrementalMesh (mesh-quality) failed");

    std::vector<double> verts;
    std::vector<int>    tris;

    for (TopExp_Explorer exp(g_step_shape, TopAbs_FACE); exp.More(); exp.Next()) {
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

// ── Netgen: surface mesh → tetrahedral volume mesh ────────────────────────────
//
// Netgen on some platforms compiles its C API inside namespace nglib; on others
// (including our Emscripten build from source) the symbols are in the global
// namespace.  Re-declare the API inside the namespace so linking succeeds
// regardless — this matches what netgen_bridge.cpp in kofem-mesh does.

namespace nglib {
    typedef void* Ng_Mesh;
    enum Ng_Result {
        NG_ERROR = -1, NG_OK = 0, NG_SURFACE_INPUT_ERROR = 1,
        NG_VOLUME_FAILURE = 2, NG_STL_INPUT_ERROR = 3,
        NG_SURFACE_FAILURE = 4, NG_FILE_NOT_FOUND = 5,
    };
    enum Ng_Surface_Element_Type { NG_TRIG = 1 };

    class Ng_Meshing_Parameters {
    public:
        int    uselocalh;    double maxh;       double minh;
        double fineness;     double grading;    double elementsperedge;
        double elementspercurve;
        int    closeedgeenable; double closeedgefact;
        int    minedgelenenable; double minedgelen;
        int    second_order; int quad_dominated;
        char*  meshsize_filename;
        int    optsurfmeshenable; int optvolmeshenable;
        int    optsteps_3d; int optsteps_2d;
        int    invert_tets; int invert_trigs;
        int    check_overlap; int check_overlapping_boundary;
        Ng_Meshing_Parameters();
    };

    extern void      Ng_Init();
    extern Ng_Mesh*  Ng_NewMesh();
    extern void      Ng_DeleteMesh(Ng_Mesh*);
    extern void      Ng_AddPoint(Ng_Mesh*, double*);
    extern void      Ng_AddSurfaceElement(Ng_Mesh*, Ng_Surface_Element_Type, int*);
    extern Ng_Result Ng_GenerateVolumeMesh(Ng_Mesh*, Ng_Meshing_Parameters*);
    extern void      Ng_GetPoint(Ng_Mesh*, int, double*);
    extern Ng_Result Ng_GetVolumeElement(Ng_Mesh*, int, int*);
    extern int       Ng_GetNP(Ng_Mesh*);
    extern int       Ng_GetNE(Ng_Mesh*);
    // Surface element queries (standard nglib API, Netgen v6.2+)
    extern int       Ng_GetNSE(Ng_Mesh*);
    extern void      Ng_GetSurfaceElement(Ng_Mesh*, int, int*);
}

// OCC meshing API (Netgen v6.2.2401, nglib/nglib_occ.cpp, namespace nglib).
// Ng_OCC_GenerateMesh does not exist — meshing is split into four steps:
// SetLocalMeshSize → GenerateEdgeMesh → GenerateSurfaceMesh → GenerateVolumeMesh.
namespace nglib {
#ifdef KOFEM_NETGEN_OCC
    typedef void* Ng_OCC_Geometry;
    extern Ng_Result         Ng_OCC_SetLocalMeshSize(Ng_OCC_Geometry*, Ng_Mesh*, Ng_Meshing_Parameters*);
    extern Ng_Result         Ng_OCC_GenerateEdgeMesh(Ng_OCC_Geometry*, Ng_Mesh*, Ng_Meshing_Parameters*);
    extern Ng_Result         Ng_OCC_GenerateSurfaceMesh(Ng_OCC_Geometry*, Ng_Mesh*, Ng_Meshing_Parameters*);
#endif
}

// ── Netgen: STEP → FEM surface mesh + tetrahedral volume mesh ────────────────
//
// Uses Netgen's native OCC geometry integration (KOFEM_NETGEN_OCC required).
// Netgen reads the CAD topology directly, meshes edges and surfaces respecting
// feature lines, then fills the volume — one call, proper FEM surface mesh.
static std::string generate_fem_mesh(const std::string& opts_json)
{
    if (!g_has_step_shape)
        throw std::runtime_error(
            "generate_fem_mesh: no STEP shape loaded — call tessellate_step first");

    static bool ng_initialized = false;
    if (!ng_initialized) { nglib::Ng_Init(); ng_initialized = true; }

    val opts = parse_json(opts_json);
    double max_size        = jdouble(opts, "max_element_size",   10.0);
    double min_size        = jdouble(opts, "min_element_size",    0.0);
    double grading         = jdouble(opts, "grading",             0.3);
    bool   second_ord      = jbool  (opts, "second_order",       false);
    double elems_per_edge  = jdouble(opts, "elementsperedge",     2.0);
    double elems_per_curve = jdouble(opts, "elementspercurve",    2.0);
    int    optsteps_2d     = jint   (opts, "optsteps_2d",           3);
    int    optsteps_3d     = jint   (opts, "optsteps_3d",           3);

#ifdef KOFEM_NETGEN_OCC
    // ── OCC path: Netgen meshes the CAD geometry directly ────────────────────
    // Netgen v6.2.2401 four-step pipeline (nglib_occ.cpp, namespace nglib):
    //   1. Ng_OCC_SetLocalMeshSize  — size field from CAD curvature
    //   2. Ng_OCC_GenerateEdgeMesh  — mesh feature edges
    //   3. Ng_OCC_GenerateSurfaceMesh — mesh boundary faces
    //   4. Ng_GenerateVolumeMesh    — fill volume with tetrahedra
    //
    // The Netgen geometry is built straight from the OCCT shape that
    // tessellate_step already transferred — re-reading the STEP file through
    // Netgen's own reader (Ng_OCC_Load_STEP) parsed the whole file a second
    // time and doubled peak geometry memory.

    log_mem("generate_fem_mesh: before OCC geometry build");
    nglib::Ng_OCC_Geometry* geom =
        (nglib::Ng_OCC_Geometry*)kofem_occ_geometry_from_shape(g_step_shape);
    if (!geom)
        throw std::runtime_error("OCCGeometry construction failed — check STEP geometry validity");
    log_mem("generate_fem_mesh: after OCC geometry build");

    nglib::Ng_Meshing_Parameters mp;
    mp.uselocalh                  = 1;
    mp.maxh                       = max_size;
    mp.minh                       = min_size;
    mp.fineness                   = 0.5;
    mp.grading                    = grading;
    mp.elementsperedge            = elems_per_edge;
    mp.elementspercurve           = elems_per_curve;
    mp.closeedgeenable            = 0;
    mp.closeedgefact              = 2.0;
    mp.minedgelenenable           = 0;
    mp.minedgelen                 = 1e-4;
    mp.second_order               = second_ord ? 1 : 0;
    mp.quad_dominated             = 0;
    mp.meshsize_filename          = nullptr;
    mp.optsurfmeshenable          = 1;
    mp.optvolmeshenable           = 1;
    // Skip both surface and volume optimisation: for complex CAD (many faces,
    // short edges) the optimiser reprojects nodes onto OCC surfaces in a loop
    // that runs for minutes.  The unoptimised mesh is adequate for FEM analysis.
    mp.optsteps_2d                = 0;
    mp.optsteps_3d                = 0;
    mp.invert_tets                = 0;
    mp.invert_trigs               = 0;
    mp.check_overlap              = 0;
    mp.check_overlapping_boundary = 0;

    nglib::Ng_Mesh* mesh = nglib::Ng_NewMesh();
    if (!mesh) {
        kofem_occ_geometry_delete(geom);
        throw std::runtime_error("Ng_NewMesh returned null");
    }

    printf("[netgen] step 1/4: computing local mesh size from CAD curvature (maxh=%.2f)\n", max_size);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 1 SetLocalMeshSize");
    nglib::Ng_OCC_SetLocalMeshSize(geom, mesh, &mp);

    printf("[netgen] step 2/4: meshing feature edges\n");
    fflush(stdout);
    log_mem("generate_fem_mesh: step 2 GenerateEdgeMesh");
    nglib::Ng_Result res = nglib::Ng_OCC_GenerateEdgeMesh(geom, mesh, &mp);
    if (res != nglib::NG_OK) {
        kofem_delete_mesh(mesh);
        kofem_occ_geometry_delete(geom);
        throw std::runtime_error(
            "Ng_OCC_GenerateEdgeMesh failed (code " + std::to_string((int)res) + ")");
    }
    printf("[netgen] step 2/4: edge mesh done\n");
    fflush(stdout);
    log_mem("generate_fem_mesh: step 2 done");

    printf("[netgen] step 3/4: meshing boundary surfaces (optsteps_2d=%d)\n", mp.optsteps_2d);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 3 GenerateSurfaceMesh");
    res = nglib::Ng_OCC_GenerateSurfaceMesh(geom, mesh, &mp);
    if (res != nglib::NG_OK) {
        kofem_delete_mesh(mesh);
        kofem_occ_geometry_delete(geom);
        throw std::runtime_error(
            "Ng_OCC_GenerateSurfaceMesh failed (code " + std::to_string((int)res) + ")");
    }
    printf("[netgen] step 3/4: surface mesh done — %d surface nodes\n", nglib::Ng_GetNP(mesh));
    fflush(stdout);
    log_mem("generate_fem_mesh: step 3 done");

    // Step 4: fill volume.
    // Keep geom alive: Netgen stores OCC geometry references in the mesh during
    // step 3 and accesses them during BOTH Delaunay insertion and mesh
    // optimisation (surface node projection).  Freeing geom before this call
    // causes dangling-pointer reads that corrupt the WASM vtable (invoke_ii
    // trap with a heap address instead of a function table index).
    printf("[netgen] step 4/4: Delaunay volume fill (optsteps_3d=%d)\n", mp.optsteps_3d);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 4 GenerateVolumeMesh");
    res = nglib::Ng_GenerateVolumeMesh(mesh, &mp);
    kofem_occ_geometry_delete(geom);     // safe: volume fill complete
    if (res != nglib::NG_OK) {
        kofem_delete_mesh(mesh);
        throw std::runtime_error(
            "Ng_GenerateVolumeMesh failed (code " + std::to_string((int)res) + ")");
    }
    log_mem("generate_fem_mesh: step 4 done");

    int np = nglib::Ng_GetNP(mesh);
    int ne = nglib::Ng_GetNE(mesh);
    printf("[netgen] step 4/4: volume mesh done — %d nodes, %d tetrahedra\n", np, ne);
    fflush(stdout);

    std::vector<double> out_verts;
    out_verts.reserve(3 * np);
    for (int i = 1; i <= np; ++i) {
        double pt[3];
        nglib::Ng_GetPoint(mesh, i, pt);
        out_verts.push_back(pt[0]);
        out_verts.push_back(pt[1]);
        out_verts.push_back(pt[2]);
    }

    std::vector<int> out_tets;
    out_tets.reserve(4 * ne);
    for (int i = 1; i <= ne; ++i) {
        int tet[4];
        nglib::Ng_GetVolumeElement(mesh, i, tet);
        out_tets.push_back(tet[0] - 1);
        out_tets.push_back(tet[1] - 1);
        out_tets.push_back(tet[2] - 1);
        out_tets.push_back(tet[3] - 1);
    }

    // Surface elements — boundary triangles from the Netgen surface mesh.
    // Netgen records the owning CAD face of every surface element it generates
    // during Ng_OCC_GenerateSurfaceMesh; kofem_surface_element_face_index reads
    // that index (1-based) straight from the mesh.  The previous implementation
    // matched each element against the nearest OCCT tessellation centroid, which
    // was O(elements × tessellation triangles) — minutes on complex parts — and
    // mis-assigned elements near face boundaries.
    int nse = nglib::Ng_GetNSE(mesh);
    std::vector<int> out_surf_tris;
    std::vector<int> out_surf_face_ids;
    out_surf_tris.reserve(3 * nse);
    out_surf_face_ids.reserve(nse);
    for (int i = 1; i <= nse; ++i) {
        int tri[3];
        nglib::Ng_GetSurfaceElement(mesh, i, tri);
        out_surf_tris.push_back(tri[0] - 1);
        out_surf_tris.push_back(tri[1] - 1);
        out_surf_tris.push_back(tri[2] - 1);
        out_surf_face_ids.push_back(kofem_surface_element_face_index(mesh, i));
    }
    printf("[netgen] %d surface elements, %d unique OCC face IDs\n",
           nse, (int)std::set<int>(out_surf_face_ids.begin(), out_surf_face_ids.end()).size());
    fflush(stdout);

    kofem_delete_mesh(mesh);
    log_mem("generate_fem_mesh: after Ng_DeleteMesh");

    return "{\"vertices\":" + json_vec3(out_verts) +
           ",\"tetrahedra\":" + json_ivec4(out_tets) +
           ",\"surfaceTriangles\":" + json_ivec3(out_surf_tris) +
           ",\"surfaceFaceIds\":" + json_ints(out_surf_face_ids) + "}";

#else
#error "KoFEM requires Netgen built with -DUSE_OCC=ON (KOFEM_NETGEN_OCC is not defined). " \
       "Rebuild the kofem-dependencies Docker image or pass -DUSE_NETGEN_OCC=ON to CMake."
#endif
}

static std::string generate_volume_mesh(
    const std::string& surface_json,
    const std::string& opts_json)
{
    // Ng_Init() must be called once before any Netgen API usage.
    // Called lazily here rather than as a static initializer to avoid
    // potential crashes during WASM module startup.
    static bool ng_initialized = false;
    if (!ng_initialized) {
        nglib::Ng_Init();
        ng_initialized = true;
    }

    val surface = parse_json(surface_json);
    val opts    = parse_json(opts_json);

    double max_size        = jdouble(opts, "max_element_size",   10.0);
    double min_size        = jdouble(opts, "min_element_size",    0.0);
    double grading         = jdouble(opts, "grading",             0.3);
    bool   second_ord      = jbool  (opts, "second_order",       false);
    int    uselocalh       = jint   (opts, "uselocalh",             1);
    double elems_per_edge  = jdouble(opts, "elementsperedge",     2.0);
    double elems_per_curve = jdouble(opts, "elementspercurve",    2.0);
    int    optsteps_2d     = jint   (opts, "optsteps_2d",           3);
    int    optsteps_3d     = jint   (opts, "optsteps_3d",           3);

    val verts_js = surface["vertices"];
    val tris_js  = surface["triangles"];
    unsigned nv  = verts_js["length"].as<unsigned>();
    unsigned nt  = tris_js ["length"].as<unsigned>();

    nglib::Ng_Mesh* mesh = nglib::Ng_NewMesh();
    if (!mesh) throw std::runtime_error("Ng_NewMesh() returned null");

    for (unsigned i = 0; i < nv; ++i) {
        val v = verts_js[i];
        double pt[3] = { v[0].as<double>(), v[1].as<double>(), v[2].as<double>() };
        nglib::Ng_AddPoint(mesh, pt);
    }
    for (unsigned i = 0; i < nt; ++i) {
        val t = tris_js[i];
        int tri[3] = { t[0].as<int>()+1, t[1].as<int>()+1, t[2].as<int>()+1 };
        nglib::Ng_AddSurfaceElement(mesh, nglib::NG_TRIG, tri);
    }

    // Initialise every field explicitly.  In the WASM build Netgen exports
    // symbols in the global namespace while the re-declaration above is inside
    // namespace nglib::, so Ng_Meshing_Parameters() may not link and leaves
    // fields uninitialised.  Explicit assignment is correct regardless.
    //
    // check_overlap / check_overlapping_boundary are forced to 0: the Netgen
    // default (1) crashes on complex STEP geometry with near-touching surfaces,
    // and the JS deduplication step already produces a manifold mesh.
    nglib::Ng_Meshing_Parameters mp;
    mp.uselocalh                  = uselocalh;
    mp.maxh                       = max_size;
    mp.minh                       = min_size;
    mp.fineness                   = 0.5;
    mp.grading                    = grading;
    mp.elementsperedge            = elems_per_edge;
    mp.elementspercurve           = elems_per_curve;
    mp.closeedgeenable            = 0;
    mp.closeedgefact              = 2.0;
    mp.minedgelenenable           = 0;
    mp.minedgelen                 = 1e-4;
    mp.second_order               = second_ord ? 1 : 0;
    mp.quad_dominated             = 0;
    mp.meshsize_filename          = nullptr;
    mp.optsurfmeshenable          = 1;
    mp.optvolmeshenable           = 1;
    mp.optsteps_3d                = optsteps_3d;
    mp.optsteps_2d                = optsteps_2d;
    mp.invert_tets                = 0;
    mp.invert_trigs               = 0;
    mp.check_overlap              = 0;
    mp.check_overlapping_boundary = 0;

    nglib::Ng_Result res = nglib::Ng_GenerateVolumeMesh(mesh, &mp);
    if (res != nglib::NG_OK) {
        kofem_delete_mesh(mesh);
        throw std::runtime_error(
            "Ng_GenerateVolumeMesh failed (code " + std::to_string((int)res) + ")");
    }

    int np = nglib::Ng_GetNP(mesh);
    int ne = nglib::Ng_GetNE(mesh);

    std::vector<double> out_verts;
    out_verts.reserve(3 * np);
    for (int i = 1; i <= np; ++i) {
        double pt[3];
        nglib::Ng_GetPoint(mesh, i, pt);
        out_verts.push_back(pt[0]);
        out_verts.push_back(pt[1]);
        out_verts.push_back(pt[2]);
    }

    std::vector<int> out_tets;
    out_tets.reserve(4 * ne);
    for (int i = 1; i <= ne; ++i) {
        int tet[4];
        nglib::Ng_GetVolumeElement(mesh, i, tet);
        out_tets.push_back(tet[0] - 1);
        out_tets.push_back(tet[1] - 1);
        out_tets.push_back(tet[2] - 1);
        out_tets.push_back(tet[3] - 1);
    }

    kofem_delete_mesh(mesh);

    return "{\"vertices\":" + json_vec3(out_verts) +
           ",\"tetrahedra\":" + json_ivec4(out_tets) + "}";
}

// ── MFEM: linear-elastic FEM solve ────────────────────────────────────────────

// Traction coefficient for a uniform pressure load: returns -p·n̂ at each
// boundary quadrature point, where n̂ is the unit outward normal. The integrator
// (VectorBoundaryLFIntegrator) already multiplies by the surface measure, so the
// coefficient must return the *unit* normal scaled by the pressure, not the
// area-weighted one. Positive pressure pushes into the surface (compression).
class PressureCoefficient : public mfem::VectorCoefficient {
    double pressure_;

public:
    PressureCoefficient(int dim, double pressure)
        : mfem::VectorCoefficient(dim), pressure_(pressure) {}

    void Eval(mfem::Vector& V, mfem::ElementTransformation& T,
              const mfem::IntegrationPoint& ip) override {
        V.SetSize(vdim);
        mfem::Vector nor(vdim);
        T.SetIntPoint(&ip);
        // CalcOrtho yields the outward normal of a boundary ElementTransformation
        // with magnitude equal to the surface Jacobian; normalize to a unit vector.
        mfem::CalcOrtho(T.Jacobian(), nor);
        double len = nor.Norml2();
        if (len > 0.0)
            nor /= len;
        V.Set(-pressure_, nor);
    }
};

static std::string solve_linear_elastic(
    const std::string& mesh_json,
    const std::string& mat_json,
    const std::string& bcs_json,
    int order)
{
    using namespace mfem;

    log_mem("solve: start");
    printf("[mfem] solve_linear_elastic: parsing inputs\n"); fflush(stdout);
    val mesh_js = parse_json(mesh_json);
    val mat_js  = parse_json(mat_json);
    val bcs_js  = parse_json(bcs_json);

    val verts_js = mesh_js["vertices"];
    val tets_js  = mesh_js["tetrahedra"];
    val hexs_js  = mesh_js["hexahedra"];
    unsigned nv  = verts_js["length"].as<unsigned>();
    unsigned nt  = tets_js ["length"].as<unsigned>();
    unsigned nh  = hexs_js ["length"].as<unsigned>();

    printf("[mfem] mesh counts: nv=%u nt=%u nh=%u\n", nv, nt, nh); fflush(stdout);

    if (nt == 0 && nh == 0)
        throw std::runtime_error(
            "Mesh has no elements. Send at least one CTETRA or CHEXA element.");

    log_mem("solve: after JSON parse");
    printf("[mfem] extracting %u vertices\n", nv); fflush(stdout);
    std::vector<double> vertices;
    vertices.reserve(3 * nv);
    for (unsigned i = 0; i < nv; ++i) {
        val v = verts_js[i];
        vertices.push_back(v[0].as<double>());
        vertices.push_back(v[1].as<double>());
        vertices.push_back(v[2].as<double>());
    }

    printf("[mfem] extracting %u tets\n", nt); fflush(stdout);
    std::vector<int> tets;
    tets.reserve(4 * nt);
    for (unsigned i = 0; i < nt; ++i) {
        val t = tets_js[i];
        tets.push_back(t[0].as<int>());
        tets.push_back(t[1].as<int>());
        tets.push_back(t[2].as<int>());
        tets.push_back(t[3].as<int>());
    }

    printf("[mfem] extracting %u hexs\n", nh); fflush(stdout);
    std::vector<int> hexs;
    hexs.reserve(8 * nh);
    for (unsigned i = 0; i < nh; ++i) {
        val h = hexs_js[i];
        for (int k = 0; k < 8; ++k)
            hexs.push_back(h[k].as<int>());
    }

    double E  = jdouble(mat_js, "young_modulus", 210e9);
    double nu = jdouble(mat_js, "poisson_ratio",   0.3);

    val fixed_js = bcs_js["fixed_vertices"];
    unsigned n_fixed = fixed_js["length"].as<unsigned>();

    val loads_js  = bcs_js["point_loads"];
    unsigned n_loads = loads_js["length"].as<unsigned>();

    printf("[mfem] BCs: %u fixed vertices, %u point loads\n", n_fixed, n_loads); fflush(stdout);
    log_mem("solve: after extracting mesh data");

    // Build MFEM mesh programmatically to avoid C++ iostream file I/O.
    //
    // The file-based path (Mesh(filename, ...)) opens an ifstream and reads
    // through basic_filebuf / basic_streambuf virtual dispatch.  In the WASM
    // (Emscripten) build the locale/codec facet pointer inside the streambuf
    // object is null, so the first virtual call through it traps with
    // "Out of bounds memory access" via invoke_iiiiii.
    //
    // The programmatic path calls no iostream code at all: AddVertex / AddTet /
    // AddHex populate in-memory arrays directly, and FinalizeTopology builds all
    // connectivity (faces, boundary elements, edge table) without file I/O.
    // In 3D, FinalizeTopology always builds the edge table, which is required by
    // H1_FECollection for DOF numbering.
    printf("[mfem] building mesh (%u verts, %u tets, %u hexs)\n", nv, nt, nh); fflush(stdout);
    log_mem("solve: before MFEM mesh build");
    constexpr int dim = 3;
    Mesh mfem_mesh(dim, (int)nv, (int)(nt + nh), /*NBdrElem=*/0, /*spaceDim=*/dim);

    printf("[mfem] mesh shell ok\n"); fflush(stdout);
    for (unsigned i = 0; i < nv; ++i)
        mfem_mesh.AddVertex(vertices[3*i], vertices[3*i+1], vertices[3*i+2]);
    printf("[mfem] vertices added\n"); fflush(stdout);

    for (unsigned i = 0; i < nt; ++i)
        mfem_mesh.AddTet(tets[4*i], tets[4*i+1], tets[4*i+2], tets[4*i+3], /*attr=*/1);
    printf("[mfem] tets added\n"); fflush(stdout);

    for (unsigned i = 0; i < nh; ++i)
        mfem_mesh.AddHex(hexs[8*i], hexs[8*i+1], hexs[8*i+2], hexs[8*i+3],
                         hexs[8*i+4], hexs[8*i+5], hexs[8*i+6], hexs[8*i+7], /*attr=*/1);
    printf("[mfem] hexs added\n"); fflush(stdout);

    // generate_bdr=true: boundary Triangle/Quad elements auto-generated from
    // exposed faces of volume elements (correct for a watertight Netgen mesh).
    mfem_mesh.FinalizeTopology(/*generate_bdr=*/true);
    printf("[mfem] FinalizeTopology done\n"); fflush(stdout);

    // Netgen uses the opposite tet vertex-winding convention from MFEM.
    // Without fixing orientation every tet has a negative Jacobian, making
    // the assembled stiffness matrix non-positive-definite.  CG then fails
    // at iteration 0 ("preconditioner not positive definite") and returns the
    // zero initial guess, giving physically meaningless results.
    // fix_orientation=true calls CheckElementOrientation(true) which swaps
    // two vertices per tet to correct the sign — this uses only GetVertices()
    // (int* overload, already anchored) and direct array swaps, no new virtual
    // calls.
    mfem_mesh.Finalize(/*refine=*/false, /*fix_orientation=*/true);
    printf("[mfem] Finalize done\n"); fflush(stdout);

    printf("[mfem] mesh ready: %d vertices, %d elements, %d boundary elems\n",
           mfem_mesh.GetNV(), mfem_mesh.GetNE(), mfem_mesh.GetNBE());
    fflush(stdout);
    log_mem("solve: after MFEM mesh build");

    order = std::max(1, order);
    double lam = E * nu / ((1.0 + nu) * (1.0 - 2.0*nu));
    double mu  = E / (2.0 * (1.0 + nu));

    printf("[mfem] setting up H1 FE space (order=%d, dim=%d)…\n", order, dim);
    fflush(stdout);
    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mfem_mesh, &fec, dim);
    printf("[mfem] FE space: %d dofs\n", fespace.GetTrueVSize());
    fflush(stdout);
    log_mem("solve: after FE space setup");

    // Essential (Dirichlet) DOFs from fixed vertices.
    // fixed_vertices is the full-fixity shorthand: every translational component
    // (Ux, Uy, Uz) of the listed vertex is pinned.
    Array<int> ess_tdof;
    for (unsigned i = 0; i < n_fixed; ++i) {
        int vi = fixed_js[i].as<int>();
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int j = 0; j < vdofs.Size(); ++j)
            ess_tdof.Append(vdofs[j]);
    }

    // fixed_dofs pins only the listed components of a vertex, leaving the others
    // free — a single-DOF constraint. This is what a symmetry-plane roller or a
    // statically-determinate 3-2-1 restraint needs. Each entry is
    // { vertex: int, dofs: int[] } with dofs ⊂ {0=Ux, 1=Uy, 2=Uz}. Optional:
    // absent on the full-fixity path, so older payloads keep working unchanged.
    val fdofs_js = bcs_js["fixed_dofs"];
    if (!fdofs_js.isUndefined() && !fdofs_js.isNull()) {
        unsigned n_fdofs = fdofs_js["length"].as<unsigned>();
        for (unsigned i = 0; i < n_fdofs; ++i) {
            val entry = fdofs_js[i];
            int vi = entry["vertex"].as<int>();
            val comps = entry["dofs"];
            unsigned nc = comps["length"].as<unsigned>();
            Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            for (unsigned c = 0; c < nc; ++c) {
                int d = comps[c].as<int>();
                if (d >= 0 && d < vdofs.Size())
                    ess_tdof.Append(vdofs[d]);
            }
        }
    }

    // prescribed_dofs pins a single component of a vertex to a NON-ZERO value —
    // an inhomogeneous Dirichlet condition (e.g. a prescribed-displacement
    // support that drives the deformation on its own). Each entry is
    // { vertex: int, dof: int (0=Ux,1=Uy,2=Uz), value: double }. The DOF is added
    // to the essential set like any other fixed DOF, but the value is written
    // into the solution GridFunction below so FormLinearSystem eliminates it and
    // moves its contribution to the load vector. Optional: absent payloads keep
    // the all-zero Dirichlet behaviour unchanged.
    std::vector<std::pair<int, double>> prescribed_vals;
    val pdofs_js = bcs_js["prescribed_dofs"];
    if (!pdofs_js.isUndefined() && !pdofs_js.isNull()) {
        unsigned n_pdofs = pdofs_js["length"].as<unsigned>();
        for (unsigned i = 0; i < n_pdofs; ++i) {
            val entry = pdofs_js[i];
            int vi = entry["vertex"].as<int>();
            int d  = entry["dof"].as<int>();
            double value = entry["value"].as<double>();
            Array<int> vdofs;
            fespace.GetVertexVDofs(vi, vdofs);
            if (d >= 0 && d < vdofs.Size()) {
                ess_tdof.Append(vdofs[d]);
                prescribed_vals.emplace_back(vdofs[d], value);
            }
        }
    }

    ess_tdof.Sort();
    ess_tdof.Unique();

    GridFunction x(&fespace);
    x = 0.0;
    // Seed the prescribed components before FormLinearSystem so the eliminated
    // essential DOFs carry the requested displacement instead of zero.
    for (const auto& pv : prescribed_vals)
        x[pv.first] = pv.second;

    LinearForm b(&fespace);

    // ── Surface (traction / pressure) loads ──────────────────────────────────
    // Work-equivalent surface loads applied through MFEM's boundary linear-form
    // integrator: f_i = ∫_S N_i · t dS. Unlike splitting a face's total force
    // equally across its nodes, this weights each node by the shape-function
    // integral of its tributary surface, so (a) corner/edge nodes get the right
    // share and (b) the resultant passes through the face's area-centroid no
    // matter how non-uniformly the face is meshed — no spurious moment.
    //
    // Each entry tags the boundary elements covering a set of surface faces
    // (matched by sorted node-index list) with a unique boundary attribute,
    // then a VectorBoundaryLFIntegrator restricted to that attribute applies:
    //   type "force"    — total force F spread as a uniform traction F / A_total
    //   type "traction" — a traction vector applied directly
    //   type "pressure" — scalar p applied as -p·n̂ (outward normal; + pushes in)
    //
    // The integrators take ownership of their coefficient by reference and the
    // marker arrays by pointer, so both must outlive b.Assemble(); they are held
    // in stable-address containers below.
    std::deque<std::unique_ptr<VectorCoefficient>> surf_coeffs;
    std::deque<Array<int>> surf_markers;

    val surf_js = bcs_js["surface_loads"];
    if (!surf_js.isUndefined() && !surf_js.isNull()) {
        unsigned n_surf = surf_js["length"].as<unsigned>();

        // sorted boundary-face vertex list → boundary element index, over the
        // auto-generated boundary mesh (its vertex indices equal the input node
        // IDs). Keyed by a sorted vertex vector so it matches both triangular
        // (tet) and quadrilateral (hex) boundary faces.
        std::map<std::vector<int>, int> face_to_be;
        for (int be = 0; be < mfem_mesh.GetNBE(); ++be) {
            Array<int> bv;
            mfem_mesh.GetBdrElementVertices(be, bv);
            std::vector<int> key(bv.begin(), bv.end());
            std::sort(key.begin(), key.end());
            face_to_be[key] = be;
        }

        struct PendingLoad { int attr; std::unique_ptr<VectorCoefficient> coeff; };
        std::vector<PendingLoad> pending;
        int next_attr = 2;  // attribute 1 stays the default (un-loaded) value

        for (unsigned i = 0; i < n_surf; ++i) {
            val entry = surf_js[i];
            std::string type = entry["type"].as<std::string>();
            val faces = entry["triangles"];  // node-index lists (3 = tri, 4 = quad)
            unsigned n_faces = faces["length"].as<unsigned>();

            int attr = next_attr;
            int matched = 0;
            for (unsigned t = 0; t < n_faces; ++t) {
                val face = faces[t];
                unsigned fn = face["length"].as<unsigned>();
                std::vector<int> key(fn);
                for (unsigned k = 0; k < fn; ++k)
                    key[k] = face[k].as<int>();
                std::sort(key.begin(), key.end());
                auto it = face_to_be.find(key);
                if (it == face_to_be.end()) continue;
                mfem_mesh.GetBdrElement(it->second)->SetAttribute(attr);
                ++matched;
            }
            if (matched == 0) {
                printf("[mfem] surface_load %u (%s): no boundary elements matched "
                       "%u faces — skipped\n", i, type.c_str(), n_faces);
                continue;
            }
            // This load owns `attr` (its elements are now tagged); reserve the
            // next number so a later skip can't make two loads share an attribute.
            ++next_attr;

            std::unique_ptr<VectorCoefficient> coeff;
            if (type == "pressure") {
                double p = entry["pressure"].as<double>();
                coeff = std::make_unique<PressureCoefficient>(dim, p);
                printf("[mfem] surface_load %u: pressure %g over %d bdr elems\n",
                       i, p, matched);
            } else {  // "force" or "traction"
                Vector tvec(3);
                tvec[0] = entry["force"][0].as<double>();
                tvec[1] = entry["force"][1].as<double>();
                tvec[2] = entry["force"][2].as<double>();
                if (type == "force") {
                    // Total force → uniform traction: divide by the integrated area
                    // of the matched boundary elements — the same surface measure
                    // the integrator uses, so it is exact for straight-sided faces.
                    double area = 0.0;
                    for (int be = 0; be < mfem_mesh.GetNBE(); ++be) {
                        if (mfem_mesh.GetBdrAttribute(be) != attr) continue;
                        ElementTransformation* T =
                            mfem_mesh.GetBdrElementTransformation(be);
                        const IntegrationRule& ir =
                            IntRules.Get(mfem_mesh.GetBdrElementGeometry(be), 4);
                        for (int q = 0; q < ir.GetNPoints(); ++q) {
                            const IntegrationPoint& ip = ir.IntPoint(q);
                            T->SetIntPoint(&ip);
                            area += ip.weight * T->Weight();
                        }
                    }
                    if (area <= 0.0) {
                        printf("[mfem] surface_load %u: zero matched area — skipped\n", i);
                        continue;
                    }
                    tvec /= area;
                    printf("[mfem] surface_load %u: force → traction [%g %g %g] over "
                           "%d bdr elems (A=%g)\n",
                           i, tvec[0], tvec[1], tvec[2], matched, area);
                } else {
                    printf("[mfem] surface_load %u: traction [%g %g %g] over %d bdr elems\n",
                           i, tvec[0], tvec[1], tvec[2], matched);
                }
                coeff = std::make_unique<VectorConstantCoefficient>(tvec);
            }
            pending.push_back({ attr, std::move(coeff) });
        }

        // Refresh the mesh attribute tables now that boundary attributes changed,
        // so marker arrays can be sized to bdr_attributes.Max().
        mfem_mesh.SetAttributes();
        int max_attr = mfem_mesh.bdr_attributes.Size()
                           ? mfem_mesh.bdr_attributes.Max() : 0;
        for (auto& pl : pending) {
            surf_coeffs.push_back(std::move(pl.coeff));
            surf_markers.emplace_back(max_attr);
            Array<int>& marker = surf_markers.back();
            marker = 0;
            if (pl.attr >= 1 && pl.attr <= max_attr)
                marker[pl.attr - 1] = 1;
            b.AddBoundaryIntegrator(
                new VectorBoundaryLFIntegrator(*surf_coeffs.back()), marker);
        }
    }

    b.Assemble();

    // Concentrated point loads — applied straight to the assembled load vector.
    // Still used for explicit nodal forces and for the equivalent nodal forces of
    // a moment load. Surface (face) forces now flow through surface_loads above.
    for (unsigned i = 0; i < n_loads; ++i) {
        val load  = loads_js[i];
        int vi    = load["vertex"].as<int>();
        val force = load["force"];
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        if (vdofs.Size() >= 3) {
            b[vdofs[0]] += force[0].as<double>();
            b[vdofs[1]] += force[1].as<double>();
            b[vdofs[2]] += force[2].as<double>();
        }
    }

    BilinearForm a(&fespace);
    ConstantCoefficient lam_c(lam), mu_c(mu);
    a.AddDomainIntegrator(new ElasticityIntegrator(lam_c, mu_c));
    printf("[mfem] assembling stiffness matrix…\n"); fflush(stdout);
    a.Assemble();
    printf("[mfem] assembly done\n"); fflush(stdout);
    log_mem("solve: after stiffness assembly");

    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess_tdof, x, b, A, X, B);

    SparseMatrix& A_mat = *A.As<SparseMatrix>();
    // GSSmoother (Gauss-Seidel) is numerically robust for 3D elasticity after
    // Dirichlet BC elimination.  DSmoother (Jacobi) diverges on ill-conditioned
    // tet systems, producing NaN residuals that crash the WASM worker.
    GSSmoother prec(A_mat);
    CGSolver cg;
    // 1e-1 tolerance is sufficient for visual FEM and converges in ~20 iterations
    // (vs ~1000+ for 1e-6), keeping showcase solves under 60 s in WASM.
    cg.SetRelTol(1e-1);
    cg.SetMaxIter(1000);
    cg.SetPrintLevel(1);  // print final iteration count to help diagnose convergence
    cg.SetPreconditioner(prec);
    cg.SetOperator(A_mat);
    printf("[mfem] starting CG solve (%d rows)…\n", A_mat.Height()); fflush(stdout);
    log_mem("solve: before CG solve");
    cg.Mult(B, X);
    a.RecoverFEMSolution(X, b, x);
    printf("[mfem] CG done — computing von Mises stress…\n"); fflush(stdout);
    log_mem("solve: after CG solve");

    int n_verts = mfem_mesh.GetNV();
    int n_elems = mfem_mesh.GetNE();

    std::vector<double> displacements(3 * n_verts, 0.0);
    for (int vi = 0; vi < n_verts; ++vi) {
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int c = 0; c < dim && c < vdofs.Size(); ++c)
            displacements[3*vi + c] = x[vdofs[c]];
    }

    std::vector<double> von_mises(n_elems);
    for (int e = 0; e < n_elems; ++e) {
        ElementTransformation* T = mfem_mesh.GetElementTransformation(e);
        const IntegrationRule& ir = IntRules.Get(mfem_mesh.GetElementGeometry(e), 1);
        T->SetIntPoint(&ir.IntPoint(0));

        DenseMatrix grad_u;
        x.GetVectorGradient(*T, grad_u);

        double eps[3][3];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                eps[i][j] = 0.5 * (grad_u(i,j) + grad_u(j,i));

        double tr_eps = eps[0][0] + eps[1][1] + eps[2][2];
        double s[3][3];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                s[i][j] = (i == j ? lam * tr_eps : 0.0) + 2.0 * mu * eps[i][j];

        double tr_s = s[0][0] + s[1][1] + s[2][2];
        double vm2  = 0.0;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
                double dev = s[i][j] - (i == j ? tr_s / 3.0 : 0.0);
                vm2 += dev * dev;
            }
        von_mises[e] = std::sqrt(1.5 * vm2);
    }

    printf("[mfem] solve complete: %d vertex displacements, %d element stresses\n",
           n_verts, n_elems);
    fflush(stdout);
    log_mem("solve: complete");

    return "{\"displacements\":" + json_doubles(displacements) +
           ",\"von_mises\":"     + json_doubles(von_mises)     + "}";
}

// ── Embind registrations ──────────────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(kofem) {
    emscripten::function("tessellate_step",        &tessellate_step);
    emscripten::function("tessellate_for_meshing", &tessellate_for_meshing);
    emscripten::function("generate_volume_mesh",   &generate_volume_mesh);
    emscripten::function("generate_fem_mesh",      &generate_fem_mesh);
    emscripten::function("free_geometry_cache",    &free_geometry_cache);
    emscripten::function("solve_linear_elastic",   &solve_linear_elastic);
}
