// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Netgen: surface mesh → tetrahedral volume mesh. See mesh_netgen.h.

#include "mesh_netgen.h"

#include "geometry_cache.h"
#include "json_util.h"
#include "wasm_util.h"

// Netgen (C API)
#include <nglib.h>

// Netgen internal-API glue (face indices, geometry from shape) — see netgen_glue.h
#include "netgen_glue.h"

#include <TopoDS_Shape.hxx>

#include <cstdio>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using emscripten::val;

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
std::string generate_fem_mesh(const std::string& opts_json)
{
    if (!has_cached_shape())
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
        (nglib::Ng_OCC_Geometry*)kofem_occ_geometry_from_shape(cached_shape());
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

    // A surface mesh with no tetrahedra means the geometry enclosed no volume:
    // the boundary surfaces did not sew into a watertight solid (typical of
    // surface-only IGES — issue #276). Fail loudly rather than handing a
    // tetrahedron-free mesh to the solver, which can't analyse it.
    if (ne == 0) {
        kofem_delete_mesh(mesh);
        throw std::runtime_error(
            "Volume meshing produced 0 tetrahedra: the geometry has surfaces but "
            "no closed solid to fill. This usually means the CAD file (often IGES) "
            "stores only free surfaces that do not sew into a watertight body. "
            "Export the model as a solid (closed shell) and reload.");
    }

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

std::string generate_volume_mesh(
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
