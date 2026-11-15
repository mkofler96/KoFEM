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
import type { MeshTopology } from "./useMeshTopology";
import { modelCentroid } from "./bcOverlayShared";
import { nodalLoadVectors } from "../../lib/nodalLoadGlyphs";

const LOAD_COLOR = "#d97706";

interface LoadArrowsProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function LoadArrows({ topology, showResult }: LoadArrowsProps) {
  const nodes = useModelStore((s) => s.nodes);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const loadDisplay = useModelStore((s) => s.loadDisplay);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const { nodeMap, modelSize, hexElements, tetElements, triElements } =
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
  // work-equivalent load the solver applies there (lib/nodalLoadGlyphs): a
  // face load's tributary-area share, a shell edge load's tributary-length
  // share, or a picked point's share. Shown when loadDisplay === "nodal".
  // Moments carry no per-node decomposition here — they are represented by the
  // group-level double-headed axis arrow, drawn in both display modes (issues
  // #196, #277).
  const nodalLoadArrows = useMemo(() => {
    const byNode = nodalLoadVectors({
      loadGroups,
      nodes,
      // Only the bodies on screen.
      elements: [...tetElements, ...hexElements, ...triElements],
      couplingGroups,
    });
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
      const quaternion = new Quaternion().setFromUnitVectors(
        up,
        new Vector3(...dir),
      );
      arrows.push({
        nodeId: id,
        pos: [entry.n.x, entry.n.y, entry.n.z],
        quaternion,
        frac: mag / maxMag,
      });
    }
    return arrows;
  }, [
    loadGroups,
    nodes,
    nodeMap,
    tetElements,
    hexElements,
    triElements,
    couplingGroups,
  ]);

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
