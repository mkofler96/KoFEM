/// <reference lib="webworker" />
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

import createModule, { EngineLoadError } from "../wasm/pkg/kofem_wasm.js";
import {
  Couplings,
  ElasticModel,
  MixedModel,
  MortarSurface,
  ShellModel,
  SolveOptions,
  Ties,
  tieMortarWeights,
  TopologyRun,
  TopologySettings,
} from "../wasm/fem/kofem_wasm.js";
import { FemLoadError, loadFemModule } from "../lib/femModule.js";
import type {
  EngineLoadProgress,
  KofemModule,
  TopOptResult,
  CgLimitProgress,
} from "../wasm/pkg/kofem_wasm.js";
import type {
  Node,
  Element,
  ParseStepPayload,
  SplitGeometryPayload,
  BooleanGeometryPayload,
  RepairHingesPayload,
  SplitConeTipsPayload,
  RemoveFacesPayload,
  VolumeMeshPayload,
  SolvePayload,
  TopOptPayload,
} from "./solverTypes.js";
import { buildVertexIndexer } from "../lib/solveMeshPacking.js";
import {
  thinWallFindings,
  type ThinWallCheckInput,
} from "../lib/solve/thinWall.js";
import { dropSuppressedBodies } from "../lib/suppressBodies.js";
import { inStage, splitStage } from "../lib/workerError.js";
import {
  buildMeshTimeShellModel,
  prepareAutoShellSolve,
} from "../lib/solve/autoShell.js";
import {
  buildCoupledEngineInputs,
  mapMixedResult,
  type SolveLog,
} from "../lib/solve/coupled.js";
import { routeSolve, routeTopOpt, topOptStartLog } from "../lib/solve/route.js";
import { buildShellEngineInputs } from "../lib/solve/shell.js";
import { solveShellInRust } from "../lib/solve/shellRust.js";
import {
  solveCoupledInRust,
  type MixedPreconditionerName,
} from "../lib/solve/coupledRust.js";
import {
  amgFallbackPreconditioner,
  amgUnavailableReason,
  FALLBACK_PRECONDITIONER_LABEL,
  isSolverMethod,
  solveCoupledSolidInRust,
  solveSolidInRust,
  type SolverMethod,
} from "../lib/solve/amg.js";
import { constraintTieCount } from "../lib/tie.js";
import { tieWeighting } from "../lib/solve/tieMortar.js";
import {
  buildSolidEngineInputs,
  expandTiedDisplacements,
  weldTies,
} from "../lib/solve/solid.js";
import {
  optimizeSolidInRust,
  usesRustTopOpt,
} from "../lib/solve/topOptRust.js";

let Module: KofemModule | null = null;
let activeTask: number | null = null;
let cgRequestId = 0;
let cgReply: { requestId: number; resolve: (extra: number) => void } | null =
  null;

function onCgLimit(progress: CgLimitProgress): Promise<number> {
  if (activeTask === null || cgReply)
    throw new Error("CG continuation requested outside an active solve");
  const requestId = ++cgRequestId;
  return new Promise((resolve) => {
    cgReply = { requestId, resolve };
    self.postMessage({ id: activeTask, cgLimit: { requestId, progress } });
  });
}

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

// The engine's load progress, streamed to sharedWorker's status store
// (store/engineStore.ts): downloading → compiling → starting → ready | failed.
type EngineStatusMessage =
  | Exclude<EngineLoadProgress, { phase: "ready" }>
  | (Extract<EngineLoadProgress, { phase: "ready" }> & { initMs: number })
  | { phase: "failed"; stage: EngineLoadError["stage"]; detail: string };

function postEngineStatus(engineStatus: EngineStatusMessage) {
  self.postMessage({ id: 0, engineStatus });
}

// One load per worker, however many requests arrive while it runs: the
// "init" message sharedWorker sends at start-up and any import queued behind
// it share this promise. A failure stays failed — every later request gets the
// same error until sharedWorker.retryEngine() replaces the worker.
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = initEngine();
  return initPromise;
}

// Netgen prints four lines per overlapping pair of surface elements, and a bad
// surface has thousands of pairs: forwarding them freezes the page. The mesh
// result reports the overlaps themselves.
const OVERLAP_PAIR_LINE =
  /^\s*(?:WARNING: Intersecting elements |el[12] = np = |layer[12] = )/;

function isOverlapPairLine(text: string): boolean {
  return OVERLAP_PAIR_LINE.test(text);
}

// Load the engine and the Rust module (shell idealisation) together. Neither
// is ready without the other, so "ready" is held back until both are, and a
// failure of either is reported as the engine's failed status — the status
// bar's Retry then replaces the worker and loads both again.
async function initEngine() {
  const t0 = performance.now();
  let engineReady: Extract<EngineLoadProgress, { phase: "ready" }> | undefined;
  // The Rust module is small and can fail while the engine still downloads;
  // its later progress must not paint over the failure.
  let failed = false;
  try {
    // Promise.all, so a failure of either is caught here and the other's
    // later rejection is still handled.
    const [engine] = await Promise.all([
      createModule({
        onCgLimit,
        print: (text: string) => {
          if (!isOverlapPairLine(text))
            self.postMessage({ id: 0, log: `[wasm] ${text}` });
        },
        printErr: (text: string) =>
          self.postMessage({ id: 0, log: `[wasm:err] ${text}` }),
        onProgress: (progress) => {
          if (progress.phase === "ready") engineReady = progress;
          else if (!failed) postEngineStatus(progress);
        },
      }),
      loadFemModule(),
    ]);
    Module = engine;
    if (!engineReady)
      throw new Error("The engine finished loading without reporting ready");
  } catch (err) {
    failed = true;
    postEngineStatus({
      phase: "failed",
      stage:
        err instanceof EngineLoadError || err instanceof FemLoadError
          ? err.stage
          : "instantiate",
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  postEngineStatus({ ...engineReady, initMs: performance.now() - t0 });
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

// ── parse_step ────────────────────────────────────────────────────────────────

// Load CAD bytes into this worker's engine and build the store's view of them:
// the display tessellation. Shared by the import and by every geometry edit,
// which both end in a freshly loaded file.
function loadGeometry(bytes: Uint8Array, format: string) {
  // deflection_relative: chord tolerance as a fraction of the model's
  // bounding-box diagonal, so a large part isn't tessellated into millions of
  // needless triangles. ~0.1% matches the fast browser STEP viewers.
  const opts = JSON.stringify({
    deflection_relative: 0.001,
    angular_deflection: 0.5,
    format,
  });
  const { vertices, triangles, triangleBodyIds, triangleFaceIds, bodyCount } =
    m().tessellate_step(bytes, opts);
  // tessellate_step stores the OCCT shape in the module — record that so a
  // subsequent volume_mesh in this same worker can skip the reload.
  geometryLoaded = true;
  // Return as {points, triangles} to match the StepTessellation type used by
  // the store; tessellate_step returns flat Float32/Uint32 typed arrays.
  // bodyCount (#353) drives the per-body material assignment UI; bodyIds
  // (one per triangle) drives per-body colour / highlight / hide; faceIds (one
  // per triangle) drive CAD-face picking and the face outlines of the split tool.
  return {
    points: chunk3(vertices),
    triangles: chunk3(triangles),
    bodyIds: Array.from(triangleBodyIds),
    faceIds: Array.from(triangleFaceIds),
    bodyCount,
  };
}

function handleParseStep(id: number, payload: ParseStepPayload) {
  self.postMessage({
    id,
    ok: true,
    ...inStage("geometry_import", () =>
      // eslint-disable-next-line kofem/no-silent-fallback -- format is optional in the parse_step message; absent means STEP, the primary import path
      loadGeometry(payload.bytes, payload.format ?? "step"),
    ),
  });
}

// ── split_geometry ────────────────────────────────────────────────────────────

// Split faces or bodies of the current geometry with a plane. The face/body ids
// in `split` were read off the store's tessellation of `bytes`, so the shape is
// always reloaded from exactly those bytes first — whatever this worker last
// held (an earlier import, an example's file) is not trusted to match. The
// engine hands the edit back as STEP bytes, which become the geometry: they are
// loaded straight away, so the reply carries both the new file and its view.
function handleSplitGeometry(id: number, payload: SplitGeometryPayload) {
  reloadForEdit(payload.bytes, payload.format);
  const { bytes, bodySources } = m().split_geometry(
    JSON.stringify(payload.split),
  );
  geometryLoaded = false; // split_geometry released the pre-edit shape
  self.postMessage({
    id,
    ok: true,
    bytes,
    bodySources,
    ...loadGeometry(bytes, "step"),
  });
}

// Combine bodies with a Boolean — the same reload / edit / reload round trip as
// a split, with body ids read off the store's tessellation of `bytes`.
function handleBooleanGeometry(id: number, payload: BooleanGeometryPayload) {
  reloadForEdit(payload.bytes, payload.format);
  const { bytes } = m().boolean_geometry(JSON.stringify(payload.boolean));
  geometryLoaded = false; // boolean_geometry released the pre-edit shape
  self.postMessage({
    id,
    ok: true,
    bytes,
    ...loadGeometry(bytes, "step"),
  });
}

// Remove hinges a failed mesh reported — the same round trip as a split.
function handleRepairHinges(id: number, payload: RepairHingesPayload) {
  reloadForEdit(payload.bytes, payload.format);
  const { bytes, bodySources } = m().repair_hinges(
    JSON.stringify(payload.repair),
  );
  geometryLoaded = false; // repair_hinges released the pre-edit shape
  self.postMessage({
    id,
    ok: true,
    bytes,
    bodySources,
    ...loadGeometry(bytes, "step"),
  });
}

// Divide cone tips a failed mesh reported — the same round trip as a split.
function handleSplitConeTips(id: number, payload: SplitConeTipsPayload) {
  reloadForEdit(payload.bytes, payload.format);
  const { bytes } = m().split_cone_tips(
    JSON.stringify({ faceIds: payload.faceIds }),
  );
  geometryLoaded = false; // split_cone_tips released the pre-edit shape
  self.postMessage({
    id,
    ok: true,
    bytes,
    ...loadGeometry(bytes, "step"),
  });
}

// Remove faces a failed mesh could not mesh — the same round trip as a split.
function handleRemoveFaces(id: number, payload: RemoveFacesPayload) {
  reloadForEdit(payload.bytes, payload.format);
  const { bytes } = m().remove_faces(
    JSON.stringify({ faceIds: payload.faceIds }),
  );
  geometryLoaded = false; // remove_faces released the pre-edit shape
  self.postMessage({
    id,
    ok: true,
    bytes,
    ...loadGeometry(bytes, "step"),
  });
}

// Load exactly the bytes an edit's ids were read from into the engine.
function reloadForEdit(bytes: Uint8Array, format: string) {
  m().tessellate_step(
    bytes,
    JSON.stringify({
      deflection_relative: 0.001,
      angular_deflection: 0.5,
      format,
    }),
  );
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

  // Floor the curvature-driven local element size at maxElementSize/10 by
  // default.  Without a floor, Netgen refines every fillet to ~radius/2
  // (elementspercurve) — on fillet-heavy CAD this produces >10x more
  // elements than the max size suggests and meshing takes minutes.
  const minSize = payload.minElementSize ?? maxElementSize / 10;

  // Any positive size is legal (KOF-222) — a 1 mm cube is meshed with 0.1 mm
  // elements. Zero, negative and NaN are not: Netgen's maxh would disable the
  // size field entirely and mesh for minutes before failing obscurely.
  if (!Number.isFinite(maxElementSize) || maxElementSize <= 0)
    throw new Error(
      `volume_mesh: max_element_size must be a positive number of mm, got ${maxElementSize}`,
    );
  if (!Number.isFinite(minSize) || minSize < 0 || minSize > maxElementSize)
    throw new Error(
      `volume_mesh: min_element_size must be between 0 and max_element_size (${maxElementSize} mm), got ${minSize}`,
    );

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
    inStage("geometry_reload", () =>
      m().tessellate_step(
        bytes,
        JSON.stringify({
          deflection_relative: 0.001,
          angular_deflection: 0.5,
          format,
        }),
      ),
    );
    geometryLoaded = true;
  }

  const opts = JSON.stringify({
    max_element_size: maxElementSize,
    min_element_size: minSize,
    ...(payload.solidMaxSizes
      ? { solid_max_sizes: payload.solidMaxSizes }
      : {}),
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
  const dto = inStage("meshing", () => m().generate_fem_mesh(opts));
  if ("overlaps" in dto) {
    flushCoverage();
    self.postMessage({ id, ok: true, overlaps: dto.overlaps });
    return;
  }
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
  const meshNodes: Node[] = new Array<Node>(nNodes);
  for (let i = 0; i < nNodes; i++) {
    meshNodes[i] = {
      id: i,
      x: dto.vertices[3 * i],
      y: dto.vertices[3 * i + 1],
      z: dto.vertices[3 * i + 2],
    };
  }
  const meshElements: Element[] = new Array<Element>(nTets);
  for (let i = 0; i < nTets; i++) {
    meshElements[i] = {
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

  const suppressed = new Set(payload.suppressedBodyIds ?? []);
  const { nodes, elements, surfaceTriangles, surfaceFaceIds } =
    dropSuppressedBodies(
      {
        nodes: meshNodes,
        elements: meshElements,
        surfaceTriangles: chunk3(dto.surfaceTriangles) as [
          number,
          number,
          number,
        ][],
        surfaceFaceIds: Array.from(dto.surfaceFaceIds),
      },
      suppressed,
    );
  if (suppressed.size > 0)
    self.postMessage({
      id,
      log: `Suppressed bodies ${[...suppressed].join(", ")} left out: ${nodes.length} nodes, ${elements.length} elements remain`,
    });

  // Auto-shell at MESH time (#397): a body marked Shell has its thin walls
  // collapsed to a mid-surface shell mesh here, so the stored model is the mixed
  // CTRIA3 + CTETRA model the user sees and solves — not an all-solid mesh whose
  // shells only ever existed transiently inside the solve.
  const mixed = inStage("shell_idealisation", () =>
    buildMeshTimeShellModel(
      nodes,
      elements,
      surfaceTriangles,
      surfaceFaceIds,
      new Set(payload.shellBodyIds ?? []),
      payload.properties ?? [],
      (line: string) => self.postMessage({ id, log: line }),
    ),
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

// ── solve ─────────────────────────────────────────────────────────────────────
//
// Each solve path's payload is built in src/lib/solve/* (pure, testable without
// a worker or WASM); the handlers below only call the engine and post results.

type SolveResultFields = {
  displacements: Float64Array;
  vonMises: Float64Array;
};

function postSolveResult(id: number, result: SolveResultFields) {
  self.postMessage(
    {
      id,
      ok: true,
      displacements: result.displacements,
      vonMises: result.vonMises,
    },
    [result.displacements.buffer, result.vonMises.buffer],
  );
}

function logTo(id: number): SolveLog {
  return (line) => self.postMessage({ id, log: line });
}

// The Kirchhoff shell solve of a { mesh, mat_json, bcs_json } payload, through
// the Rust module (KOF-306). The C++ engine's solve_shell takes the same
// payload and stays the test oracle (tests/integration/shell-rust.test.mjs).
function solveShell(
  inputs: Parameters<typeof solveShellInRust>[1],
  payload: SolvePayload,
  log: SolveLog,
) {
  return solveShellInRust(
    { ShellModel },
    inputs,
    payload.cgIterationLimit,
    onCgLimit,
    log,
  );
}

// Solve a pure-shell (all-CTRIA3) model with the Kirchhoff shell solver. The
// result matches the solid contract — three translations per node, one von
// Mises surface stress per element — so the store and viewport consume it
// unchanged. The DKT facet is linear and the shell solver applies no tie, so
// routeSolve refuses element order 2 and ties before this runs.
async function handleShellSolve(id: number, payload: SolvePayload) {
  const { nodes, elements } = payload;
  const inputs = buildShellEngineInputs(payload);

  self.postMessage({
    id,
    log: `Starting shell solve: ${nodes.length} nodes, ${elements.length} shell facets…`,
  });
  const result = await solveShell(inputs, payload, logTo(id));

  self.postMessage({
    id,
    log: `Shell solve complete: ${result.displacements.length / 3} vertex displacements, ${result.von_mises.length} facet stresses`,
  });
  postSolveResult(id, {
    displacements: result.displacements,
    vonMises: result.von_mises,
  });
}

// The mixed (solid + shell) Rust solve of the coupled assembler's inputs,
// with AMG when it was chosen and covers the model, otherwise the engine's
// incomplete Cholesky preconditioner. The C++ engine's solve_coupled takes
// the same inputs and stays the test oracle (tests/integration/coupled-rust.test.mjs).
function solveMixed(
  inputs: Parameters<typeof solveCoupledInRust>[1],
  payload: SolvePayload,
  log: SolveLog,
) {
  const preconditioner: MixedPreconditionerName =
    requestedSolver(payload) === "amg" && amgReason(payload) === null
      ? "amg"
      : "incomplete-cholesky";
  return solveCoupledInRust(
    { MixedModel, Couplings },
    inputs,
    preconditioner,
    payload.cgIterationLimit,
    onCgLimit,
    log,
  );
}

// Solve a hand-mixed shell+solid model through the Rust mixed solve, or an
// all-solid model carrying a surface-to-point coupling through the Rust solid
// solve (with the chosen preconditioner and element order) or, when Rust does
// not cover it, the engine's coupled solver, all on the same inputs. The mixed
// solve and the engine's coupled assembler are linear tets + DKT facets:
// routeSolve refuses element order 2 on a model with shells, and the engine's
// coupled solver says when it solves linear instead.
async function handleMixedSolve(id: number, payload: SolvePayload) {
  const inp = buildCoupledEngineInputs(payload, logTo(id));

  self.postMessage({
    id,
    log: `[mixed] ${inp.solidElements.length} solid tets (${inp.solidMaterialNames.join(", ")}), ${inp.shellElements.length} shell facets${inp.shellMaterialNames.length > 0 ? ` (${inp.shellMaterialNames.join(", ")})` : ""} → ${inp.model.pool.length / 3} pool nodes, ${inp.couplingCount} couplings (${inp.declaredCouplings} declared)…`,
  });
  // eslint-disable-next-line kofem/no-silent-fallback -- elementOrder is optional in the solve message; the documented default is linear elements
  const order = payload.elementOrder ?? 1;
  const hasShells = inp.shellElements.length > 0;
  const inRust = amgReason(payload) === null;
  if (!hasShells && !inRust && order !== 1)
    self.postMessage({
      id,
      log: `The coupled solver has linear elements only — solving with linear instead of order-${order} elements.`,
    });
  const result = hasShells
    ? await solveMixed(inp, payload, logTo(id))
    : inRust
      ? await solveCoupledSolidInRust(
          { ElasticModel, SolveOptions, Couplings },
          inp,
          order,
          requestedSolver(payload),
          payload.cgIterationLimit,
          onCgLimit,
          logTo(id),
        )
      : await m().solve_coupled(inp.mesh, inp.coupling, inp.bcs, inp.matJson);
  if ("error" in result) throw new Error(result.error);
  const fields = mapMixedResult(payload, inp.model, result);

  self.postMessage({
    id,
    log: `Mixed solve complete: ${fields.displacements.length / 3} vertex displacements, ${fields.vonMises.length} element stresses`,
  });
  postSolveResult(id, fields);
}

// A body marked Shell: solve it as shells or fail loudly — never fall through
// to the all-solid path, which would silently ignore the choice (KOF-352).
// Coupled when the shell touches a solid body; a pure Kirchhoff shell when every
// body is Shell. prepareAutoShellSolve throws, naming the body and the reason,
// when neither applies.
async function handleAutoShellSolve(
  id: number,
  payload: SolvePayload,
  shellBodyIds: Set<number>,
): Promise<void> {
  // The auto-shell progress lines have always gone to the shared log (id 0).
  const log = logTo(0);
  const prepared = prepareAutoShellSolve(payload, shellBodyIds, log);
  const fields =
    prepared.kind === "coupled"
      ? prepared.solve.mapResult(await solveMixed(prepared.solve, payload, log))
      : prepared.solve.mapResult(
          await solveShell(prepared.solve, payload, log),
        );
  self.postMessage({
    id,
    log: `Shell solve complete: ${fields.displacements.length / 3} vertex displacements`,
  });
  postSolveResult(id, fields);
}

// The solver the request asks for. The app always names one; a request without
// it is refused rather than guessed, since the two differ in method and speed.
function requestedSolver(payload: SolvePayload): SolverMethod {
  if (!isSolverMethod(payload.solverMethod))
    throw new Error(
      `solve: solverMethod must be "amg" or "gauss-seidel", got ${JSON.stringify(payload.solverMethod)}`,
    );
  return payload.solverMethod;
}

// Why AMG does not apply to this request, or null when it does.
function amgReason(payload: SolvePayload): string | null {
  return amgUnavailableReason({
    elements: payload.elements,
    properties: payload.properties,
    // eslint-disable-next-line kofem/no-silent-fallback -- elementOrder is optional in the solve message; the documented default is linear elements
    elementOrder: payload.elementOrder ?? 1,
    // eslint-disable-next-line kofem/no-silent-fallback -- `couplings` is optional in the solve message; a model with none is the ordinary case
    couplingCount: payload.couplings?.length ?? 0,
  });
}

// All-solid static solve, with tie connections applied — node-merge ties
// welded, constraint ties eliminated: the Rust solver with the chosen
// preconditioner when it covers the model, otherwise the engine's
// solve_linear_elastic, which takes no constraint tie.
async function handleSolidSolve(id: number, payload: SolvePayload) {
  const { nodes, elements } = payload;
  // FE polynomial order, chosen in the frontend (Solver settings). Order 2
  // (quadratic / second-order) adds edge-midpoint DOFs that resolve bending
  // and stress gradients far better than linear tets, which lock in bending
  // and smear stress concentrations to a single constant value per element
  // (issue #215), at the cost of a slower solve. Both solvers extend the
  // vertex Dirichlet BCs to the new edge DOFs so clamped/prescribed faces
  // stay fully constrained. Defaults to 1 (linear) when the payload omits it.
  // eslint-disable-next-line kofem/no-silent-fallback -- elementOrder is optional in the solve message; the documented default is linear elements
  const order = payload.elementOrder ?? 1;
  const reason = amgReason(payload);
  const constraintTies = constraintTieCount(payload.tieGroups);
  if (reason !== null && constraintTies > 0)
    throw new Error(
      `This model has ${constraintTies} constraint (MPC) tie(s), which only the Rust ` +
        `solver applies, and it cannot take this model: ${reason}. Change the ` +
        "ties to node-merge, or make the model one the Rust solver takes.",
    );
  const tied = weldTies(
    nodes,
    elements,
    payload.tieGroups,
    logTo(id),
    constraintTies > 0
      ? tieWeighting(order, { MortarSurface, tieMortarWeights })
      : null,
  );
  if (reason === null) {
    const result = await solveSolidInRust(
      { ElasticModel, SolveOptions, Ties },
      {
        ...payload,
        nodes: tied.solveNodes,
        elements: tied.tiedElements,
        constraintTies: tied.constraints,
      },
      order,
      requestedSolver(payload),
      tied.vid,
      tied.vidTied,
      payload.cgIterationLimit,
      onCgLimit,
      logTo(id),
    );
    const displacements = expandTiedDisplacements(
      nodes,
      tied,
      result.displacements,
    );
    self.postMessage({
      id,
      log: `Solve complete: ${displacements.length / 3} vertex displacements, ${result.vonMises.length} element stresses`,
    });
    postSolveResult(id, { displacements, vonMises: result.vonMises });
    return;
  }
  const { mesh, matJson, bcsJson } = buildSolidEngineInputs(
    { ...payload, nodes: tied.solveNodes, elements: tied.tiedElements },
    tied.vid,
    tied.vidTied,
  );

  self.postMessage({
    id,
    log: `Starting static solve: ${nodes.length} nodes, ${elements.length} elements (order ${order})…`,
  });
  // Mesh as typed arrays; materials/BCs stay JSON (small). The result comes
  // back as Float64Arrays whose buffers are handed to the main thread via
  // the postMessage transfer list — zero-copy, no JSON round-trip.
  const result = await m().solve_linear_elastic(mesh, matJson, bcsJson, order);
  if ("error" in result) throw new Error(result.error);

  // von Mises is per element; welding preserves element count and order, so it
  // passes through unchanged.
  const displacements = expandTiedDisplacements(
    nodes,
    tied,
    result.displacements,
  );
  self.postMessage({
    id,
    log: `Solve complete: ${displacements.length / 3} vertex displacements, ${result.von_mises.length} element stresses`,
  });
  postSolveResult(id, { displacements, vonMises: result.von_mises });
}

async function handleSolve(id: number, payload: SolvePayload) {
  m().cgIterationLimit = payload.cgIterationLimit;
  const reason = amgReason(payload);
  const route = routeSolve(payload);
  if (requestedSolver(payload) === "amg" && reason !== null) {
    const fallback = amgFallbackPreconditioner(route);
    self.postMessage({
      id,
      log: `AMG is not available for this model (${reason}) — solving with ${FALLBACK_PRECONDITIONER_LABEL[fallback]}.`,
    });
  }
  switch (route.path) {
    case "shell":
      await handleShellSolve(id, payload);
      return;
    case "coupled":
      await handleMixedSolve(id, payload);
      return;
    case "auto-shell":
      await handleAutoShellSolve(id, payload, route.shellBodyIds);
      return;
    case "solid":
      await handleSolidSolve(id, payload);
      return;
    default: {
      // Compile-time exhaustiveness: a new route without a case fails to build.
      const unhandled: never = route;
      throw new Error(`solve: unhandled route ${JSON.stringify(unhandled)}`);
    }
  }
}

// ── Topology optimization (solid / shell / coupled → optimize_topology*) ──────

// The optimizer result the worker returns, whichever design domain produced it.
// The density is one value per DESIGN element, in the canonical order the
// viewport's densityField expects — solid tets, then hexes, then shell facets —
// which is exactly the order each engine entry returns (KOF-237).
type TopOptEngineResult = {
  density: Float64Array;
  levelSet?: Float64Array;
  history: unknown[];
};

// Live density streaming (KOF-240): the engine calls this synchronously from
// inside the optimizer loop with a fresh Float64Array copy of the design density
// (float64_array copies out of the WASM heap), so the buffer is ours to transfer.
// The final iteration is always streamed, so the last progress message carries
// exactly the density the result then returns.
function densityStreamer(id: number) {
  return (it: number, density: Float64Array) => {
    self.postMessage({ id, progress: { it, density } }, [density.buffer]);
  };
}

function postDensityResult(id: number, result: TopOptEngineResult) {
  self.postMessage({
    id,
    log: `Topology optimization complete: ${result.density.length} element densities over ${result.history.length} iteration(s)`,
  });
  // The level set (method "level_set") is one value per engine vertex; the
  // solid path indexes vertices in payload node order (buildVertexIndexer), so it
  // arrives aligned with the store's `nodes` array.
  const transfer = [result.density.buffer];
  if (result.levelSet) transfer.push(result.levelSet.buffer);
  self.postMessage(
    {
      id,
      ok: true,
      density: result.density,
      levelSet: result.levelSet,
      history: result.history,
    },
    transfer,
  );
}

// SIMP / level-set topology optimization (KOF-226 epic, ADR-0002). The design
// domain follows the element mix, exactly as the static solve routes
// (routeTopOpt). SIMP on a solid domain runs in Rust (topOptRust.ts), one
// iteration per call; the shell and coupled domains and the level-set method
// run the whole loop inside an engine entry. Both stream "[topopt] it N: …"
// progress lines over the log channel the solve uses, and the design density
// per iteration as { id, progress: { it, density } } messages (KOF-240) so the
// viewport can draw the shape emerging.
//
// Cancellation is owned by the worker lifecycle, exactly as meshing is: the
// optimization runs synchronously in the worker, so the app cancels it by
// calling resetWorker() (terminate), which discards the in-flight run; the
// streamed live density is discarded with it — no best-so-far is kept.
function handleTopOpt(id: number, payload: TopOptPayload) {
  const domain = routeTopOpt(payload);
  const settingsJson = JSON.stringify(payload.settings);
  const onDensity = densityStreamer(id);
  const startLog = (nElems: number) =>
    self.postMessage({ id, log: topOptStartLog(payload, nElems, domain) });

  let result: TopOptResult;
  if (domain === "shell") {
    const { mesh, matJson, bcsJson } = buildShellEngineInputs(payload);
    startLog(payload.elements.length);
    result = m().optimize_topology_shell(
      mesh,
      matJson,
      bcsJson,
      settingsJson,
      onDensity,
    );
  } else if (domain === "coupled") {
    const inp = buildCoupledEngineInputs(payload, logTo(id));
    startLog(inp.solidElements.length + inp.shellElements.length);
    result = m().optimize_topology_coupled(
      inp.mesh,
      inp.coupling,
      inp.bcs,
      inp.matJson,
      settingsJson,
      onDensity,
    );
  } else if (usesRustTopOpt(payload.settings)) {
    // SIMP on a solid design domain runs in Rust (KOF-310). routeTopOpt has
    // refused a tied model already.
    startLog(payload.elements.length);
    result = optimizeSolidInRust(
      { ElasticModel, TopologySettings, TopologyRun },
      payload,
      logTo(id),
      onDensity,
    );
  } else {
    // The level-set method is still the engine's.
    const inp = buildSolidEngineInputs(
      payload,
      buildVertexIndexer(payload.nodes),
    );
    startLog(inp.elementCount);
    result = m().optimize_topology(
      inp.mesh,
      inp.matJson,
      inp.bcsJson,
      settingsJson,
      onDensity,
    );
  }
  if ("error" in result) throw new Error(result.error);
  postDensityResult(id, result);
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
  if ("overlaps" in dto)
    throw new Error(
      `test_generate_fem_mesh: the surface mesh overlaps itself in ${dto.overlaps.length} places`,
    );
  self.postMessage({
    id,
    ok: true,
    nodes: dto.vertices.length / 3,
    elements: dto.tetrahedra.length / 4,
    durationMs: Date.now() - t0,
  });
}

// ── Message handler ───────────────────────────────────────────────────────────

interface WorkerRequest {
  id: number;
  type: string;
  payload: unknown;
}

interface CgContinuationReply {
  requestId: number;
  extraIterations: number;
}

function handleCgReply(id: number, payload: CgContinuationReply): void {
  if (id !== activeTask || !cgReply || cgReply.requestId !== payload.requestId)
    return;
  const { resolve } = cgReply;
  cgReply = null;
  resolve(payload.extraIterations);
}

// Synchronous operations stay synchronous, including requests queued behind
// ensureInit(). Only a solve retains task ownership across an async pause.
function dispatchRequest({
  id,
  type,
  payload,
}: WorkerRequest): Promise<void> | null {
  switch (type) {
    case "init":
      self.postMessage({ id, ok: true });
      return null;
    case "parse_step":
      handleParseStep(id, payload as ParseStepPayload);
      return null;
    case "split_geometry":
      handleSplitGeometry(id, payload as SplitGeometryPayload);
      return null;
    case "boolean_geometry":
      handleBooleanGeometry(id, payload as BooleanGeometryPayload);
      return null;
    case "repair_hinges":
      handleRepairHinges(id, payload as RepairHingesPayload);
      return null;
    case "split_cone_tips":
      handleSplitConeTips(id, payload as SplitConeTipsPayload);
      return null;
    case "remove_faces":
      handleRemoveFaces(id, payload as RemoveFacesPayload);
      return null;
    case "volume_mesh":
      handleVolumeMesh(id, payload as VolumeMeshPayload);
      return null;
    case "solve":
      return handleSolve(id, payload as SolvePayload);
    case "thin_wall_check":
      self.postMessage({
        id,
        ok: true,
        findings: thinWallFindings(payload as ThinWallCheckInput),
      });
      return null;
    case "optimize_topology":
      handleTopOpt(id, payload as TopOptPayload);
      return null;
    case "test_generate_fem_mesh":
      handleTestGenerateFemMesh(id);
      return null;
    default:
      throw new Error(`Unknown worker message type: ${type}`);
  }
}

function isWasmTrap(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "RuntimeError") return false;
  return [
    "memory access out of bounds",
    "integer overflow",
    "integer divide by zero",
    "unreachable",
    "null function or function signature mismatch",
    "table index is out of bounds",
  ].some((message) => err.message.includes(message));
}

function reportTaskError(id: number, type: string, failure: unknown): void {
  const { stage, error: err } = splitStage(failure);
  const trap = isWasmTrap(err);
  const detail =
    err instanceof EngineLoadError
      ? `The solver engine failed to load: ${err.message} Retry from the status bar.`
      : describeError(err);
  const errorMessage = trap
    ? `WASM trap (code bug, not OOM): ${detail}`
    : detail;
  console.error(
    trap
      ? `[solver.worker] WASM trap in ${type}:`
      : `[solver.worker] ${type} failed:`,
    detail,
  );
  self.postMessage({
    id,
    ok: false,
    error: errorMessage,
    ...(stage === null ? {} : { stage }),
  });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = event.data;
  // Asyncify has suspended WASM. Only its matching decision may resume it;
  // no other request may enter the engine while its C++ stack is retained.
  if (type === "cg_continue") {
    handleCgReply(id, payload as CgContinuationReply);
    return;
  }
  let ownsTask = false;
  try {
    await ensureInit();
    if (activeTask !== null)
      throw new Error("The solver worker is busy with another operation");
    activeTask = id;
    ownsTask = true;
    const operation = dispatchRequest(event.data);
    if (operation !== null) await operation;
  } catch (err) {
    reportTaskError(id, type, err);
  } finally {
    if (ownsTask) {
      activeTask = null;
      cgReply = null;
    }
    flushCoverage();
  }
};
