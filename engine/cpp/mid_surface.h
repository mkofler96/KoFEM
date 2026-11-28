// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The mid-surface of a body marked Shell, built from its CAD faces (KOF-498,
// stage 1 of KOF-343).
//
// A body takes this path when its faces form walls: opposite sheets (parallel
// planes, or coaxial cylinders) of constant thickness whose projections cover
// each other, and every other face is a side face spanning the thickness. Each
// sheet is offset half the thickness into the material, and a General Fuse of
// the two offset sheets yields the mid faces: each lies on both offsets, so it
// has exactly one top and one bottom source face. A body that does not form
// walls keeps the mesh-based path, and its route names the face and the reason.
//
// The top side of a wall is fixed by its geometry, never by a mesh: for planes,
// the sheet whose outward normal points to +z (then +y, then +x); for
// cylinders, the outer (convex) sheet.
#pragma once

#include <emscripten/val.h>

#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

// The thickest wall that counts as thin: max(max_wall, body_share × the body's
// bounding-box diagonal) × (1 + slack) — the rule of crates/kofem-shellize
// (ExtractOptions::max_wall, SHELL_BODY_WALL_SHARE, MAX_WALL_SLACK), passed in
// by the app.
struct ThinWallRule {
    double max_wall;
    double body_share;
    double slack;
};

enum class WallKind { Planar, Cylindrical };

struct Wall {
    WallKind kind;
    double thickness;
    // The area of the top and of the bottom sheet per unit area of the
    // mid-surface: 1 for a flat wall; r_face / r_mid for a cylindrical one,
    // whose faces lie farther from or nearer to the axis than the mid-surface.
    // A load on a face carries its own area onto the facets (KOF-498).
    double top_area_ratio;
    double bottom_area_ratio;
    // 1-based face ids of the whole shape, ascending.
    std::vector<int> top;
    std::vector<int> bottom;
    std::vector<int> sides;
};

// Why a body keeps the mesh-based path: the first face that does not fit, and
// a reason code the app turns into text.
struct Unpaired {
    int face;
    std::string reason;
};

struct MidFace {
    TopoDS_Face face;      // a face of ShellBodyAnalysis::mid_shape
    std::size_t wall;      // index into ShellBodyAnalysis::walls
    int top;               // source face ids
    int bottom;
    TopoDS_Face top_face;  // the top source face, oriented as in the solid
};

struct ShellBodyAnalysis {
    int body;  // 1-based solid index
    // The CAD path when `unpaired` is empty.
    std::vector<Wall> walls;
    std::optional<Unpaired> unpaired;
    TopoDS_Compound mid_shape;
    std::vector<MidFace> mid_faces;
    // Lengths below this are zero for this body (mm).
    double tolerance = 0.0;
    // For finding the side face a rim point came from.
    TopTools_IndexedMapOfShape shape_faces;
    TopTools_IndexedDataMapOfShapeListOfShape edge_faces;
};

ThinWallRule thin_wall_rule(const emscripten::val& opts);

// opts.shell_bodies: absent or null for none; otherwise every entry must name
// a solid of `shape`.
std::vector<int> shell_body_ids(const emscripten::val& opts, const TopoDS_Shape& shape);

ShellBodyAnalysis analyse_shell_body(const TopoDS_Shape& shape, int body,
                                     const ThinWallRule& rule);

// The side face (1-based id) a rim edge of mid face `mid_face` came from,
// given two points ON the edge — the end nodes of a mesh edge, never the
// midpoint of its chord, which misses a curved rim by the chord's height.
// Each point is moved onto the top face's surface, where it lies on boundary
// edges of that face; the side face is the one both points share. 0 when they
// share none, for example on an edge between two mid faces.
int rim_side_face(const ShellBodyAnalysis& analysis, std::size_t mid_face, const gp_Pnt& start,
                  const gp_Pnt& end);

// The outward normal of mid face `mid_face`'s top source face at the point of
// that face nearest `point`: the direction a shell facet there must face.
gp_Dir top_side_normal(const ShellBodyAnalysis& analysis, std::size_t mid_face,
                       const gp_Pnt& point);

// { body, path: "cad", walls: [{ kind, thickness, top, bottom, sides }] }
// or { body, path: "mesh", face, reason }.
emscripten::val shell_route(const ShellBodyAnalysis& analysis);

// The routes of opts.shell_bodies on the cached shape, without meshing.
emscripten::val plan_shell_bodies(const std::string& opts_json);
