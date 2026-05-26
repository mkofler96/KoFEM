#include "netgen_bridge.h"

// Netgen public C API (nglib)
#include <nglib.h>

#include <cassert>
#include <cstring>
#include <vector>

struct NgMesh {
    Ng_Mesh* handle = nullptr;

    // Cached results from the volume solve so we can hand them out without
    // re-querying Netgen (Netgen indices are 1-based).
    std::vector<double>  vol_vertices;
    std::vector<int32_t> vol_tets;
};

extern "C" {

NgMeshHandle ng_mesh_create(
    const double*  vertices,   size_t n_vertices,
    const int32_t* triangles,  size_t n_triangles)
{
    Ng_Init();

    auto* m = new NgMesh();
    m->handle = Ng_NewMesh();

    // Insert surface vertices (Netgen is 1-based, but AddPoint just appends)
    for (size_t i = 0; i < n_vertices; ++i) {
        double pt[3] = {vertices[3*i], vertices[3*i+1], vertices[3*i+2]};
        Ng_AddPoint(m->handle, pt);
    }

    // Insert surface triangles (Netgen expects 1-based indices)
    for (size_t i = 0; i < n_triangles; ++i) {
        int tri[3] = {
            (int)triangles[3*i]   + 1,
            (int)triangles[3*i+1] + 1,
            (int)triangles[3*i+2] + 1,
        };
        Ng_AddSurfaceElement(m->handle, NG_TRIG, tri);
    }

    return static_cast<NgMeshHandle>(m);
}

int ng_mesh_generate_volume(NgMeshHandle handle, const NgMeshOptions* opts)
{
    auto* m = static_cast<NgMesh*>(handle);

    Ng_Meshing_Parameters mp;
    Ng_InitParameters(&mp);
    mp.maxh        = opts->max_element_size;
    mp.minh        = opts->min_element_size;
    mp.grading     = opts->grading;
    mp.secondorder = opts->second_order;

    Ng_Result res = Ng_GenerateVolumeMesh(m->handle, &mp);
    if (res != NG_OK)
        return static_cast<int>(res);

    // Cache vertices
    int np = Ng_GetNP(m->handle);
    m->vol_vertices.resize(3 * static_cast<size_t>(np));
    for (int i = 1; i <= np; ++i) {
        double pt[3];
        Ng_GetPoint(m->handle, i, pt);
        m->vol_vertices[3*(i-1)+0] = pt[0];
        m->vol_vertices[3*(i-1)+1] = pt[1];
        m->vol_vertices[3*(i-1)+2] = pt[2];
    }

    // Cache tets
    int ne = Ng_GetNE(m->handle, NG_VOL);
    m->vol_tets.resize(4 * static_cast<size_t>(ne));
    for (int i = 1; i <= ne; ++i) {
        int tet[4];
        Ng_GetElement(m->handle, NG_VOL, i, tet);
        // Convert to 0-based
        m->vol_tets[4*(i-1)+0] = tet[0] - 1;
        m->vol_tets[4*(i-1)+1] = tet[1] - 1;
        m->vol_tets[4*(i-1)+2] = tet[2] - 1;
        m->vol_tets[4*(i-1)+3] = tet[3] - 1;
    }

    return 0;
}

size_t ng_mesh_n_vertices(NgMeshHandle handle)
{
    auto* m = static_cast<NgMesh*>(handle);
    return m->vol_vertices.size() / 3;
}

size_t ng_mesh_n_tets(NgMeshHandle handle)
{
    auto* m = static_cast<NgMesh*>(handle);
    return m->vol_tets.size() / 4;
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
        Ng_DeleteMesh(m->handle);
        delete m;
    }
    Ng_Exit();
}

} // extern "C"
