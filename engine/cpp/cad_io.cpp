// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// OCCT: STEP / IGES → TopoDS_Shape, plus surface-only-geometry repair. See cad_io.h.

#include "cad_io.h"

#include <BOPAlgo_MakeConnected.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <Bnd_Box.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <IGESControl_Reader.hxx>
#include <ShapeFix_Shape.hxx>
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

#include <array>
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

// Diagnose and repair the imported shape (see cad_io.h). CAD exports routinely
// carry defects — sliver faces, near-degenerate edges, self-intersecting wires
// at trim boundaries — that survive import as valid-looking topology. Netgen
// then generates near-zero-area surface elements on them, which its overlap
// detection reads as intersecting geometry (issue #214). Repairing the shape
// here, once at import, fixes that at the source for both display tessellation
// and meshing.
TopoDS_Shape heal_shape(const TopoDS_Shape& shape) {
    BRepCheck_Analyzer analyzer(shape);
    if (analyzer.IsValid())
        return shape;

    (void)printf("[occt] heal_shape: imported geometry has invalid subshapes — "
                 "running ShapeFix_Shape\n");
    (void)fflush(stdout);

    Handle(ShapeFix_Shape) fixer = new ShapeFix_Shape(shape);
    // Bound how far healing may move geometry to the same model-size-relative
    // scale used for sewing: unbounded, ShapeFix can merge features that are
    // legitimately close together.
    const double diag = shape_bbox_diagonal(shape);
    if (diag > 0.0)
        fixer->SetMaxTolerance(diag * 1e-4);
    fixer->Perform();

    TopoDS_Shape healed = fixer->Shape();
    if (healed.IsNull()) {
        (void)printf("[occt] heal_shape: ShapeFix_Shape returned no shape — "
                     "keeping the original geometry\n");
        (void)fflush(stdout);
        return shape;
    }

    // A residual defect is not fatal here: meshing may still succeed, and if it
    // does not, the mesher fails with its own explicit error. Report the
    // outcome either way so the log tells the whole story.
    const bool valid_now = BRepCheck_Analyzer(healed).IsValid();
    (void)printf("[occt] heal_shape: %s\n",
                 valid_now ? "geometry repaired — all subshapes valid"
                           : "geometry partially repaired — some defects remain; "
                             "meshing will fail loudly if they matter");
    (void)fflush(stdout);
    return healed;
}

int count_solids(const TopoDS_Shape& shape) {
    return count_subshapes(shape, TopAbs_SOLID);
}

// Imprint the touching faces of a multibody assembly (see cad_io.h). After
// BOPAlgo_MakeConnected, a face where two solids touch exists once and is
// referenced by both solids, so Netgen's OCC mesher generates one triangulation
// for it and the volume meshes of both bodies share those nodes — the bonded
// (tie) interface of issue #353 falls out of mesh topology with no solver
// coupling. Faces that only partially overlap are split first, so the shared
// part is still a single common face.
TopoDS_Shape imprint_touching_solids(const TopoDS_Shape& shape) {
    const int nsolids = count_subshapes(shape, TopAbs_SOLID);
    if (nsolids < 2)
        return shape;

    BOPAlgo_MakeConnected connector;
    for (TopExp_Explorer e(shape, TopAbs_SOLID); e.More(); e.Next())
        connector.AddArgument(e.Current());
    connector.SetRunParallel(false);  // single-threaded WASM build
    // Fuzzy tolerance absorbs sub-modeling-tolerance sloppiness between mating
    // faces of separately modeled bodies. Deliberately much tighter than the
    // sewing/healing tolerance (diag·1e-4): a large fuzzy value in a Boolean
    // operation merges legitimately distinct geometry (thin walls, small
    // clearances) instead of just coincident faces.
    const double diag = shape_bbox_diagonal(shape);
    if (diag > 0.0)
        connector.SetFuzzyValue(diag * 1e-6);
    connector.Perform();
    if (connector.HasErrors())
        throw std::runtime_error(
            "BOPAlgo_MakeConnected failed to imprint the assembly's touching "
            "faces — the bodies cannot be bonded for meshing. Check the CAD "
            "model for overlapping (interpenetrating) solids and re-export.");

    const TopoDS_Shape& connected = connector.Shape();
    if (connected.IsNull() || count_subshapes(connected, TopAbs_SOLID) == 0)
        throw std::runtime_error(
            "BOPAlgo_MakeConnected produced no solids from a multibody assembly "
            "— the imported geometry is inconsistent");

    // Interface census: a face is an interface when two solids reference it.
    // Bodies with no interface float freely unless individually constrained —
    // their solve would be singular — so name them in the log now, where the
    // cause is still obvious.
    TopTools_IndexedDataMapOfShapeListOfShape face_solids;
    TopExp::MapShapesAndAncestors(connected, TopAbs_FACE, TopAbs_SOLID, face_solids);
    int n_interfaces = 0;
    for (int i = 1; i <= face_solids.Extent(); ++i)
        if (face_solids.FindFromIndex(i).Extent() >= 2)
            ++n_interfaces;

    int body_idx = 0;
    for (TopExp_Explorer e(connected, TopAbs_SOLID); e.More(); e.Next()) {
        ++body_idx;
        bool touches_another = false;
        for (TopExp_Explorer f(e.Current(), TopAbs_FACE);
             f.More() && !touches_another; f.Next())
            touches_another = face_solids.FindFromKey(f.Current()).Extent() >= 2;
        if (!touches_another) {
            (void)printf("[occt] imprint: WARNING body %d touches no other body — "
                         "it is unconnected and will float unless it is "
                         "individually constrained\n", body_idx);
            (void)fflush(stdout);
        }
    }

    (void)printf("[occt] imprint: %d bodies made connected — %d shared "
                 "interface face(s) (fuzzy tol=%.4g mm)\n",
                 nsolids, n_interfaces, diag > 0.0 ? diag * 1e-6 : 0.0);
    (void)fflush(stdout);
    return connected;
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
    std::array<char, 32> tmppath;
    std::strcpy(tmppath.data(), is_iges ? "/tmp/kofem_XXXXXX.igs" : "/tmp/kofem_XXXXXX.stp");
    int fd = mkstemps(tmppath.data(), 4);
    if (fd < 0)
        throw std::runtime_error("failed to create /tmp CAD file");
    if (write(fd, bytes.data(), bytes.size()) != (ssize_t)bytes.size()) {
        close(fd); unlink(tmppath.data());
        throw std::runtime_error("failed to write CAD bytes to /tmp");
    }
    close(fd);

    if (is_iges) {
        IGESControl_Reader reader;
        IFSelect_ReturnStatus status = reader.ReadFile(tmppath.data());
        unlink(tmppath.data());
        if (status != IFSelect_RetDone)
            throw std::runtime_error("IGESControl_Reader::ReadFile failed — invalid IGES file");
        if (reader.TransferRoots() == 0 || reader.NbShapes() == 0)
            throw std::runtime_error(
                "IGES file contains no transferable shapes. IGES often stores only "
                "free surfaces; a closed solid is required for volume meshing.");
        return reader.OneShape();
    }

    STEPControl_Reader reader;
    IFSelect_ReturnStatus status = reader.ReadFile(tmppath.data());
    unlink(tmppath.data());
    if (status != IFSelect_RetDone)
        throw std::runtime_error("STEPControl_Reader::ReadFile failed — invalid STEP file");
    if (reader.TransferRoots() == 0 || reader.NbShapes() == 0)
        throw std::runtime_error("STEP file contains no transferable shapes");
    return reader.OneShape();
}
