// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// OCCT: STEP / IGES → TopoDS_Shape, plus surface-only-geometry repair. See cad_io.h.

#include "cad_io.h"

#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <Bnd_Box.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <IGESControl_Reader.hxx>
#include <ShapeFix_Solid.hxx>
#include <STEPControl_Reader.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>

#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <unistd.h>

// Longest diagonal of the shape's axis-aligned bounding box (mm), or 0 if empty.
// Used to scale the tessellation chord tolerance with model size.
double shape_bbox_diagonal(const TopoDS_Shape& shape) {
    Bnd_Box box;
    BRepBndLib::Add(shape, box);
    if (box.IsVoid())
        return 0.0;
    return std::sqrt(box.SquareExtent());
}

static int count_subshapes(const TopoDS_Shape& shape, TopAbs_ShapeEnum type) {
    int n = 0;
    for (TopExp_Explorer e(shape, type); e.More(); e.Next())
        ++n;
    return n;
}

// A shell bounds a volume only if it is watertight: every non-degenerate edge
// must be shared by at least two faces (no free boundary). Netgen fills the
// region enclosed by such a shell; an open shell leaves the volume undefined.
static bool shell_is_closed(const TopoDS_Shell& shell) {
    TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
    TopExp::MapShapesAndAncestors(shell, TopAbs_EDGE, TopAbs_FACE, edge_faces);
    for (int i = 1; i <= edge_faces.Extent(); ++i) {
        const TopoDS_Edge& edge = TopoDS::Edge(edge_faces.FindKey(i));
        if (BRep_Tool::Degenerated(edge))
            continue;
        if (edge_faces.FindFromIndex(i).Extent() < 2)
            return false;  // free edge → open shell
    }
    return true;
}

// IGES (and occasionally STEP) files frequently store only free trimmed
// surfaces, never a closed solid. Netgen then meshes the boundary fine but has
// no enclosed region to fill, producing a surface mesh with 0 tetrahedra
// (issue #276). Sew the loose faces into shells and promote every watertight
// shell to a solid so the volume mesher has a region to fill.
//
// The original shape is returned unchanged when it already contains a solid (the
// normal STEP case — this is then a no-op) or when no closed shell can be formed
// (the geometry is genuinely not watertight, and the caller surfaces that).
TopoDS_Shape sew_faces_into_solid(const TopoDS_Shape& shape) {
    if (count_subshapes(shape, TopAbs_SOLID) > 0)
        return shape;  // already a solid — nothing to do

    const int nfaces = count_subshapes(shape, TopAbs_FACE);
    if (nfaces == 0)
        return shape;  // no surfaces to sew

    // Sewing tolerance scales with model size: IGES surface patches typically
    // have sub-millimetre gaps at trim boundaries that a fixed absolute
    // tolerance would either miss (too tight) or over-merge (too loose).
    const double diag = shape_bbox_diagonal(shape);
    const double tol  = (diag > 0.0) ? diag * 1e-4 : 1e-3;

    BRepBuilderAPI_Sewing sewing(tol);
    for (TopExp_Explorer e(shape, TopAbs_FACE); e.More(); e.Next())
        sewing.Add(e.Current());
    sewing.Perform();
    TopoDS_Shape sewn = sewing.SewedShape();
    if (sewn.IsNull())
        return shape;

    BRep_Builder builder;
    TopoDS_Compound solids;
    builder.MakeCompound(solids);
    int nsolids = 0;
    for (TopExp_Explorer e(sewn, TopAbs_SHELL); e.More(); e.Next()) {
        const TopoDS_Shell& shell = TopoDS::Shell(e.Current());
        if (!shell_is_closed(shell))
            continue;
        // SolidFromShell orients the shell so the solid has positive volume,
        // which Netgen needs to tell inside from outside.
        TopoDS_Solid solid = ShapeFix_Solid().SolidFromShell(shell);
        if (solid.IsNull())
            continue;
        builder.Add(solids, solid);
        ++nsolids;
    }

    if (nsolids == 0) {
        // Diagnostic output: the printf/fflush return values are intentionally
        // discarded (void cast) — a failed log write must not abort meshing.
        (void)printf("[occt] sew_faces_into_solid: sewed %d surface faces but found no "
                     "watertight shell — geometry is surface-only and not closed; "
                     "volume meshing cannot fill it (tol=%.4g mm)\n", nfaces, tol);
        (void)fflush(stdout);
        return shape;
    }

    (void)printf("[occt] sew_faces_into_solid: built %d solid(s) from %d surface faces "
                 "(sew tol=%.4g mm)\n", nsolids, nfaces, tol);
    (void)fflush(stdout);

    if (nsolids == 1)
        return TopoDS::Solid(TopExp_Explorer(solids, TopAbs_SOLID).Current());
    return solids;
}

// Read a CAD file (STEP or IGES) from raw bytes into an OCCT shape.
//
// OCCT provides a separate data-exchange reader per format, but both produce a
// TopoDS_Shape; everything downstream — tessellation for display and Netgen's
// OCC volume meshing — operates on the shape alone, so only the reader differs.
// `format` is "step" (default) or "iges".
TopoDS_Shape read_cad_shape(const std::vector<uint8_t>& bytes,
                            const std::string& format) {
    const bool is_iges = (format == "iges" || format == "igs");

    // OCCT's ReadFile requires a filesystem path; write to Emscripten's in-memory
    // /tmp.  The extension is cosmetic (both readers detect the format from file
    // contents) but kept accurate for clarity.  Both suffixes are 4 chars, the
    // length mkstemps splices the random component before.
    char tmppath[32];
    std::strcpy(tmppath, is_iges ? "/tmp/kofem_XXXXXX.igs" : "/tmp/kofem_XXXXXX.stp");
    int fd = mkstemps(tmppath, 4);
    if (fd < 0)
        throw std::runtime_error("failed to create /tmp CAD file");
    if (write(fd, bytes.data(), bytes.size()) != (ssize_t)bytes.size()) {
        close(fd); unlink(tmppath);
        throw std::runtime_error("failed to write CAD bytes to /tmp");
    }
    close(fd);

    if (is_iges) {
        IGESControl_Reader reader;
        IFSelect_ReturnStatus status = reader.ReadFile(tmppath);
        unlink(tmppath);
        if (status != IFSelect_RetDone)
            throw std::runtime_error("IGESControl_Reader::ReadFile failed — invalid IGES file");
        if (reader.TransferRoots() == 0 || reader.NbShapes() == 0)
            throw std::runtime_error(
                "IGES file contains no transferable shapes. IGES often stores only "
                "free surfaces; a closed solid is required for volume meshing.");
        return reader.OneShape();
    }

    STEPControl_Reader reader;
    IFSelect_ReturnStatus status = reader.ReadFile(tmppath);
    unlink(tmppath);
    if (status != IFSelect_RetDone)
        throw std::runtime_error("STEPControl_Reader::ReadFile failed — invalid STEP file");
    if (reader.TransferRoots() == 0 || reader.NbShapes() == 0)
        throw std::runtime_error("STEP file contains no transferable shapes");
    return reader.OneShape();
}
