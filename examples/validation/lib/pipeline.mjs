// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The node-side build of an example from its recipe (KOF-322): the steps a
// user takes in the KoFEM GUI, run through the same engine calls and the same
// app code, so the number this build publishes is the number the Results panel
// shows after a user rebuilds the example by hand.
//
//   import      tessellate_step on the recipe's STEP text (the worker's
//               loadGeometry), one property per CAD body, all Steel, each
//               Solid or Shell as the recipe's discretization says;
//   split       for each split: reload the current bytes, split_geometry with
//               the request the split tool sends, tessellate the new bytes;
//   mesh        generate_fem_mesh with the worker's exact options, in the same
//               engine instance, as the worker does after an import or edit;
//               a Shell body is then idealised to its mid-surface as the
//               worker does (buildMeshTimeShellModel), and the thickness it
//               measured is checked against the recipe's;
//   material    the recipe's material, assigned to every body;
//   supports,   one group per support / load, each face entry a whole CAD face
//   loads       (cadFaceId), its nodes those of the face on the mesh — or, for a
//               face a shell collapsed to its rim, an Edge entry with the rim
//               nodes of that face (web/src/lib/shellRim.ts); the solver
//               arrays are built by the app's own rebuildConstraints,
//               rebuildLoads (momentToNodalForces) and rebuildSurfaceLoads;
//   solve       the app's default solver: the all-solid AMG path of the worker
//               (weldTies → solveSolidWithAmg → expandTiedDisplacements) in the
//               Rust module, with the recipe's element order; an all-shell
//               model takes the worker's pure-shell path instead
//               (buildShellEngineInputs → solveShellInRust);
//   read-out    the recipe's probe, evaluated as lib/recipe.mjs defines it.
//
// A recipe with an `optimize` step runs the topology optimisation in place of
// the static solve, as the worker's handleTopOpt runs it: the app's solid
// engine inputs (buildSolidEngineInputs) and the Optimize panel's settings, in
// a fresh engine instance, read out by the final compliance.
//
// The app code is imported from web/src (bun runs TypeScript), so a change to
// how the app builds a load changes the published number with it — the build
// never re-implements it. Run under bun: `bun examples/validation/run.mjs`.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFLECTION_RELATIVE,
  faceDistances,
  modelSize,
  resolveFaceAt,
  validateRecipe,
} from "./recipe.mjs";
import {
  rebuildConstraints,
  rebuildLoads,
  rebuildSurfaceLoads,
} from "../../../web/src/store/boundaryRebuild.ts";
import { summarizeComponents } from "../../../web/src/store/boundaryGroups.ts";
import { MATERIAL_PALETTE } from "../../../web/src/store/materialSlice.ts";
import { routeSolve, routeTopOpt } from "../../../web/src/lib/solve/route.ts";
import {
  amgUnavailableReason,
  DEFAULT_SOLVER_METHOD,
  solveSolidWithAmg,
} from "../../../web/src/lib/solve/amg.ts";
import {
  buildSolidEngineInputs,
  expandTiedDisplacements,
  weldTies,
} from "../../../web/src/lib/solve/solid.ts";
import { buildVertexIndexer } from "../../../web/src/lib/solveMeshPacking.ts";
import { nodeVonMisesField } from "../../../web/src/lib/resultField.ts";
import { buildMeshTimeShellModel } from "../../../web/src/lib/solve/autoShell.ts";
import { buildShellEngineInputs } from "../../../web/src/lib/solve/shell.ts";
import { solveShellInRust } from "../../../web/src/lib/solve/shellRust.ts";
import { shellRimFaces } from "../../../web/src/lib/shellRim.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, "../../../web/src/wasm/pkg");
const FEM = join(here, "../../../web/src/wasm/fem");

// The worker's tessellation options (solver.worker.ts loadGeometry): chord
// tolerance 0.1 % of the model's bounding-box diagonal.
const TESSELLATE = JSON.stringify({
  deflection_relative: DEFLECTION_RELATIVE,
  angular_deflection: 0.5,
  format: "step",
});

// ── Engines ───────────────────────────────────────────────────────────────────

let engineModule = null;
let engineFactory = null;

/**
 * A fresh instance of the C++ engine (OCCT + Netgen + MFEM). The 36 MB module
 * is compiled once; every call instantiates it anew, as the app's worker is
 * recreated, so no Netgen or OCCT state leaks from one build into the next.
 */
export async function freshEngine() {
  const wasm = join(ENGINE, "kofem_wasm_emcc.wasm");
  if (!existsSync(wasm))
    throw new Error(
      `${wasm} is missing: fetch the engine with scripts/fetch-wasm-engine.sh (cd web && bun run wasm:prepare)`,
    );
  engineModule ??= await WebAssembly.compile(readFileSync(wasm));
  engineFactory ??= (await import(join(ENGINE, "kofem_wasm_emcc.js"))).default;
  return engineFactory({
    print: () => {},
    printErr: () => {},
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(engineModule, imports).then((instance) =>
        receive(instance, engineModule),
      );
      return {};
    },
  });
}

let femModule = null;

/** The Rust finite-element module (web/src/wasm/fem), loaded once. */
async function rustFem() {
  if (femModule) return femModule;
  const wasm = join(FEM, "kofem_wasm_bg.wasm");
  if (!existsSync(wasm))
    throw new Error(
      `${wasm} is missing: build it with bash scripts/build-fem-wasm.sh (cd web && bun run wasm:prepare)`,
    );
  const fem = await import(join(FEM, "kofem_wasm.js"));
  await fem.default({ module_or_path: readFileSync(wasm) });
  femModule = fem;
  return fem;
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

const chunk3 = (flat) => {
  const out = new Array(flat.length / 3);
  for (let i = 0; i < out.length; i++)
    out[i] = [flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]];
  return out;
};

const fmtPoint = (p) => `[${p.join(", ")}]`;

// The CAD face a point names on the display tessellation (lib/recipe.mjs
// resolveFaceAt, the function the GUI test uses too), with where it was named.
function resolveOnTessellation(at, tess, where) {
  try {
    return resolveFaceAt(tess, at);
  } catch (err) {
    throw new Error(`${where}: ${err.message}`);
  }
}

// ── The build ─────────────────────────────────────────────────────────────────

/**
 * Builds, meshes and solves an example from its recipe, as a user would in the
 * GUI. Throws on anything the GUI would not let the user do, or would do
 * differently, rather than guessing.
 *
 * @param {string} id
 * @param {import("./recipe.mjs").Recipe} recipe
 * @returns {Promise<RecipeBuild>}
 *
 * @typedef {object} RecipeBuild
 * @property {string} id
 * @property {string} stepText            the file the user imports (site/<id>.step)
 * @property {Uint8Array} stepBytes       the geometry after the splits
 * @property {{points, triangles, bodyIds, faceIds}} stepSurface
 *                                        the display tessellation, as the store holds it
 * @property {number} bodyCount
 * @property {{id, x, y, z}[]} nodes      node id = vertex index, as after meshing
 * @property {{id, type, nodeIds, propertyId}[]} elements   CTETRA (propertyId = CAD
 *                                        body), or CTRIA3 shell facets (propertyId =
 *                                        the PSHELL section of the idealised body)
 * @property {[number, number, number][]} surfaceTriangles
 * @property {number[]} surfaceFaceIds    CAD face of each surface triangle
 * @property {{maxElementSize, minElementSize, order}} meshSettings
 * @property {object[]} materials         the store's material table
 * @property {object[]} properties        one per CAD body
 * @property {object[]} bcGroups          NamedBcGroup[]
 * @property {object[]} loadGroups        NamedLoadGroup[]
 * @property {number} nextFaceEntryId
 * @property {object | null} handCheck    the analysis file's handCheck block
 *                                        (null for an optimisation)
 * @property {{displacements: Float64Array, vonMises: Float64Array} | null} result
 *                                        the static solve (null for an optimisation)
 * @property {{settings, density, history, seconds}} [optimization]
 *                                        the run, for a recipe with `optimize`
 * @property {number} fe                  the probe's value (÷ divideBy), or the
 *                                        final compliance of an optimisation
 */
export async function buildFromRecipe(id, recipe) {
  validateRecipe(id, recipe);
  const where = `recipe "${id}"`;
  const shell = recipe.discretization.kind === "shell";
  if (shell && recipe.mesh.order !== 1)
    throw new Error(
      `${where}: a shell facet is linear whatever element order the mesh panel shows — give a shell recipe mesh.order 1`,
    );
  if (recipe.mesh.localSizes !== undefined)
    throw new Error(
      `${where}: mesh.localSizes — the app's mesher offers no per-face sizes, so a user could not set them`,
    );

  // ── Import ──────────────────────────────────────────────────────────────────
  const stepText = recipe.step();
  if (typeof stepText !== "string" || !stepText.startsWith("ISO-10303-21"))
    throw new Error(`${where}: step() must return ISO-10303-21 STEP text`);
  const mesher = await freshEngine();
  let stepBytes = new TextEncoder().encode(stepText);
  let tess = loadGeometry(mesher, stepBytes, `${where}: import`);

  // ── Splits (the worker's handleSplitGeometry) ──────────────────────────────
  recipe.splits.forEach((split, i) => {
    const at = `${where}.splits[${i}]`;
    const plane = splitPlane(split, at);
    const faceIds =
      split.mode === "faces"
        ? distinct(
            split.faces.map((f, k) =>
              resolveOnTessellation(f.at, tess, `${at}.faces[${k}]`),
            ),
            `${at}.faces`,
          )
        : [];
    engineCall(mesher, `${at}: reloading the geometry`, () =>
      mesher.tessellate_step(stepBytes, TESSELLATE),
    ); // reloadForEdit
    const { bytes } = engineCall(mesher, `${at}: split_geometry`, () =>
      mesher.split_geometry(
        JSON.stringify({
          mode: split.mode,
          ...plane,
          ...(split.mode === "faces" ? { faceIds } : {}),
        }),
      ),
    );
    stepBytes = bytes;
    tess = loadGeometry(mesher, stepBytes, at);
  });

  // ── Mesh (the worker's handleVolumeMesh) ───────────────────────────────────
  const maxElementSize = recipe.mesh.maxElementSize;
  const minElementSize = minSizeOf(recipe);
  const dto = engineCall(
    mesher,
    `${where}: Netgen could not mesh the geometry at max element size ${maxElementSize} mm (min ${minElementSize} mm)`,
    () =>
      mesher.generate_fem_mesh(
        JSON.stringify({
          max_element_size: maxElementSize,
          min_element_size: minElementSize,
          grading: 0.3,
          second_order: false,
          elementsperedge: 2.0,
          elementspercurve: 2.0,
          optsteps_2d: 3,
          optsteps_3d: 3,
        }),
      ),
  );
  if ("overlaps" in dto)
    throw new Error(
      `${where}: Netgen reports ${dto.overlaps.length} surface-mesh overlaps — the app would ask the user to repair the geometry`,
    );
  mesher.free_geometry_cache();
  let nodes = Array.from({ length: dto.vertices.length / 3 }, (_, i) => ({
    id: i,
    x: dto.vertices[3 * i],
    y: dto.vertices[3 * i + 1],
    z: dto.vertices[3 * i + 2],
  }));
  let elements = Array.from({ length: dto.tetrahedra.length / 4 }, (_, i) => ({
    id: i,
    type: "CTETRA",
    nodeIds: Array.from(dto.tetrahedra.subarray(4 * i, 4 * i + 4)),
    propertyId: dto.bodyIds[i],
  }));
  let surfaceTriangles = chunk3(Array.from(dto.surfaceTriangles));
  let surfaceFaceIds = Array.from(dto.surfaceFaceIds);

  // ── Body types and the shell idealisation (the worker's handleVolumeMesh) ──
  // The recipe's element type applies to every CAD body; meshing idealises the
  // Shell bodies and returns the CTRIA3 (+ CTETRA) model the store keeps.
  const bodyIds = Array.from(
    { length: Math.max(1, tess.bodyCount) },
    (_, i) => i + 1,
  );
  let properties = bodyIds.map((bodyId) => ({
    id: bodyId,
    materialId: 1,
    discretization: recipe.discretization.kind,
  }));
  if (shell) {
    await rustFem(); // the shell idealisation runs in the Rust module
    const mixed = buildMeshTimeShellModel(
      nodes,
      elements,
      surfaceTriangles,
      surfaceFaceIds,
      new Set(bodyIds),
      properties,
      () => {},
    );
    if (!mixed)
      throw new Error(
        `${where}: the body is marked Shell, but meshing did not idealise it`,
      );
    ({ nodes, elements, properties, surfaceTriangles, surfaceFaceIds } = mixed);
    checkShellThickness(properties, recipe.discretization.thickness, where);
  }
  const nNodes = nodes.length;
  // The faces a shell collapsed to the rim of its mid-surface (none for solids).
  const rim = shellRimFaces(
    { nodes, elements, surfaceTriangles, surfaceFaceIds },
    tess,
  );
  const meshSurface = {
    points: nodes.map((n) => [n.x, n.y, n.z]),
    triangles: surfaceTriangles,
    faceIds: surfaceFaceIds,
  };

  // Every face a recipe names is resolved on the display tessellation (what
  // the user clicks), then checked against the mesh: the nearest surface
  // triangle of the mesh must carry the same CAD face id, so the two
  // numberings cannot silently disagree.
  const nodesOfFace = new Map();
  surfaceTriangles.forEach((tri, t) => {
    const face = surfaceFaceIds[t];
    if (!nodesOfFace.has(face)) nodesOfFace.set(face, new Set());
    for (const v of tri) nodesOfFace.get(face).add(v);
  });
  const resolve = (refs, at, { rimFaces = false } = {}) =>
    distinct(
      refs.map((ref, k) => {
        const label = `${at}.faces[${k}]`;
        const face = resolveOnTessellation(ref.at, tess, label);
        // A face a shell collapsed to its rim: picked as an Edge selection.
        if (rimFaces && isRimFace(face)) return face;
        const nearest = faceDistances(meshSurface, ref.at)[0];
        if (!nearest || nearest[0] !== face)
          throw new Error(
            `${label}: the point ${fmtPoint(ref.at)} is on CAD face ${face} of the geometry, but the nearest surface triangle of the mesh is on face ${nearest?.[0]}`,
          );
        if (!nodesOfFace.has(face))
          throw new Error(
            `${label}: CAD face ${face} is not on the mesh's surface${shell ? " nor on the rim of its shell mid-surface" : ""}`,
          );
        return face;
      }),
      `${at}.faces`,
    );
  const faceNodes = (face) => [...nodesOfFace.get(face)].sort((a, b) => a - b);
  const isRimFace = (face) =>
    !nodesOfFace.has(face) && rim.nodesByFace.has(face);

  // ── Model: material, bodies, supports, loads (the store's groups) ──────────
  const m = recipe.material;
  const materials = [
    {
      id: 1,
      name: m.name,
      young: m.young,
      poisson: m.poisson,
      density: m.density,
      color: MATERIAL_PALETTE[0],
    },
  ];
  let nextFaceEntryId = 1;
  // toFaceEntries: one entry per pick, labelled "Face n" for a whole CAD face
  // on the mesh surface, "Edge n" for the rim a shell collapsed a face to. A
  // selection holds faces or edges, not both: the panel picks one or the other.
  const entries = (faces, at) => {
    const edges = faces.filter(isRimFace);
    if (edges.length > 0 && edges.length !== faces.length)
      throw new Error(
        `${at}: mixes faces on the mesh surface with faces a shell collapsed to its rim — the panel picks Faces or Edges, not both`,
      );
    const geometry = edges.length > 0 ? "edge" : "face";
    return faces.map((cadFaceId, k) => ({
      id: nextFaceEntryId++,
      label: `${geometry === "edge" ? "Edge" : "Face"} ${k + 1}`,
      nodeIds:
        geometry === "edge"
          ? rim.nodesByFace.get(cadFaceId)
          : faceNodes(cadFaceId),
      geometry,
      cadFaceId,
    }));
  };
  const supportFaces = recipe.supports.map((s, i) =>
    resolve(s.faces, `${where}.supports[${i}]`, { rimFaces: shell }),
  );
  const loadFaces = recipe.loads.map((l, i) =>
    resolve(l.faces, `${where}.loads[${i}]`, { rimFaces: shell }),
  );
  // The panel offers Rx, Ry, Rz on shell models only.
  const hasShells = elements.some((e) => e.type === "CTRIA3");
  const dofLimit = hasShells ? 5 : 2;
  const bcGroups = recipe.supports.map((s, i) => {
    if (!s.dofs.every((d) => Number.isInteger(d) && d >= 0 && d <= dofLimit))
      throw new Error(
        hasShells
          ? `${where}.supports[${i}]: a shell support fixes Ux … Rz (dofs 0 … 5), got [${s.dofs.join(", ")}]`
          : `${where}.supports[${i}]: a solid support fixes Ux, Uy, Uz (dofs 0, 1, 2) only, got [${s.dofs.join(", ")}]`,
      );
    return {
      id: i + 1,
      name: s.name,
      dofs: [...s.dofs],
      value: s.value,
      faces: entries(supportFaces[i], `${where}.supports[${i}]`),
    };
  });
  const loadGroups = recipe.loads.map((l, i) => {
    const faces = entries(loadFaces[i], `${where}.loads[${i}]`);
    const group = { id: i + 1, name: l.name };
    if (l.kind === "pressure")
      return { ...group, dof: 0, totalForce: l.value, faces, kind: "pressure" };
    const components =
      l.kind === "force"
        ? [...l.components]
        : [0, 1, 2].map((axis) => (axis === l.axis ? l.value : 0));
    if (components.every((v) => v === 0))
      throw new Error(
        `${where}.loads[${i}]: an all-zero ${l.kind} — the app rejects it`,
      );
    return {
      ...group,
      ...summarizeComponents(components, l.kind),
      components,
      faces,
      kind: l.kind,
    };
  });

  const elementOrder = recipe.mesh.order;
  const payload = {
    nodes,
    elements,
    materials,
    properties,
    constraints: rebuildConstraints(bcGroups),
    loads: rebuildLoads(loadGroups, nodes, []),
    surfaceLoads: rebuildSurfaceLoads(loadGroups, elements, []),
    tieGroups: [],
    couplings: [],
    elementOrder,
    solverMethod: DEFAULT_SOLVER_METHOD,
  };
  // What the app holds once the model is set up, solved or not.
  const model = () => ({
    id,
    stepText,
    stepBytes,
    stepSurface: {
      points: tess.points,
      triangles: tess.triangles,
      bodyIds: tess.bodyIds,
      faceIds: tess.faceIds,
    },
    bodyCount: tess.bodyCount,
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
    meshSettings: { maxElementSize, minElementSize, order: elementOrder },
    materials,
    properties,
    bcGroups,
    loadGroups,
    nextFaceEntryId,
  });

  // ── Optimize (the worker's handleTopOpt), in place of the static solve ─────
  if (recipe.optimize) {
    const optimization = await optimizeLikeTheApp(
      where,
      payload,
      recipe.optimize,
    );
    return {
      ...model(),
      handCheck: null,
      result: null,
      optimization,
      fe: optimization.history.at(-1).compliance,
    };
  }

  // ── Solve (the worker's handleSolve) ───────────────────────────────────────
  const route = routeSolve(payload);
  const result =
    route.path === "shell"
      ? await solveShell(payload, where)
      : route.path === "solid"
        ? await solveSolid(payload, where)
        : unsupportedRoute(route.path, where);
  if (result.displacements.length !== 3 * nNodes)
    throw new Error(
      `${where}: the solve returned ${result.displacements.length / 3} displacements for ${nNodes} nodes`,
    );

  // ── Read-out ────────────────────────────────────────────────────────────────
  const ro = recipe.readout;
  const probeFaces = ro.probe.faces
    ? resolve(ro.probe.faces, `${where}.readout.probe`)
    : null;
  const probe = resolvedProbe(ro.probe, probeFaces);
  const fe = evaluateProbe(probe, {
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
    result,
  });

  const handCheck = {
    quantity: ro.quantity,
    formula: ro.formula,
    reference: ro.reference,
    unit: ro.probe.unit,
    ...(probe.divideBy !== undefined ? { divideBy: probe.divideBy } : {}),
    probe: probe.spec,
    assumes: {
      loads: loadGroups.map((g, i) => {
        const l = recipe.loads[i];
        const cadFaceIds = loadFaces[i];
        if (l.kind === "force")
          return { kind: "force", force: [...l.components], cadFaceIds };
        if (l.kind === "pressure")
          return { kind: "pressure", value: l.value, cadFaceIds };
        return { kind: "moment", axis: l.axis, value: l.value, cadFaceIds };
      }),
      supports: recipe.supports.map((s, i) => ({
        dofs: [...s.dofs],
        value: s.value,
        cadFaceIds: supportFaces[i],
      })),
      young: m.young,
    },
  };

  return { ...model(), handCheck, result, fe };
}

/**
 * The topology optimisation as the app runs it (useTopOpt → the worker's
 * handleTopOpt): the settings object useTopOpt's parseSettings sends for a SIMP
 * minimum-compliance study, the solid design domain's engine inputs built by
 * the app's buildSolidEngineInputs, and optimize_topology in a fresh engine
 * instance (the app resets its worker after meshing). Throws unless the run
 * converges: a published optimum must be one.
 *
 * @returns {Promise<{settings: object, density: number[], history: {it, objective, compliance, volume, max_change}[], seconds: number}>}
 */
async function optimizeLikeTheApp(where, payload, optimize) {
  const settings = {
    method: "simp",
    objective: optimize.objective,
    constraints: { volumeFraction: optimize.volumeFraction },
    penalty: optimize.penalty,
    filterRadius: optimize.filterRadius,
    moveLimit: optimize.moveLimit,
    maxIterations: optimize.maxIterations,
    tolerance: optimize.tolerance,
  };
  const topOptPayload = {
    nodes: payload.nodes,
    elements: payload.elements,
    materials: payload.materials,
    properties: payload.properties,
    constraints: payload.constraints,
    loads: payload.loads,
    surfaceLoads: payload.surfaceLoads,
    tieGroups: payload.tieGroups,
    couplings: payload.couplings,
    settings,
  };
  const domain = routeTopOpt(topOptPayload);
  if (domain !== "solid")
    throw new Error(
      `${where}: the app would optimize this model on the "${domain}" path; only solid design domains are built here`,
    );
  const inputs = buildSolidEngineInputs(
    topOptPayload,
    buildVertexIndexer(topOptPayload.nodes),
  );
  const engine = await freshEngine();
  const start = performance.now();
  const result = engine.optimize_topology(
    inputs.mesh,
    inputs.matJson,
    inputs.bcsJson,
    JSON.stringify(settings),
    null, // the app streams the density to the viewport; nothing to show here
  );
  const seconds = (performance.now() - start) / 1000;
  if ("error" in result)
    throw new Error(`${where}: the optimizer failed: ${result.error}`);
  const history = result.history.map((h) => ({ ...h }));
  const last = history.at(-1);
  if (!last) throw new Error(`${where}: the optimizer returned no iterations`);
  if (!(last.max_change < optimize.tolerance))
    throw new Error(
      `${where}: the optimization did not converge in ${history.length} iterations (largest density change ${last.max_change}, tolerance ${optimize.tolerance})`,
    );
  return { settings, density: Array.from(result.density), history, seconds };
}

// The worker's handleSolidSolve on its default (AMG) path.
async function solveSolid(payload, where) {
  const { nodes, elements, properties, elementOrder } = payload;
  if (payload.solverMethod !== "amg")
    throw new Error(
      `${where}: the app's default solver is "${payload.solverMethod}"; this build mirrors only the AMG path`,
    );
  const reason = amgUnavailableReason({
    elements,
    properties,
    elementOrder,
    couplingCount: 0,
  });
  if (reason !== null)
    throw new Error(
      `${where}: the app would not use AMG for this model (${reason})`,
    );
  const log = () => {};
  const tied = weldTies(nodes, elements, payload.tieGroups, log);
  const neverAsk = () => {
    throw new Error(`${where}: the AMG solve reached its iteration limit`);
  };
  const solved = await solveSolidWithAmg(
    await rustFem(),
    { ...payload, nodes: tied.solveNodes, elements: tied.tiedElements },
    elementOrder,
    tied.vid,
    tied.vidTied,
    undefined, // the app sends no cgIterationLimit unless the user set one
    neverAsk,
    log,
  );
  return {
    displacements: expandTiedDisplacements(nodes, tied, solved.displacements),
    vonMises: solved.vonMises,
  };
}

// The worker's handleShellSolve: an all-CTRIA3 model, packed by the app's
// buildShellEngineInputs and solved by the Rust shell solver. elementOrder does
// not apply to shells (a DKT facet is what it is).
async function solveShell(payload, where) {
  const fem = await rustFem();
  const neverAsk = () => {
    throw new Error(`${where}: the shell solve reached its iteration limit`);
  };
  const solved = await solveShellInRust(
    { ShellModel: fem.ShellModel },
    buildShellEngineInputs(payload),
    undefined, // the app sends no cgIterationLimit unless the user set one
    neverAsk,
    () => {},
  );
  return { displacements: solved.displacements, vonMises: solved.von_mises };
}

function unsupportedRoute(path, where) {
  throw new Error(
    `${where}: the app would solve this model on the "${path}" path; only all-solid and all-shell recipes are built here`,
  );
}

// The app measures a shell's thickness from the wall it idealises and offers no
// thickness input: every shell section the mesh made must have the recipe's.
function checkShellThickness(properties, thickness, where) {
  const sections = properties.filter((p) => p.sourceBodyId !== undefined);
  if (sections.length === 0)
    throw new Error(
      `${where}: the body is marked Shell but the mesh made no shell section`,
    );
  for (const s of sections)
    if (
      !(typeof s.thickness === "number") ||
      Math.abs(s.thickness - thickness) > 1e-6 * thickness
    )
      throw new Error(
        `${where}: the app measured a ${s.thickness} mm wall, the recipe says ${thickness} mm — the GUI has no thickness input to change it`,
      );
}

// The worker's loadGeometry: tessellate the bytes and keep what the store keeps
// (stepSurface: nested points / triangles, a body and a face id per triangle).
function loadGeometry(engine, bytes, where) {
  const t = engineCall(engine, `${where}: tessellate_step`, () =>
    engine.tessellate_step(bytes, TESSELLATE),
  );
  return {
    points: chunk3(Array.from(t.vertices)),
    triangles: chunk3(Array.from(t.triangles)),
    bodyIds: Array.from(t.triangleBodyIds),
    faceIds: Array.from(t.triangleFaceIds),
    bodyCount: t.bodyCount,
  };
}

// An engine call whose C++ exception reaches JS readable. Emscripten
// (-fexceptions) throws an uncaught C++ exception into JS as the bare heap
// pointer of the exception object, a number such as 12584968; the worker
// decodes it with the engine's getExceptionMessage (solver.worker.ts
// describeError), and so does this build.
function engineCall(engine, what, call) {
  try {
    return call();
  } catch (err) {
    if (typeof err !== "number") throw err;
    throw new Error(`${what}: ${cxxExceptionText(engine, err)}`);
  }
}

/** "type: what()" of the C++ exception at heap pointer `ptr`. */
export function cxxExceptionText(engine, ptr) {
  if (typeof engine.getExceptionMessage !== "function")
    throw new Error(
      `the engine threw C++ exception ${ptr}, but this build exports no getExceptionMessage to decode it (-sEXPORT_EXCEPTION_HANDLING_HELPERS, engine/CMakeLists.txt)`,
    );
  const [type, message] = engine.getExceptionMessage(ptr);
  return message ? `${type}: ${message}` : type;
}

// The split tool cuts with an axis-aligned plane at a position along the axis
// (useGeometryEdit splitPlane); any other plane cannot be entered in the GUI.
function splitPlane(split, where) {
  const axis = [0, 1, 2].find((k) =>
    split.normal.every((v, j) => v === (j === k ? 1 : 0)),
  );
  if (axis === undefined)
    throw new Error(
      `${where}: normal ${fmtPoint(split.normal)} — the split tool cuts along +x, +y or +z only ([1, 0, 0], [0, 1, 0], [0, 0, 1])`,
    );
  const position = split.origin[axis];
  const normal = [0, 1, 2].map((j) => (j === axis ? 1 : 0));
  return { origin: normal.map((v) => v * position), normal };
}

// The faces of one selection, each once: picking a face twice in the GUI
// toggles it off again, so a recipe naming one face twice is not a GUI action.
function distinct(faces, where) {
  const seen = new Set();
  for (const f of faces) {
    if (seen.has(f))
      throw new Error(
        `${where}: CAD face ${f} is named twice — a second click would deselect it`,
      );
    seen.add(f);
  }
  return faces;
}

// The minimum element size: the recipe's, or max / 10 — the worker's default,
// which the GUI test types into the Mesh panel's min field.
function minSizeOf(recipe) {
  const { maxElementSize, minElementSize } = recipe.mesh;
  return minElementSize === undefined ? maxElementSize / 10 : minElementSize;
}

// ── The probe ─────────────────────────────────────────────────────────────────

// A recipe probe with its faces resolved: `spec` is what the analysis file's
// handCheck.probe holds.
function resolvedProbe(p, cadFaceIds) {
  const base = p.divideBy !== undefined ? { divideBy: p.divideBy } : {};
  if (p.kind === "displacement")
    return {
      ...base,
      spec: cadFaceIds
        ? { kind: "displacement", component: p.component, cadFaceIds }
        : { kind: "displacement", component: p.component, point: [...p.at] },
    };
  if (p.kind === "twist")
    return { ...base, spec: { kind: "twist", axis: p.axis, cadFaceIds } };
  return {
    ...base,
    spec: {
      kind: "stress",
      field: p.field,
      stat: p.stat,
      ...(cadFaceIds ? { cadFaceIds } : {}),
    },
  };
}

/**
 * The value of a resolved probe on a solved model, as lib/recipe.mjs defines
 * it (and the Results panel's hand check reads it):
 *
 *   displacement on faces   mean component over the distinct nodes of the
 *                           faces' surface triangles
 *   displacement at point   the component at the mesh node nearest the point
 *                           (a tie closer than 1e-9 · model size throws)
 *   twist                   mean over the faces' nodes off the axis — |r⊥|
 *                           above 1e-6 of the largest |r⊥| — of
 *                           (r × u)_axis / |r⊥|², r from the nodes' centroid
 *   stress                  largest volume-weighted nodal von Mises
 *                           (the app's nodeVonMisesField) over the faces'
 *                           nodes, or all nodes
 *
 * then divided by `divideBy` when the probe has one.
 *
 * @param {{spec: object, divideBy?: number}} probe
 * @param {{nodes, elements, surfaceTriangles, surfaceFaceIds, result}} model
 */
export function evaluateProbe(probe, model) {
  const { spec } = probe;
  const { nodes, surfaceTriangles, surfaceFaceIds, result } = model;
  const u = result.displacements;
  const faceNodes = (ids) => {
    const want = new Set(ids);
    const set = new Set();
    surfaceTriangles.forEach((tri, t) => {
      if (want.has(surfaceFaceIds[t])) for (const v of tri) set.add(v);
    });
    if (!set.size)
      throw new Error(
        `probe: CAD faces [${ids.join(", ")}] have no nodes on the mesh`,
      );
    for (const id of ids)
      if (!surfaceFaceIds.includes(id))
        throw new Error(`probe: CAD face ${id} is not on the mesh's surface`);
    // Node ids equal indices (as after meshing).
    return [...set].sort((a, b) => a - b);
  };
  let value;
  if (spec.kind === "displacement" && spec.cadFaceIds) {
    const ids = faceNodes(spec.cadFaceIds);
    value = ids.reduce((s, v) => s + u[3 * v + spec.component], 0) / ids.length;
  } else if (spec.kind === "displacement") {
    const size = modelSize(nodes.map((n) => [n.x, n.y, n.z]));
    let best = -1,
      bestD = Infinity,
      second = Infinity;
    nodes.forEach((n, i) => {
      const d = Math.hypot(
        n.x - spec.point[0],
        n.y - spec.point[1],
        n.z - spec.point[2],
      );
      if (d < bestD) {
        second = bestD;
        bestD = d;
        best = i;
      } else if (d < second) second = d;
    });
    if (second - bestD <= 1e-9 * size)
      throw new Error(
        `probe: two mesh nodes are equally near ${fmtPoint(spec.point)}`,
      );
    value = u[3 * best + spec.component];
  } else if (spec.kind === "twist") {
    const ids = faceNodes(spec.cadFaceIds);
    const c = [0, 1, 2].map(
      (k) =>
        ids.reduce((s, v) => s + [nodes[v].x, nodes[v].y, nodes[v].z][k], 0) /
        ids.length,
    );
    // (axis, a1, a2) cyclic, so (r × u)_axis = r_a1·u_a2 − r_a2·u_a1.
    const a1 = (spec.axis + 1) % 3,
      a2 = (spec.axis + 2) % 3;
    const arms = ids.map((v) => {
      const p = [nodes[v].x, nodes[v].y, nodes[v].z];
      const r1 = p[a1] - c[a1],
        r2 = p[a2] - c[a2];
      return { v, r1, r2, r2sum: r1 * r1 + r2 * r2 };
    });
    const maxArm = Math.sqrt(Math.max(...arms.map((a) => a.r2sum)));
    const off = arms.filter((a) => Math.sqrt(a.r2sum) > 1e-6 * maxArm);
    if (!off.length)
      throw new Error("probe: every node of the twist faces lies on the axis");
    value =
      off.reduce(
        (s, { v, r1, r2, r2sum }) =>
          s + (r1 * u[3 * v + a2] - r2 * u[3 * v + a1]) / r2sum,
        0,
      ) / off.length;
  } else if (spec.kind === "stress") {
    const nodal = nodeVonMisesField(
      { displacements: result.displacements, vonMises: result.vonMises },
      nodes,
      model.elements,
    );
    if (!nodal)
      throw new Error("probe: the solve returned no von Mises stress");
    const ids = spec.cadFaceIds
      ? faceNodes(spec.cadFaceIds)
      : nodes.map((_, i) => i);
    value = Math.max(...ids.map((v) => nodal[v]));
  } else throw new Error(`probe: unknown kind "${spec.kind}"`);
  return probe.divideBy !== undefined ? value / probe.divideBy : value;
}

/** The nodal von Mises field of a build, averaged as the app averages it. */
export function nodalVonMises(build) {
  const nodal = nodeVonMisesField(
    {
      displacements: build.result.displacements,
      vonMises: build.result.vonMises,
    },
    build.nodes,
    build.elements,
  );
  if (!nodal)
    throw new Error(`${build.id}: the solve returned no von Mises stress`);
  return nodal;
}

/**
 * The recipe with other mesher settings — a convergence-study level. Only the
 * mesh changes, so the model is the case's own.
 */
export function withMesh(recipe, mesh) {
  return { ...recipe, mesh: { ...recipe.mesh, ...mesh } };
}
