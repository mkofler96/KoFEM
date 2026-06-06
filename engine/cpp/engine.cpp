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
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
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

// MFEM
#include <mfem.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unistd.h>
#include <vector>

using emscripten::val;

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

// ── OCCT: STEP → surface mesh ─────────────────────────────────────────────────

// Stored after tessellate_step for reuse by generate_fem_mesh.
// g_step_bytes holds the raw STEP file so Netgen can re-read it via its own
// STEP reader (Netgen's OCC integration requires a file path, not an in-memory shape).
static TopoDS_Shape              g_step_shape;
static bool                      g_has_step_shape = false;
static std::vector<uint8_t>      g_step_bytes;

static std::string tessellate_step(val bytes_val, const std::string& opts_json) {
    val opts = parse_json(opts_json);
    double linear_defl  = jdouble(opts, "linear_deflection",  0.1);
    double angular_defl = jdouble(opts, "angular_deflection", 0.5);

    std::vector<uint8_t> bytes = emscripten::vecFromJSArray<uint8_t>(bytes_val);
    g_step_bytes = bytes;   // keep for Netgen OCC re-read in generate_fem_mesh

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

    BRepMesh_IncrementalMesh mesher(shape, linear_defl, /*relative=*/false, angular_defl);
    mesher.Perform();
    if (!mesher.IsDone())
        throw std::runtime_error("BRepMesh_IncrementalMesh failed");

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
        throw std::runtime_error("shape produced no triangles — try a smaller linear_deflection");

    return "{\"vertices\":" + json_vec3(verts) + ",\"triangles\":" + json_ivec3(tris) + "}";
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
}

// OCC meshing API (Netgen v6.2.2401, nglib/nglib_occ.cpp, namespace nglib).
// Ng_OCC_GenerateMesh does not exist — meshing is split into four steps:
// SetLocalMeshSize → GenerateEdgeMesh → GenerateSurfaceMesh → GenerateVolumeMesh.
namespace nglib {
#ifdef KOFEM_NETGEN_OCC
    typedef void* Ng_OCC_Geometry;
    extern Ng_OCC_Geometry* Ng_OCC_Load_STEP(const char* filename);
    extern Ng_Result         Ng_OCC_DeleteGeometry(Ng_OCC_Geometry*);
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
    if (!g_has_step_shape || g_step_bytes.empty())
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
    // ── OCC path: Netgen reads the CAD geometry directly ─────────────────────
    // Netgen v6.2.2401 four-step pipeline (nglib_occ.cpp, namespace nglib):
    //   1. Ng_OCC_SetLocalMeshSize  — size field from CAD curvature
    //   2. Ng_OCC_GenerateEdgeMesh  — mesh feature edges
    //   3. Ng_OCC_GenerateSurfaceMesh — mesh boundary faces
    //   4. Ng_GenerateVolumeMesh    — fill volume with tetrahedra

    const char* steppath = "/tmp/kofem_fem.stp";
    {
        FILE* f = fopen(steppath, "wb");
        if (!f) throw std::runtime_error("generate_fem_mesh: cannot open /tmp/kofem_fem.stp");
        fwrite(g_step_bytes.data(), 1, g_step_bytes.size(), f);
        fclose(f);
    }

    nglib::Ng_OCC_Geometry* geom = nglib::Ng_OCC_Load_STEP(steppath);
    unlink(steppath);
    if (!geom)
        throw std::runtime_error("Ng_OCC_Load_STEP failed — check STEP geometry validity");

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
        nglib::Ng_OCC_DeleteGeometry(geom);
        throw std::runtime_error("Ng_NewMesh returned null");
    }

    printf("[netgen] step 1/4: computing local mesh size from CAD curvature (maxh=%.2f)\n", max_size);
    fflush(stdout);
    nglib::Ng_OCC_SetLocalMeshSize(geom, mesh, &mp);

    printf("[netgen] step 2/4: meshing feature edges\n");
    fflush(stdout);
    nglib::Ng_Result res = nglib::Ng_OCC_GenerateEdgeMesh(geom, mesh, &mp);
    if (res != nglib::NG_OK) {
        nglib::Ng_DeleteMesh(mesh);
        nglib::Ng_OCC_DeleteGeometry(geom);
        throw std::runtime_error(
            "Ng_OCC_GenerateEdgeMesh failed (code " + std::to_string((int)res) + ")");
    }
    printf("[netgen] step 2/4: edge mesh done\n");
    fflush(stdout);

    printf("[netgen] step 3/4: meshing boundary surfaces (optsteps_2d=%d)\n", mp.optsteps_2d);
    fflush(stdout);
    res = nglib::Ng_OCC_GenerateSurfaceMesh(geom, mesh, &mp);
    if (res != nglib::NG_OK) {
        nglib::Ng_DeleteMesh(mesh);
        nglib::Ng_OCC_DeleteGeometry(geom);
        throw std::runtime_error(
            "Ng_OCC_GenerateSurfaceMesh failed (code " + std::to_string((int)res) + ")");
    }
    printf("[netgen] step 3/4: surface mesh done — %d surface nodes\n", nglib::Ng_GetNP(mesh));
    fflush(stdout);

    // Step 4: fill volume.
    // Keep geom alive: Netgen stores OCC geometry references in the mesh during
    // step 3 and accesses them during BOTH Delaunay insertion and mesh
    // optimisation (surface node projection).  Freeing geom before this call
    // causes dangling-pointer reads that corrupt the WASM vtable (invoke_ii
    // trap with a heap address instead of a function table index).
    printf("[netgen] step 4/4: Delaunay volume fill (optsteps_3d=%d)\n", mp.optsteps_3d);
    fflush(stdout);
    res = nglib::Ng_GenerateVolumeMesh(mesh, &mp);
    nglib::Ng_OCC_DeleteGeometry(geom);  // safe: volume fill complete
    if (res != nglib::NG_OK) {
        nglib::Ng_DeleteMesh(mesh);
        throw std::runtime_error(
            "Ng_GenerateVolumeMesh failed (code " + std::to_string((int)res) + ")");
    }

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

    nglib::Ng_DeleteMesh(mesh);

    return "{\"vertices\":" + json_vec3(out_verts) +
           ",\"tetrahedra\":" + json_ivec4(out_tets) + "}";

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
        nglib::Ng_DeleteMesh(mesh);
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

    nglib::Ng_DeleteMesh(mesh);

    return "{\"vertices\":" + json_vec3(out_verts) +
           ",\"tetrahedra\":" + json_ivec4(out_tets) + "}";
}

// ── MFEM: linear-elastic FEM solve ────────────────────────────────────────────

static std::string solve_linear_elastic(
    const std::string& mesh_json,
    const std::string& mat_json,
    const std::string& bcs_json,
    int order)
{
    using namespace mfem;

    val mesh_js = parse_json(mesh_json);
    val mat_js  = parse_json(mat_json);
    val bcs_js  = parse_json(bcs_json);

    val verts_js = mesh_js["vertices"];
    val tets_js  = mesh_js["tetrahedra"];
    val hexs_js  = mesh_js["hexahedra"];
    unsigned nv  = verts_js["length"].as<unsigned>();
    unsigned nt  = tets_js ["length"].as<unsigned>();
    unsigned nh  = hexs_js ["length"].as<unsigned>();

    if (nt == 0 && nh == 0)
        throw std::runtime_error(
            "Mesh has no elements. Send at least one CTETRA or CHEXA element.");

    std::vector<double> vertices;
    vertices.reserve(3 * nv);
    for (unsigned i = 0; i < nv; ++i) {
        val v = verts_js[i];
        vertices.push_back(v[0].as<double>());
        vertices.push_back(v[1].as<double>());
        vertices.push_back(v[2].as<double>());
    }

    std::vector<int> tets;
    tets.reserve(4 * nt);
    for (unsigned i = 0; i < nt; ++i) {
        val t = tets_js[i];
        tets.push_back(t[0].as<int>());
        tets.push_back(t[1].as<int>());
        tets.push_back(t[2].as<int>());
        tets.push_back(t[3].as<int>());
    }

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

    // Build MFEM mesh — supports pure-tet, pure-hex, or mixed meshes
    constexpr int dim = 3;
    Mesh mfem_mesh(dim, (int)nv, (int)(nt + nh), 0, dim);
    for (unsigned i = 0; i < nv; ++i)
        mfem_mesh.AddVertex(vertices.data() + 3*i);
    for (unsigned i = 0; i < nt; ++i) {
        int vi[4] = { tets[4*i], tets[4*i+1], tets[4*i+2], tets[4*i+3] };
        mfem_mesh.AddTet(vi, /*attr=*/1);
    }
    for (unsigned i = 0; i < nh; ++i) {
        int vi[8];
        for (int k = 0; k < 8; ++k) vi[k] = hexs[8*i + k];
        mfem_mesh.AddHex(vi, /*attr=*/1);
    }
    // FinalizeHexMesh / FinalizeTetMesh both call GenerateBoundaryElements()
    // internally.  Finalize() (the general method) does not — so for mixed
    // meshes we call it explicitly afterwards.  Without boundary elements,
    // MFEM's FE space setup aborts.
    if (nh == 0)
        mfem_mesh.FinalizeTetMesh(/*gen_edges=*/1, /*refine=*/0, /*fix_orient=*/true);
    else if (nt == 0)
        mfem_mesh.FinalizeHexMesh(/*gen_edges=*/1, /*refine=*/0, /*fix_orient=*/true);
    else {
        mfem_mesh.Finalize(/*refine=*/0, /*fix_orientation=*/1);
        mfem_mesh.GenerateBoundaryElements();
    }

    order = std::max(1, order);
    double lam = E * nu / ((1.0 + nu) * (1.0 - 2.0*nu));
    double mu  = E / (2.0 * (1.0 + nu));

    H1_FECollection fec(order, dim);
    FiniteElementSpace fespace(&mfem_mesh, &fec, dim);

    // Essential (Dirichlet) DOFs from fixed vertices
    Array<int> ess_tdof;
    for (unsigned i = 0; i < n_fixed; ++i) {
        int vi = fixed_js[i].as<int>();
        Array<int> vdofs;
        fespace.GetVertexVDofs(vi, vdofs);
        for (int j = 0; j < vdofs.Size(); ++j)
            ess_tdof.Append(vdofs[j]);
    }
    ess_tdof.Sort();
    ess_tdof.Unique();

    GridFunction x(&fespace);
    x = 0.0;

    LinearForm b(&fespace);
    b.Assemble();
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
    a.Assemble();

    OperatorPtr A;
    Vector B, X;
    a.FormLinearSystem(ess_tdof, x, b, A, X, B);

    SparseMatrix& A_mat = *A.As<SparseMatrix>();
    GSSmoother prec(A_mat);
    CGSolver cg;
    cg.SetRelTol(1e-8);
    cg.SetMaxIter(3000);
    cg.SetPrintLevel(0);
    cg.SetPreconditioner(prec);
    cg.SetOperator(A_mat);
    cg.Mult(B, X);
    a.RecoverFEMSolution(X, b, x);

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

    return "{\"displacements\":" + json_doubles(displacements) +
           ",\"von_mises\":"     + json_doubles(von_mises)     + "}";
}

// ── Convenience: full pipeline in one call ────────────────────────────────────

static std::string step_to_fem_result(
    val bytes_val,
    const std::string& tess_opts,
    const std::string& mesh_opts,
    const std::string& mat_json,
    const std::string& bcs_json,
    int order)
{
    std::string surface_json = tessellate_step(bytes_val, tess_opts);
    std::string volume_json  = generate_volume_mesh(surface_json, mesh_opts);
    return solve_linear_elastic(volume_json, mat_json, bcs_json, order);
}

// ── Embind registrations ──────────────────────────────────────────────────────

EMSCRIPTEN_BINDINGS(kofem) {
    emscripten::function("tessellate_step",        &tessellate_step);
    emscripten::function("tessellate_for_meshing", &tessellate_for_meshing);
    emscripten::function("generate_volume_mesh",   &generate_volume_mesh);
    emscripten::function("generate_fem_mesh",      &generate_fem_mesh);
    emscripten::function("solve_linear_elastic",   &solve_linear_elastic);
    emscripten::function("step_to_fem_result",     &step_to_fem_result);
}
