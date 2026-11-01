// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Auto-shell: a body the user marked "Shell" has its thin walls idealised to a
// mid-surface shell mesh. At mesh time this produces the stored mixed CTRIA3 +
// CTETRA model; at solve time (an all-tet model whose Shell body was not yet
// idealised) it builds the coupled or pure-shell engine inputs and maps the
// result back onto the original mesh. The mid-surface extraction itself lives
// in shellize.ts.

import type {
  Element,
  Node,
  Property,
  SolvePayload,
} from "../../workers/solverTypes.js";
import type { ShellMesh } from "../../wasm/pkg/kofem_wasm.js";
import { coupledMaterials } from "../coupledMaterials.js";
import { buildReferenceCouplings, referencePointIds } from "../coupling.js";
import {
  extractThinWallShells,
  shellBodyTets,
  buildCoupledModel,
  buildShellTransitionModel,
  dropCouplingsOnFixedNodes,
  shellNodeLocator,
  isShellPoolIndex,
  concatCouplings,
  type CoupledModel,
  type ShellizeMesh,
  type ShellExtraction,
} from "../shellize.js";
import { buildVertexIndexer, type VertexIndexer } from "../solveMeshPacking.js";
import {
  coupledFixedDofs,
  coupledLoads,
  coupledToShellDirichlet,
  coupledToShellPointLoads,
} from "./bcs.js";
import {
  coupledTies,
  engineCoupledBcs,
  engineCoupling,
  reportTieCouplings,
  type EngineCoupledBcs,
  type EngineCoupling,
  type SolveLog,
} from "./coupled.js";
import {
  buildNearestVertexLocator,
  maxFacetStressPerNode,
  shellStressAtCentroid,
  type NearestLocator,
} from "./shellMapping.js";

export interface SolveFields {
  displacements: Float64Array;
  vonMises: Float64Array;
}

// The bodies marked Shell that take part in the analysis. A suppressed body was
// left out of the mesh, so its element type no longer applies.
export function shellMarkedBodies(properties: Property[]): Property[] {
  return properties.filter(
    (p) => p.discretization === "shell" && !p.suppressed,
  );
}

// The coupled and shell solvers take a single shell material (#376), so one body
// is idealised per model. Marking a second would leave it solid behind the
// user's back — refuse instead.
export function requireOneShellBody(shellBodyIds: Set<number>): void {
  if (shellBodyIds.size > 1)
    throw new Error(
      `Bodies ${[...shellBodyIds].join(", ")} are all marked "Shell", but one body per ` +
        "model can be idealised as shells today. Keep one of them Shell and set the " +
        "others to Solid.",
    );
}

// Flat 0-based mesh for the shellize pipeline, built from the store model.
export function buildShellizeMesh(
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

// Extract the Shell body's thin walls, refusing loudly when the body carries
// none — a Shell choice is never silently solved as solid.
function extractShellsOrThrow(
  mesh: ShellizeMesh,
  shellBodyIds: Set<number>,
): ShellExtraction {
  const shells = extractThinWallShells(mesh, { shellBodyIds });
  if (shells.shellBody < 0)
    throw new Error(
      `Shell idealisation failed: body ${[...shellBodyIds].join(", ")} is marked "Shell" but no ` +
        "thin walls were found in it. Switch it to Solid, or check that it is genuinely thin-walled.",
    );
  return shells;
}

// The all-tet model with a surface mesh the solve-time idealisation needs, or
// null when it does not apply (no surface mesh, or non-tet elements).
function tetShellizeInput(payload: SolvePayload): {
  tetElements: Element[];
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
} | null {
  const { elements, surfaceTriangles, surfaceFaceIds } = payload;
  if (!surfaceTriangles || !surfaceFaceIds || surfaceTriangles.length === 0)
    return null;
  if (surfaceFaceIds.length !== surfaceTriangles.length) return null;
  const tetElements = elements.filter((e) => e.type === "CTETRA");
  if (tetElements.length !== elements.length) return null; // tets-only idealisation
  return { tetElements, surfaceTriangles, surfaceFaceIds };
}

// ── Mesh-time idealisation (#397) ─────────────────────────────────────────────

export interface MeshTimeShellModel {
  nodes: Node[];
  elements: Element[];
  properties: Property[];
  surfaceTriangles: [number, number, number][];
  surfaceFaceIds: number[];
}

// Idealise the Shell-marked body into a mid-surface shell mesh and
// return the mixed model to store: the coupled node pool, the retained solid tets
// as CTETRA, and the collapsed wall facets as CTRIA3. Thickness is per SECTION —
// detectWallPairs measures each wall pair separately, so one PSHELL property is
// emitted per distinct wall thickness and each facet references its own (the same
// scheme the offline crane generator uses). Solid bodies keep their existing
// property ids, so material assignments survive the mesh. Returns null when the
// idealisation does not apply (no Shell body, no surface mesh, or no thin wall
// found), leaving the caller's all-solid mesh in place.
export function buildMeshTimeShellModel(
  nodes: Node[],
  elements: Element[],
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
  shellBodyIds: Set<number>,
  properties: Property[],
  log: SolveLog,
): MeshTimeShellModel | null {
  if (shellBodyIds.size === 0) return null;
  requireOneShellBody(shellBodyIds);
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
  const shells = extractShellsOrThrow(mesh, shellBodyIds);
  // No ties here: this runs at MESH time, before any surface can have been
  // picked. It only needs the pool's node/element layout — the couplings are
  // rebuilt at solve time from the connections the user defined by then.
  const transition = buildShellTransitionModel(mesh, shells);
  const model = transition.model;

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
    rebuildPoolSurface(
      model,
      shells,
      Array.from(
        { length: transition.mesh.surfFace.length },
        (_, index) =>
          transition.mesh.surfTri.slice(3 * index, 3 * index + 3) as [
            number,
            number,
            number,
          ],
      ),
      transition.mesh.surfFace,
    );

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
export function rebuildPoolSurface(
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

// ── Solve-time auto-shell coupled to the solid bodies (→ solve_coupled) ───────

// Map pool displacements onto every original store node: solid nodes directly,
// the shelled body's nodes from their nearest mid-surface node.
export function mapCoupledDisplacements(
  rd: Float64Array,
  nodes: Node[],
  model: CoupledModel,
  nearestShell: NearestLocator,
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
export function mapCoupledVonMises(
  vmTets: Float64Array,
  vmTris: Float64Array,
  nodes: Node[],
  elements: Element[],
  model: CoupledModel,
  nearestShell: NearestLocator,
  shellBody: number,
  wallTets: Set<number>,
): Float64Array {
  const vmByShellNode = maxFacetStressPerNode(model.triangles, vmTris);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const vonMises = new Float64Array(elements.length);
  let solidIdx = 0;
  for (let e = 0; e < elements.length; e++) {
    // Solid tet (any other body, or the shelled body's retained base) → 1:1.
    // Only the shelled body's wall tets are represented by shells.
    if (!(elements[e].propertyId === shellBody && wallTets.has(e))) {
      vonMises[e] = vmTets[solidIdx++];
    } else {
      vonMises[e] = shellStressAtCentroid(
        elements[e],
        nodeById,
        nearestShell,
        vmByShellNode,
        "stress mapping",
      );
    }
  }
  return vonMises;
}

// The coupled-assembler inputs of an auto-shell model, plus the mapping of the
// engine's pool result back onto the original store mesh.
export interface AutoCoupledSolve {
  mesh: {
    vertices: Float64Array;
    tets: Int32Array;
    triangles: Int32Array;
    thicknesses: Float64Array;
  };
  coupling: EngineCoupling;
  bcs: EngineCoupledBcs;
  matJson: string;
  mapResult: (result: {
    displacements: Float64Array;
    von_mises_tets: Float64Array;
    von_mises_tris: Float64Array;
  }) => SolveFields;
}

// Build the coupled solve of an all-tet multibody model whose Shell body is
// idealised at solve time. Returns null when this path does not apply — no
// surface mesh, non-tet elements, a single body, no Shell body, or a shell that
// does not couple to any solid — so the caller can try the pure-shell path.
// Throws when a body is marked Shell but carries no detectable thin wall.
export function prepareAutoCoupledSolve(
  payload: SolvePayload,
  shellBodyIds: Set<number>,
  log: SolveLog,
): AutoCoupledSolve | null {
  const {
    nodes,
    elements,
    materials,
    properties,
    constraints,
    loads,
    surfaceLoads,
  } = payload;
  const input = tetShellizeInput(payload);
  if (!input) return null;
  const { tetElements } = input;
  if (new Set(elements.map((e) => e.propertyId)).size < 2) return null; // need a multibody assembly
  if (shellBodyIds.size === 0) return null; // every body solid → all-solid path

  const vid = buildVertexIndexer(nodes);
  const mesh = buildShellizeMesh(
    nodes,
    tetElements,
    input.surfaceTriangles,
    input.surfaceFaceIds,
    vid,
  );
  const shells = extractShellsOrThrow(mesh, shellBodyIds);

  // The shelled body becomes shells everywhere (shellBodyTets). Distinct
  // solid bodies keep their own nodes and are joined only where the model has a
  // tie connection, by distributing couplings rather than node-merging, so a
  // gapped pin/hole interface is a proper force-and-moment tie instead of a
  // sparse near-hinge.
  const wallTets = shellBodyTets(mesh, shells);
  const couplings = payload.couplings ?? [];
  const refIds = referencePointIds(couplings);
  const model = buildCoupledModel(mesh, shells, wallTets, {
    ties: coupledTies(payload.tieGroups, elements, vid),
    referencePoints: [...refIds].map((nodeId) =>
      vid(nodeId, "coupling reference point"),
    ),
  });
  // Before the bail below: a dropped tie must not be hidden by falling through to
  // the pure-shell path, which would solve a different model entirely.
  reportTieCouplings(model.tieReports, log);
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

  const dirichlet = coupledFixedDofs(
    constraints,
    poolOf,
    (pi) => isShellPoolIndex(model, pi),
    isRefPoint,
  );
  // A clamped or DRIVEN shell rim can sit next to the retained base solid; the
  // proximity detector would otherwise couple the very nodes the user constrained
  // (the engine refuses a constrained coupling-dependent node, #377/KOF-210). The
  // BC wins, for a prescribed displacement exactly as for a clamp.
  // The declared surface-to-point couplings ride on the same pool mapping as the
  // BCs: a coupled node whose thin wall was idealised away resolves to the
  // mid-surface node that replaced it, which is where its stiffness now lives.
  const coupling = concatCouplings(
    dropCouplingsOnFixedNodes(model.coupling, [
      ...dirichlet.fixed_dofs,
      ...dirichlet.prescribed_dofs,
    ]),
    buildReferenceCouplings(couplings, (nodeId) => poolOf(nodeId)),
  );
  const nodalLoads = coupledLoads(
    loads,
    surfaceLoads,
    poolOf,
    isRefPoint,
    nodes,
    vid,
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

  log(
    `[auto-shell] body ${shells.shellBody}: ${shells.walls.length} thin walls → ${model.shellPool.length} shell nodes, ${model.tets.length / 4} solid tets, ${coupling.ref.length} couplings`,
  );
  const matJson = JSON.stringify(
    coupledMaterials(materials, properties, shells.shellBody, solidBodyIds),
  );

  return {
    mesh: {
      vertices: Float64Array.from(model.pool),
      tets: Int32Array.from(model.tets),
      triangles: Int32Array.from(model.triangles),
      thicknesses: Float64Array.from(model.thicknesses),
    },
    coupling: engineCoupling(coupling),
    bcs: engineCoupledBcs(dirichlet, nodalLoads),
    matJson,
    mapResult: (result) => ({
      displacements: mapCoupledDisplacements(
        result.displacements,
        nodes,
        model,
        nearestShell,
      ),
      vonMises: mapCoupledVonMises(
        result.von_mises_tets,
        result.von_mises_tris,
        nodes,
        elements,
        model,
        nearestShell,
        shells.shellBody,
        wallTets,
      ),
    }),
  };
}

// ── Solve-time pure auto-shell (thin single body / all-shell → solve_shell) ───

export interface PureShellSolve {
  mesh: Required<ShellMesh>;
  matJson: string;
  bcsJson: string;
  mapResult: (result: {
    displacements: Float64Array;
    von_mises: Float64Array;
  }) => SolveFields;
}

// A thin single body (or an assembly where EVERY body is marked Shell) has no
// solid domain to couple to, so prepareAutoCoupledSolve bails. Idealise its
// thin walls to a mid-surface shell mesh and solve it directly with the
// engine's Kirchhoff shell solver — the auto counterpart of the explicit
// CTRIA3 shell path. BCs, loads and results map onto the collapsed mid-surface
// by nearest node, exactly as the coupled path maps the shelled body. Returns
// null when this path does not apply (a solid domain is present, or there is no
// surface mesh); throws when a body is marked Shell but carries no detectable
// thin wall — so the choice is never silently ignored.
export function preparePureShellSolve(
  payload: SolvePayload,
  shellBodyIds: Set<number>,
  log: SolveLog,
): PureShellSolve | null {
  const { nodes, elements, materials, properties, constraints, loads } =
    payload;
  const input = tetShellizeInput(payload);
  if (!input) return null;
  const { tetElements } = input;
  // Only when there is NO solid domain to preserve: every body is idealised as a
  // shell. A mixed shell+solid assembly must go through the coupled path — pure
  // shells here would silently drop the solid bodies.
  if (!tetElements.every((e) => shellBodyIds.has(e.propertyId))) return null;

  const vid = buildVertexIndexer(nodes);
  const mesh = buildShellizeMesh(
    nodes,
    tetElements,
    input.surfaceTriangles,
    input.surfaceFaceIds,
    vid,
  );
  const shells = extractShellsOrThrow(mesh, shellBodyIds);

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

  // Reuse the coupled BC/load mapping (work-equivalent loads, 6·node+dof), then
  // fold it into the shell solver's fixed_vertices/fixed_dofs/point_loads form.
  // Every node here is a shell node and none is a coupling reference point: an
  // all-shell model that declares a coupling is refused by the solve routing,
  // because only the coupled assembler applies one.
  const noReferencePoints: (poolIndex: number) => boolean = () => false;
  const dirichlet = coupledToShellDirichlet(
    coupledFixedDofs(constraints, shellOf, () => true, noReferencePoints),
  );
  const { load_dofs, load_vals } = coupledLoads(
    loads,
    payload.surfaceLoads,
    shellOf,
    noReferencePoints,
    nodes,
    vid,
  );
  const point_loads = coupledToShellPointLoads(load_dofs, load_vals);

  log(
    `[auto-shell] body ${shells.shellBody}: ${shells.walls.length} thin walls → ${shells.shellVerts.length / 3} shell nodes, ${shells.shellTris.length / 3} facets (pure shell, no solid to couple)`,
  );

  return {
    mesh: {
      vertices: Float64Array.from(shells.shellVerts),
      triangles: Int32Array.from(shells.shellTris),
      thicknesses: Float64Array.from(shells.shellThk),
    },
    matJson: JSON.stringify({
      young_modulus: mat.young,
      poisson_ratio: mat.poisson,
    }),
    bcsJson: JSON.stringify({ ...dirichlet, point_loads }),
    mapResult: (result) => {
      // Displacements: every store node takes its nearest mid-surface node's
      // three translations (the mid-surface is offset ~t/2 from the original
      // solid faces).
      const displacements = new Float64Array(3 * nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const si = nearestShell([nodes[i].x, nodes[i].y, nodes[i].z]);
        displacements[3 * i] = result.displacements[3 * si];
        displacements[3 * i + 1] = result.displacements[3 * si + 1];
        displacements[3 * i + 2] = result.displacements[3 * si + 2];
      }
      // Von Mises per original tet: the worst surface stress of the shell
      // facets adjacent to the tet's nearest mid-surface node (the same
      // recovery the coupled path uses for wall elements).
      const vmByShellNode = maxFacetStressPerNode(
        shells.shellTris,
        result.von_mises,
      );
      const nodeById = new Map(nodes.map((nd) => [nd.id, nd]));
      const vonMises = new Float64Array(elements.length);
      for (let e = 0; e < elements.length; e++)
        vonMises[e] = shellStressAtCentroid(
          elements[e],
          nodeById,
          nearestShell,
          vmByShellNode,
          "pure shell stress mapping",
        );
      return { displacements, vonMises };
    },
  };
}
