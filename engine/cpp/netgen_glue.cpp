// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

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

#include <BRep_Tool.hxx>
#include <GProp_GProps.hxx>
#include <Geom_Curve.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

// Netgen does not install occ_edge.hpp. These are the data members of its
// netgen::OCCEdge (libsrc/occ/occ_edge.hpp, pinned at v6.2.2401), which
// OCCGeometry stores behind every GeometryEdge. Never constructed here.
namespace netgen {
class OCCEdge : public GeometryEdge {
public:
    TopoDS_Edge edge;
    Handle(Geom_Curve) curve;
    double s0, s1;
    GProp_GProps props;
};
}  // namespace netgen

void* kofem_occ_geometry_from_shape(const TopoDS_Shape& shape) {
    // Same constructor Ng_OCC_Load_STEP ends up in (BuildFMap + bounding box),
    // minus the second STEP read/translate.
    auto* geometry = new netgen::OCCGeometry(shape);
    // A degenerated edge (the collapsed side of a B-spline face) has no 3D
    // curve, but OCCT can compute a small non-zero length for it from the
    // surface. Netgen's FindEdges then takes it for a real edge and divides it
    // through the null curve, which traps. Zero the length so it takes its
    // existing "collapsed edge" skip.
    for (int i = 1; i <= geometry->emap.Extent(); ++i) {
        const TopoDS_Edge& edge = TopoDS::Edge(geometry->emap(i));
        if (BRep_Tool::Degenerated(edge))
            static_cast<netgen::OCCEdge&>(geometry->GetEdge(edge)).props = GProp_GProps();
    }
    return geometry;
}

void kofem_set_solid_max_sizes(const TopoDS_Shape& shape, const std::vector<double>& max_sizes) {
    TopTools_IndexedMapOfShape solids;
    TopTools_IndexedMapOfShape faces;
    TopTools_IndexedMapOfShape edges;
    TopExp::MapShapes(shape, TopAbs_SOLID, solids);
    TopExp::MapShapes(shape, TopAbs_FACE, faces);
    TopExp::MapShapes(shape, TopAbs_EDGE, edges);
    if (static_cast<int>(max_sizes.size()) != solids.Extent())
        throw std::runtime_error("kofem_set_solid_max_sizes: " + std::to_string(max_sizes.size()) +
                                 " sizes for " + std::to_string(solids.Extent()) + " solids");

    // Netgen's "no limit" (ShapeProperties::maxh's default).
    constexpr double NO_LIMIT = 1e99;
    std::vector<double> face_h(static_cast<size_t>(faces.Extent()), NO_LIMIT);
    std::vector<double> edge_h(static_cast<size_t>(edges.Extent()), NO_LIMIT);
    for (int i = 1; i <= solids.Extent(); ++i) {
        const double h = max_sizes[static_cast<size_t>(i - 1)];
        if (!std::isfinite(h) || h <= 0.0)
            throw std::runtime_error("kofem_set_solid_max_sizes: solid " + std::to_string(i) +
                                     " has max size " + std::to_string(h) +
                                     " — it must be a positive number");
        netgen::OCCGeometry::GetProperties(solids(i)).maxh = h;
        // A face or edge between two regions takes the finer of their sizes, so
        // the finer region is fine right up to the cut.
        for (TopExp_Explorer f(solids(i), TopAbs_FACE); f.More(); f.Next()) {
            double& fh = face_h[static_cast<size_t>(faces.FindIndex(f.Current()) - 1)];
            fh = std::min(fh, h);
        }
        for (TopExp_Explorer e(solids(i), TopAbs_EDGE); e.More(); e.Next()) {
            double& eh = edge_h[static_cast<size_t>(edges.FindIndex(e.Current()) - 1)];
            eh = std::min(eh, h);
        }
    }
    // Every face and edge is assigned, not just those of sized solids: Netgen's
    // table is static and keyed by shape, so a size left from an earlier mesh of
    // the same shape would otherwise still apply.
    for (int k = 1; k <= faces.Extent(); ++k)
        netgen::OCCGeometry::GetProperties(faces(k)).maxh = face_h[static_cast<size_t>(k - 1)];
    for (int k = 1; k <= edges.Extent(); ++k)
        netgen::OCCGeometry::GetProperties(edges(k)).maxh = edge_h[static_cast<size_t>(k - 1)];
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

int kofem_volume_element_domain_index(void* mesh, int i) {
    // Element::GetIndex() is the 1-based subdomain number the volume filler
    // assigned; for OCC geometry the subdomains are the solids of the shape.
    return static_cast<netgen::Mesh*>(mesh)->VolumeElement(i).GetIndex();
}

std::vector<KofemSurfaceTriangle> kofem_overlapping_surface_elements(void* mesh) {
    auto* m = static_cast<netgen::Mesh*>(mesh);
    std::vector<KofemSurfaceTriangle> out;
    // The check Netgen ran stopped the volume fill per domain and its flags died
    // with the per-domain copies, so run it again on the whole surface mesh.
    (void)m->CheckOverlappingBoundary();
    for (int i = 1; i <= m->GetNSE(); ++i) {
        const netgen::Element2d& element = m->SurfaceElement(i);
        if (!element.BadElement())
            continue;
        KofemSurfaceTriangle triangle{};
        triangle.face = element.GetIndex();
        for (int k = 0; k < 3; ++k) {
            const netgen::MeshPoint& point = m->Point(element[k]);
            triangle.points.at(k) = {point(0), point(1), point(2)};
        }
        out.push_back(triangle);
    }
    return out;
}

std::vector<int> kofem_unmeshed_faces(void* geom) {
    const auto* geometry = static_cast<const netgen::OCCGeometry*>(geom);
    // OCCGeometry::MeshFace sets the status to -1 when both its parameter-space
    // and plane-space attempts fail, and to 1 when one succeeds.
    if (geometry->facemeshstatus.Size() != geometry->fmap.Extent())
        throw std::runtime_error("kofem_unmeshed_faces: Netgen holds a mesh status for " +
                                 std::to_string(geometry->facemeshstatus.Size()) +
                                 " faces, but the geometry has " +
                                 std::to_string(geometry->fmap.Extent()));
    std::vector<int> failed;
    for (int i = 0; i < geometry->fmap.Extent(); ++i)
        if (geometry->facemeshstatus[i] == -1)
            failed.push_back(i + 1);
    return failed;
}

void kofem_delete_mesh(void* mesh) {
    // Ng_Mesh* is a netgen::Mesh* internally. ~Mesh() frees every owned
    // resource (including the bcnames/materials/cd2names string*); we skip
    // nglib::Ng_DeleteMesh because it additionally calls Mesh::DeleteMesh()
    // first, double-freeing those strings. See netgen_glue.h.
    delete static_cast<netgen::Mesh*>(mesh);
}
