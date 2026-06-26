// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// BRepFill::Face and BRepFill::Shell are referenced by Netgen's
// IGESToBRep_TopoSurface (IGES import) but are absent from the installed
// OCCT libraries in the kofem-dependencies Docker image.  KoFEM never
// exercises the IGES code path, so empty stubs satisfy the linker safely.

#include <BRepFill.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Wire.hxx>

TopoDS_Face  BRepFill::Face (const TopoDS_Edge&, const TopoDS_Edge&)  { return {}; }
TopoDS_Shell BRepFill::Shell(const TopoDS_Wire&, const TopoDS_Wire&)  { return {}; }
