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
  tieLimit,
  tieSides,
  bodyMembership,
  expandToOriginalNodes,
  type TieDefinition,
} from "../lib/tie.js";
import {
  extractThinWallShells,
  shellWallTets,
  buildCoupledModel,
  buildExplicitCoupledModel,
  type TieSurfaces,
  dropCouplingsOnFixedNodes,
  shellNodeLocator,
  isShellPoolIndex,
  concatCouplings,
  couplingMpcCodes,
  couplingDofMasks,
  type CoupledModel,
  type ShellizeMesh,
  type ShellExtraction,
} from "../lib/shellize.js";
import {
  buildReferenceCouplings,
  referencePointIds,
  type CouplingDefinition,
} from "../lib/coupling.js";
import { detectShellBodies } from "../lib/thinBodies.js";

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
// the property names the material the body is made of. Properties referenced
// by shell (CTRIA3) elements also carry the shell thickness (PSHELL semantics).
interface Property {
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
  // Wall-thickness threshold of the thin-body (auto-shell) preselection, as a
  // fraction of each body's own bounding-box diagonal. Absent ⇒ the detector's
  // own default (DEFAULT_THIN_RATIO).
  thinRatio?: number;
}
interface VolumeMeshPayload {
  bytes?: Uint8Array;
  format?: string;
  maxElementSize?: number;
  minElementSize?: number;
  // Bodies marked Shell (Property.discretization === "shell") and the current
  // property table. With these, meshing idealises those bodies' thin walls to a
  // mid-surface shell mesh and stores the MIXED CTRIA3 + CTETRA model, instead of
  // deriving it throwaway inside the solve (#397). Absent/empty ⇒ all-solid mesh.
  shellBodyIds?: number[];
  properties?: Property[];
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
  // Thin-walled bodies (a ray cast inward from the surface finds an opposite wall
  // close by, relative to the body's size) are preselected as shells — before any
  // volume mesh exists, purely from the tessellation.
  const shellBodyIds = detectShellBodies(
    { vertices, triangles, triangleBodyIds },
    { thinRatio: payload.thinRatio },
  );
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
    shellBodyIds,
  });
}

// ── volume_mesh ───────────────────────────────────────────────────────────────

// Ship this worker's Istanbul counters to the page. useMesh calls resetWorker()
// (terminate) as soon as the volume_mesh response resolves, so counters left in
// the worker are destroyed before the coverage fixture can harvest them — the
// entire mesh-time auto-shell idealisation reported as unexecuted. Messages are
// delivered in post order, so calling this immediately BEFORE the task's result
// guarantees the page stashes the counters before it can terminate the worker.
// No-op unless the app was built with COVERAGE=1.
function flushCoverage(): void {
  const cov = (globalThis as { __coverage__?: unknown }).__coverage__;
  if (cov) self.postMessage({ __workerCoverage: cov });
}

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

  const surfaceTriangles = chunk3(dto.surfaceTriangles) as [
    number,
    number,
    number,
  ][];
  const surfaceFaceIds = Array.from(dto.surfaceFaceIds);

  // Auto-shell at MESH time (#397): a body marked Shell has its thin walls
  // collapsed to a mid-surface shell mesh here, so the stored model is the mixed
  // CTRIA3 + CTETRA model the user sees and solves — not an all-solid mesh whose
  // shells only ever existed transiently inside the solve.
  const mixed = buildMeshTimeShellModel(
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
    new Set(payload.shellBodyIds ?? []),
    payload.properties ?? [],
    (line: string) => self.postMessage({ id, log: line }),
  );
  if (mixed) {
    flushCoverage();
    self.postMessage({
      id,
      ok: true,
      nodes: mixed.nodes,
      elements: mixed.elements,
      properties: mixed.properties,
      surfaceTriangles: mixed.surfaceTriangles,
      surfaceFaceIds: mixed.surfaceFaceIds,
    });
    return;
  }

  flushCoverage();
  self.postMessage({
    id,
    ok: true,
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
  });
}

// Idealise the Shell-marked bodies' thin walls into a mid-surface shell mesh and
// return the mixed model to store: the coupled node pool, the retained solid tets
// as CTETRA, and the collapsed wall facets as CTRIA3. Thickness is per SECTION —
// detectWallPairs measures each wall pair separately, so one PSHELL property is
// emitted per distinct wall thickness and each facet references its own (the same
// scheme the offline crane generator uses). Solid bodies keep their existing
// property ids, so material assignments survive the mesh. Returns null when the
// The model's tie connections in the form the coupled builders take: the two
// picked surfaces as vertex indices, and how far the tie reaches. This is the
// ONLY thing that joins distinct solid bodies in a coupled model — nothing is
// inferred from the geometry — so a payload with no connections leaves the
// bodies apart, exactly as the all-solid path does.
function coupledTies(
  tieGroups: TieDefinition[] | undefined,
  elements: Element[],
  vid: VertexIndexer,
): TieSurfaces[] {
  if (!tieGroups || tieGroups.length === 0) return [];
  // The same side resolution the weld path uses (tieSides), so a connection
  // means the same thing whichever solver ends up carrying it.
  const bodyOf = bodyMembership(elements);
  return tieGroups.map((tie) => {
    const sides = tieSides(tie, bodyOf);
    return {
      name: tie.name,
      verticesA: sides.a.map((nodeId) => vid(nodeId, "tie surface")),
      verticesB: sides.b.map((nodeId) => vid(nodeId, "tie surface")),
      maxSeparation: tieLimit(tie),
    };
  });
}

// idealisation does not apply (no Shell body, no surface mesh, or no thin wall
// found), leaving the caller's all-solid mesh in place.
function buildMeshTimeShellModel(
  nodes: Node[],
  elements: Element[],
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
  shellBodyIds: Set<number>,
  properties: Property[],
  log: (line: string) => void,
): {
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
} | null {
  if (shellBodyIds.size === 0) return null;
  if (surfaceTriangles.length === 0) return null;
  if (surfaceFaceIds.length !== surfaceTriangles.length) return null;
  const tetElements = elements.filter((e) => e.type === "CTETRA");
  if (tetElements.length !== elements.length) return null;

  const vid = buildVertexIndexer(nodes);
  const mesh = buildShellizeMesh(
    nodes,
    tetElements,
    surfaceTriangles,
    surfaceFaceIds,
    vid,
  );
  const shells = extractThinWallShells(mesh, { shellBodyIds });
  if (shells.shellBody < 0)
    throw new Error(
      `Shell idealisation failed: body ${[...shellBodyIds].join(", ")} is marked "Shell" but no ` +
        "thin walls were found in it. Switch it to Solid, or check that it is genuinely thin-walled.",
    );
  const wallTets = shellWallTets(mesh, shells);
  // No ties here: this runs at MESH time, before any surface can have been
  // picked. It only needs the pool's node/element layout — the couplings are
  // rebuilt at solve time from the connections the user defined by then.
  const model = buildCoupledModel(mesh, shells, wallTets);

  // Nodes: the coupled pool (solid nodes first, then the shell mid-surface nodes).
  const poolNodes: Node[] = [];
  for (let i = 0; i < model.pool.length / 3; i++)
    poolNodes.push({
      id: i,
      x: model.pool[3 * i],
      y: model.pool[3 * i + 1],
      z: model.pool[3 * i + 2],
    });

  // Properties: the CAD bodies keep their own ids (materials stay assigned); one
  // PSHELL per distinct wall thickness, inheriting the shelled body's material.
  // The PSHELLs of an earlier mesh are dropped first — they describe walls that
  // no longer exist, and carrying them over made every re-mesh append another
  // dead body to the list.
  const cadBodies = properties.filter((p) => p.sourceBodyId === undefined);
  const nextId = cadBodies.reduce((mx, p) => Math.max(mx, p.id), 0) + 1;
  const shellProp = cadBodies.find((p) => p.id === shells.shellBody);
  const shellMaterialId = shellProp ? shellProp.materialId : 1;
  const thkKey = (t: number) => Number(t.toFixed(6));
  const propOfThk = new Map<number, number>();
  const outProperties: Property[] = cadBodies.map((p) => ({ ...p }));
  for (const t of model.thicknesses) {
    const key = thkKey(t);
    if (propOfThk.has(key)) continue;
    const pid = nextId + propOfThk.size;
    propOfThk.set(key, pid);
    outProperties.push({
      id: pid,
      materialId: shellMaterialId,
      thickness: key,
      discretization: "shell",
      sourceBodyId: shells.shellBody,
    });
  }

  // Elements: retained solid tets (their body's property) then the shell facets
  // (their thickness's PSHELL).
  const outElements: Element[] = [];
  for (let e = 0; e < model.tets.length / 4; e++)
    outElements.push({
      id: outElements.length,
      type: "CTETRA",
      nodeIds: [
        model.tets[4 * e],
        model.tets[4 * e + 1],
        model.tets[4 * e + 2],
        model.tets[4 * e + 3],
      ],
      propertyId: model.tetBody[e],
    });
  for (let t = 0; t < model.triangles.length / 3; t++) {
    const pid = propOfThk.get(thkKey(model.thicknesses[t]));
    if (pid === undefined)
      throw new Error(
        `mesh-time shell: facet ${t} has thickness ${model.thicknesses[t]} with no PSHELL property`,
      );
    outElements.push({
      id: outElements.length,
      type: "CTRIA3",
      nodeIds: [
        model.triangles[3 * t],
        model.triangles[3 * t + 1],
        model.triangles[3 * t + 2],
      ],
      propertyId: pid,
    });
  }

  const { surfaceTriangles: poolSurfTris, surfaceFaceIds: poolSurfFaces } =
    rebuildPoolSurface(model, shells, surfaceTriangles, surfaceFaceIds);

  const thkList = [...propOfThk.keys()]
    .sort((a, b) => a - b)
    .map((t) => `${t} mm`)
    .join(", ");
  log(
    `[auto-shell] body ${shells.shellBody}: ${shells.walls.length} thin walls → ` +
      `${model.shellPool.length} shell nodes, ${model.triangles.length / 3} facets ` +
      `(${propOfThk.size} thickness section(s): ${thkList}), ` +
      `${model.tets.length / 4} solid tets retained, ${model.coupling.ref.length} couplings`,
  );

  return {
    nodes: poolNodes,
    elements: outElements,
    properties: outProperties,
    surfaceTriangles: poolSurfTris,
    surfaceFaceIds: poolSurfFaces,
  };
}

// Surface mesh of the coupled pool, so face picking keeps working after the
// idealisation. Two sources: every shell facet is itself a surface (its OCC face
// is the wall it came from), and the retained solid keeps those original surface
// triangles whose nodes all survived into the solid pool. Faces of the solid that
// were only exposed by removing the wall tets have no CAD face and are left
// out — they are internal to the idealisation, not pickable CAD geometry.
function rebuildPoolSurface(
  model: CoupledModel,
  shells: ShellExtraction,
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
): {
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
} {
  const outTris: [number, number, number][] = [];
  const outFaces: number[] = [];
  for (let t = 0; t < surfaceTriangles.length; t++) {
    const [a, b, c] = surfaceTriangles[t];
    const pa = model.solidPool.get(a),
      pb = model.solidPool.get(b),
      pc = model.solidPool.get(c);
    if (pa === undefined || pb === undefined || pc === undefined) continue;
    outTris.push([pa, pb, pc]);
    outFaces.push(surfaceFaceIds[t]);
  }
  for (let t = 0; t < shells.shellTris.length / 3; t++) {
    outTris.push([
      model.shellPool[shells.shellTris[3 * t]],
      model.shellPool[shells.shellTris[3 * t + 1]],
      model.shellPool[shells.shellTris[3 * t + 2]],
    ]);
    outFaces.push(shells.shellTriSrc[t]);
  }
  return { surfaceTriangles: outTris, surfaceFaceIds: outFaces };
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

// ── Pure-shell solve (CTRIA3 → solve_shell) ─────────────────────────────────

// Resolve the shell section: one (E, ν) pair plus the per-facet thickness
// field. The engine's shell solver takes a single material for the whole mesh;
// a model whose shell elements span several materials cannot be honoured, so
// refuse loudly instead of solving part of it with the wrong stiffness
// (mirrors coupledMaterials, issue #376). Thickness lives on each element's
// property (PSHELL semantics) and must be a positive number.
function resolveShellSection(
  shellElements: Element[],
  materials: Material[],
  properties: Property[],
): { young: number; poisson: number; thicknesses: Float64Array } {
  const propById = new Map(properties.map((p) => [p.id, p]));
  const matById = new Map(materials.map((mat) => [mat.id, mat]));
  const usedMats = new Map<number, Material>();
  const thicknesses = new Float64Array(shellElements.length);
  for (let i = 0; i < shellElements.length; i++) {
    const el = shellElements[i];
    const prop = propById.get(el.propertyId);
    if (!prop)
      throw new Error(
        `shell solve: element ${el.id} belongs to body ${el.propertyId}, ` +
          "which has no property — the model is inconsistent",
      );
    if (typeof prop.thickness !== "number" || prop.thickness <= 0)
      throw new Error(
        `shell solve: property ${prop.id} has no positive shell thickness — ` +
          "shell (CTRIA3) elements require a thickness on their property",
      );
    thicknesses[i] = prop.thickness;
    const mat = matById.get(prop.materialId);
    if (!mat)
      throw new Error(
        `shell solve: property ${prop.id} references material ${prop.materialId}, ` +
          "which does not exist",
      );
    usedMats.set(mat.id, mat);
  }
  if (usedMats.size > 1) {
    const names = [...usedMats.values()].map((mat) => mat.name).join(", ");
    throw new Error(
      `shell solve: the shell solver supports one material, but the shell elements span ` +
        `${usedMats.size} distinct materials (${names}) — assign a single material to the shell body`,
    );
  }
  const mat = [...usedMats.values()][0];
  return { young: mat.young, poisson: mat.poisson, thicknesses };
}

// Essential BCs for the shell solve. Shell nodes carry six DOFs
// (u,v,w,θx,θy,θz), so rotational constraints are honoured — unlike the solid
// path, which drops them as stiffness-free. A node with all six DOFs fixed
// becomes a fixed_vertices entry, anything partial a fixed_dofs entry. The
// shell solver has no inhomogeneous essential BCs, so a non-zero prescribed
// displacement is a loud error, not a silent pin-to-zero.
function shellDirichlet(constraints: Constraint[], vid: VertexIndexer) {
  const dofsByVertex = new Map<number, Set<number>>();
  for (const c of constraints) {
    if (c.dof < 0 || c.dof > 5)
      throw new Error(
        `shell solve: constraint on node ${c.nodeId} names DOF ${c.dof} — valid shell DOFs are 0..5`,
      );
    // eslint-disable-next-line kofem/no-silent-fallback -- a constraint without prescribedValue is a homogeneous fixed BC, i.e. u = 0 by definition
    if ((c.prescribedValue ?? 0) !== 0)
      throw new Error(
        "shell solve: prescribed (non-zero) displacements are not supported for shell models yet",
      );
    const vertex = vid(c.nodeId, "constraint");
    let dofs = dofsByVertex.get(vertex);
    if (!dofs) {
      dofs = new Set();
      dofsByVertex.set(vertex, dofs);
    }
    dofs.add(c.dof);
  }
  const fixed_vertices: number[] = [];
  const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
  for (const [vertex, dofSet] of dofsByVertex) {
    if (dofSet.size === 6) fixed_vertices.push(vertex);
    else fixed_dofs.push({ vertex, dofs: [...dofSet].sort((a, b) => a - b) });
  }
  return { fixed_vertices, fixed_dofs };
}

type ShellNodalLoad = {
  force: [number, number, number];
  moment: [number, number, number];
};

// Work-equivalent nodal loads of one surface load on a shell mesh. The shell
// solver takes only nodal loads, so the traction integral f_i = ∫ N_i·t dS the
// solid engine evaluates over boundary elements must be computed here. With
// linear (CST/DKT) shape functions a uniform traction contributes t·A/3 to
// each node of a facet, and a uniform line load q·L/2 to each end of an edge:
//   force on facets — uniform traction t = F/ΣA over the loaded region
//   force on edges  — uniform line load q = F/ΣL along the loaded edge
//   pressure        — -p·n̂·A/3 per facet node, n̂ the facet winding normal
//                     (a shell has no outward side; + pushes against n̂)
function distributeShellSurfaceLoad(
  sl: SurfaceLoad,
  posOf: (nodeId: number) => [number, number, number],
  at: (nodeId: number) => ShellNodalLoad,
): void {
  const facets = sl.faces.filter((f) => f.length === 3);
  const edges = sl.faces.filter((f) => f.length === 2);
  if (facets.length + edges.length !== sl.faces.length)
    throw new Error(
      "shell solve: a surface load carries a face that is neither a facet (3 nodes) nor an edge (2 nodes)",
    );

  // Area-weighted winding normal: |areaNormal| = A, direction from winding.
  const areaNormal = (f: number[]): [number, number, number] => {
    const [a, b, c] = [posOf(f[0]), posOf(f[1]), posOf(f[2])];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    return [
      (ab[1] * ac[2] - ab[2] * ac[1]) / 2,
      (ab[2] * ac[0] - ab[0] * ac[2]) / 2,
      (ab[0] * ac[1] - ab[1] * ac[0]) / 2,
    ];
  };

  if (sl.type === "pressure") {
    if (sl.pressure === undefined)
      throw new Error("shell solve: pressure load carries no magnitude");
    if (facets.length === 0)
      throw new Error(
        "shell solve: a pressure load needs shell facets — it cannot act on an edge",
      );
    for (const f of facets) {
      const n = areaNormal(f);
      for (const nodeId of f) {
        const acc = at(nodeId).force;
        for (let d = 0; d < 3; d++) acc[d] += (-sl.pressure * n[d]) / 3;
      }
    }
    return;
  }

  if (!sl.force)
    throw new Error(`shell solve: ${sl.type} load carries no force vector`);
  if (sl.type === "traction" && edges.length > 0)
    throw new Error(
      "shell solve: a traction (per-area) load cannot act on an edge",
    );

  if (facets.length > 0) {
    const areas = facets.map((f) => {
      const n = areaNormal(f);
      return Math.hypot(n[0], n[1], n[2]);
    });
    const totalArea = areas.reduce((s, a) => s + a, 0);
    if (totalArea <= 0)
      throw new Error("shell solve: loaded facets have zero total area");
    for (let i = 0; i < facets.length; i++) {
      // force: share of the TOTAL vector ∝ area; traction: t·A/3 directly.
      const scale =
        sl.type === "force" ? areas[i] / (3 * totalArea) : areas[i] / 3;
      for (const nodeId of facets[i]) {
        const acc = at(nodeId).force;
        for (let d = 0; d < 3; d++) acc[d] += sl.force[d] * scale;
      }
    }
  } else if (edges.length > 0) {
    const lengths = edges.map((e) => {
      const [a, b] = [posOf(e[0]), posOf(e[1])];
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    });
    const totalLength = lengths.reduce((s, l) => s + l, 0);
    if (totalLength <= 0)
      throw new Error("shell solve: loaded edges have zero total length");
    for (let i = 0; i < edges.length; i++) {
      const scale = lengths[i] / (2 * totalLength);
      for (const nodeId of edges[i]) {
        const acc = at(nodeId).force;
        for (let d = 0; d < 3; d++) acc[d] += sl.force[d] * scale;
      }
    }
  }
}

// Nodal loads for the shell solve: direct loads (moment groups arrive here as
// equivalent nodal forces; DOFs 3–5 would be true nodal moments) merged with
// the work-equivalent distribution of every surface load.
function shellPointLoads(
  loads: Load[],
  surfaceLoads: SurfaceLoad[] | undefined,
  posOf: (nodeId: number) => [number, number, number],
  vid: VertexIndexer,
) {
  const acc = new Map<number, ShellNodalLoad>();
  const atVertex = (vertex: number): ShellNodalLoad => {
    let entry = acc.get(vertex);
    if (!entry) {
      entry = { force: [0, 0, 0], moment: [0, 0, 0] };
      acc.set(vertex, entry);
    }
    return entry;
  };
  for (const load of loads) {
    if (load.dof < 0 || load.dof > 5)
      throw new Error(
        `shell solve: load on node ${load.nodeId} names DOF ${load.dof} — valid shell DOFs are 0..5`,
      );
    const entry = atVertex(vid(load.nodeId, "load"));
    if (load.dof <= 2) entry.force[load.dof] += load.value;
    else entry.moment[load.dof - 3] += load.value;
  }
  const atNode = (nodeId: number): ShellNodalLoad =>
    atVertex(vid(nodeId, "surface load face"));
  for (const sl of surfaceLoads ?? [])
    distributeShellSurfaceLoad(sl, posOf, atNode);

  return [...acc.entries()].map(([vertex, { force, moment }]) => ({
    vertex,
    ...(force.some((v) => v !== 0) ? { force } : {}),
    ...(moment.some((v) => v !== 0) ? { moment } : {}),
  }));
}

// Solve a pure-shell (all-CTRIA3) model via the engine's Kirchhoff shell
// solver. The result matches the solid contract — three translations per node,
// one von Mises surface stress per element — so the store and viewport consume
// it unchanged. elementOrder and tie connections do not apply to shells (the
// DKT facet is what it is; ties join solid bodies) and are ignored.
function handleShellSolve(id: number, payload: SolvePayload) {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;

  const vid = buildVertexIndexer(nodes);
  const vertices = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    vertices[3 * i] = nodes[i].x;
    vertices[3 * i + 1] = nodes[i].y;
    vertices[3 * i + 2] = nodes[i].z;
  }
  const triangles = new Int32Array(3 * elements.length);
  for (let i = 0; i < elements.length; i++) {
    const { nodeIds } = elements[i];
    if (nodeIds.length !== 3)
      throw new Error(
        `CTRIA3 element ${elements[i].id} has ${nodeIds.length} nodes — expected 3`,
      );
    for (let k = 0; k < 3; k++)
      triangles[3 * i + k] = vid(nodeIds[k], "CTRIA3 element");
  }

  const { young, poisson, thicknesses } = resolveShellSection(
    elements,
    materials,
    properties,
  );
  const { fixed_vertices, fixed_dofs } = shellDirichlet(constraints, vid);
  const posOf = (nodeId: number): [number, number, number] => {
    const vi = vid(nodeId, "surface load face");
    return [vertices[3 * vi], vertices[3 * vi + 1], vertices[3 * vi + 2]];
  };
  const point_loads = shellPointLoads(loads, surfaceLoads, posOf, vid);

  self.postMessage({
    id,
    log: `Starting shell solve: ${nodes.length} nodes, ${elements.length} shell facets…`,
  });
  const result = m().solve_shell(
    { vertices, triangles, thicknesses },
    JSON.stringify({ young_modulus: young, poisson_ratio: poisson }),
    JSON.stringify({ fixed_vertices, fixed_dofs, point_loads }),
  );
  if ("error" in result) throw new Error(result.error);

  self.postMessage({
    id,
    log: `Shell solve complete: ${result.displacements.length / 3} vertex displacements, ${result.von_mises.length} facet stresses`,
  });
  self.postMessage(
    {
      id,
      ok: true,
      displacements: result.displacements,
      vonMises: result.von_mises,
    },
    [result.displacements.buffer, result.von_mises.buffer],
  );
}

// ── Auto-shell coupled solve ────────────────────────────────────────────────

// Relaxation factor ψ for the shell↔solid MPC coupling (Lu, Zhang & Yang 2023,
// "A Relaxed MPC Method for Non-rigid Shell to Solid Coupling", J. Phys.: Conf.
// Ser. 2528 012064). ψ ∈ [0.5, 1]: 1 is the classical rigid MPC, < 1 relaxes the
// rotation transfer to avoid the artificial over-stiffening of a fully rigid tie.
// The rigid translation tie (mpc = 1 in the coupling set) is ψ-independent and is
// what restores displacement continuity across the shell/solid seam.
const SHELL_SOLID_MPC_RELAXATION = 1.0;

// Flat 0-based mesh for the shellize pipeline, built from the store model.
function buildShellizeMesh(
  nodes: Node[],
  tetElements: Element[],
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
  vid: VertexIndexer,
): ShellizeMesh {
  const verts = new Array<number>(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    verts[3 * i] = nodes[i].x;
    verts[3 * i + 1] = nodes[i].y;
    verts[3 * i + 2] = nodes[i].z;
  }
  const tet: number[] = [];
  const body: number[] = [];
  for (const el of tetElements) {
    for (const nid of el.nodeIds) tet.push(vid(nid, "shellize tet"));
    body.push(el.propertyId);
  }
  const surfTri: number[] = [];
  const surfFace: number[] = [];
  for (let t = 0; t < surfaceTriangles.length; t++) {
    const [triA, triB, triC] = surfaceTriangles[t];
    surfTri.push(
      vid(triA, "surface tri"),
      vid(triB, "surface tri"),
      vid(triC, "surface tri"),
    );
    surfFace.push(surfaceFaceIds[t]);
  }
  return { V: verts, tet, body, surfTri, surfFace };
}

// Solid and shell material for the coupled solve (single each). The shell uses
// the thin body's material; the solid uses the single material shared by every
// solid body. The coupled solid-shell assembler (engine/cpp/solve_coupled.cpp →
// assemble_solid_stiffness_mfem) takes one (E, nu) pair for the whole solid
// domain — it has no per-body material plumbing — so a solid domain that spans
// two different materials cannot be honoured here. Rather than silently pick one
// and solve part of the model with the wrong stiffness (issue #376), refuse
// loudly and name the ambiguity. `solidBodyIds` are the property ids of the
// solid bodies actually present in the coupled tet mesh (shell body excluded).
function coupledMaterials(
  materials: Material[],
  properties: Property[],
  shellBody: number,
  solidBodyIds: number[],
) {
  const matOf = (propId: number): Material => {
    const prop = properties.find((p) => p.id === propId);
    if (!prop)
      throw new Error(
        `coupledMaterials: no property with id ${propId} in the model`,
      );
    const mat = materials.find((mm) => mm.id === prop.materialId);
    if (!mat)
      throw new Error(
        `coupledMaterials: property ${propId} references material ${prop.materialId}, which does not exist`,
      );
    return mat;
  };
  const shellMat = matOf(shellBody);
  const solidMats = new Map<number, Material>();
  for (const pid of solidBodyIds) {
    const mat = matOf(pid);
    solidMats.set(mat.id, mat);
  }
  if (solidMats.size === 0)
    throw new Error(
      "coupledMaterials: the coupled solve has no solid body — a shell body must be coupled to at least one solid body",
    );
  if (solidMats.size > 1) {
    const names = [...solidMats.values()].map((mm) => mm.name).join(", ");
    throw new Error(
      "coupledMaterials: the coupled solid-shell solve supports only one solid material, but the " +
        `solid domain spans ${solidMats.size} distinct materials (${names}). Per-body materials are ` +
        "not yet plumbed through the coupled shell path — assign a single material to all solid " +
        "bodies, or solve this model without the thin-wall shell idealisation.",
    );
  }
  const solidMat = [...solidMats.values()][0];
  return {
    solid: { young_modulus: solidMat.young, poisson_ratio: solidMat.poisson },
    shell: { young_modulus: shellMat.young, poisson_ratio: shellMat.poisson },
  };
}

// Essential BCs for the coupled solve: a translation constraint maps to its
// pool node, and a shelled node clamped in all three translations is also
// clamped in rotation. `isShell` reports whether a pool node carries shell
// (6-DOF) stiffness — the auto-shell and mixed paths supply it differently, but
// the rule is the same.
//
// `isRefPoint` marks the pool nodes that are a coupling's REFERENCE POINT. Those
// carry six real DOFs (shell_core gives a coupling reference its rotations), so
// an Rx/Ry/Rz constraint on one is a genuine rotational restraint and is passed
// through instead of dropped — clamping a kinematic reference point is how a
// bolted connection is stated. Everywhere else a rotational constraint is still
// dropped: the shell nodes take their rotational clamp from the all-three-
// translations rule below, and a solid node has no rotational DOF to restrain.
function coupledFixedDofs(
  constraints: Constraint[],
  poolOf: (nodeId: number) => number,
  isShell: (poolIndex: number) => boolean,
  isRefPoint: (poolIndex: number) => boolean = () => false,
): number[] {
  const fixedByPool = new Map<number, Set<number>>();
  for (const c of constraints) {
    const pi = poolOf(c.nodeId);
    if (c.dof > 2 && !isRefPoint(pi)) continue;
    let dofs = fixedByPool.get(pi);
    if (!dofs) {
      dofs = new Set();
      fixedByPool.set(pi, dofs);
    }
    dofs.add(c.dof);
  }
  const fixed_dofs: number[] = [];
  for (const [pi, dofs] of fixedByPool) {
    for (const d of dofs) fixed_dofs.push(6 * pi + d);
    // A shell node clamped in all three translations is clamped, not hinged.
    // A reference point is NOT given that treatment: its rotations are the DOFs
    // the coupled surface's rigid-body motion rides on, so fixing them because
    // the translations were fixed would silently turn a pinned point into a
    // built-in one. Check Rx/Ry/Rz to clamp a reference point.
    if (
      isShell(pi) &&
      !isRefPoint(pi) &&
      dofs.has(0) &&
      dofs.has(1) &&
      dofs.has(2)
    )
      for (const d of [3, 4, 5]) fixed_dofs.push(6 * pi + d);
  }
  return fixed_dofs;
}

// Point + surface loads → equivalent nodal forces on the pool.
//
// A moment (DOF 3..5) is applied directly where the node has a rotational DOF to
// receive it — a coupling REFERENCE POINT. That is the couple a surface-to-point
// coupling exists to carry: the point takes M, the coupling spreads it over the
// gripped surface as the statically equivalent traction, and no lever arm has to
// be invented. Elsewhere a moment still arrives pre-converted to a ring of nodal
// forces (momentToNodalForces), so it is skipped here as it always was.
function coupledLoads(
  loads: Load[],
  surfaceLoads: SurfaceLoad[] | undefined,
  poolOf: (nodeId: number) => number,
  isRefPoint: (poolIndex: number) => boolean = () => false,
): { load_dofs: number[]; load_vals: number[] } {
  const load_dofs: number[] = [];
  const load_vals: number[] = [];
  for (const l of loads) {
    const pi = poolOf(l.nodeId);
    if (l.dof > 2 && !isRefPoint(pi)) continue;
    load_dofs.push(6 * pi + l.dof);
    load_vals.push(l.value);
  }
  for (const sl of surfaceLoads ?? []) {
    if ((sl.type !== "force" && sl.type !== "traction") || !sl.force) continue; // pressure not mapped yet
    const nodeSet = new Set<number>();
    for (const f of sl.faces) for (const n of f) nodeSet.add(n);
    if (nodeSet.size === 0) continue;
    const per = sl.force.map((v) => v / nodeSet.size);
    for (const nid of nodeSet) {
      const pi = poolOf(nid);
      for (let d = 0; d < 3; d++)
        if (per[d] !== 0) {
          load_dofs.push(6 * pi + d);
          load_vals.push(per[d]);
        }
    }
  }
  return { load_dofs, load_vals };
}

// Map pool displacements onto every original store node: solid nodes directly,
// the shelled body's nodes from their nearest mid-surface node.
function mapCoupledDisplacements(
  rd: Float64Array,
  nodes: Node[],
  model: CoupledModel,
  nearestShell: (p: [number, number, number]) => number,
): Float64Array {
  const displacements = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const rp = model.refPool.get(i);
    const sp = rp !== undefined ? rp : model.solidPool.get(i);
    const pi =
      sp !== undefined
        ? sp
        : nearestShell([nodes[i].x, nodes[i].y, nodes[i].z]);
    displacements[3 * i] = rd[3 * pi];
    displacements[3 * i + 1] = rd[3 * pi + 1];
    displacements[3 * i + 2] = rd[3 * pi + 2];
  }
  return displacements;
}

// Von Mises per ORIGINAL element. Solid tets map 1:1 in the order they were
// appended to the pool (every element that is NOT inside a shelled-body wall,
// which now includes the shelled body's retained base tets). The wall elements of
// the shelled body take the stress of the shell node nearest their centroid — per
// shell node, the worst adjacent facet's surface stress. The append order in
// buildCoupledModel is the element iteration order below, so a single `solidIdx`
// cursor over vmTets stays aligned as long as we consume it for exactly the
// non-wall elements.
function mapCoupledVonMises(
  vmTets: Float64Array,
  vmTris: Float64Array,
  nodes: Node[],
  elements: Element[],
  model: CoupledModel,
  nearestShell: (p: [number, number, number]) => number,
  shellBody: number,
  wallTets: Set<number>,
): Float64Array {
  const vmByShellNode = new Map<number, number>();
  for (let t = 0; t < model.triangles.length / 3; t++) {
    const facetVm = vmTris[t];
    for (const pi of [
      model.triangles[3 * t],
      model.triangles[3 * t + 1],
      model.triangles[3 * t + 2],
    ])
      // eslint-disable-next-line kofem/no-silent-fallback -- running max over adjacent facets; 0 is the identity for a node seen for the first time
      vmByShellNode.set(pi, Math.max(vmByShellNode.get(pi) ?? 0, facetVm));
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const vonMises = new Float64Array(elements.length);
  let solidIdx = 0;
  for (let e = 0; e < elements.length; e++) {
    // Solid tet (any other body, or the shelled body's retained base) → 1:1.
    // Only the shelled body's wall tets are represented by shells.
    if (!(elements[e].propertyId === shellBody && wallTets.has(e))) {
      vonMises[e] = vmTets[solidIdx++];
    } else {
      let cx = 0,
        cy = 0,
        cz = 0;
      for (const nid of elements[e].nodeIds) {
        const nd = nodeById.get(nid);
        if (!nd)
          throw new Error(
            `stress mapping: element ${elements[e].id} references unknown node id ${nid}`,
          );
        cx += nd.x;
        cy += nd.y;
        cz += nd.z;
      }
      const k = elements[e].nodeIds.length;
      const pi = nearestShell([cx / k, cy / k, cz / k]);
      // eslint-disable-next-line kofem/no-silent-fallback -- a mid-surface node not touched by any facet (isolated weld artefact) carries no recovered stress
      vonMises[e] = vmByShellNode.get(pi) ?? 0;
    }
  }
  return vonMises;
}

// Returns the coupled displacement/von-Mises result, or null when no body is
// marked Shell (→ the caller runs the all-solid path). `shellBodyIds` is the
// per-body Shell choice (property ids); an empty set means every body is solid.
function tryCoupledSolve(
  payload: SolvePayload,
  shellBodyIds: Set<number>,
): { displacements: Float64Array; vonMises: Float64Array } | null {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;
  const surfaceTriangles = payload.surfaceTriangles;
  const surfaceFaceIds = payload.surfaceFaceIds;
  if (!surfaceTriangles || !surfaceFaceIds || surfaceTriangles.length === 0)
    return null;
  if (surfaceFaceIds.length !== surfaceTriangles.length) return null;
  const tetElements = elements.filter((e) => e.type === "CTETRA");
  if (tetElements.length !== elements.length) return null; // coupled path is tets-only for now
  if (new Set(elements.map((e) => e.propertyId)).size < 2) return null; // need a multibody assembly

  const vid = buildVertexIndexer(nodes);
  const mesh = buildShellizeMesh(
    nodes,
    tetElements,
    surfaceTriangles,
    surfaceFaceIds,
    vid,
  );
  if (shellBodyIds.size === 0) return null; // every body solid → all-solid path
  const shells = extractThinWallShells(mesh, { shellBodyIds });
  if (shells.shellBody < 0)
    // A body is marked Shell but has no detectable thin walls — refuse loudly
    // rather than silently solving it as solid (which would ignore the choice).
    throw new Error(
      `Shell idealisation failed: body ${[...shellBodyIds].join(", ")} is marked "Shell" but no ` +
        "thin walls were found in it. Switch it to Solid, or check that it is genuinely thin-walled.",
    );

  // Only the shelled body's thin walls become shells; its thick base tets stay
  // solid (kept in the pool) so the load path through them is not lost. Distinct
  // solid bodies keep their own nodes and are joined only where the model has a
  // tie connection, by distributing couplings rather than node-merging, so a
  // gapped pin/hole interface is a proper force-and-moment tie instead of a
  // sparse near-hinge.
  const wallTets = shellWallTets(mesh, shells);
  const couplings = payload.couplings ?? [];
  const refIds = referencePointIds(couplings);
  const model = buildCoupledModel(mesh, shells, wallTets, {
    ties: coupledTies(payload.tieGroups, elements, vid),
    referencePoints: [...refIds].map((nodeId) =>
      vid(nodeId, "coupling reference point"),
    ),
  });
  if (model.coupling.ref.length === 0 && couplings.length === 0) return null; // shell doesn't couple to the solid

  const nearestShell = shellNodeLocator(model);
  const poolOf = (nodeId: number): number => {
    const vi = vid(nodeId, "coupled bc");
    const rp = model.refPool.get(vi);
    if (rp !== undefined) return rp;
    const sp = model.solidPool.get(vi);
    if (sp !== undefined) return sp;
    return nearestShell([
      mesh.V[3 * vi],
      mesh.V[3 * vi + 1],
      mesh.V[3 * vi + 2],
    ]);
  };
  const refPoolIndices = new Set(model.refPool.values());
  const isRefPoint = (pi: number) => refPoolIndices.has(pi);

  const fixed_dofs = coupledFixedDofs(
    constraints,
    poolOf,
    (pi) => isShellPoolIndex(model, pi),
    isRefPoint,
  );
  // A clamped shell rim can sit next to the retained base solid; the proximity
  // detector would otherwise couple the very nodes the user fixed (engine refuses
  // a fixed coupling-dependent node, #377). The BC wins.
  // The declared surface-to-point couplings ride on the same pool mapping as the
  // BCs: a coupled node whose thin wall was idealised away resolves to the
  // mid-surface node that replaced it, which is where its stiffness now lives.
  const coupling = concatCouplings(
    dropCouplingsOnFixedNodes(model.coupling, fixed_dofs),
    buildReferenceCouplings(couplings, (nodeId) => poolOf(nodeId)),
  );
  const { load_dofs, load_vals } = coupledLoads(
    loads,
    surfaceLoads,
    poolOf,
    isRefPoint,
  );

  // Solid bodies that actually contribute solid tets to the pool: the other
  // bodies plus the shelled body when its thick base survived (only its thin walls
  // became shells). A body that is ENTIRELY shelled contributes none, so it is not
  // part of the solid domain and its material must not be validated as such — the
  // wall-tet set (tet indices in tetElements order) tells them apart. They are
  // assembled with the single `solid` (E, ν); coupledMaterials rejects the case
  // where the solid domain spans more than one material (issue #376).
  const solidBodyIds = [
    ...new Set(
      tetElements
        .filter((_el, idx) => !wallTets.has(idx))
        .map((el) => el.propertyId),
    ),
  ];

  self.postMessage({
    id: 0,
    log: `[auto-shell] body ${shells.shellBody}: ${shells.walls.length} thin walls → ${model.shellPool.length} shell nodes, ${model.tets.length / 4} solid tets, ${coupling.ref.length} couplings`,
  });

  const result = m().solve_coupled(
    {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from(model.triangles),
      thicknesses: Float64Array.from(model.thicknesses),
    },
    {
      ref: Int32Array.from(coupling.ref),
      offsets: Int32Array.from(coupling.offsets),
      solid: Int32Array.from(coupling.solid),
      mpc: Int32Array.from(couplingMpcCodes(coupling)),
      dof_mask: Int32Array.from(couplingDofMasks(coupling)),
      relaxation: SHELL_SOLID_MPC_RELAXATION,
    },
    {
      fixed_dofs: Int32Array.from(fixed_dofs),
      load_dofs: Int32Array.from(load_dofs),
      load_vals: Float64Array.from(load_vals),
    },
    JSON.stringify(
      coupledMaterials(materials, properties, shells.shellBody, solidBodyIds),
    ),
  );
  if ("error" in result) throw new Error(result.error);

  const displacements = mapCoupledDisplacements(
    result.displacements,
    nodes,
    model,
    nearestShell,
  );
  const vonMises = mapCoupledVonMises(
    result.von_mises_tets,
    result.von_mises_tris,
    nodes,
    elements,
    model,
    nearestShell,
    shells.shellBody,
    wallTets,
  );
  return { displacements, vonMises };
}

// ── Pure auto-shell solve (thin single body / all-shell → solve_shell) ───────
//
// Nearest mid-surface node to a query point, grid-accelerated with an expanding
// ring search so it works whatever the wall offset. Standalone counterpart of
// shellNodeLocator (which needs a CoupledModel); here the pool IS the shell.
function buildNearestVertexLocator(
  verts: number[],
): (p: [number, number, number]) => number {
  const n = verts.length / 3;
  let span = 0;
  for (let d = 0; d < 3; d++) {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const val = verts[3 * i + d];
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    }
    span = Math.max(span, hi - lo);
  }
  // Cell ~ mean node spacing; the 1e-6 floor keeps it positive for a degenerate
  // (single-point) cloud.
  const cell = Math.max(span / Math.max(1, Math.cbrt(n)), 1e-6);
  const grid = new Map<string, number[]>();
  const gk = (x: number, y: number, z: number) =>
    `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < n; i++) {
    const key = gk(verts[3 * i], verts[3 * i + 1], verts[3 * i + 2]);
    getOrInitList(grid, key).push(i);
  }
  const maxRings = 32;
  return (p) => {
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell),
      cz = Math.floor(p[2] / cell);
    let best = -1,
      bd = Infinity;
    for (let r = 0; r <= maxRings && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            if (
              r > 0 &&
              Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r
            )
              continue; // ring shell only
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const i of bucket) {
              const dd =
                (p[0] - verts[3 * i]) ** 2 +
                (p[1] - verts[3 * i + 1]) ** 2 +
                (p[2] - verts[3 * i + 2]) ** 2;
              if (dd < bd) {
                bd = dd;
                best = i;
              }
            }
          }
    }
    if (best < 0)
      throw new Error(
        `pure shell: no mid-surface node found near query point (${p[0]}, ${p[1]}, ${p[2]}) — ` +
          "a boundary condition or load could not be mapped onto the shell mesh",
      );
    return best;
  };
}

function getOrInitList(map: Map<string, number[]>, key: string): number[] {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  return arr;
}

// A thin single body (or an assembly where EVERY body is marked Shell) has no
// solid domain to couple to, so tryCoupledSolve bails. Idealise its thin walls
// to a mid-surface shell mesh (extractThinWallShells) and solve it directly with
// the engine's Kirchhoff shell solver — the auto counterpart of handleShellSolve
// (which needs explicit CTRIA3 elements). BCs, loads and results map onto the
// collapsed mid-surface by nearest node, exactly as the coupled path maps the
// shelled body. Returns null when this path does not apply (a solid domain is
// present, or there is no surface mesh); throws when a body is marked Shell but
// carries no detectable thin wall — so the choice is never silently ignored.
function tryPureShellSolve(
  payload: SolvePayload,
  shellBodyIds: Set<number>,
): { displacements: Float64Array; vonMises: Float64Array } | null {
  const { nodes, elements, materials, properties, constraints, loads } =
    payload;
  const surfaceLoads = payload.surfaceLoads;
  const surfaceTriangles = payload.surfaceTriangles;
  const surfaceFaceIds = payload.surfaceFaceIds;
  if (!surfaceTriangles || !surfaceFaceIds || surfaceTriangles.length === 0)
    return null;
  if (surfaceFaceIds.length !== surfaceTriangles.length) return null;
  const tetElements = elements.filter((e) => e.type === "CTETRA");
  if (tetElements.length !== elements.length) return null; // tets-only idealisation
  // Only when there is NO solid domain to preserve: every body is idealised as a
  // shell. A mixed shell+solid assembly must go through the coupled path — pure
  // shells here would silently drop the solid bodies.
  if (!tetElements.every((e) => shellBodyIds.has(e.propertyId))) return null;

  const vid = buildVertexIndexer(nodes);
  const mesh = buildShellizeMesh(
    nodes,
    tetElements,
    surfaceTriangles,
    surfaceFaceIds,
    vid,
  );
  const shells = extractThinWallShells(mesh, { shellBodyIds });
  if (shells.shellBody < 0)
    throw new Error(
      `Shell idealisation failed: body ${[...shellBodyIds].join(", ")} is marked "Shell" but no ` +
        "thin walls were found in it. Switch it to Solid, or check that it is genuinely thin-walled.",
    );

  // Single (E, ν) for the whole shell domain — the shelled body's material.
  const prop = properties.find((p) => p.id === shells.shellBody);
  if (!prop)
    throw new Error(`pure shell: no property with id ${shells.shellBody}`);
  const mat = materials.find((mm) => mm.id === prop.materialId);
  if (!mat)
    throw new Error(
      `pure shell: property ${prop.id} references material ${prop.materialId}, which does not exist`,
    );

  const nearestShell = buildNearestVertexLocator(shells.shellVerts);
  const shellOf = (nodeId: number): number => {
    const vi = vid(nodeId, "pure shell bc");
    return nearestShell([
      mesh.V[3 * vi],
      mesh.V[3 * vi + 1],
      mesh.V[3 * vi + 2],
    ]);
  };

  // Reuse the coupled BC/load mapping (nearest-node lumping, 6·node+dof), then
  // fold it into the shell solver's fixed_vertices/fixed_dofs/point_loads form.
  const flatFixed = coupledFixedDofs(constraints, shellOf, () => true);
  const dofsByVertex = new Map<number, Set<number>>();
  for (const d of flatFixed)
    getOrInitDofs(dofsByVertex, Math.floor(d / 6)).add(d % 6);
  const fixed_vertices: number[] = [];
  const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
  for (const [vertex, dofSet] of dofsByVertex) {
    if (dofSet.size === 6) fixed_vertices.push(vertex);
    else fixed_dofs.push({ vertex, dofs: [...dofSet].sort((a, b) => a - b) });
  }

  const { load_dofs, load_vals } = coupledLoads(loads, surfaceLoads, shellOf);
  const forceByVertex = new Map<number, [number, number, number]>();
  for (let k = 0; k < load_dofs.length; k++) {
    const vertex = Math.floor(load_dofs[k] / 6);
    const comp = load_dofs[k] % 6;
    let acc = forceByVertex.get(vertex);
    if (!acc) {
      acc = [0, 0, 0];
      forceByVertex.set(vertex, acc);
    }
    if (comp <= 2) acc[comp] += load_vals[k];
  }
  const point_loads = [...forceByVertex.entries()].map(([vertex, force]) => ({
    vertex,
    force,
  }));

  self.postMessage({
    id: 0,
    log: `[auto-shell] body ${shells.shellBody}: ${shells.walls.length} thin walls → ${shells.shellVerts.length / 3} shell nodes, ${shells.shellTris.length / 3} facets (pure shell, no solid to couple)`,
  });

  const result = m().solve_shell(
    {
      vertices: Float64Array.from(shells.shellVerts),
      triangles: Int32Array.from(shells.shellTris),
      thicknesses: Float64Array.from(shells.shellThk),
    },
    JSON.stringify({ young_modulus: mat.young, poisson_ratio: mat.poisson }),
    JSON.stringify({ fixed_vertices, fixed_dofs, point_loads }),
  );
  if ("error" in result) throw new Error(result.error);

  // Displacements: every store node takes its nearest mid-surface node's three
  // translations (the mid-surface is offset ~t/2 from the original solid faces).
  const displacements = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const si = nearestShell([nodes[i].x, nodes[i].y, nodes[i].z]);
    displacements[3 * i] = result.displacements[3 * si];
    displacements[3 * i + 1] = result.displacements[3 * si + 1];
    displacements[3 * i + 2] = result.displacements[3 * si + 2];
  }

  // Von Mises per original tet: the worst surface stress of the shell facets
  // adjacent to the tet's nearest mid-surface node (the same recovery the coupled
  // path uses for wall elements).
  const vmByShellNode = new Map<number, number>();
  for (let t = 0; t < shells.shellTris.length / 3; t++) {
    const facetVm = result.von_mises[t];
    for (const si of [
      shells.shellTris[3 * t],
      shells.shellTris[3 * t + 1],
      shells.shellTris[3 * t + 2],
    ])
      // eslint-disable-next-line kofem/no-silent-fallback -- running max over adjacent facets; 0 is the identity for a node seen for the first time
      vmByShellNode.set(si, Math.max(vmByShellNode.get(si) ?? 0, facetVm));
  }
  const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
  const vonMises = new Float64Array(elements.length);
  for (let e = 0; e < elements.length; e++) {
    let cx = 0,
      cy = 0,
      cz = 0;
    for (const nid of elements[e].nodeIds) {
      const nd = nodeById.get(nid);
      if (!nd)
        throw new Error(
          `pure shell stress mapping: element ${elements[e].id} references unknown node id ${nid}`,
        );
      cx += nd.x;
      cy += nd.y;
      cz += nd.z;
    }
    const k = elements[e].nodeIds.length;
    const si = nearestShell([cx / k, cy / k, cz / k]);
    // eslint-disable-next-line kofem/no-silent-fallback -- a mid-surface node not touched by any facet carries no recovered stress
    vonMises[e] = vmByShellNode.get(si) ?? 0;
  }
  return { displacements, vonMises };
}

function getOrInitDofs(
  map: Map<number, Set<number>>,
  key: number,
): Set<number> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

// ── Mixed shell/solid solve (explicit CTRIA3 + CTETRA → solve_coupled) ────────

// Single (E, ν) per domain for the coupled assembler, resolved from the explicit
// element → property → material chain. The coupled solid-shell solver takes one
// material for the whole solid domain and one for the whole shell domain (issue
// #376), so a domain spanning several materials is refused loudly rather than
// solved with the wrong stiffness on part of it.
function mixedCoupledMaterials(
  materials: Material[],
  properties: Property[],
  shellElements: Element[],
  solidElements: Element[],
) {
  const propById = new Map(properties.map((p) => [p.id, p]));
  const matById = new Map(materials.map((mat) => [mat.id, mat]));
  const materialOf = (el: Element, domain: string): Material => {
    const prop = propById.get(el.propertyId);
    if (!prop)
      throw new Error(
        `mixed solve: ${domain} element ${el.id} belongs to body ${el.propertyId}, ` +
          "which has no property — the model is inconsistent",
      );
    const mat = matById.get(prop.materialId);
    if (!mat)
      throw new Error(
        `mixed solve: property ${prop.id} references material ${prop.materialId}, ` +
          "which does not exist",
      );
    return mat;
  };

  // Solid: one entry per distinct material, selected per tet by `attributes`
  // (1-based) — a steel bracket carrying an aluminium part is one solve.
  if (solidElements.length === 0)
    throw new Error("mixed solve: the model has no solid element");
  const solidOrder: Material[] = [];
  const solidIndex = new Map<number, number>();
  const solidAttributes = solidElements.map((el) => {
    const mat = materialOf(el, "solid");
    let at = solidIndex.get(mat.id);
    if (at === undefined) {
      at = solidOrder.push(mat); // 1-based: push returns the new length
      solidIndex.set(mat.id, at);
    }
    return at;
  });

  // Shell: still exactly one. A solve idealises a single body as shells (#376),
  // so several shell materials means the model, not the solver, is inconsistent.
  const shellUsed = new Map<number, Material>();
  for (const el of shellElements) {
    const mat = materialOf(el, "shell");
    shellUsed.set(mat.id, mat);
  }
  // A model with NO shell element takes this path when it carries a
  // surface-to-point coupling: the coupled assembler is what applies an RBE2/RBE3
  // constraint, and it accepts zero triangles. `mat.shell` is still read by
  // solve_coupled, so it gets the first solid material — with no facet to
  // assemble it can only be unused, and inventing an arbitrary modulus would
  // print a stiffness that is not in the model anywhere.
  if (shellUsed.size === 0 && shellElements.length === 0)
    return {
      mat: {
        solid: solidOrder.map((mat) => ({
          young_modulus: mat.young,
          poisson_ratio: mat.poisson,
        })),
        shell: {
          young_modulus: solidOrder[0].young,
          poisson_ratio: solidOrder[0].poisson,
        },
      },
      solidAttributes,
      solidMaterialNames: solidOrder.map((mat) => mat.name),
    };
  if (shellUsed.size === 0)
    throw new Error("mixed solve: the model has no shell element");
  if (shellUsed.size > 1) {
    const names = [...shellUsed.values()].map((mat) => mat.name).join(", ");
    throw new Error(
      "mixed solve: one body is idealised as shells per solve, so the shell elements carry one " +
        `material — these span ${shellUsed.size} (${names}). Assign a single material to the ` +
        "shelled body.",
    );
  }
  const shellMat = [...shellUsed.values()][0];
  return {
    mat: {
      solid: solidOrder.map((mat) => ({
        young_modulus: mat.young,
        poisson_ratio: mat.poisson,
      })),
      shell: { young_modulus: shellMat.young, poisson_ratio: shellMat.poisson },
    },
    solidAttributes,
    solidMaterialNames: solidOrder.map((mat) => mat.name),
  };
}

// Per-facet shell thickness from each CTRIA3 element's PSHELL property, in shell
// element order (matching the triangles handed to solve_coupled).
function resolveMixedThicknesses(
  shellElements: Element[],
  properties: Property[],
): number[] {
  const propById = new Map(properties.map((p) => [p.id, p]));
  return shellElements.map((el) => {
    const prop = propById.get(el.propertyId);
    if (!prop)
      throw new Error(
        `mixed solve: shell element ${el.id} belongs to body ${el.propertyId}, ` +
          "which has no property — the model is inconsistent",
      );
    if (typeof prop.thickness !== "number" || prop.thickness <= 0)
      throw new Error(
        `mixed solve: property ${prop.id} has no positive shell thickness — ` +
          "shell (CTRIA3) elements require a thickness on their property",
      );
    return prop.thickness;
  });
}

// Solve a hand-mixed shell+solid model (explicit CTRIA3 shells alongside CTETRA
// solids) through the engine's coupled solid-shell solver. The CTRIA3 elements
// become DKT shell facets (per-facet thickness from their PSHELL property), the
// CTETRA elements the solid tets, and the two domains are joined by RBE3
// distributing couplings re-derived from proximity — the same pipeline the
// auto-shell path uses, only with the shells given explicitly instead of
// idealised from thin solid walls. Constraints/loads map onto the 6-DOF pool the
// same way the auto-shell path does (coupledFixedDofs/coupledLoads). elementOrder
// does not apply (the coupled assembler is linear tets + DKT facets).
//
// An ALL-SOLID model comes here too when it carries a surface-to-point coupling:
// an RBE2/RBE3 constraint only exists in this assembler, and it is happy with
// zero shell triangles. Nothing else about the path changes — the shell arrays
// are simply empty.
function handleMixedSolve(id: number, payload: SolvePayload) {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;

  const shellElements = elements.filter((e) => e.type === "CTRIA3");
  const solidElements = elements.filter((e) => e.type !== "CTRIA3");
  const nonTet = solidElements.find((e) => e.type !== "CTETRA");
  if (nonTet)
    throw new Error(
      `mixed solve: solid element ${nonTet.id} is a ${nonTet.type} — the coupled ` +
        "solid-shell solver supports CTETRA solids only; mesh the solid bodies as tetrahedra",
    );
  if (solidElements.length === 0)
    throw new Error(
      "mixed solve: no solid (CTETRA) elements — a mixed model needs at least one solid body",
    );

  const vid = buildVertexIndexer(nodes);
  const verts = new Array<number>(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    verts[3 * i] = nodes[i].x;
    verts[3 * i + 1] = nodes[i].y;
    verts[3 * i + 2] = nodes[i].z;
  }
  const solidTets: number[] = [];
  for (const el of solidElements) {
    if (el.nodeIds.length !== 4)
      throw new Error(
        `CTETRA element ${el.id} has ${el.nodeIds.length} nodes — expected 4`,
      );
    for (const nid of el.nodeIds) solidTets.push(vid(nid, "CTETRA element"));
  }
  const shellTris: number[] = [];
  for (const el of shellElements) {
    if (el.nodeIds.length !== 3)
      throw new Error(
        `CTRIA3 element ${el.id} has ${el.nodeIds.length} nodes — expected 3`,
      );
    for (const nid of el.nodeIds) shellTris.push(vid(nid, "CTRIA3 element"));
  }
  const thicknesses = resolveMixedThicknesses(shellElements, properties);

  // Reference points belong to no element, so they enter the pool explicitly.
  const couplings = payload.couplings ?? [];
  const refIds = referencePointIds(couplings);
  const model = buildExplicitCoupledModel(
    verts,
    solidTets,
    shellTris,
    thicknesses,
    {
      ties: coupledTies(payload.tieGroups, elements, vid),
      referencePoints: [...refIds].map((nodeId) =>
        vid(nodeId, "coupling reference point"),
      ),
    },
  );

  const poolOf = (nodeId: number): number => {
    const pi = model.poolOfVertex.get(vid(nodeId, "coupled bc/load"));
    if (pi === undefined)
      throw new Error(
        `mixed solve: node ${nodeId} carries a boundary condition or load but is not part of ` +
          "any shell or solid element — the model is inconsistent",
      );
    return pi;
  };
  const refPoolIndices = new Set([...refIds].map((nodeId) => poolOf(nodeId)));
  const isRefPoint = (pi: number) => refPoolIndices.has(pi);
  const fixed_dofs = coupledFixedDofs(
    constraints,
    poolOf,
    (pi) => model.shellPoolIndex.has(pi),
    isRefPoint,
  );
  // A clamped shell node that also sits within coupling range of the solid would
  // be both fixed and a distributing-coupling dependent — the engine refuses that
  // (#377). The BC wins; drop the coupling on those nodes.
  const coupling = concatCouplings(
    dropCouplingsOnFixedNodes(model.coupling, fixed_dofs),
    buildReferenceCouplings(couplings, (nodeId, context) => {
      const pi = model.poolOfVertex.get(vid(nodeId, context));
      if (pi === undefined)
        throw new Error(
          `${context}: node ${nodeId} is not part of the solved model — re-pick the ` +
            "coupled surface, or delete the coupling.",
        );
      return pi;
    }),
  );
  const { load_dofs, load_vals } = coupledLoads(
    loads,
    surfaceLoads,
    poolOf,
    isRefPoint,
  );
  const { mat, solidAttributes, solidMaterialNames } = mixedCoupledMaterials(
    materials,
    properties,
    shellElements,
    solidElements,
  );

  self.postMessage({
    id,
    log: `[mixed] ${solidElements.length} solid tets (${solidMaterialNames.join(", ")}), ${shellElements.length} shell facets → ${model.pool.length / 3} pool nodes, ${coupling.ref.length} couplings (${couplings.length} declared)…`,
  });

  const result = m().solve_coupled(
    {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from(model.triangles),
      thicknesses: Float64Array.from(model.thicknesses),
      attributes: Int32Array.from(solidAttributes),
    },
    {
      ref: Int32Array.from(coupling.ref),
      offsets: Int32Array.from(coupling.offsets),
      solid: Int32Array.from(coupling.solid),
      mpc: Int32Array.from(couplingMpcCodes(coupling)),
      dof_mask: Int32Array.from(couplingDofMasks(coupling)),
      relaxation: SHELL_SOLID_MPC_RELAXATION,
    },
    {
      fixed_dofs: Int32Array.from(fixed_dofs),
      load_dofs: Int32Array.from(load_dofs),
      load_vals: Float64Array.from(load_vals),
    },
    JSON.stringify(mat),
  );
  if ("error" in result) throw new Error(result.error);

  // Displacements: every store node maps to its pool node (solid and shell store
  // nodes both live in the pool). Von Mises: one solid-tet value per CTETRA and
  // one shell-facet value per CTRIA3, in the order they crossed the WASM boundary
  // (solid tets first, then shell triangles) — walk the original element list and
  // pull from whichever field the element type selects.
  const displacements = new Float64Array(3 * nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    // A node in no element is not part of the solve; it stays at rest (u = 0).
    const pi = model.poolOfVertex.get(i);
    if (pi === undefined) continue;
    displacements[3 * i] = result.displacements[3 * pi];
    displacements[3 * i + 1] = result.displacements[3 * pi + 1];
    displacements[3 * i + 2] = result.displacements[3 * pi + 2];
  }
  const vonMises = new Float64Array(elements.length);
  let solidIdx = 0,
    shellIdx = 0;
  for (let e = 0; e < elements.length; e++) {
    vonMises[e] =
      elements[e].type === "CTRIA3"
        ? result.von_mises_tris[shellIdx++]
        : result.von_mises_tets[solidIdx++];
  }

  self.postMessage({
    id,
    log: `Mixed solve complete: ${displacements.length / 3} vertex displacements, ${vonMises.length} element stresses`,
  });
  self.postMessage({ id, ok: true, displacements, vonMises }, [
    displacements.buffer,
    vonMises.buffer,
  ]);
}

function handleSolve(id: number, payload: SolvePayload) {
  // Shell models route away from the all-solid path. A model that is ALL CTRIA3
  // solves via the Kirchhoff shell solver; a model that MIXES CTRIA3 shells with
  // solid elements solves via the coupled solid-shell solver (the shells are
  // explicit here, unlike the auto-shell path below, which idealises thin SOLID
  // bodies itself).
  const nShells = payload.elements.filter((e) => e.type === "CTRIA3").length;
  // eslint-disable-next-line kofem/no-silent-fallback -- `couplings` is optional in the solve message; a model with none is the ordinary case
  const nCouplings = payload.couplings?.length ?? 0;
  if (nShells > 0) {
    // A coupling is an RBE2/RBE3 constraint, and only the coupled assembler
    // applies one — the pure Kirchhoff shell solver has no couplings, and the
    // coupled assembler needs a solid domain to assemble. An all-shell model
    // therefore cannot carry a coupling today; say so, rather than solve it
    // as if the coupling were not there.
    if (nShells === payload.elements.length && nCouplings > 0)
      throw new Error(
        `This model is all shell elements and declares ${nCouplings} surface-to-point ` +
          "coupling(s), which the shell solver cannot apply — a coupling needs the " +
          "coupled solid-shell assembler, and that needs at least one solid body. " +
          "Delete the coupling, or keep one body solid.",
      );
    if (nShells === payload.elements.length) handleShellSolve(id, payload);
    else handleMixedSolve(id, payload);
    return;
  }
  // An all-solid model that declares a surface-to-point coupling still needs the
  // coupled assembler — solve_linear_elastic has no notion of an RBE2/RBE3
  // constraint, and the reference point is not even a node it could carry.
  if (nCouplings > 0) {
    handleMixedSolve(id, payload);
    return;
  }

  // A body marked "Shell" is idealised as shells and solved coupled to the solid
  // bodies — this converges where the all-solid solve of the thin part stalls
  // (#358). Which bodies are shells is the per-body Shell/Solid choice
  // (Property.discretization), set for every body at import by detectShellBodies
  // and editable in the UI. No bodies marked Shell ⇒ the all-solid path.
  const shellBodyIds = new Set(
    payload.properties
      .filter((p) => p.discretization === "shell")
      .map((p) => p.id),
  );
  if (shellBodyIds.size > 0) {
    // A body is marked Shell: solve it as shells or fail loudly — never fall
    // through to the all-solid path, which would silently ignore the choice.
    // Coupled first (shells tied to solid bodies); if there is no solid domain
    // to couple to (a single thin body, or an all-shell assembly), idealise the
    // thin walls and solve them with the pure Kirchhoff shell solver.
    const shellResult =
      tryCoupledSolve(payload, shellBodyIds) ??
      tryPureShellSolve(payload, shellBodyIds);
    if (shellResult) {
      self.postMessage({
        id,
        log: `Shell solve complete: ${shellResult.displacements.length / 3} vertex displacements`,
      });
      self.postMessage(
        {
          id,
          ok: true,
          displacements: shellResult.displacements,
          vonMises: shellResult.vonMises,
        },
        [shellResult.displacements.buffer, shellResult.vonMises.buffer],
      );
      return;
    }
  }

  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;

  // Tie conditions (#359): weld the node pairs of every connection the user
  // defined, so parts that touch without a shared face are joined for the solve.
  // A no-op when the model has none, in which case solveNodes/tiedElements are
  // the originals and every step below is unchanged.
  const tieGroups = payload.tieGroups ?? [];
  const tie = buildTie(nodes, elements, tieGroups);
  const solveNodes = tie.nodes;
  const tiedElements =
    tie.repOf.size > 0
      ? elements.map((el) => remapElement(el, tie.repOf))
      : elements;
  if (tie.repOf.size > 0) assertNoCollapsedElements(tiedElements);
  for (const report of tie.reports) {
    // A connection that welds nothing AND shares no nodes joins nothing: the
    // assembly stays split and the solve would fail far from the cause.
    if (report.nPaired === 0 && report.nShared === 0)
      throw new Error(
        `Tie "${report.name}" connected no nodes — its two surfaces have no ` +
          "node pairs within the search distance. Increase the distance, or " +
          "couple the full surface.",
      );
    self.postMessage({
      id,
      log: `Tie "${report.name}": welded ${report.nPaired} node pair(s) up to ${report.maxDistance.toFixed(4)} mm apart${report.nShared > 0 ? `, ${report.nShared} already shared` : ""}`,
    });
  }
  if (tie.nWelded > 0)
    self.postMessage({
      id,
      log: `Ties merged ${tie.nWelded} node(s); ${solveNodes.length} nodes remain`,
    });

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
  } finally {
    flushCoverage();
  }
};
