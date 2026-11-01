// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// Load glyphs: one resultant arrow per load group, or one arrow per loaded
// node sized by the load it carries (loadDisplay === "nodal"). Moment arrows
// are double-headed and shown in both display modes.

import { useMemo } from "react";
import { Quaternion, Vector3 } from "three";
import {
  useModelStore,
  loadKind,
  loadComponents,
} from "../../store/modelStore";
import type { NamedLoadGroup } from "../../store/modelStore";
import type { MeshTopology } from "./useMeshTopology";
import { modelCentroid, nodePosition } from "./bcOverlayShared";

const LOAD_COLOR = "#d97706";

// Load direction (unit) and magnitude (N) carried by one node.
interface NodalLoad {
  dir: Vector3;
  mag: number;
}

// Area and unit normal of a boundary triangle or quad: a triangle directly, a
// quad via its diagonals. The normal's orientation follows the corner order.
function faceAreaNormal(corners: readonly Vector3[]): {
  area: number;
  normal: Vector3;
} {
  const normal = new Vector3();
  if (corners.length === 3) {
    normal
      .copy(corners[1])
      .sub(corners[0])
      .cross(new Vector3().copy(corners[2]).sub(corners[0]));
  } else {
    normal
      .copy(corners[2])
      .sub(corners[0])
      .cross(new Vector3().copy(corners[3]).sub(corners[1]));
  }
  const area = 0.5 * normal.length();
  return { area, normal };
}

// Tributary area per node and, for pressure, the area-weighted inward normal,
// integrated over the boundary faces that lie entirely on the group's selected
// faces. This is the same membership test the solver uses to apply the
// surface traction, so the per-node share matches the FE load.
function tributaryAreas(
  nodeSet: ReadonlySet<number>,
  withNormals: boolean,
  posOf: (id: number) => Vector3 | null,
  centroid: Vector3,
  faces: readonly (readonly number[])[],
): {
  tribArea: Map<number, number>;
  inward: Map<number, Vector3>;
  totalArea: number;
} {
  const tribArea = new Map<number, number>();
  const inward = new Map<number, Vector3>();
  let totalArea = 0;
  for (const ids of faces) {
    if (!ids.every((id) => nodeSet.has(id))) continue;
    const pts = ids.map(posOf);
    if (pts.some((pt) => pt === null)) continue;
    const corners = pts as Vector3[];

    const { area, normal } = faceAreaNormal(corners);
    if (area < 1e-30) continue;
    normal.normalize();
    totalArea += area;

    // Orient the face normal inward (positive pressure pushes in).
    const fc = new Vector3();
    for (const v of corners) fc.add(v);
    fc.divideScalar(corners.length);
    if (normal.dot(new Vector3().copy(centroid).sub(fc)) < 0) normal.negate();

    const share = area / corners.length;
    for (const id of ids) {
      // eslint-disable-next-line kofem/no-silent-fallback -- accumulating tributary area; 0 is the identity for a node seen for the first time
      tribArea.set(id, (tribArea.get(id) ?? 0) + share);
      if (withNormals) {
        // eslint-disable-next-line kofem/no-silent-fallback -- accumulating area-weighted normals; the zero vector is the identity for a node seen for the first time
        const acc = inward.get(id) ?? new Vector3();
        inward.set(id, acc.addScaledVector(normal, area));
      }
    }
  }
  return { tribArea, inward, totalArea };
}

// The work-equivalent load each node of one force or pressure group carries:
// its tributary-area share of the group total (force ⇒ totalForce·Aᵢ/A,
// pressure ⇒ p·Aᵢ, both in N). Force arrows point along the applied force;
// pressure arrows point into the surface along the per-node inward normal.
// Moments have no per-node decomposition and yield no entries.
function groupNodalLoads(
  g: NamedLoadGroup,
  posOf: (id: number) => Vector3 | null,
  centroid: Vector3,
  triFaces: readonly (readonly number[])[],
  quadFaces: readonly (readonly number[])[],
): Map<number, NodalLoad> {
  const loads = new Map<number, NodalLoad>();
  const kind = loadKind(g);
  if (kind === "moment") return loads;

  const nodeSet = new Set<number>();
  for (const f of g.faces) for (const id of f.nodeIds) nodeSet.add(id);
  if (nodeSet.size === 0) return loads;

  const { tribArea, inward, totalArea } = tributaryAreas(
    nodeSet,
    kind === "pressure",
    posOf,
    centroid,
    [...triFaces, ...quadFaces],
  );
  if (totalArea < 1e-30) return loads;

  // Force direction is shared by every node; pressure direction is per-node.
  const force = loadComponents(g);
  const forceMag = Math.hypot(force[0], force[1], force[2]);
  const forceDir = new Vector3();
  if (kind === "force") {
    if (forceMag < 1e-30) return loads;
    forceDir.set(force[0], force[1], force[2]).normalize();
  }
  // Pressure stores its (signed) magnitude in totalForce; positive pushes in.
  const pressureSign = g.totalForce < 0 ? -1 : 1;

  for (const [id, a] of tribArea) {
    let dir: Vector3;
    let mag: number;
    if (kind === "force") {
      dir = forceDir;
      mag = forceMag * (a / totalArea);
    } else {
      const acc = inward.get(id);
      if (!acc || acc.lengthSq() < 1e-30) continue;
      dir = acc.clone().normalize().multiplyScalar(pressureSign);
      mag = Math.abs(g.totalForce) * a; // p · Aᵢ
    }
    if (mag < 1e-30) continue;
    loads.set(id, { dir, mag });
  }
  return loads;
}

interface LoadArrowsProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function LoadArrows({ topology, showResult }: LoadArrowsProps) {
  const nodes = useModelStore((s) => s.nodes);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const loadDisplay = useModelStore((s) => s.loadDisplay);
  const { nodeMap, modelSize, boundaryQuadFaceIds, boundaryTriFaceIds } =
    topology;

  // Load glyphs — one arrow per load group, at the centroid of its loaded
  // nodes. Force arrows point along the applied force; pressure arrows point
  // into the loaded face (positive pressure pushes inward); moment arrows point
  // along the moment vector [Mx,My,Mz] (right-hand rule) and are drawn with a
  // double head, the standard couple symbol (issue #277). Driven by loadGroups
  // because force/pressure loads reach the solver as surface tractions rather
  // than nodal forces.
  const loadArrows = useMemo(() => {
    if (loadGroups.length === 0 || nodes.length === 0) return [];
    // Model centroid — used to orient pressure arrows inward.
    const centroid = modelCentroid(nodes);

    const up = new Vector3(0, 1, 0);
    const arrows: {
      groupId: number;
      pos: [number, number, number];
      quaternion: Quaternion;
      isMoment: boolean;
    }[] = [];
    for (const g of loadGroups) {
      const kind = loadKind(g);
      let cx = 0,
        cy = 0,
        cz = 0,
        count = 0;
      for (const f of g.faces) {
        for (const id of f.nodeIds) {
          const entry = nodeMap.get(id);
          if (entry) {
            cx += entry.n.x;
            cy += entry.n.y;
            cz += entry.n.z;
            count++;
          }
        }
      }
      if (count === 0) continue;
      cx /= count;
      cy /= count;
      cz /= count;

      let dir: Vector3;
      if (kind === "pressure") {
        dir = new Vector3(centroid.x - cx, centroid.y - cy, centroid.z - cz);
      } else {
        // Force [Fx,Fy,Fz] or moment [Mx,My,Mz] vector — a moment arrow points
        // along its axis (right-hand rule), e.g. Mz along +z.
        const vec = loadComponents(g);
        dir = new Vector3(vec[0], vec[1], vec[2]);
      }
      if (dir.lengthSq() < 1e-30) continue;
      dir.normalize();
      const quaternion = new Quaternion();
      quaternion.setFromUnitVectors(up, dir);
      arrows.push({
        groupId: g.id,
        pos: [cx, cy, cz],
        quaternion,
        isMoment: kind === "moment",
      });
    }
    return arrows;
  }, [loadGroups, nodes, nodeMap]);

  // Per-node load glyphs — one arrow at every loaded node, sized by the
  // work-equivalent load that node carries: its tributary-area share of the
  // group total (force ⇒ totalForce·Aᵢ/A, pressure ⇒ p·Aᵢ, both in N). This is
  // what actually reaches the solver as a surface traction, in contrast to the
  // single statically-equivalent resultant. Shown when loadDisplay === "nodal".
  // Force arrows point along the applied force; pressure arrows point into the
  // surface along the per-node inward normal. Moments carry no per-node force
  // decomposition here — they are represented by the group-level double-headed
  // axis arrow, which is drawn in both display modes (issues #196, #277).
  const nodalLoadArrows = useMemo(() => {
    if (loadGroups.length === 0 || nodes.length === 0) return [];

    // Model centroid — used to orient pressure arrows inward.
    const centroid = modelCentroid(nodes);
    const posOf = (id: number) => nodePosition(nodeMap, id);

    // Accumulated per node across all groups: load direction (unit) and
    // magnitude (N). A node shared by two groups gets the larger arrow.
    const byNode = new Map<number, NodalLoad>();
    for (const g of loadGroups) {
      for (const [id, load] of groupNodalLoads(
        g,
        posOf,
        centroid,
        boundaryTriFaceIds,
        boundaryQuadFaceIds,
      )) {
        const prev = byNode.get(id);
        if (!prev || load.mag > prev.mag) byNode.set(id, load);
      }
    }

    if (byNode.size === 0) return [];
    let maxMag = 0;
    for (const { mag } of byNode.values()) if (mag > maxMag) maxMag = mag;
    if (maxMag < 1e-30) return [];

    const up = new Vector3(0, 1, 0);
    const arrows: {
      nodeId: number;
      pos: [number, number, number];
      quaternion: Quaternion;
      frac: number;
    }[] = [];
    for (const [id, { dir, mag }] of byNode) {
      const entry = nodeMap.get(id);
      if (!entry) continue;
      const quaternion = new Quaternion().setFromUnitVectors(up, dir);
      arrows.push({
        nodeId: id,
        pos: [entry.n.x, entry.n.y, entry.n.z],
        quaternion,
        frac: mag / maxMag,
      });
    }
    return arrows;
  }, [loadGroups, nodes, nodeMap, boundaryTriFaceIds, boundaryQuadFaceIds]);

  if (showResult) return null;
  return (
    <>
      {/* Resultant load arrows — one per group, cylinder shaft + cone head.
          Moment arrows get a second head (couple symbol) and, having no
          per-node form, appear in both display modes. */}
      {loadArrows
        .filter((arrow) => arrow.isMoment || loadDisplay === "resultant")
        .map((arrow) => {
          const shaftLen = modelSize * 0.22;
          const headLen = modelSize * 0.09;
          const shaftR = modelSize * 0.012;
          const headR = modelSize * 0.038;
          return (
            <group
              key={`arrow-${arrow.groupId}`}
              // skipcq: JS-0455 -- typed React Three Fiber property
              position={arrow.pos}
              // skipcq: JS-0455 -- typed React Three Fiber property
              quaternion={arrow.quaternion}
            >
              <mesh
                // skipcq: JS-0455 -- typed React Three Fiber property
                position={[0, shaftLen / 2, 0]}
              >
                <cylinderGeometry
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[shaftR, shaftR, shaftLen, 8]}
                />
                <meshStandardMaterial color={LOAD_COLOR} />
              </mesh>
              <mesh
                // skipcq: JS-0455 -- typed React Three Fiber property
                position={[0, shaftLen + headLen / 2, 0]}
              >
                <coneGeometry
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[headR, headLen, 8]}
                />
                <meshStandardMaterial color={LOAD_COLOR} />
              </mesh>
              {arrow.isMoment && (
                <mesh
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  position={[0, shaftLen - headLen / 2, 0]}
                >
                  <coneGeometry
                    // skipcq: JS-0455 -- typed React Three Fiber property
                    args={[headR, headLen, 8]}
                  />
                  <meshStandardMaterial color={LOAD_COLOR} />
                </mesh>
              )}
            </group>
          );
        })}

      {/* Per-node load arrows — one per loaded node, length scaled by the load
          that node carries (relative to the largest in the model) */}
      {loadDisplay === "nodal" &&
        nodalLoadArrows.map((arrow) => {
          // Shortest arrows stay at 35% of the full length so light-loaded
          // nodes remain visible; radii are fixed so arrows read as a field.
          const len = modelSize * 0.13 * (0.35 + 0.65 * arrow.frac);
          const shaftLen = len * 0.68;
          const headLen = len * 0.32;
          const shaftR = modelSize * 0.006;
          const headR = modelSize * 0.018;
          return (
            <group
              key={`nodal-arrow-${arrow.nodeId}`}
              // skipcq: JS-0455 -- typed React Three Fiber property
              position={arrow.pos}
              // skipcq: JS-0455 -- typed React Three Fiber property
              quaternion={arrow.quaternion}
            >
              <mesh
                // skipcq: JS-0455 -- typed React Three Fiber property
                position={[0, shaftLen / 2, 0]}
              >
                <cylinderGeometry
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[shaftR, shaftR, shaftLen, 6]}
                />
                <meshStandardMaterial color={LOAD_COLOR} />
              </mesh>
              <mesh
                // skipcq: JS-0455 -- typed React Three Fiber property
                position={[0, shaftLen + headLen / 2, 0]}
              >
                <coneGeometry
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[headR, headLen, 8]}
                />
                <meshStandardMaterial color={LOAD_COLOR} />
              </mesh>
            </group>
          );
        })}
    </>
  );
}
