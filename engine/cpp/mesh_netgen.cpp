// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Netgen: cached OCC geometry → FEM surface mesh + tetrahedral volume mesh,
// and the surface mesh of the CAD mid-surface of Shell bodies (KOF-498).
// See mesh_netgen.h.

#include "mesh_netgen.h"

#include "geometry_cache.h"
#include "json_util.h"
#include "mesh_overlap.h"
#include "mesh_sizes.h"
#include "mid_surface.h"
#include "wasm_util.h"

// Netgen (C API)
#include <nglib.h>

// Netgen internal-API glue (face indices, geometry from shape) — see netgen_glue.h
#include "netgen_glue.h"

#include <BRep_Builder.hxx>
#include <Precision.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <array>
#include <climits>
#include <cmath>
#include <cstdio>
#include <map>
#include <memory>
#include <new>
#include <set>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

using emscripten::val;

// ── Netgen C API declarations ─────────────────────────────────────────────────
//
// Netgen on some platforms compiles its C API inside namespace nglib; on others
// (including our Emscripten build from source) the symbols are in the global
// namespace.  Re-declare the API inside the namespace so linking succeeds
// regardless — this matches what netgen_bridge.cpp in kofem-mesh does.

namespace nglib {
    using Ng_Mesh = void*;
    enum Ng_Result {
        NG_ERROR = -1, NG_OK = 0, NG_SURFACE_INPUT_ERROR = 1,
        NG_VOLUME_FAILURE = 2, NG_STL_INPUT_ERROR = 3,
        NG_SURFACE_FAILURE = 4, NG_FILE_NOT_FOUND = 5,
    };

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
    extern Ng_Result Ng_GenerateVolumeMesh(Ng_Mesh*, Ng_Meshing_Parameters*);
    extern void      Ng_GetPoint(Ng_Mesh*, int, double*);
    extern Ng_Result Ng_GetVolumeElement(Ng_Mesh*, int, int*);
    extern int       Ng_GetNP(Ng_Mesh*);
    extern int       Ng_GetNE(Ng_Mesh*);
    // Surface element queries (standard nglib API, Netgen v6.2+)
    extern int       Ng_GetNSE(Ng_Mesh*);
    // Preserve the installed API's enum return type: exception invokes go
    // through typed WASM trampolines, which enforce this signature.
    extern ::Ng_Surface_Element_Type Ng_GetSurfaceElement(Ng_Mesh*, int, int*);
}

static_assert(std::is_same_v<decltype(nglib::Ng_GetSurfaceElement),
                             decltype(::Ng_GetSurfaceElement)>,
              "The Netgen surface query declaration must match nglib.h");

// OCC meshing API (Netgen v6.2.2401, nglib/nglib_occ.cpp, namespace nglib).
// Ng_OCC_GenerateMesh does not exist — meshing is split into four steps:
// SetLocalMeshSize → GenerateEdgeMesh → GenerateSurfaceMesh → GenerateVolumeMesh.
namespace nglib {
#ifdef KOFEM_NETGEN_OCC
    using Ng_OCC_Geometry = void*;
    extern Ng_Result         Ng_OCC_SetLocalMeshSize(Ng_OCC_Geometry*, Ng_Mesh*, Ng_Meshing_Parameters*);
    extern Ng_Result         Ng_OCC_GenerateEdgeMesh(Ng_OCC_Geometry*, Ng_Mesh*, Ng_Meshing_Parameters*);
    extern Ng_Result         Ng_OCC_GenerateSurfaceMesh(Ng_OCC_Geometry*, Ng_Mesh*, Ng_Meshing_Parameters*);
#endif
}

// ── Ownership and out-of-memory reporting (KOF-425) ──────────────────────────
namespace {

#ifdef KOFEM_NETGEN_OCC
// Free the Netgen geometry and mesh on every way out of generate_fem_mesh,
// exceptions included: a std::bad_alloc from an Ng_* call used to leave both
// allocated. Declare the geometry first, so the mesh, which refers to it, is
// destroyed first.
struct OccGeometryDeleter {
    void operator()(nglib::Ng_OCC_Geometry* geom) const {
        kofem_occ_geometry_delete(static_cast<void*>(geom));
    }
};
struct NetgenMeshDeleter {
    void operator()(nglib::Ng_Mesh* mesh) const { kofem_delete_mesh(static_cast<void*>(mesh)); }
};
using OccGeometryPtr = std::unique_ptr<nglib::Ng_OCC_Geometry, OccGeometryDeleter>;
using NetgenMeshPtr  = std::unique_ptr<nglib::Ng_Mesh, NetgenMeshDeleter>;
#endif

// Releases Netgen's node pools on every way out of generate_fem_mesh (KOF-431).
// Its destructor runs after generate_fem_mesh_owned has freed the geometry and
// the mesh, which is what makes the release safe.
class NetgenPoolRelease {
public:
    NetgenPoolRelease() = default;
    ~NetgenPoolRelease() {
        kofem_release_netgen_pools();
        log_mem("generate_fem_mesh: Netgen pools released");
    }
    NetgenPoolRelease(const NetgenPoolRelease&) = delete;
    NetgenPoolRelease& operator=(const NetgenPoolRelease&) = delete;
    NetgenPoolRelease(NetgenPoolRelease&&) = delete;
    NetgenPoolRelease& operator=(NetgenPoolRelease&&) = delete;
};

// Records whether operator new failed while it is alive. Netgen's volume fill
// catches the std::bad_alloc itself and returns no tetrahedra, or skips a
// domain, so its result alone cannot tell running out of memory from a
// geometry with nothing to fill.
class AllocationFailureWatch {
public:
    AllocationFailureWatch() : previous_(std::set_new_handler(&record)) { failed_ = false; }
    ~AllocationFailureWatch() { std::set_new_handler(previous_); }
    AllocationFailureWatch(const AllocationFailureWatch&) = delete;
    AllocationFailureWatch& operator=(const AllocationFailureWatch&) = delete;
    AllocationFailureWatch(AllocationFailureWatch&&) = delete;
    AllocationFailureWatch& operator=(AllocationFailureWatch&&) = delete;

    [[nodiscard]] bool failed() const { return failed_; }

private:
    // operator new calls this when malloc returns null; it then fails as it
    // would without a handler.
    static void record() {
        failed_ = true;
        throw std::bad_alloc();
    }

    static inline bool failed_ = false;
    std::new_handler previous_;
};

constexpr const char* out_of_memory_message =
    "Meshing ran out of memory at this element size. Use a larger maximum "
    "element size and mesh again.";

val generate_fem_mesh_owned(const std::string& opts_json);

} // namespace

// ── Netgen: STEP → FEM surface mesh + tetrahedral volume mesh ────────────────
//
// Uses Netgen's native OCC geometry integration (KOFEM_NETGEN_OCC required).
// Netgen reads the CAD topology directly, meshes edges and surfaces respecting
// feature lines, then fills the volume — one call, proper FEM surface mesh.
//
// Running out of memory anywhere in it is reported as such. By the time the
// std::bad_alloc reaches this catch, the geometry and mesh are freed, so the
// message can be built.
val generate_fem_mesh(const std::string& opts_json)
{
    const NetgenPoolRelease release_pools;
    try {
        return generate_fem_mesh_owned(opts_json);
    } catch (const std::bad_alloc&) {
        log_mem("generate_fem_mesh: out of memory, geometry and mesh freed");
        throw std::runtime_error(out_of_memory_message);
    }
}

namespace {

#ifdef KOFEM_NETGEN_OCC

struct MeshOptions {
    double max_size = 10.0;
    double min_size = 0.0;
    double grading = 0.3;
    bool second_order = false;
    double elems_per_edge = 2.0;
    double elems_per_curve = 2.0;
    int optsteps_2d = 0;
    int optsteps_3d = 0;
    MeshSizes sizes;
};

MeshOptions parse_mesh_options(const val& opts, const TopoDS_Shape& shape)
{
    MeshOptions o;
    o.max_size        = jdouble(opts, "max_element_size",   10.0);
    o.min_size        = jdouble(opts, "min_element_size",    0.0);
    o.grading         = jdouble(opts, "grading",             0.3);
    o.second_order    = jbool  (opts, "second_order",       false);
    o.elems_per_edge  = jdouble(opts, "elementsperedge",     2.0);
    o.elems_per_curve = jdouble(opts, "elementspercurve",    2.0);
    o.optsteps_2d     = jint   (opts, "optsteps_2d",           0);
    o.optsteps_3d     = jint   (opts, "optsteps_3d",           0);

    TopTools_IndexedMapOfShape solids;
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    TopExp::MapShapes(shape, TopAbs_FACE, faces);

    // Per-region sizes (KOF-257): entry k is the max element size of solid k+1.
    // Absent: every solid meshes at max_element_size.
    const val solid_sizes_js = opts["solid_max_sizes"];
    if (!solid_sizes_js.isUndefined() && !solid_sizes_js.isNull()) {
        o.sizes.solid_max = f64_vector(solid_sizes_js, "solid_max_sizes");
        if (static_cast<int>(o.sizes.solid_max.size()) != solids.Extent())
            throw std::runtime_error(
                "generate_fem_mesh: solid_max_sizes has " +
                std::to_string(o.sizes.solid_max.size()) + " entries but the geometry has " +
                std::to_string(solids.Extent()) + " solids");
        for (size_t k = 0; k < o.sizes.solid_max.size(); ++k) {
            const double h = o.sizes.solid_max[k];
            if (!std::isfinite(h) || h <= 0.0)
                throw std::runtime_error("generate_fem_mesh: solid " + std::to_string(k + 1) +
                                         " has max size " + std::to_string(h) +
                                         " — it must be a positive number");
        }
    }

    // Face sizes (KOF-394): [{face, max_size}], face a 1-based OCC face index.
    // Absent or empty: no face is meshed finer than its solid.
    const val face_sizes_js = opts["face_max_sizes"];
    if (!face_sizes_js.isUndefined() && !face_sizes_js.isNull()) {
        if (!face_sizes_js.isArray())
            throw std::runtime_error("generate_fem_mesh: face_max_sizes must be an array");
        const int count = face_sizes_js["length"].as<int>();
        for (int k = 0; k < count; ++k) {
            const val entry = face_sizes_js[k];
            if (!entry["face"].isNumber() || !entry["max_size"].isNumber())
                throw std::runtime_error("generate_fem_mesh: face_max_sizes entry " +
                                         std::to_string(k) +
                                         " needs a numeric face and max_size");
            const double face = entry["face"].as<double>();
            if (face != std::floor(face) || face < 1.0 || face > faces.Extent())
                throw std::runtime_error("generate_fem_mesh: face " + std::to_string(face) +
                                         " has an element size, but the geometry has faces 1 to " +
                                         std::to_string(faces.Extent()));
            const double h = entry["max_size"].as<double>();
            if (!std::isfinite(h) || h <= 0.0)
                throw std::runtime_error("generate_fem_mesh: face " +
                                         std::to_string(static_cast<int>(face)) +
                                         " has max size " + std::to_string(h) +
                                         " — it must be a positive number");
            o.sizes.face_max.push_back({static_cast<int>(face), h});
        }
    }
    return o;
}

nglib::Ng_Meshing_Parameters netgen_parameters(const MeshOptions& o, double maxh)
{
    nglib::Ng_Meshing_Parameters mp;
    mp.uselocalh                  = 1;
    mp.maxh                       = maxh;
    mp.minh                       = o.min_size;
    mp.fineness                   = 0.5;
    mp.grading                    = o.grading;
    mp.elementsperedge            = o.elems_per_edge;
    mp.elementspercurve           = o.elems_per_curve;
    mp.closeedgeenable            = 0;
    mp.closeedgefact              = 2.0;
    mp.minedgelenenable           = 0;
    mp.minedgelen                 = 1e-4;
    mp.second_order               = o.second_order ? 1 : 0;
    mp.quad_dominated             = 0;
    mp.meshsize_filename          = nullptr;
    mp.optsurfmeshenable          = 1;
    mp.optvolmeshenable           = 1;
    // Optimisation defaults to 0 (skipped): for complex CAD (many faces, short
    // edges) the optimiser reprojects nodes onto OCC surfaces in a loop that
    // can run for minutes. Callers can opt in via optsteps_2d/optsteps_3d for
    // a higher-quality (slower) mesh.
    mp.optsteps_2d                = o.optsteps_2d;
    mp.optsteps_3d                = o.optsteps_3d;
    mp.invert_tets                = 0;
    mp.invert_trigs               = 0;
    // Overlap detection stays enabled (issue #214): imported geometry is
    // healed at load (heal_shape in cad_io.cpp), which repairs the defects
    // that used to make the check fail on valid parts. A mesh that still
    // trips it contains genuinely intersecting elements — the stiffness
    // matrix assembled from it would be silently wrong, so meshing fails
    // loudly below instead.
    mp.check_overlap              = 1;
    mp.check_overlapping_boundary = 1;
    return mp;
}

// The largest size any of `sizes` gives: Netgen's global maxh caps every size,
// and a region may be coarser than the rest as well as finer. Face sizes only
// ever refine, so they leave it alone.
double global_max_size(const MeshOptions& o, const std::vector<KofemShapeMaxSize>& sizes)
{
    double maxh = o.max_size;
    for (const KofemShapeMaxSize& sized : sizes)
        if (sized.shape.ShapeType() == TopAbs_SOLID)
            maxh = std::max(maxh, sized.max_size);
    return maxh;
}

// Whole-shape id of each entry of a Netgen geometry's face or solid order.
std::vector<int> whole_shape_ids(const std::vector<TopoDS_Shape>& netgen_order,
                                 const TopTools_IndexedMapOfShape& whole)
{
    std::vector<int> ids;
    ids.reserve(netgen_order.size());
    for (const TopoDS_Shape& s : netgen_order) {
        const int id = whole.FindIndex(s);
        if (id == 0)
            throw std::runtime_error(
                "generate_fem_mesh: Netgen meshed a shape that is not part of the geometry");
        ids.push_back(id);
    }
    return ids;
}

// Steps 1–3 of Netgen's OCC pipeline: the size field from CAD curvature, the
// edge mesh, the surface mesh.
void mesh_edges_and_surfaces(nglib::Ng_OCC_Geometry* geom, nglib::Ng_Mesh* mesh,
                             nglib::Ng_Meshing_Parameters* mp, const char* label, int steps)
{
    printf("[netgen] %s 1/%d: computing local mesh size from CAD curvature (maxh=%.2f)\n",
           label, steps, mp->maxh);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 1 SetLocalMeshSize");
    nglib::Ng_OCC_SetLocalMeshSize(geom, mesh, mp);

    printf("[netgen] %s 2/%d: meshing feature edges\n", label, steps);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 2 GenerateEdgeMesh");
    nglib::Ng_Result res = nglib::Ng_OCC_GenerateEdgeMesh(geom, mesh, mp);
    if (res != nglib::NG_OK)
        throw std::runtime_error(
            "Ng_OCC_GenerateEdgeMesh failed (code " + std::to_string((int)res) + ")");
    log_mem("generate_fem_mesh: step 2 done");

    printf("[netgen] %s 3/%d: meshing surfaces (optsteps_2d=%d)\n", label, steps, mp->optsteps_2d);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 3 GenerateSurfaceMesh");
    res = nglib::Ng_OCC_GenerateSurfaceMesh(geom, mesh, mp);
    if (res != nglib::NG_OK)
        throw std::runtime_error(
            "Ng_OCC_GenerateSurfaceMesh failed (code " + std::to_string((int)res) + ")");
    printf("[netgen] %s 3/%d: surface mesh done — %d surface nodes\n", label, steps,
           nglib::Ng_GetNP(mesh));
    fflush(stdout);
    log_mem("generate_fem_mesh: step 3 done");
}

std::vector<double> mesh_points(nglib::Ng_Mesh* mesh)
{
    const int np = nglib::Ng_GetNP(mesh);
    std::vector<double> out;
    out.reserve(3 * static_cast<size_t>(np));
    for (int i = 1; i <= np; ++i) {
        std::array<double, 3> pt{};
        nglib::Ng_GetPoint(mesh, i, pt.data());
        out.insert(out.end(), pt.begin(), pt.end());
    }
    return out;
}

val empty_volume_mesh()
{
    val result = val::object();
    result.set("vertices",         float64_array({}));
    result.set("tetrahedra",       int32_array({}));
    result.set("bodyIds",          int32_array({}));
    result.set("surfaceTriangles", int32_array({}));
    result.set("surfaceFaceIds",   int32_array({}));
    return result;
}

// ── Solids: surface + tetrahedral volume mesh ────────────────────────────────
//
// `part` is the whole shape, or the solids of it that are meshed as volumes
// when some Shell bodies take the CAD mid-surface path. Face and body ids are
// the whole shape's either way.
val mesh_solids(const TopoDS_Shape& shape, const TopoDS_Shape& part, const MeshOptions& o)
{
    TopTools_IndexedMapOfShape shape_faces;
    TopTools_IndexedMapOfShape shape_solids;
    TopExp::MapShapes(shape, TopAbs_FACE, shape_faces);
    TopExp::MapShapes(shape, TopAbs_SOLID, shape_solids);

    // With region sizes, every solid gets one and the global maxh becomes the
    // largest of them. Without any size, every size is reset to Netgen's
    // default, so the mesh is the one the global settings alone make. Either
    // way Netgen's static size table keeps nothing from an earlier mesh.
    const std::vector<KofemShapeMaxSize> sizes = solid_mesh_sizes(shape, part, o.sizes);
    kofem_apply_max_sizes(part, sizes);
    const double max_size = global_max_size(o, sizes);

    // The Netgen geometry is built straight from the OCCT shape that
    // tessellate_step already transferred — re-reading the STEP file through
    // Netgen's own reader (Ng_OCC_Load_STEP) parsed the whole file a second
    // time and doubled peak geometry memory.
    log_mem("generate_fem_mesh: before OCC geometry build");
    OccGeometryPtr geom(
        static_cast<nglib::Ng_OCC_Geometry*>(kofem_occ_geometry_from_shape(part)));
    if (!geom)
        throw std::runtime_error("OCCGeometry construction failed — check STEP geometry validity");
    log_mem("generate_fem_mesh: after OCC geometry build");
    const std::vector<int> face_id =
        whole_shape_ids(kofem_occ_geometry_faces(static_cast<void*>(geom.get())), shape_faces);
    const std::vector<int> body_id =
        whole_shape_ids(kofem_occ_geometry_solids(static_cast<void*>(geom.get())), shape_solids);
    auto whole_face = [&](int netgen_face) {
        return face_id.at(static_cast<size_t>(netgen_face - 1));
    };

    nglib::Ng_Meshing_Parameters mp = netgen_parameters(o, max_size);
    NetgenMeshPtr mesh(nglib::Ng_NewMesh());
    if (!mesh)
        throw std::runtime_error("Ng_NewMesh returned null");
    mesh_edges_and_surfaces(geom.get(), mesh.get(), &mp, "step", 4);

    // Netgen returns NG_OK even when it gave up on faces ("NOT ALL FACES HAVE
    // BEEN MESHED"), keeping their half-made or overfilled elements. The volume
    // fill must not run on that: it throws "Illegal position in Geomsearch" and
    // corrupts the heap, or flags those elements as overlaps that are not in the
    // geometry. Report the faces instead, so the caller can show them.
    //
    // A face narrower than OCCT's own tolerance is not a feature but noise a
    // Boolean left behind (hinge "connect" leaves ~1e-9 mm ones); the volume
    // fill closes over it, so it is logged and meshing goes on.
    std::vector<int> unmeshed;
    for (const int netgen_face : kofem_unmeshed_faces(static_cast<void*>(geom.get()))) {
        const int id = whole_face(netgen_face);
        const double width = face_width(TopoDS::Face(shape_faces(id)));
        if (width >= Precision::Confusion()) {
            unmeshed.push_back(id);
            continue;
        }
        printf("[netgen] face %d could not be meshed, but it is %.2g mm wide — below the "
               "geometry tolerance, so the volume fill goes on\n", id, width);
        fflush(stdout);
    }
    if (!unmeshed.empty()) {
        printf("[netgen] %d faces could not be meshed; skipping the volume fill\n",
               (int)unmeshed.size());
        fflush(stdout);
        val unmeshed_result = val::object();
        unmeshed_result.set("overlaps", describe_unmeshed_faces(unmeshed, shape));
        return unmeshed_result;
    }

    // Step 4: fill volume.
    // Keep geom alive: Netgen stores OCC geometry references in the mesh during
    // step 3 and accesses them during BOTH Delaunay insertion and mesh
    // optimisation (surface node projection).  Freeing geom before this call
    // causes dangling-pointer reads that corrupt the WASM vtable (invoke_ii
    // trap with a heap address instead of a function table index).
    printf("[netgen] step 4/4: Delaunay volume fill with overlap checking "
           "(optsteps_3d=%d)\n", mp.optsteps_3d);
    fflush(stdout);
    log_mem("generate_fem_mesh: step 4 GenerateVolumeMesh");
    bool fill_ran_out_of_memory = false;
    nglib::Ng_Result res = nglib::NG_OK;
    {
        const AllocationFailureWatch watch;
        res = nglib::Ng_GenerateVolumeMesh(mesh.get(), &mp);
        fill_ran_out_of_memory = watch.failed();
    }
    geom.reset();     // safe: volume fill complete
    // Whatever the fill returned, a domain it gave up on for memory is missing
    // from the mesh; generate_fem_mesh reports the std::bad_alloc.
    if (fill_ran_out_of_memory) {
        printf("[netgen] step 4/4: the volume fill ran out of memory\n");
        fflush(stdout);
        mesh.reset();
        throw std::bad_alloc();
    }
    if (res != nglib::NG_OK)
        throw std::runtime_error(
            "Ng_GenerateVolumeMesh failed (code " + std::to_string((int)res) + "). "
            "The boundary mesh contains overlapping or self-intersecting elements "
            "that geometry healing could not repair — an analysis on such a mesh "
            "would be silently wrong. Check the CAD model for near-touching or "
            "self-intersecting surfaces and re-export.");
    log_mem("generate_fem_mesh: step 4 done");

    int np = nglib::Ng_GetNP(mesh.get());
    int ne = nglib::Ng_GetNE(mesh.get());
    printf("[netgen] step 4/4: volume mesh done — %d nodes, %d tetrahedra\n", np, ne);
    fflush(stdout);

    // Netgen catches its own "boundary mesh is overlapping" exception and returns
    // NG_OK with no tetrahedra. Tell that apart from an open shell below: report
    // where the surface overlaps so the caller can show it and offer a repair.
    if (ne == 0) {
        std::vector<KofemSurfaceTriangle> overlapping =
            kofem_overlapping_surface_elements(static_cast<void*>(mesh.get()));
        for (KofemSurfaceTriangle& triangle : overlapping)
            triangle.face = whole_face(triangle.face);
        if (!overlapping.empty()) {
            val overlap_result = val::object();
            overlap_result.set("overlaps", describe_mesh_overlaps(overlapping, shape));
            return overlap_result;
        }
    }

    // A surface mesh with no tetrahedra means the geometry enclosed no volume:
    // the boundary surfaces did not sew into a watertight solid (typical of
    // surface-only IGES — issue #276). Fail loudly rather than handing a
    // tetrahedron-free mesh to the solver, which can't analyse it.
    if (ne == 0)
        throw std::runtime_error(
            "Volume meshing produced 0 tetrahedra: the geometry has surfaces but "
            "no closed solid to fill. This usually means the CAD file (often IGES) "
            "stores only free surfaces that do not sew into a watertight body. "
            "Export the model as a solid (closed shell) and reload.");

    const std::vector<double> out_verts = mesh_points(mesh.get());

    std::vector<int> out_tets;
    out_tets.reserve(4 * ne);
    for (int i = 1; i <= ne; ++i) {
        std::array<int, 4> tet;
        nglib::Ng_GetVolumeElement(mesh.get(), i, tet.data());
        out_tets.push_back(tet[0] - 1);
        out_tets.push_back(tet[1] - 1);
        out_tets.push_back(tet[2] - 1);
        out_tets.push_back(tet[3] - 1);
    }

    // Body index per tetrahedron — Netgen's 1-based subdomain number, one
    // subdomain per solid of the meshed part, as the whole shape's solid index
    // (issue #353). This is what lets the solver apply per-body materials to a
    // multibody assembly.
    std::vector<int> out_body_ids;
    out_body_ids.reserve(ne);
    for (int i = 1; i <= ne; ++i)
        out_body_ids.push_back(body_id.at(static_cast<size_t>(
            kofem_volume_element_domain_index(static_cast<void*>(mesh.get()), i) - 1)));
    printf("[netgen] %d bodies in volume mesh\n",
           (int)std::set<int>(out_body_ids.begin(), out_body_ids.end()).size());
    fflush(stdout);

    // Surface elements — boundary triangles from the Netgen surface mesh.
    // Netgen records the owning CAD face of every surface element it generates
    // during Ng_OCC_GenerateSurfaceMesh; kofem_surface_element_face_index reads
    // that index (1-based) straight from the mesh, in the meshed part's face
    // order, which whole_face turns into the whole shape's face id.
    int nse = nglib::Ng_GetNSE(mesh.get());
    std::vector<int> out_surf_tris;
    std::vector<int> out_surf_face_ids;
    out_surf_tris.reserve(3 * nse);
    out_surf_face_ids.reserve(nse);
    for (int i = 1; i <= nse; ++i) {
        std::array<int, 3> tri;
        nglib::Ng_GetSurfaceElement(mesh.get(), i, tri.data());
        out_surf_tris.push_back(tri[0] - 1);
        out_surf_tris.push_back(tri[1] - 1);
        out_surf_tris.push_back(tri[2] - 1);
        out_surf_face_ids.push_back(
            whole_face(kofem_surface_element_face_index(static_cast<void*>(mesh.get()), i)));
    }
    printf("[netgen] %d surface elements, %d unique OCC face IDs\n",
           nse, (int)std::set<int>(out_surf_face_ids.begin(), out_surf_face_ids.end()).size());
    fflush(stdout);

    mesh.reset();
    log_mem("generate_fem_mesh: after Ng_DeleteMesh");

    // Flat typed arrays instead of JSON text (issue #166): xyz-interleaved
    // Float64 coordinates, four Int32 vertex indices per tet, one Int32 body id
    // per tet, three Int32 vertex indices per surface triangle, one Int32 OCC
    // face id per surface triangle.
    val result = val::object();
    result.set("vertices",         float64_array(out_verts));
    result.set("tetrahedra",       int32_array(out_tets));
    result.set("bodyIds",          int32_array(out_body_ids));
    result.set("surfaceTriangles", int32_array(out_surf_tris));
    result.set("surfaceFaceIds",   int32_array(out_surf_face_ids));
    return result;
}

// ── Shell bodies on the CAD path: surface mesh of the mid-surface only ───────
//
// Returns the DTO's midSurface (see mesh_netgen.h), or { overlaps } naming the
// top faces of mid faces Netgen could not mesh.
val mesh_mid_surfaces(const TopoDS_Shape& shape,
                      const std::vector<const ShellBodyAnalysis*>& bodies, const MeshOptions& o)
{
    // Every mid face, numbered across the bodies, with its body and its index
    // in that body's analysis.
    struct MidRef {
        const ShellBodyAnalysis* body;
        size_t index;
    };
    std::vector<MidRef> refs;
    TopTools_IndexedMapOfShape mid_faces;
    BRep_Builder builder;
    TopoDS_Compound mid_shape;
    builder.MakeCompound(mid_shape);
    std::vector<KofemShapeMaxSize> sizes;
    for (const ShellBodyAnalysis* body : bodies) {
        builder.Add(mid_shape, body->mid_shape);
        for (size_t k = 0; k < body->mid_faces.size(); ++k) {
            mid_faces.Add(body->mid_faces[k].face);
            refs.push_back({body, k});
        }
        const std::vector<KofemShapeMaxSize> own = mid_surface_mesh_sizes(*body, o.sizes);
        sizes.insert(sizes.end(), own.begin(), own.end());
    }
    kofem_apply_max_sizes(mid_shape, sizes);
    double max_size = o.max_size;
    if (!o.sizes.solid_max.empty())
        for (const ShellBodyAnalysis* body : bodies)
            max_size = std::max(max_size, o.sizes.solid_max.at(static_cast<size_t>(body->body - 1)));

    OccGeometryPtr geom(
        static_cast<nglib::Ng_OCC_Geometry*>(kofem_occ_geometry_from_shape(mid_shape)));
    if (!geom)
        throw std::runtime_error("OCCGeometry construction failed for the mid-surface");
    std::vector<size_t> mid_of_netgen_face;
    for (const TopoDS_Shape& face : kofem_occ_geometry_faces(static_cast<void*>(geom.get()))) {
        const int k = mid_faces.FindIndex(face);
        if (k == 0)
            throw std::runtime_error("generate_fem_mesh: Netgen meshed a face that is not a mid face");
        mid_of_netgen_face.push_back(static_cast<size_t>(k - 1));
    }

    nglib::Ng_Meshing_Parameters mp = netgen_parameters(o, max_size);
    NetgenMeshPtr mesh(nglib::Ng_NewMesh());
    if (!mesh)
        throw std::runtime_error("Ng_NewMesh returned null");
    mesh_edges_and_surfaces(geom.get(), mesh.get(), &mp, "mid-surface step", 3);

    // A mid face Netgen gave up on is a hole in the shell: report it by its
    // top face, the face the user knows.
    std::vector<int> unmeshed;
    for (const int netgen_face : kofem_unmeshed_faces(static_cast<void*>(geom.get()))) {
        const MidRef& ref = refs.at(mid_of_netgen_face.at(static_cast<size_t>(netgen_face - 1)));
        unmeshed.push_back(ref.body->mid_faces[ref.index].top);
    }
    if (!unmeshed.empty()) {
        std::sort(unmeshed.begin(), unmeshed.end());
        unmeshed.erase(std::unique(unmeshed.begin(), unmeshed.end()), unmeshed.end());
        val unmeshed_result = val::object();
        unmeshed_result.set("overlaps", describe_unmeshed_faces(unmeshed, shape));
        return unmeshed_result;
    }

    const std::vector<double> vertices = mesh_points(mesh.get());
    auto point = [&](int v) {
        return gp_Pnt(vertices[3 * static_cast<size_t>(v)], vertices[3 * static_cast<size_t>(v) + 1],
                      vertices[3 * static_cast<size_t>(v) + 2]);
    };
    const int nse = nglib::Ng_GetNSE(mesh.get());
    std::vector<int> triangles;
    std::vector<int> mid_face;
    triangles.reserve(3 * static_cast<size_t>(nse));
    mid_face.reserve(static_cast<size_t>(nse));
    // Netgen winds the surface elements of a face consistently, along or
    // against the face's own orientation. Each mid face's triangles are wound
    // so their normal points to the top side, the outward side of the top
    // source face; a face whose triangles would need both windings is a folded
    // mesh, and an error.
    std::vector<int> winding(refs.size(), 0);
    for (int i = 1; i <= nse; ++i) {
        std::array<int, 3> tri{};
        nglib::Ng_GetSurfaceElement(mesh.get(), i, tri.data());
        for (int& v : tri)
            v -= 1;
        const size_t g = mid_of_netgen_face.at(static_cast<size_t>(
            kofem_surface_element_face_index(static_cast<void*>(mesh.get()), i) - 1));
        const gp_Pnt a = point(tri[0]);
        const gp_Pnt b = point(tri[1]);
        const gp_Pnt c = point(tri[2]);
        const gp_Vec normal = gp_Vec(a, b).Crossed(gp_Vec(a, c));
        const gp_Pnt centroid((a.XYZ() + b.XYZ() + c.XYZ()) / 3.0);
        const gp_Dir top = top_side_normal(*refs[g].body, refs[g].index, centroid);
        const int sense = normal.Dot(gp_Vec(top)) > 0.0 ? 1 : -1;
        if (winding[g] == 0)
            winding[g] = sense;
        else if (winding[g] != sense)
            throw std::runtime_error(
                "generate_fem_mesh: Netgen wound the mid-surface triangles of top face " +
                std::to_string(refs[g].body->mid_faces[refs[g].index].top) +
                " both ways, so the mesh folds over");
        if (sense < 0)
            std::swap(tri[1], tri[2]);
        triangles.insert(triangles.end(), tri.begin(), tri.end());
        mid_face.push_back(static_cast<int>(g));
    }

    // Every mesh edge is shared by two triangles, except on the rim, where it
    // lies on the side face it came from. An open edge anywhere else means the
    // mid faces were not meshed conformally.
    std::map<std::pair<int, int>, std::pair<int, size_t>> edges;  // → (uses, mid face)
    for (size_t t = 0; t < mid_face.size(); ++t)
        for (int k = 0; k < 3; ++k) {
            const int p = triangles[3 * t + k];
            const int q = triangles[3 * t + (k + 1) % 3];
            auto& entry = edges[{std::min(p, q), std::max(p, q)}];
            entry.first += 1;
            entry.second = static_cast<size_t>(mid_face[t]);
        }
    std::vector<int> rim;
    for (const auto& [ends, use] : edges) {
        if (use.first > 2)
            throw std::runtime_error("generate_fem_mesh: a mid-surface mesh edge joins " +
                                     std::to_string(use.first) + " triangles");
        if (use.first == 2)
            continue;
        const MidRef& ref = refs[use.second];
        const int side =
            rim_side_face(*ref.body, ref.index, point(ends.first), point(ends.second));
        if (side == 0)
            throw std::runtime_error(
                "generate_fem_mesh: the mid-surface mesh is open inside top face " +
                std::to_string(ref.body->mid_faces[ref.index].top) +
                ": Netgen did not join the mid faces there");
        rim.insert(rim.end(), {ends.first, ends.second, side});
    }
    printf("[netgen] mid-surface: %d faces, %d triangles, %d rim edges (surface mesh only)\n",
           static_cast<int>(refs.size()), nse, static_cast<int>(rim.size() / 3));
    fflush(stdout);

    mesh.reset();
    geom.reset();

    val faces = val::array();
    for (const MidRef& ref : refs) {
        const MidFace& mid = ref.body->mid_faces[ref.index];
        val entry = val::object();
        entry.set("body", ref.body->body);
        entry.set("top", mid.top);
        entry.set("bottom", mid.bottom);
        entry.set("thickness", ref.body->walls.at(mid.wall).thickness);
        faces.call<void>("push", entry);
    }
    val result = val::object();
    result.set("vertices",  float64_array(vertices));
    result.set("triangles", int32_array(triangles));
    result.set("midFace",   int32_array(mid_face));
    result.set("faces",     faces);
    result.set("rimEdges",  int32_array(rim));
    return result;
}

#endif  // KOFEM_NETGEN_OCC

val generate_fem_mesh_owned(const std::string& opts_json)
{
    if (!has_cached_shape())
        throw std::runtime_error(
            "generate_fem_mesh: no STEP shape loaded — call tessellate_step first");

    static bool ng_initialized = false;
    if (!ng_initialized) { nglib::Ng_Init(); ng_initialized = true; }

#ifdef KOFEM_NETGEN_OCC
    const val opts = parse_json(opts_json);
    const TopoDS_Shape& shape = cached_shape();
    const MeshOptions options = parse_mesh_options(opts, shape);

    // Bodies marked Shell (KOF-498): each takes the CAD mid-surface path or
    // keeps the mesh-based one, which meshes it as a solid like any other body.
    const std::vector<int> shell_bodies = shell_body_ids(opts, shape);
    std::vector<ShellBodyAnalysis> analyses;
    if (!shell_bodies.empty()) {
        const ThinWallRule rule = thin_wall_rule(opts);
        for (const int body : shell_bodies)
            analyses.push_back(analyse_shell_body(shape, body, rule));
    }
    std::vector<const ShellBodyAnalysis*> cad;
    for (const ShellBodyAnalysis& analysis : analyses)
        if (!analysis.unpaired)
            cad.push_back(&analysis);

    val result = val::undefined();
    if (cad.empty()) {
        result = mesh_solids(shape, shape, options);
    } else {
        TopTools_IndexedMapOfShape solids;
        TopExp::MapShapes(shape, TopAbs_SOLID, solids);
        BRep_Builder builder;
        TopoDS_Compound volume_part;
        builder.MakeCompound(volume_part);
        bool any_volume = false;
        for (int i = 1; i <= solids.Extent(); ++i) {
            const bool mid_surface = std::any_of(cad.begin(), cad.end(), [i](const ShellBodyAnalysis* a) {
                return a->body == i;
            });
            if (mid_surface)
                continue;
            builder.Add(volume_part, solids(i));
            any_volume = true;
        }
        result = any_volume ? mesh_solids(shape, volume_part, options) : empty_volume_mesh();
        if (result["overlaps"].isUndefined()) {
            const val mid = mesh_mid_surfaces(shape, cad, options);
            if (!mid["overlaps"].isUndefined())
                return mid;
            result.set("midSurface", mid);
        }
    }
    if (!result["overlaps"].isUndefined())
        return result;
    if (!shell_bodies.empty()) {
        val routes = val::array();
        for (const ShellBodyAnalysis& analysis : analyses)
            routes.call<void>("push", shell_route(analysis));
        result.set("shellRoutes", routes);
    }
    return result;
#else
#error "KoFEM requires Netgen built with -DUSE_OCC=ON (KOFEM_NETGEN_OCC is not defined). " \
       "Rebuild the kofem-dependencies Docker image or pass -DUSE_NETGEN_OCC=ON to CMake."
#endif
}

} // namespace
