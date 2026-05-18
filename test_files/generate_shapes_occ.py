#!/usr/bin/env python3
"""
Generate all standard STEP test geometry files using OCC (OCP Python bindings).

Replaces the hand-coded generate_shapes.py.  Curved surfaces (cylinder
barrels, cone frustums, full torus) are modelled by the CAD kernel, so the
reference STLs produced by convert_steps_to_stl.py will tessellate them
correctly.

Run from the repo root:
    python3 test_files/generate_shapes_occ.py
"""

import math
import os

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
)
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCone,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakePrism,
    BRepPrimAPI_MakeTorus,
)
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Vec
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopoDS import TopoDS_Iterator, topods

OUT = os.path.dirname(os.path.abspath(__file__))


# ── helpers ────────────────────────────────────────────────────────────────────

def write_step(shape, stem: str) -> None:
    path = os.path.join(OUT, f"{stem}.stp")
    w = STEPControl_Writer()
    w.Transfer(shape, STEPControl_AsIs)
    ok = w.Write(path) == IFSelect_RetDone
    print(f"  {'ok  ' if ok else 'FAIL'} {path}")


def extrude(pts2d: list, depth: float):
    """Extrude a closed CCW 2-D polygon (list of (x, y)) along +Z."""
    poly = BRepBuilderAPI_MakePolygon()
    for x, y in pts2d:
        poly.Add(gp_Pnt(x, y, 0.0))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0.0, 0.0, depth)).Shape()


def sew_solid(*face_vert_lists) -> object:
    """Sew planar polygonal faces into a closed solid."""
    sew = BRepBuilderAPI_Sewing()
    for verts in face_vert_lists:
        poly = BRepBuilderAPI_MakePolygon()
        for v in verts:
            poly.Add(v)
        poly.Close()
        sew.Add(BRepBuilderAPI_MakeFace(poly.Wire(), True).Face())
    sew.Perform()
    sewn = sew.SewedShape()
    # SewedShape may be a Shell directly or a Compound containing one Shell
    try:
        shell = topods.Shell(sewn)
    except Exception:
        it = TopoDS_Iterator(sewn)
        shell = topods.Shell(it.Value())
    return BRepBuilderAPI_MakeSolid(shell).Solid()


# ── shapes ─────────────────────────────────────────────────────────────────────

def gen_box():
    return BRepPrimAPI_MakeBox(80.0, 60.0, 40.0).Shape()


def gen_cylinder():
    # R=25 mm, H=80 mm
    return BRepPrimAPI_MakeCylinder(25.0, 80.0).Shape()


def gen_cone():
    # Truncated cone (frustum): R_bottom=10, R_top=20, H=30 mm
    return BRepPrimAPI_MakeCone(10.0, 20.0, 30.0).Shape()


def gen_torus_ring():
    # Full torus: R_major=30, R_minor=10 mm
    return BRepPrimAPI_MakeTorus(30.0, 10.0).Shape()


def gen_tube():
    # Hollow cylinder: R_outer=20, R_inner=14, H=60 mm
    outer = BRepPrimAPI_MakeCylinder(20.0, 60.0).Shape()
    inner = BRepPrimAPI_MakeCylinder(14.0, 60.0).Shape()
    return BRepAlgoAPI_Cut(outer, inner).Shape()


def gen_elbow():
    # 90° pipe elbow: quarter-torus, R_bend=30, R_pipe=10 mm
    ax2 = gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1), gp_Dir(1, 0, 0))
    return BRepPrimAPI_MakeTorus(ax2, 30.0, 10.0, math.pi / 2).Shape()


def gen_stepped_shaft():
    # Lower: R=15, H=30 mm; upper: R=10, H=40 mm, stacked along Z
    lower = BRepPrimAPI_MakeCylinder(15.0, 30.0).Shape()
    upper = BRepPrimAPI_MakeCylinder(
        gp_Ax2(gp_Pnt(0, 0, 30), gp_Dir(0, 0, 1)), 10.0, 40.0
    ).Shape()
    return BRepAlgoAPI_Fuse(lower, upper).Shape()


def gen_pyramid():
    # Square pyramid: base 40×40 mm, H=30 mm
    b, h = 40.0, 30.0
    c = [gp_Pnt(0, 0, 0), gp_Pnt(b, 0, 0), gp_Pnt(b, b, 0), gp_Pnt(0, b, 0)]
    apex = gp_Pnt(b / 2, b / 2, h)
    return sew_solid(
        [c[3], c[2], c[1], c[0]],  # base, outward normal −Z
        [c[0], c[1], apex],
        [c[1], c[2], apex],
        [c[2], c[3], apex],
        [c[3], c[0], apex],
    )


def gen_wedge():
    # Triangular prism: cross-section (0,0)–(40,0)–(0,30), L=80 mm
    return extrude([(0, 0), (40, 0), (0, 30)], 80.0)


def gen_hex_prism():
    # Regular hexagon, side=20 mm, H=40 mm, flat-side up
    s = 20.0
    pts = [
        (s * math.cos(math.pi / 6 + i * math.pi / 3),
         s * math.sin(math.pi / 6 + i * math.pi / 3))
        for i in range(6)
    ]
    return extrude(pts, 40.0)


def gen_l_bracket():
    # L-bracket: matches existing geometry, D=20 mm
    return extrude([(0,0),(80,0),(80,25),(30,25),(30,80),(0,80)], 20.0)


def gen_i_beam():
    # I-beam: flange 60×10 mm, web 80×8 mm, L=150 mm
    fw, ft, wh, wt = 60.0, 10.0, 80.0, 8.0
    hf, hw = fw / 2, wt / 2
    return extrude([
        (-hf, 0),         (hf, 0),
        (hf, ft),         (hw, ft),
        (hw, ft + wh),    (hf, ft + wh),
        (hf, 2*ft + wh),  (-hf, 2*ft + wh),
        (-hw, ft + wh),   (-hw, ft),
        (-hf, ft),
    ], 150.0)


def gen_t_profile():
    # T-section: flange 60×10 mm, web 30×8 mm, L=100 mm
    fw, ft, wh, wt = 60.0, 10.0, 30.0, 8.0
    return extrude([
        (-fw/2, 0),      (fw/2, 0),
        (fw/2, ft),      (wt/2, ft),
        (wt/2, ft + wh), (-wt/2, ft + wh),
        (-wt/2, ft),     (-fw/2, ft),
    ], 100.0)


def gen_u_channel():
    # U-channel: outer 60×40 mm, wall 8 mm, L=120 mm
    ow, od, t = 60.0, 40.0, 8.0
    return extrude([
        (0, 0),       (ow, 0),
        (ow, od),     (ow - t, od),
        (ow - t, t),  (t, t),
        (t, od),      (0, od),
    ], 120.0)


# ── main ───────────────────────────────────────────────────────────────────────

SHAPES = [
    ("box",           gen_box),
    ("cylinder",      gen_cylinder),
    ("cone",          gen_cone),
    ("torus_ring",    gen_torus_ring),
    ("tube",          gen_tube),
    ("elbow",         gen_elbow),
    ("stepped_shaft", gen_stepped_shaft),
    ("pyramid",       gen_pyramid),
    ("wedge",         gen_wedge),
    ("hex_prism",     gen_hex_prism),
    ("l_bracket",     gen_l_bracket),
    ("i_beam",        gen_i_beam),
    ("t_profile",     gen_t_profile),
    ("u_channel",     gen_u_channel),
]

if __name__ == "__main__":
    print(f"Writing STEP files to {OUT}/")
    for stem, gen in SHAPES:
        try:
            write_step(gen(), stem)
        except Exception as exc:
            print(f"  FAIL {stem}: {exc}")
    print("\nnew_bracket_2.stp and quarter_cylinder.stp left unchanged.")
