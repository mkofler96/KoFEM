#include "netgen_bridge.h"
#include <cstdint>
#include <cstring>
#include <vector>

// Ubuntu 24.04's libnglib.so was compiled with all types and functions inside
// namespace nglib, but nglib.h declares them in the global namespace.
// We redeclare everything we need inside the correct namespace to match the ABI.
namespace nglib {
    typedef void* Ng_Mesh;

    enum Ng_Result {
        NG_ERROR               = -1,
        NG_OK                  = 0,
        NG_SURFACE_INPUT_ERROR = 1,
        NG_VOLUME_FAILURE      = 2,
        NG_STL_INPUT_ERROR     = 3,
        NG_SURFACE_FAILURE     = 4,
        NG_FILE_NOT_FOUND      = 5
    };

    enum Ng_Surface_Element_Type {
        NG_TRIG  = 1,
        NG_QUAD  = 2,
        NG_TRIG6 = 16,
        NG_QUAD8 = 17
    };

    // Replicate exact field layout from nglib.h so field offsets match.
    class Ng_Meshing_Parameters {
    public:
        int    uselocalh;
        double maxh;
        double minh;
        double fineness;
        double grading;
        double elementsperedge;
        double elementspercurve;
        int    closeedgeenable;
        double closeedgefact;
        int    minedgelenenable;
        double minedgelen;
        int    second_order;
        int    quad_dominated;
        char*  meshsize_filename;
        int    optsurfmeshenable;
        int    optvolmeshenable;
        int    optsteps_3d;
        int    optsteps_2d;
        int    invert_tets;
        int    invert_trigs;
        int    check_overlap;
        int    check_overlapping_boundary;

        Ng_Meshing_Parameters();  // implemented in libnglib.so
    };

    extern Ng_Mesh*   Ng_NewMesh();
    extern void       Ng_DeleteMesh(Ng_Mesh* mesh);
    extern void       Ng_AddPoint(Ng_Mesh* mesh, double* x);
    extern void       Ng_AddSurfaceElement(Ng_Mesh* mesh, Ng_Surface_Element_Type et, int* pi);
    extern Ng_Result  Ng_GenerateVolumeMesh(Ng_Mesh* mesh, Ng_Meshing_Parameters* mp);
    extern void       Ng_GetPoint(Ng_Mesh* mesh, int num, double* x);
    extern void       Ng_GetVolumeElement(Ng_Mesh* mesh, int num, int* pi);
    extern int        Ng_GetNP(Ng_Mesh* mesh);
    extern int        Ng_GetNE(Ng_Mesh* mesh);
}

struct NgMesh {
    nglib::Ng_Mesh*  handle = nullptr;
    std::vector<double>  vol_vertices;
    std::vector<int32_t> vol_tets;
};

extern "C" {

NgMeshHandle ng_mesh_create(
    const double*  vertices,   size_t n_vertices,
    const int32_t* triangles,  size_t n_triangles)
{
    auto* m = new NgMesh();
    m->handle = nglib::Ng_NewMesh();

    for (size_t i = 0; i < n_vertices; ++i) {
        double pt[3] = {vertices[3*i], vertices[3*i+1], vertices[3*i+2]};
        nglib::Ng_AddPoint(m->handle, pt);
    }

    for (size_t i = 0; i < n_triangles; ++i) {
        int tri[3] = {
            (int)triangles[3*i]   + 1,
            (int)triangles[3*i+1] + 1,
            (int)triangles[3*i+2] + 1,
        };
        nglib::Ng_AddSurfaceElement(m->handle, nglib::NG_TRIG, tri);
    }

    return static_cast<NgMeshHandle>(m);
}

int ng_mesh_generate_volume(NgMeshHandle handle, const NgMeshOptions* opts)
{
    auto* m = static_cast<NgMesh*>(handle);

    nglib::Ng_Meshing_Parameters mp;
    mp.maxh         = opts->max_element_size;
    mp.minh         = opts->min_element_size;
    mp.grading      = opts->grading;
    mp.second_order = opts->second_order;

    nglib::Ng_Result res = nglib::Ng_GenerateVolumeMesh(m->handle, &mp);
    if (res != nglib::NG_OK)
        return static_cast<int>(res);

    int np = nglib::Ng_GetNP(m->handle);
    m->vol_vertices.resize(3 * static_cast<size_t>(np));
    for (int i = 1; i <= np; ++i) {
        double pt[3];
        nglib::Ng_GetPoint(m->handle, i, pt);
        m->vol_vertices[3*(i-1)+0] = pt[0];
        m->vol_vertices[3*(i-1)+1] = pt[1];
        m->vol_vertices[3*(i-1)+2] = pt[2];
    }

    int ne = nglib::Ng_GetNE(m->handle);
    m->vol_tets.resize(4 * static_cast<size_t>(ne));
    for (int i = 1; i <= ne; ++i) {
        int tet[4];
        nglib::Ng_GetVolumeElement(m->handle, i, tet);
        m->vol_tets[4*(i-1)+0] = tet[0] - 1;
        m->vol_tets[4*(i-1)+1] = tet[1] - 1;
        m->vol_tets[4*(i-1)+2] = tet[2] - 1;
        m->vol_tets[4*(i-1)+3] = tet[3] - 1;
    }

    return 0;
}

size_t ng_mesh_n_vertices(NgMeshHandle handle)
{
    return static_cast<NgMesh*>(handle)->vol_vertices.size() / 3;
}

size_t ng_mesh_n_tets(NgMeshHandle handle)
{
    return static_cast<NgMesh*>(handle)->vol_tets.size() / 4;
}

void ng_mesh_get_vertices(NgMeshHandle handle, double* out)
{
    auto* m = static_cast<NgMesh*>(handle);
    std::memcpy(out, m->vol_vertices.data(), m->vol_vertices.size() * sizeof(double));
}

void ng_mesh_get_tets(NgMeshHandle handle, int32_t* out)
{
    auto* m = static_cast<NgMesh*>(handle);
    std::memcpy(out, m->vol_tets.data(), m->vol_tets.size() * sizeof(int32_t));
}

void ng_mesh_free(NgMeshHandle handle)
{
    auto* m = static_cast<NgMesh*>(handle);
    if (m) {
        nglib::Ng_DeleteMesh(m->handle);
        delete m;
    }
}

} // extern "C"
