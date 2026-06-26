// Netgen internal-API glue — see netgen_glue.h.
//
// Netgen install layouts differ between builds:
//   flat:    <prefix>/include/occgeom.hpp
//   nested:  <prefix>/include/netgen/include/occgeom.hpp (umbrella header)
//   subdirs: <prefix>/include/occ/occgeom.hpp
// CMakeLists.txt adds every existing variant to the include path; the probe
// below picks whichever resolves. occgeom.hpp pulls in meshing.hpp
// (netgen::Mesh, netgen::Element2d) transitively.
#if __has_include(<occgeom.hpp>)
#include <occgeom.hpp>
#elif __has_include(<occ/occgeom.hpp>)
#include <occ/occgeom.hpp>
#else
#error "Netgen occgeom.hpp not found — Netgen must be built with -DUSE_OCC=ON and its headers installed"
#endif

#include "netgen_glue.h"

void* kofem_occ_geometry_from_shape(const TopoDS_Shape& shape) {
    // Same constructor Ng_OCC_Load_STEP ends up in (BuildFMap + bounding box),
    // minus the second STEP read/translate.
    return new netgen::OCCGeometry(shape);
}

void kofem_occ_geometry_delete(void* geom) {
    delete static_cast<netgen::OCCGeometry*>(geom);
}

int kofem_surface_element_face_index(void* mesh, int i) {
    // Element2d::GetIndex() is the 1-based FaceDescriptor number, which for
    // OCC-meshed geometry equals the position of the owning face in Netgen's
    // face map (TopExp order over the shape).
    return static_cast<netgen::Mesh*>(mesh)->SurfaceElement(i).GetIndex();
}

void kofem_delete_mesh(void* mesh) {
    // Ng_Mesh* is a netgen::Mesh* internally. ~Mesh() frees every owned
    // resource (including the bcnames/materials/cd2names string*); we skip
    // nglib::Ng_DeleteMesh because it additionally calls Mesh::DeleteMesh()
    // first, double-freeing those strings. See netgen_glue.h.
    delete static_cast<netgen::Mesh*>(mesh);
}
