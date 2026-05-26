#include "occt_bridge.h"

// OCCT headers
#include <BRep_Tool.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <Poly_Triangulation.hxx>
#include <STEPControl_Reader.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>

#include <cstring>
#include <vector>

extern "C" {

OcctShape occt_load_step(const uint8_t* data, size_t len, const char** err)
{
    *err = nullptr;

    // Write to a temp file so STEPControl_Reader can open it.
    // OCCT 7.6+ exposes ReadStream; we use the tmpfile approach for compatibility.
    STEPControl_Reader reader;

    // ReadBuf is available in OCCT ≥ 7.7; for older versions write to tmpfile.
    // We use ReadBuf when available via the Standard_ReadBuffer override.
    std::string buf(reinterpret_cast<const char*>(data), len);
    Standard_IStream sstream(buf.c_str(), buf.size());

    IFSelect_ReturnStatus status = reader.ReadStream("mem", sstream);
    if (status != IFSelect_RetDone) {
        *err = "STEPControl_Reader::ReadStream failed";
        return nullptr;
    }

    reader.TransferRoots();
    if (reader.NbShapes() == 0) {
        *err = "STEP file contains no transferable shapes";
        return nullptr;
    }

    auto* shape = new TopoDS_Shape(reader.OneShape());
    return static_cast<OcctShape>(shape);
}

void occt_free_shape(OcctShape shape)
{
    delete static_cast<TopoDS_Shape*>(shape);
}

int occt_tessellate(
    OcctShape         raw_shape,
    const OcctTessOptions* opts,
    double**  out_vertices,   size_t* out_n_vertices,
    int32_t** out_triangles,  size_t* out_n_triangles,
    const char** err)
{
    *err = nullptr;
    *out_vertices  = nullptr; *out_n_vertices  = 0;
    *out_triangles = nullptr; *out_n_triangles = 0;

    auto* shape = static_cast<TopoDS_Shape*>(raw_shape);

    BRepMesh_IncrementalMesh mesher(
        *shape,
        opts->linear_deflection,
        static_cast<bool>(opts->relative_deflection),
        opts->angular_deflection);
    mesher.Perform();

    if (!mesher.IsDone()) {
        *err = "BRepMesh_IncrementalMesh failed";
        return -1;
    }

    // Collect all triangle data from all faces into a single flat mesh.
    // Vertices are deduplicated per-face only; the caller (Rust) can run a
    // global dedup pass if needed.
    std::vector<double>  verts;
    std::vector<int32_t> tris;

    for (TopExp_Explorer exp(*shape, TopAbs_FACE); exp.More(); exp.Next()) {
        TopoDS_Face face = TopoDS::Face(exp.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;

        int32_t base = static_cast<int32_t>(verts.size() / 3);

        // Nodes
        for (int i = 1; i <= tri->NbNodes(); ++i) {
            gp_Pnt pt = tri->Node(i).Transformed(loc);
            verts.push_back(pt.X());
            verts.push_back(pt.Y());
            verts.push_back(pt.Z());
        }

        // Triangles (OCCT 1-based → 0-based, respect face orientation)
        const bool reversed = (face.Orientation() == TopAbs_REVERSED);
        for (int i = 1; i <= tri->NbTriangles(); ++i) {
            int n1, n2, n3;
            tri->Triangle(i).Get(n1, n2, n3);
            if (reversed) std::swap(n2, n3);
            tris.push_back(base + n1 - 1);
            tris.push_back(base + n2 - 1);
            tris.push_back(base + n3 - 1);
        }
    }

    if (verts.empty()) {
        *err = "shape produced no triangles — check linear_deflection";
        return -2;
    }

    // Allocate output buffers owned by the caller
    size_t nv = verts.size() / 3;
    size_t nt = tris.size()  / 3;

    auto* ov = new double [verts.size()];
    auto* ot = new int32_t[tris.size()];
    std::memcpy(ov, verts.data(), verts.size() * sizeof(double));
    std::memcpy(ot, tris.data(),  tris.size()  * sizeof(int32_t));

    *out_vertices   = ov;  *out_n_vertices   = nv;
    *out_triangles  = ot;  *out_n_triangles  = nt;
    return 0;
}

void occt_free_tessellation(double* vertices, int32_t* triangles)
{
    delete[] vertices;
    delete[] triangles;
}

} // extern "C"
