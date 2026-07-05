/// <reference lib="webworker" />
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

import createModule from "../wasm/pkg/kofem_wasm.js";
import type { KofemModule, SolveMesh } from "../wasm/pkg/kofem_wasm.js";
import {
  buildTie,
  remapElement,
  assertNoCollapsedElements,
  tiedId,
  expandToOriginalNodes,
} from "./tie.js";

let Module: KofemModule | null = null;

// True once tessellate_step has loaded the OCCT STEP shape into THIS worker's
// WASM module. The worker is torn down after every mesh (resetWorker in
// LeftPanel) to keep Netgen's global state out of the MFEM solve, so a re-mesh
// starts in a fresh module where this is false and the geometry must be
// reloaded from the original STEP bytes before meshing.
let geometryLoaded = false;

// Emscripten (-fexceptions) surfaces an uncaught C++ exception to JS as the raw
// heap pointer of the exception object — a bare number such as 12190840. Decode
// it to the real what() text via getExceptionMessage, exported by the build flag
// EXPORT_EXCEPTION_HANDLING_HELPERS. Degrades gracefully (labelled pointer) when
// the helper is absent, e.g. an older wasm binary built before the flag was added.
function describeError(err: unknown): string {
  if (err instanceof Error)
    return `${err.name}: ${err.message}\n${err.stack ?? ""}`;
  if (typeof err === "number") {
    const getMsg = (
      Module as unknown as {
        getExceptionMessage?: (ptr: number) => [string, string];
      } | null
    )?.getExceptionMessage;
    if (getMsg) {
      try {
        const [type, message] = getMsg(err);
        return message ? `${type}: ${message}` : type;
      } catch {
        // decoding failed — fall through to the labelled raw pointer
      }
    }
    return `C++ exception (undecoded, ptr ${err})`;
  }
  return String(err);
}

async function ensureInit() {
  if (!Module) {
    Module = await createModule({
      print: (text: string) =>
        self.postMessage({ id: 0, log: `[wasm] ${text}` }),
      printErr: (text: string) =>
        self.postMessage({ id: 0, log: `[wasm:err] ${text}` }),
    });
  }
}
function m(): KofemModule {
  if (!Module)
    throw new Error("WASM module not initialised — await ensureInit() first");
  return Module;
}

// Group a flat typed array (xyz / abc interleaved) into [a, b, c] tuples.
// The engine returns binary typed arrays instead of JSON strings (issue #166);
// the store's types hold nested tuples, so unpack at this boundary —
// far cheaper than the previous JSON.parse of a multi-MB text payload.
function chunk3(
  flat: Float32Array | Uint32Array | Int32Array,
): [number, number, number][] {
  const n = (flat.length / 3) | 0;
  const out = new Array<[number, number, number]>(n);
  for (let i = 0; i < n; i++) {
    const j = 3 * i;
    out[i] = [flat[j], flat[j + 1], flat[j + 2]];
  }
  return out;
}

// ── Payload types ─────────────────────────────────────────────────────────────

interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}
interface Element {
  id: number;
  type: string;
  nodeIds: number[];
  propertyId: number;
}
interface Material {
  id: number;
  name: string;
  young: number;
  poisson: number;
  density: number;
}
// Body → material mapping (#317/#353): each body of the assembly is one
// property (property id = 1-based body index from Netgen's mesh domains), and
// the property names the material the body is made of.
interface Property {
  id: number;
  materialId: number;
}
interface Constraint {
  nodeId: number;
  dof: number;
  prescribedValue?: number;
}
interface Load {
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
interface SurfaceLoad {
  type: "force" | "pressure" | "traction";
  faces: number[][];
  force?: [number, number, number];
  pressure?: number;
}
interface ParseStepPayload {
  bytes: Uint8Array;
  format?: string;
}
interface VolumeMeshPayload {
  bytes?: Uint8Array;
  format?: string;
  maxElementSize?: number;
  minElementSize?: number;
}
interface SolvePayload {
  nodes: Node[];
  elements: Element[];
  materials: Material[];
  properties: Property[];
  constraints: Constraint[];
  loads: Load[];
  surfaceLoads?: SurfaceLoad[];
  elementOrder?: number;
  // Bonded-tie detection distance (mm): weld near-contact nodes of different
  // bodies so parts that touch without a shared face are joined (#359). 0 = off.
  tieDistance?: number;
}

// ── parse_step ────────────────────────────────────────────────────────────────

function handleParseStep(id: number, payload: ParseStepPayload) {
  // deflection_relative: chord tolerance as a fraction of the model's
  // bounding-box diagonal, so a large part isn't tessellated into millions of
  // needless triangles. ~0.1% matches the fast browser STEP viewers.
  const opts = JSON.stringify({
    deflection_relative: 0.001,
    angular_deflection: 0.5,
    // eslint-disable-next-line kofem/no-silent-fallback -- format is optional in the parse_step message; absent means STEP, the primary import path
    format: payload.format ?? "step",
  });
  const { vertices, triangles, triangleBodyIds, bodyCount } =
    m().tessellate_step(payload.bytes, opts);
  // tessellate_step stores the OCCT shape in the module — record that so a
  // subsequent volume_mesh in this same worker can skip the reload.
  geometryLoaded = true;
  // Return as {points, triangles} to match the StepTessellation type used by
  // the store; tessellate_step returns flat Float32/Uint32 typed arrays.
  // bodyCount (#353) drives the per-body material assignment UI; bodyIds
  // (one per triangle) drives per-body colour / highlight / hide.
  self.postMessage({
    id,
    ok: true,
    points: chunk3(vertices),
    triangles: chunk3(triangles),
    bodyIds: Array.from(triangleBodyIds),
    bodyCount,
  });
}

// ── volume_mesh ───────────────────────────────────────────────────────────────

function handleVolumeMesh(id: number, payload: VolumeMeshPayload) {
  const { bytes, format = "step", maxElementSize = 20.0 } = payload;

  // A re-mesh runs in a fresh worker (the previous mesh tore this worker's
  // predecessor down), so the OCCT shape generate_fem_mesh needs is gone.
  // Reload it from the original STEP bytes first. This makes every mesh
  // reproduce the known-good import→mesh sequence — tessellate_step (loads
  // the shape) then generate_fem_mesh — rather than meshing twice inside one
  // Netgen-contaminated module.
  if (!geometryLoaded) {
    if (!bytes)
      throw new Error(
        "volume_mesh: no STEP geometry is loaded and no STEP bytes were provided to reload it — re-import the STEP file before meshing",
      );
    self.postMessage({
      id,
      log: "Reloading STEP geometry into the mesher…",
    });
    m().tessellate_step(
      bytes,
      JSON.stringify({
        deflection_relative: 0.001,
        angular_deflection: 0.5,
        format,
      }),
    );
    geometryLoaded = true;
  }

  // Floor the curvature-driven local element size at maxElementSize/10 by
  // default.  Without a floor, Netgen refines every fillet to ~radius/2
  // (elementspercurve) — on fillet-heavy CAD this produces >10x more
  // elements than the max size suggests and meshing takes minutes.
  const minSize = payload.minElementSize ?? maxElementSize / 10;

  const opts = JSON.stringify({
    max_element_size: maxElementSize,
    min_element_size: minSize,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 3,
    optsteps_3d: 3,
  });

  // Use Netgen's native OCC mesher: reads the stored STEP geometry directly,
  // generates a proper FEM surface mesh respecting CAD topology (edges, faces,
  // feature lines), then fills the volume — all in one pass.
  self.postMessage({
    id,
    log: `Generating FEM mesh via Netgen OCC (element size: ${minSize}–${maxElementSize} mm)…`,
  });
  // Binary typed-array transfer (issue #166): flat Float64 coordinates and
  // Int32 index arrays straight from the WASM heap — no JSON string, no
  // JSON.parse. surfaceTriangles/surfaceFaceIds are in Netgen
  // surface-element order (NOT tet boundary order); surfaceFaceIds holds
  // the 1-based OCC face index per surface triangle.
  const dto = m().generate_fem_mesh(opts);
  const nNodes = dto.vertices.length / 3;
  const nTets = dto.tetrahedra.length / 4;

  self.postMessage({
    id,
    log: `Volume mesh complete: ${nNodes} nodes, ${nTets} tetrahedra`,
  });

  // Release OCCT shape + STEP bytes from WASM heap — they are no longer
  // needed once meshing is done, and freeing them before the solve gives
  // MFEM more headroom for stiffness-matrix assembly.
  m().free_geometry_cache();
  geometryLoaded = false;

  // The store models nodes/elements as object lists; build them here from
  // the flat arrays (plain JS, no parsing — cheap relative to meshing).
  const nodes: Node[] = new Array<Node>(nNodes);
  for (let i = 0; i < nNodes; i++) {
    nodes[i] = {
      id: i,
      x: dto.vertices[3 * i],
      y: dto.vertices[3 * i + 1],
      z: dto.vertices[3 * i + 2],
    };
  }
  const elements: Element[] = new Array<Element>(nTets);
  for (let i = 0; i < nTets; i++) {
    elements[i] = {
      id: i,
      type: "CTETRA",
      nodeIds: [
        dto.tetrahedra[4 * i],
        dto.tetrahedra[4 * i + 1],
        dto.tetrahedra[4 * i + 2],
        dto.tetrahedra[4 * i + 3],
      ],
      // The tet's body (1-based CAD solid index) — resolved to a material via
      // the store's properties at solve time (#353).
      propertyId: dto.bodyIds[i],
    };
  }

  self.postMessage({
    id,
    ok: true,
    nodes,
    elements,
    surfaceTriangles: chunk3(dto.surfaceTriangles),
    surfaceFaceIds: Array.from(dto.surfaceFaceIds),
  });
}

// ── solve ─────────────────────────────────────────────────────────────────────

// The engine indexes vertices 0-based in the order they are added (mesh
// vertices are emitted in node-array order). Stored node .id values are NOT
// those indices — saved analyses number nodes 1-based and .inp imports use
// arbitrary ids — so every node reference (element connectivity, constraints,
// loads, surface-load faces) must be remapped to its vertex index before
// reaching the engine. Passing a raw node id where the engine expects a vertex
// index reads past the vertex array and traps with "memory access out of
// bounds" (issue #288).
type VertexIndexer = (nodeId: number, context: string) => number;

function buildVertexIndexer(nodes: Node[]): VertexIndexer {
  const vertexIndexById = new Map(nodes.map((n, i) => [n.id, i]));
  return (nodeId, context) => {
    const i = vertexIndexById.get(nodeId);
    if (i === undefined)
      throw new Error(
        `${context} references unknown node id ${nodeId} — the model is inconsistent`,
      );
    return i;
  };
}

// The mesh crosses the WASM boundary as flat typed arrays (issue #166):
// no multi-MB JSON.stringify here and no JSON.parse inside the engine —
// the engine bulk-copies these buffers onto its heap in one call each.
function packSolveMesh(
  nodes: Node[],
  tetElements: Element[],
  hexElements: Element[],
  vid: VertexIndexer,
): SolveMesh {
  if (tetElements.length === 0 && hexElements.length === 0) {
    throw new Error(
      "No supported elements found. MFEM requires CTETRA or CHEXA elements — " +
        'import a STEP file and click "Mesh STEP volume" first.',
    );
  }
  const vertices = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    vertices[3 * i] = nodes[i].x;
    vertices[3 * i + 1] = nodes[i].y;
    vertices[3 * i + 2] = nodes[i].z;
  }
  const packConnectivity = (
    els: Element[],
    nodesPerElement: number,
    context: string,
  ): Int32Array => {
    const out = new Int32Array(nodesPerElement * els.length);
    for (let i = 0; i < els.length; i++) {
      const { nodeIds } = els[i];
      if (nodeIds.length !== nodesPerElement)
        throw new Error(
          `${context} ${els[i].id} has ${nodeIds.length} nodes — expected ${nodesPerElement}`,
        );
      for (let k = 0; k < nodesPerElement; k++)
        out[nodesPerElement * i + k] = vid(nodeIds[k], context);
    }
    return out;
  };
  return {
    vertices,
    tetrahedra: packConnectivity(tetElements, 4, "CTETRA element"),
    hexahedra: packConnectivity(hexElements, 8, "CHEXA element"),
  };
}

// Per-body materials (#317/#353): each element's propertyId is its body, and
// the property maps the body to a material. Returns the materials payload for
// the engine plus one 1-based index into it per element, in the order the
// elements cross the WASM boundary (mesh.attributes contract).
function resolveMaterials(
  orderedElements: Element[],
  materials: Material[],
  properties: Property[],
) {
  if (materials.length === 0) {
    throw new Error(
      "solve: no material assigned — assign a material before running the solver",
    );
  }
  const matIndexById = new Map(materials.map((mat, i) => [mat.id, i + 1]));
  const matIndexByProperty = new Map<number, number>();
  for (const prop of properties) {
    const idx = matIndexById.get(prop.materialId);
    if (idx === undefined)
      throw new Error(
        `solve: body ${prop.id} is assigned material id ${prop.materialId}, ` +
          "which does not exist — assign an existing material to every body",
      );
    matIndexByProperty.set(prop.id, idx);
  }
  const attributes = new Int32Array(orderedElements.length);
  for (let i = 0; i < orderedElements.length; i++) {
    const idx = matIndexByProperty.get(orderedElements[i].propertyId);
    if (idx === undefined)
      throw new Error(
        `solve: element ${orderedElements[i].id} belongs to body ` +
          `${orderedElements[i].propertyId}, which has no material assignment — ` +
          "the model is inconsistent",
      );
    attributes[i] = idx;
  }
  return {
    materials: materials.map((mat) => ({
      young_modulus: mat.young,
      poisson_ratio: mat.poisson,
      density: mat.density,
    })),
    attributes,
  };
}

// Group translational constraints (DOFs 0–2) per node. A node constrained
// in all three components is a full fix (fixed_vertices); a node constrained
// in only some becomes a per-DOF constraint (fixed_dofs) so the unconstrained
// directions stay free — e.g. a symmetry-plane roller. Rotational DOFs (3–5)
// carry no stiffness for solid (H1 displacement) elements and are ignored.
//
// A non-zero prescribed displacement is also a Dirichlet condition, but it
// must reach the solver as an inhomogeneous essential BC (prescribed_dofs):
// folding it into fixed_vertices/fixed_dofs would silently pin the DOF to
// zero and discard the requested value (issue #216).
// Keyed by vertex index (vid), so the essential-DOF sets the engine
// receives line up with the remapped mesh connectivity.
function groupDirichlet(constraints: Constraint[], vid: VertexIndexer) {
  const dofsByNode = new Map<number, Set<number>>();
  const prescribed_dofs: { vertex: number; dof: number; value: number }[] = [];
  for (const c of constraints) {
    if (c.dof > 2) continue;
    const vertex = vid(c.nodeId, "constraint");
    // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
    const value = c.prescribedValue ?? 0;
    if (value === 0) {
      let dofs = dofsByNode.get(vertex);
      if (!dofs) {
        dofs = new Set();
        dofsByNode.set(vertex, dofs);
      }
      dofs.add(c.dof);
    } else {
      prescribed_dofs.push({ vertex, dof: c.dof, value });
    }
  }
  const fixed_vertices: number[] = [];
  const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
  for (const [vertex, dofSet] of dofsByNode) {
    if (dofSet.size === 3) fixed_vertices.push(vertex);
    else fixed_dofs.push({ vertex, dofs: [...dofSet].sort() });
  }
  return { fixed_vertices, fixed_dofs, prescribed_dofs };
}

// Group translational force loads by vertex index, accumulating [fx,fy,fz]
function groupPointLoads(loads: Load[], vid: VertexIndexer) {
  const loadMap = new Map<number, [number, number, number]>();
  for (const load of loads) {
    if (load.dof > 2) continue;
    const vertex = vid(load.nodeId, "load");
    let force = loadMap.get(vertex);
    if (!force) {
      force = [0, 0, 0];
      loadMap.set(vertex, force);
    }
    force[load.dof] += load.value;
  }
  return [...loadMap.entries()].map(([vertex, force]) => ({ vertex, force }));
}

function handleSolve(id: number, payload: SolvePayload) {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;

  // Bonded tie (#359): weld near-contact nodes of different bodies so parts
  // that touch without a shared face are joined for the solve. A no-op when
  // tieDistance is 0/absent, in which case solveNodes/tiedElements are the
  // originals and every step below is unchanged.
  // eslint-disable-next-line kofem/no-silent-fallback -- tieDistance is optional; the documented default is 0 (tie off)
  const tieDistance = payload.tieDistance ?? 0;
  const tie = buildTie(nodes, elements, tieDistance);
  const solveNodes = tie.nodes;
  const tiedElements =
    tie.repOf.size > 0
      ? elements.map((el) => remapElement(el, tie.repOf))
      : elements;
  if (tie.repOf.size > 0) assertNoCollapsedElements(tiedElements);
  if (tie.nWelded > 0) {
    self.postMessage({
      id,
      log: `Bonded tie: welded ${tie.nWelded} node(s) across bodies (≤ ${tieDistance} mm), ${solveNodes.length} nodes remain`,
    });
  }

  const vid = buildVertexIndexer(solveNodes);
  // Every stored node reference (constraints, loads, surface-load faces) is an
  // ORIGINAL node id; map it through the tie to its representative before
  // resolving to a solve vertex index.
  const vidTied: VertexIndexer = (nodeId, context) =>
    vid(tiedId(tie.repOf, nodeId), context);

  // Tets and hexs cross the WASM boundary as separate arrays (tets first) —
  // the per-element material attributes must follow the same order.
  const tetElements = tiedElements.filter((e) => e.type === "CTETRA");
  const hexElements = tiedElements.filter((e) => e.type === "CHEXA");
  const mesh = packSolveMesh(solveNodes, tetElements, hexElements, vid);
  const { materials: engineMaterials, attributes } = resolveMaterials(
    [...tetElements, ...hexElements],
    materials,
    properties,
  );
  mesh.attributes = attributes;

  // Surface-load faces are node-id lists from the store; remap each to the
  // engine's vertex indices so the boundary-element matcher finds them.
  const surface_loads = (surfaceLoads ?? []).map((sl) => ({
    ...sl,
    faces: sl.faces.map((face) =>
      face.map((nodeId) => vidTied(nodeId, "surface load face")),
    ),
  }));
  const bcs = {
    ...groupDirichlet(constraints, vidTied),
    point_loads: groupPointLoads(loads, vidTied),
    surface_loads,
  };

  // FE polynomial order, chosen in the frontend (Solver settings). Order 2
  // (quadratic / second-order) adds edge-midpoint DOFs that resolve bending
  // and stress gradients far better than linear tets, which lock in bending
  // and smear stress concentrations to a single constant value per element
  // (issue #215), at the cost of a slower solve. The engine extends the
  // vertex Dirichlet BCs to the new edge DOFs so clamped/prescribed faces
  // stay fully constrained. Defaults to 1 (linear) when the payload omits it.
  // eslint-disable-next-line kofem/no-silent-fallback -- elementOrder is optional in the solve message; the documented default is linear elements
  const order = payload.elementOrder ?? 1;
  self.postMessage({
    id,
    log: `Starting static solve: ${nodes.length} nodes, ${elements.length} elements (order ${order})…`,
  });
  // Mesh as typed arrays; materials/BCs stay JSON (small). The result comes
  // back as Float64Arrays whose buffers are handed to the main thread via
  // the postMessage transfer list — zero-copy, no JSON round-trip.
  const result = m().solve_linear_elastic(
    mesh,
    JSON.stringify(engineMaterials),
    JSON.stringify(bcs),
    order,
  );

  if ("error" in result) {
    throw new Error(result.error);
  }

  // The engine returns one displacement per SOLVE node (tied set). Expand back
  // to one per ORIGINAL store node — a merged-away node takes its
  // representative's displacement — so the result overlays the original mesh.
  // von Mises is per element; welding preserves element count and order, so it
  // passes through unchanged. When the tie is off this is a straight pass-through
  // (zero-copy).
  const displacements =
    tie.nWelded > 0
      ? expandToOriginalNodes(
          nodes,
          solveNodes,
          tie.repOf,
          result.displacements,
          3,
        )
      : result.displacements;

  self.postMessage({
    id,
    log: `Solve complete: ${displacements.length / 3} vertex displacements, ${result.von_mises.length} element stresses`,
  });
  self.postMessage(
    {
      id,
      ok: true,
      displacements,
      vonMises: result.von_mises,
    },
    [displacements.buffer, result.von_mises.buffer],
  );
}

// ── test_generate_fem_mesh ────────────────────────────────────────────────────

// Smoke test for the production OCC meshing path. Requires tessellate_step
// to have been called first so the STEP geometry is loaded in WASM memory.
function handleTestGenerateFemMesh(id: number) {
  const t0 = Date.now();
  const opts = JSON.stringify({
    max_element_size: 20.0,
    min_element_size: 2.0,
    grading: 0.3,
    second_order: false,
    elementsperedge: 2.0,
    elementspercurve: 2.0,
    optsteps_2d: 0,
    optsteps_3d: 0,
  });
  const dto = m().generate_fem_mesh(opts);
  self.postMessage({
    id,
    ok: true,
    nodes: dto.vertices.length / 3,
    elements: dto.tetrahedra.length / 4,
    durationMs: Date.now() - t0,
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;

  try {
    await ensureInit();

    if (type === "parse_step") {
      handleParseStep(id, payload as ParseStepPayload);
    } else if (type === "volume_mesh") {
      handleVolumeMesh(id, payload as VolumeMeshPayload);
    } else if (type === "solve") {
      handleSolve(id, payload as SolvePayload);
    } else if (type === "test_generate_fem_mesh") {
      handleTestGenerateFemMesh(id);
    } else if (type === "mesh") {
      throw new Error(
        "Parametric mesh generation is not available in the new pipeline. Import a STEP file instead.",
      );
    } else {
      throw new Error(`Unknown worker message type: ${type}`);
    }
  } catch (err) {
    const isRuntimeError = err instanceof Error && err.name === "RuntimeError";
    const isWasmTrap =
      isRuntimeError &&
      (err.message.includes("memory access out of bounds") ||
        err.message.includes("integer overflow") ||
        err.message.includes("integer divide by zero") ||
        err.message.includes("unreachable") ||
        err.message.includes("null function or function signature mismatch") ||
        err.message.includes("table index is out of bounds"));
    const detail = describeError(err);
    const errorMessage = isWasmTrap
      ? `WASM trap (code bug, not OOM): ${detail}`
      : detail;
    if (isWasmTrap) {
      console.error(`[solver.worker] WASM trap in ${type}:`, detail);
    } else {
      console.error(`[solver.worker] ${type} failed:`, detail);
    }
    self.postMessage({ id, ok: false, error: errorMessage });
  }
};
