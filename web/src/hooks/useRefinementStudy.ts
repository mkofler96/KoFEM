// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Mesh refinement study (KOF-401): one click solves the static case on the
// current mesh and on meshes √2 and 2 times finer, so the user sees whether
// the result still depends on the mesh. Each level meshes exactly as the Mesh
// button would (lib/volumeMesh) and solves exactly as the Solve button would
// (lib/solve/payload); the supports and loads follow their CAD faces onto each
// mesh. The model ends on the finest mesh with its result; the Mesh settings
// stay as the user typed them.

import { useMemo } from "react";
import { useModelStore, type ModelState } from "../store/modelStore";
import type { MeshSizes } from "../store/geometrySlice";
import type {
  RefinementLevelSnapshot,
  RefinementStudyRun,
} from "../store/studySlice";
import {
  levelSizes,
  checkLevelDisplacement,
  checkLevelMaterials,
  nextLevelNodes,
  REFINEMENT_LEVELS,
  sizeLabel,
  studyFingerprint,
  STUDY_NODE_BUDGET,
  type StudyLevel,
} from "../lib/refinementStudy";
import {
  applyVolumeMesh,
  parseMeshSizes,
  runVolumeMesh,
} from "../lib/volumeMesh";
import { solvePayload } from "../lib/solve/payload";
import { carryGroupsToMesh } from "../lib/remeshGroups";
import { modelShellRim } from "../lib/shellRim";
import { computeResultRange } from "../lib/resultField";
import { sendToWorker } from "../workers/sharedWorker";

type StudySource = Pick<
  ModelState,
  | "stepBytes"
  | "stepSurface"
  | "nodes"
  | "elements"
  | "surfaceTriangles"
  | "surfaceFaceIds"
  | "bcGroups"
  | "loadGroups"
  | "tieGroups"
  | "couplingGroups"
  | "meshSizes"
  | "maxElementSize"
  | "minElementSize"
  | "properties"
>;

// The sizes of the first level, and whether the current mesh is that level.
// A mesh made in this session records its sizes, and is level 0 as it is. An
// opened analysis does not record them: level 0 is then meshed at the Mesh
// settings.
function studyBase(s: StudySource): { sizes: MeshSizes; remesh: boolean } {
  if (s.meshSizes !== null) return { sizes: s.meshSizes, remesh: false };
  return {
    sizes: parseMeshSizes(s.maxElementSize, s.minElementSize, s.properties),
    remesh: true,
  };
}

// Why the study cannot run on this model, or null. Checked before anything is
// re-meshed: a group that cannot follow onto a new mesh would be lost.
export function refinementRefusal(s: StudySource): string | null {
  if (s.nodes.length === 0) return null; // the solve checks say "mesh first"
  if (s.stepBytes === null)
    return "The study re-meshes the geometry, and this model has none (an opened analysis keeps only its mesh). Re-import the STEP file to run it.";
  if (s.couplingGroups.length > 0)
    return `Couplings cannot follow onto a new mesh: their reference point is a node of this one. Remove ${s.couplingGroups.map((c) => c.name).join(", ")} to run the study.`;
  // Carry the groups onto the mesh they are on: what does not come across
  // here cannot come across to a finer mesh either.
  const carried = carryGroupsToMesh(
    {
      bcGroups: s.bcGroups,
      loadGroups: s.loadGroups,
      tieGroups: s.tieGroups,
      couplingGroups: [],
    },
    s.surfaceTriangles,
    s.surfaceFaceIds,
    new Set(s.nodes.map((n) => n.id)),
    modelShellRim(
      {
        nodes: s.nodes,
        elements: s.elements,
        surfaceTriangles: s.surfaceTriangles,
        surfaceFaceIds: s.surfaceFaceIds,
      },
      s.stepSurface,
    ).nodesByFace,
  );
  if (carried.dropped.length > 0)
    return `Only supports and loads picked as whole CAD faces follow onto a new mesh. Pick these again as faces to run the study: ${carried.dropped.join("; ")}.`;
  try {
    studyBase(s);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return err.message;
  }
  return null;
}

// Supports, loads and tie surfaces: a re-mesh that loses one changes the model.
function entryCount(s: StudySource): number {
  return (
    s.bcGroups.reduce((n, g) => n + g.faces.length, 0) +
    s.loadGroups.reduce((n, g) => n + g.faces.length, 0) +
    s.tieGroups.reduce((n, t) => n + t.facesA.length + t.facesB.length, 0)
  );
}

// Nodes the solver works on: a quadratic tetrahedron adds a node on each edge,
// about seven per vertex on a Netgen mesh.
function solverNodes(vertices: number, elementOrder: number): number {
  return elementOrder === 2 ? 8 * vertices : vertices;
}

function levelSnapshot(s: ModelState): RefinementLevelSnapshot {
  return {
    nodes: s.nodes,
    elements: s.elements,
    properties: s.properties,
    surfaceTriangles: s.surfaceTriangles,
    surfaceFaceIds: s.surfaceFaceIds,
    meshSizes: s.meshSizes,
    meshSuppressedIds: s.meshSuppressedIds,
    bcGroups: s.bcGroups,
    loadGroups: s.loadGroups,
    tieGroups: s.tieGroups,
    constraints: s.constraints,
    loads: s.loads,
    surfaceLoads: s.surfaceLoads,
    result: s.result,
  };
}

function levelMetrics(s: ModelState, sizes: MeshSizes): StudyLevel {
  if (s.result === null)
    throw new Error("The level's solve stored no result to measure");
  const disp = computeResultRange(
    s.result,
    "Displacement (magnitude)",
    s.nodes,
    s.elements,
  );
  if (disp === null)
    throw new Error("The level's solve returned no displacement to measure");
  const vm = computeResultRange(
    s.result,
    "Von Mises stress",
    s.nodes,
    s.elements,
  );
  return {
    sizes,
    nodes: s.nodes.length,
    elements: s.elements.length,
    maxDisplacement: disp.max,
    maxVonMises: vm === null ? null : vm.max,
  };
}

export function useRefinementStudy() {
  const run = useModelStore((s) => s.refinementStudy);
  const stepBytes = useModelStore((s) => s.stepBytes);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const tieGroups = useModelStore((s) => s.tieGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const meshSizes = useModelStore((s) => s.meshSizes);
  const maxElementSize = useModelStore((s) => s.maxElementSize);
  const minElementSize = useModelStore((s) => s.minElementSize);
  const properties = useModelStore((s) => s.properties);

  const source: StudySource = useMemo(
    () => ({
      stepBytes,
      stepSurface,
      nodes,
      elements,
      surfaceTriangles,
      surfaceFaceIds,
      bcGroups,
      loadGroups,
      tieGroups,
      couplingGroups,
      meshSizes,
      maxElementSize,
      minElementSize,
      properties,
    }),
    [
      stepBytes,
      stepSurface,
      nodes,
      elements,
      surfaceTriangles,
      surfaceFaceIds,
      bcGroups,
      loadGroups,
      tieGroups,
      couplingGroups,
      meshSizes,
      maxElementSize,
      minElementSize,
      properties,
    ],
  );
  const refusal = useMemo(() => refinementRefusal(source), [source]);
  // The sizes the levels will mesh at, for the hint under the button.
  const plannedSizes = useMemo(() => {
    if (refusal !== null || nodes.length === 0) return null;
    const { sizes } = studyBase(source);
    return Array.from(
      { length: REFINEMENT_LEVELS },
      (_, k) => levelSizes(sizes, k).max,
    );
  }, [refusal, source, nodes.length]);

  async function start(): Promise<void> {
    const get = useModelStore.getState;
    const s0 = get();
    const refused = refinementRefusal(s0);
    if (refused !== null) throw new Error(refused);
    if (s0.stepBytes === null)
      throw new Error("The study needs the geometry to re-mesh");
    const stepBytes = s0.stepBytes;
    const { sizes: base, remesh } = studyBase(s0);
    // The editors stay open while the study runs: a level solved after an
    // edit would mix two models into one verdict, so the study stops instead.
    const fingerprint = studyFingerprint(s0);
    const assertUnchanged = () => {
      if (studyFingerprint(get()) !== fingerprint)
        throw new Error(
          "The model changed while the study ran (a material, body, support, load or solver setting). Run the study again to compare levels of one model.",
        );
    };

    let current: RefinementStudyRun = {
      status: "running",
      step: null,
      phase: null,
      plannedSizes: Array.from(
        { length: REFINEMENT_LEVELS },
        (_, k) => levelSizes(base, k).max,
      ),
      levels: [],
      snapshots: [],
      fingerprint,
      stopNote: null,
      error: null,
    };
    const publish = (patch: Partial<RefinementStudyRun>) => {
      current = { ...current, ...patch };
      get().setRefinementStudy(current);
    };
    publish({});
    // Straight to the result: the chart fills the centre and the levels land
    // on the right as they finish.
    get().showRefinementResult();
    s0.setRunning(true);
    try {
      for (let k = 0; k < REFINEMENT_LEVELS; k++) {
        const sizes = levelSizes(base, k);
        const label = `Level ${k + 1} of ${REFINEMENT_LEVELS}`;
        const previous = current.levels[current.levels.length - 1];
        if (previous !== undefined) {
          const model = get();
          const shellOnly = model.elements.every((e) => e.type === "CTRIA3");
          const estimate = solverNodes(
            nextLevelNodes(previous.nodes, shellOnly ? 2 : 3),
            model.elementOrder,
          );
          if (estimate > STUDY_NODE_BUDGET) {
            const note = `The mesh at ${sizeLabel(sizes.max)} mm would have about ${Math.round(estimate).toLocaleString("en-US")} nodes, more than a browser solves comfortably (${STUDY_NODE_BUDGET.toLocaleString("en-US")}).`;
            if (current.levels.length < 2)
              throw new Error(
                `${note} Coarsen the mesh to run the study from a coarser start.`,
              );
            publish({
              stopNote: `Stopped after ${current.levels.length} levels. ${note}`,
            });
            break;
          }
        }
        assertUnchanged();
        if (k > 0 || remesh) {
          publish({
            step: `${label} · meshing at ${sizeLabel(sizes.max)} mm`,
            phase: "meshing",
          });
          get().setMeshing(true);
          let reply;
          try {
            reply = await runVolumeMesh({
              stepBytes,
              geometryFormat: get().geometryFormat,
              properties: get().properties,
              sizes,
            });
          } finally {
            get().setMeshing(false);
          }
          if (reply.kind === "overlaps") {
            get().setMeshOverlaps(reply.overlaps);
            throw new Error(
              `The mesh at ${sizeLabel(sizes.max)} mm found overlapping bodies — see the Mesh step.`,
            );
          }
          const before = entryCount(get());
          applyVolumeMesh(get().applyMeshResult, reply.mesh, sizes);
          if (entryCount(get()) !== before)
            throw new Error(
              `Supports or loads did not follow onto the mesh at ${sizeLabel(sizes.max)} mm. ${get().remeshNotice ?? ""}`.trim(),
            );
          checkLevelMaterials(get().properties, sizes.max);
        }
        const model = get();
        publish({
          step: `${label} · solving ${model.nodes.length.toLocaleString("en-US")} nodes`,
          phase: "solving",
        });
        const { displacements, vonMises } = await sendToWorker<{
          displacements: Float64Array;
          vonMises: Float64Array;
        }>("solve", solvePayload(model));
        get().setResult({ displacements, vonMises });
        assertUnchanged();
        const level = levelMetrics(get(), sizes);
        checkLevelDisplacement(level.maxDisplacement, sizes.max);
        publish({
          levels: [...current.levels, level],
          snapshots: [...current.snapshots, levelSnapshot(get())],
        });
      }
      publish({ status: "done", step: null, phase: null });
    } catch (err) {
      console.error("[refinement study] failed:", err);
      publish({
        status: "failed",
        step: null,
        phase: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      get().setRunning(false);
    }
  }

  return { run, refusal, plannedSizes, start };
}
