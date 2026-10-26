// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  SplitGeometryOptions,
  BooleanGeometryOptions,
  TopOptSettings,
} from "../wasm/pkg/kofem_wasm.js";
import type { TieDefinition } from "../lib/tie.js";
import type { CouplingDefinition } from "../lib/coupling.js";

export interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}
export interface Element {
  id: number;
  type: string;
  nodeIds: number[];
  propertyId: number;
}
export interface Material {
  id: number;
  name: string;
  young: number;
  poisson: number;
  density: number;
}
// Body → material mapping (#317/#353): each body of the assembly is one
// property (property id = 1-based body index from Netgen's mesh domains), and
// the property names the material the body is made of. Properties referenced
// by shell (CTRIA3) elements also carry the shell thickness (PSHELL semantics).
export interface Property {
  id: number;
  materialId: number;
  thickness?: number;
  // Per-body discretisation chosen before meshing: "shell" idealises the body's
  // thin walls as shells, "solid" keeps it as tets. Undefined on legacy models
  // (no per-body choice) — the auto-shell path then auto-detects thin bodies.
  discretization?: "shell" | "solid";
  // On a mesh-time PSHELL: the CAD body whose thin walls it replaces. Lets the
  // viewport map the derived property back to a body that has a tessellation.
  sourceBodyId?: number;
  // A suppressed body is not in the mesh, whatever its element type.
  suppressed?: boolean;
}
export interface Constraint {
  nodeId: number;
  dof: number;
  prescribedValue?: number;
}
export interface Load {
  nodeId: number;
  dof: number;
  value: number;
}
// A work-equivalent surface load applied by the engine's boundary integrator
// over the boundary elements covering `faces` (node-index lists — triangles for
// tets, quads for hexes).
//   force    — total force vector spread as a uniform traction over the face
//   pressure — scalar magnitude applied as -p·n̂ (outward normal; + pushes in)
//   traction — traction vector applied directly
export interface SurfaceLoad {
  type: "force" | "pressure" | "traction";
  faces: number[][];
  force?: [number, number, number];
  pressure?: number;
}
export interface ParseStepPayload {
  bytes: Uint8Array;
  format?: string;
}
export interface SplitGeometryPayload {
  // The current geometry file and its format — reloaded before the split.
  bytes: Uint8Array;
  format: string;
  split: SplitGeometryOptions;
}
export interface BooleanGeometryPayload {
  // The current geometry file and its format — reloaded before the Boolean.
  bytes: Uint8Array;
  format: string;
  boolean: BooleanGeometryOptions;
}
export interface VolumeMeshPayload {
  bytes?: Uint8Array;
  format?: string;
  maxElementSize?: number;
  minElementSize?: number;
  // Bodies marked Shell (Property.discretization === "shell") and the current
  // property table. With these, meshing idealises those bodies' thin walls to a
  // mid-surface shell mesh and stores the MIXED CTRIA3 + CTETRA model, instead of
  // deriving it throwaway inside the solve (#397). Absent/empty ⇒ all-solid mesh.
  shellBodyIds?: number[];
  // Suppressed CAD bodies: meshed with the assembly (Netgen meshes the whole
  // imprinted shape) and then dropped — see dropSuppressedBodies.
  suppressedBodyIds?: number[];
  properties?: Property[];
}
export interface SolvePayload {
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  constraints: Constraint[];
  loads: Load[];
  surfaceLoads?: SurfaceLoad[];
  elementOrder?: number;
  // Tie (connector) conditions: each welds the nodes of two picked surfaces so
  // parts that touch without a shared face are joined (#359). Absent/empty =
  // no ties, and the mesh reaches the solver untouched.
  tieGroups?: TieDefinition[];
  // Surface-to-point couplings (KOF-208): each idealises a picked surface to one
  // reference point, either distributing (RBE3) or kinematic (RBE2). A model
  // carrying any of these solves through the COUPLED assembler, whether or not
  // it has shells. Absent/empty = no couplings, and the routing is unchanged.
  couplings?: CouplingDefinition[];
  // Surface mesh + per-triangle CAD face id (from meshing / the analysis file):
  // needed to detect thin-walled bodies and idealise them as shells (auto-shell).
  surfaceTriangles?: [number, number, number][] | null;
  surfaceFaceIds?: number[] | null;
}

// Topology-optimization request: the same model the static solve takes (mesh +
// materials + BCs/loads + ties/couplings) plus the TO settings block. The design
// domain follows the element mix — all-solid, all-shell, or coupled shell/solid
// (KOF-237). Ties and couplings join the coupled design domain exactly as they
// do for the solve; element order does not apply (linear tets + DKT facets).
export interface TopOptPayload {
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  constraints: Constraint[];
  loads: Load[];
  surfaceLoads?: SurfaceLoad[];
  tieGroups?: TieDefinition[];
  couplings?: CouplingDefinition[];
  settings: TopOptSettings;
}
