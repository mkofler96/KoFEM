// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a mesh request asks the engine for, and the model the store keeps from
// its reply. Shared by the solver worker (volume_mesh) and the example
// pipeline (examples/validation/lib/pipeline.mjs), so the examples are meshed
// exactly as the app meshes them.
//
// The engine meshes a Shell body whose faces pair as its CAD mid-surface
// (KOF-498) and every other body as a volume. The stored model is the volume
// part as node and element lists, without the suppressed bodies, plus the
// Shell body: its CAD mid-surface with the links back to the CAD faces
// (lib/cadShell), or, when its faces do not pair, the mid-surface idealised
// from its volume mesh (lib/solve/autoShell, #397).

import type {
  FemMesh,
  ShellRoute,
  ThinWallRule,
} from "../wasm/pkg/kofem_wasm.js";
import type {
  Element,
  Node,
  Property,
  VolumeMeshPayload,
} from "../workers/solverTypes.js";
import { buildCadShellModel, type MidSurfaceLinks } from "./cadShell.js";
import {
  buildMeshTimeShellModel,
  requireOneShellBody,
} from "./solve/autoShell.js";
import { shellThinWallRule } from "./shellize.js";
import {
  dropSuppressedBodies,
  type VolumeMeshParts,
} from "./suppressBodies.js";
import { inStage } from "./workerError.js";
import { tr } from "../i18n/useLocale.js";
import { meshMessages } from "../i18n/messages/mesh.js";

type Triangle = [number, number, number];

export interface StoredMesh {
  nodes: Node[];
  elements: Element[];
  // Present when a Shell body was meshed: the CAD bodies' properties plus
  // one PSHELL per wall thickness.
  properties?: Property[];
  surfaceTriangles: Triangle[];
  surfaceFaceIds: number[];
  shellRoutes: ShellRoute[];
  midSurfaceLinks: MidSurfaceLinks | null;
}

// The generate_fem_mesh options for the bodies marked Shell. One Shell body
// per model, as the solve takes.
export function shellMeshOptions(shellBodyIds: Set<number>): {
  shell_bodies?: number[];
  thin_wall?: ThinWallRule;
} {
  requireOneShellBody(shellBodyIds);
  if (shellBodyIds.size === 0) return {};
  return { shell_bodies: [...shellBodyIds], thin_wall: shellThinWallRule() };
}

function chunk3(flat: Int32Array): Triangle[] {
  const out = new Array<Triangle>(flat.length / 3);
  for (let i = 0; i < out.length; i++)
    out[i] = [flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]];
  return out;
}

type MeshRequest = Pick<
  VolumeMeshPayload,
  "properties" | "suppressedBodyIds"
> & {
  shellBodyIds: Set<number>;
};

// The bodies the engine meshed as volumes, without the suppressed ones.
function volumePart(
  dto: FemMesh,
  suppressed: ReadonlySet<number>,
): VolumeMeshParts<Node, Element> {
  // The store models nodes/elements as object lists; build them here from
  // the flat arrays (plain JS, no parsing — cheap relative to meshing).
  const nodes: Node[] = new Array<Node>(dto.vertices.length / 3);
  for (let i = 0; i < nodes.length; i++)
    nodes[i] = {
      id: i,
      x: dto.vertices[3 * i],
      y: dto.vertices[3 * i + 1],
      z: dto.vertices[3 * i + 2],
    };
  const elements: Element[] = new Array<Element>(dto.tetrahedra.length / 4);
  for (let i = 0; i < elements.length; i++)
    elements[i] = {
      id: i,
      type: "CTETRA",
      nodeIds: Array.from(dto.tetrahedra.subarray(4 * i, 4 * i + 4)),
      // The tet's body (1-based CAD solid index) — resolved to a material via
      // the store's properties at solve time (#353).
      propertyId: dto.bodyIds[i],
    };
  return dropSuppressedBodies(
    {
      nodes,
      elements,
      surfaceTriangles: chunk3(dto.surfaceTriangles),
      surfaceFaceIds: Array.from(dto.surfaceFaceIds),
    },
    suppressed,
  );
}

// The volume part plus the Shell body, on whichever path the engine took.
function withShellBody(
  volume: VolumeMeshParts<Node, Element>,
  dto: FemMesh,
  request: MeshRequest,
  log: (line: string) => void,
): StoredMesh {
  const shellRoutes = dto.shellRoutes ?? [];
  const properties = request.properties ?? [];
  const { midSurface } = dto;
  if (midSurface) {
    const model = inStage("shell_idealisation", () =>
      buildCadShellModel(volume, midSurface, properties),
    );
    log(
      `[shell] CAD mid-surface: ${model.links.facets.length} shell facets, ${volume.elements.length} tetrahedra`,
    );
    return {
      nodes: model.nodes,
      elements: model.elements,
      properties: model.properties,
      surfaceTriangles: model.surfaceTriangles,
      surfaceFaceIds: model.surfaceFaceIds,
      shellRoutes,
      midSurfaceLinks: model.links,
    };
  }

  const mixed = inStage("shell_idealisation", () =>
    buildMeshTimeShellModel(
      volume.nodes,
      volume.elements,
      volume.surfaceTriangles,
      volume.surfaceFaceIds,
      request.shellBodyIds,
      properties,
      log,
    ),
  );
  if (mixed) return { ...mixed, shellRoutes, midSurfaceLinks: null };
  return { ...volume, shellRoutes, midSurfaceLinks: null };
}

export function storedMesh(
  dto: FemMesh,
  // The mesh request: the property table and the suppressed bodies, as the
  // app sends them (VolumeMeshPayload; absent: none), and the Shell bodies.
  request: MeshRequest,
  log: (line: string) => void,
): StoredMesh {
  const suppressed = new Set(request.suppressedBodyIds ?? []);
  const volume = volumePart(dto, suppressed);
  if (suppressed.size > 0)
    log(
      `Suppressed bodies ${[...suppressed].join(", ")} left out: ${volume.nodes.length} nodes, ${volume.elements.length} elements remain`,
    );
  const stored = withShellBody(volume, dto, request, log);
  if (stored.elements.length > 0) return stored;
  if (suppressed.size === 0)
    throw new Error("storedMesh: the engine returned a mesh without elements");
  throw new Error(tr(meshMessages).allSuppressed([...suppressed].join(", ")));
}
