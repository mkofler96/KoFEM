// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// One volume-mesh request to the worker, from validated element sizes: the
// Mesh panel (hooks/useMesh) and the mesh refinement study
// (hooks/useRefinementStudy) both mesh through here, so a study level meshes
// exactly as the Mesh button would at the same sizes.

import type { MeshOverlap } from "../wasm/pkg/kofem_wasm";
import {
  isCadBody,
  MESH_KIND_LABEL,
  meshKind,
  type Element,
  type GeometryFormat,
  type MeshSizes,
  type Node,
  type Property,
} from "../store/geometrySlice";
import {
  resetWorker,
  sendToWorker,
  WorkerResetError,
} from "../workers/sharedWorker";
import { regionMaxSizes, solidName } from "./regions";
import type { ModelState } from "../store/modelStore";

// The Mesh settings as typed (the global max and min, and each region's own
// max), validated into sizes a mesh request takes. Throws with the message the
// user sees for the first invalid one.
export function parseMeshSizes(
  maxElementSize: string,
  minElementSize: string,
  properties: Property[],
): MeshSizes {
  const max = parseFloat(maxElementSize);
  const min = parseFloat(minElementSize);
  if (!Number.isFinite(max) || max <= 0)
    throw new Error(
      `Max element size must be a positive number of mm — got "${maxElementSize}".`,
    );
  if (!Number.isFinite(min) || min < 0)
    throw new Error(
      `Min element size must be 0 or a positive number of mm — got "${minElementSize}".`,
    );
  if (min > max)
    throw new Error(
      `Min element size (${min} mm) must not exceed max element size (${max} mm).`,
    );
  // Regions with a size of their own (KOF-257). The min size stays global —
  // Netgen has one — so no region may go below it.
  const regions = regionMaxSizes(properties);
  for (const [id, size] of regions)
    if (min > size)
      throw new Error(
        `Min element size (${min} mm) must not exceed the max element size of ${solidName(properties, id)} (${size} mm).`,
      );
  return { max, min, regions: Object.fromEntries(regions) };
}

export interface VolumeMeshInput {
  stepBytes: Uint8Array;
  geometryFormat: GeometryFormat;
  properties: Property[];
  // Validated sizes: max > 0, 0 ≤ min ≤ every max, region sizes keyed by CAD
  // solid id.
  sizes: MeshSizes;
}

export interface VolumeMesh {
  nodes: Node[];
  elements: Element[];
  // Present when the mesh idealised bodies as shells (#397).
  properties?: Property[];
  surfaceTriangles: [number, number, number][] | null;
  surfaceFaceIds: number[] | null;
  // The bodies the request left out as suppressed.
  suppressedBodyIds: number[];
}

export type VolumeMeshReply =
  | { kind: "mesh"; mesh: VolumeMesh }
  | { kind: "overlaps"; overlaps: MeshOverlap[] };

// Mesh the geometry at `sizes`. Resets the worker after Netgen ran, on a mesh,
// an overlap refusal or a failure: Netgen's Ng_Init() installs global C++
// state in the engine module, and later engine calls get a clean instance. A
// failed mesh must not be retried in the same module either: one that ran out
// of memory leaks the Netgen mesh and OCC geometry, and every retry there
// fails, ending in Aborted() (KOF-418). A mesh ended by resetWorker() itself
// (New model) already has a fresh worker, which must survive.
export async function runVolumeMesh(
  input: VolumeMeshInput,
): Promise<VolumeMeshReply> {
  const { stepBytes, geometryFormat, properties, sizes } = input;
  // One size per CAD solid, in solid order: the region's own, else the global.
  const regionCount = Object.keys(sizes.regions).length;
  const solidMaxSizes =
    regionCount > 0
      ? properties
          .filter(isCadBody)
          .map((p) => p.id)
          .sort((a, b) => a - b)
          .map((id) => {
            const own = sizes.regions[id];
            return own === undefined ? sizes.max : own;
          })
      : undefined;
  // Captured at request time: the mesh records what it left out, even if the
  // user toggles a body while Netgen runs.
  const suppressedBodyIds = properties
    .filter((p) => isCadBody(p) && p.suppressed)
    .map((p) => p.id);
  const request = sendToWorker<
    | {
        nodes: Node[];
        elements: Element[];
        properties?: Property[];
        surfaceTriangles: [number, number, number][] | null;
        surfaceFaceIds: number[] | null;
      }
    | { overlaps: MeshOverlap[] }
  >("volume_mesh", {
    bytes: stepBytes,
    format: geometryFormat,
    maxElementSize: sizes.max,
    minElementSize: sizes.min,
    solidMaxSizes,
    // Bodies the user marked Shell, plus the property table: meshing
    // idealises them to a mid-surface shell mesh and returns the mixed
    // CTRIA3 + CTETRA model (#397). Only CAD bodies can be idealised — the
    // PSHELLs a previous mesh derived are shells already, and passing their
    // ids would send the thin-wall extraction hunting for bodies the fresh
    // mesh has never heard of.
    shellBodyIds: properties
      .filter(
        (p) => isCadBody(p) && p.discretization === "shell" && !p.suppressed,
      )
      .map((p) => p.id),
    suppressedBodyIds,
    properties,
  });
  const reply = await request.catch((err: unknown) => {
    if (!(err instanceof WorkerResetError)) resetWorker();
    throw err;
  });
  resetWorker();
  if ("overlaps" in reply)
    return { kind: "overlaps", overlaps: reply.overlaps };
  return { kind: "mesh", mesh: { ...reply, suppressedBodyIds } };
}

// Make `mesh`, meshed at `sizes`, the model's mesh: the store carries the
// supports, loads and ties picked on whole CAD faces over to it.
export function applyVolumeMesh(
  applyMeshResult: ModelState["applyMeshResult"],
  mesh: VolumeMesh,
  sizes: MeshSizes,
): void {
  applyMeshResult(
    mesh.nodes,
    mesh.elements,
    MESH_KIND_LABEL[meshKind(mesh.elements)],
    sizes,
    mesh.surfaceTriangles,
    mesh.surfaceFaceIds,
    mesh.properties,
    mesh.suppressedBodyIds,
  );
}
