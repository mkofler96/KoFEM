// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// See face_properties.h.

#include "face_properties.h"

#include "geometry_cache.h"
#include "wasm_util.h"

#include <BRepAdaptor_Surface.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <GProp_GProps.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <gp.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <array>
#include <stdexcept>
#include <string>
#include <vector>

using emscripten::val;

namespace {

struct FaceProperties {
    FaceSurfaceType type = FaceSurfaceType::Other;
    double area = 0.0;
    std::array<double, 3> direction{0.0, 0.0, 0.0};
    double radius = 0.0;
};

std::array<double, 3> components(const gp_Dir& d) {
    return {d.X(), d.Y(), d.Z()};
}

// The plane's normal pointing out of the material: the surface's own normal
// (∂S/∂u × ∂S/∂v, which an indirect placement points against the placement's
// main direction) turned round where the face is reversed in its shape.
gp_Dir outward_plane_normal(const TopoDS_Face& face, const BRepAdaptor_Surface& surface,
                            int face_id) {
    double u0 = 0.0;
    double u1 = 0.0;
    double v0 = 0.0;
    double v1 = 0.0;
    BRepTools::UVBounds(face, u0, u1, v0, v1);
    gp_Pnt point;
    gp_Vec du;
    gp_Vec dv;
    surface.D1(0.5 * (u0 + u1), 0.5 * (v0 + v1), point, du, dv);
    gp_Vec normal = du.Crossed(dv);
    if (normal.Magnitude() < gp::Resolution())
        throw std::runtime_error("cad_face_properties: plane face " + std::to_string(face_id) +
                                 " has a degenerate parametrisation, so no normal");
    if (face.Orientation() == TopAbs_REVERSED)
        normal.Reverse();
    return {normal};
}

FaceProperties describe(const TopoDS_Face& face, int face_id) {
    FaceProperties props;
    GProp_GProps surface_props;
    BRepGProp::SurfaceProperties(face, surface_props);
    props.area = surface_props.Mass();

    // The adaptor applies the face's location, so directions are in model space.
    const BRepAdaptor_Surface surface(face);
    switch (surface.GetType()) {
        case GeomAbs_Plane:
            props.type = FaceSurfaceType::Plane;
            props.direction = components(outward_plane_normal(face, surface, face_id));
            break;
        case GeomAbs_Cylinder:
            props.type = FaceSurfaceType::Cylinder;
            props.direction = components(surface.Cylinder().Axis().Direction());
            props.radius = surface.Cylinder().Radius();
            break;
        case GeomAbs_Cone:
            props.type = FaceSurfaceType::Cone;
            props.direction = components(surface.Cone().Axis().Direction());
            break;
        default:
            props.type = FaceSurfaceType::Other;
            break;
    }
    return props;
}

}  // namespace

val cad_face_properties() {
    // The face map numbers faces exactly as tessellate_step numbers its
    // triangleFaceIds. A face two solids share (an imprinted interface) is
    // kept with the orientation of the first solid holding it, so its normal
    // points out of that solid.
    TopTools_IndexedMapOfShape faces;
    TopExp::MapShapes(cached_shape(), TopAbs_FACE, faces);

    const auto n = static_cast<std::size_t>(faces.Extent());
    std::vector<uint8_t> types;
    std::vector<double> areas;
    std::vector<double> directions;
    std::vector<double> radii;
    types.reserve(n);
    areas.reserve(n);
    directions.reserve(3 * n);
    radii.reserve(n);
    for (int id = 1; id <= faces.Extent(); ++id) {
        const FaceProperties props = describe(TopoDS::Face(faces(id)), id);
        types.push_back(static_cast<uint8_t>(props.type));
        areas.push_back(props.area);
        directions.insert(directions.end(), props.direction.begin(), props.direction.end());
        radii.push_back(props.radius);
    }

    val result = val::object();
    result.set("surfaceTypes", uint8_array(types));
    result.set("areas",        float64_array(areas));
    result.set("directions",   float64_array(directions));
    result.set("radii",        float64_array(radii));
    return result;
}
