// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary condition and load visualisation: committed BC/load face highlights,
// the in-progress pick-session highlights (pending + selected faces), the
// fixed-support marker, and resultant / per-node load arrows.

import { useMemo } from "react";
import * as THREE from "three";
import {
  useModelStore,
  loadKind,
  loadComponents,
} from "../../store/modelStore";
import { buildFacePositions } from "./useMeshTopology";
import type { MeshTopology } from "./useMeshTopology";

interface BoundaryConditionLayerProps {
  topology: MeshTopology;
  showResult: boolean;
}

export function BoundaryConditionLayer({
  topology,
  showResult,
}: BoundaryConditionLayerProps) {
  const nodes = useModelStore((s) => s.nodes);
  const constraints = useModelStore((s) => s.constraints);
  const pickTargetGroupId = useModelStore((s) => s.pickTargetGroupId);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const loadDisplay = useModelStore((s) => s.loadDisplay);

  const {
    nodeMap,
    modelSize,
    boundaryQuadFaceIds,
    boundaryTriFaceIds,
    boundaryMeshTopo,
  } = topology;

  // Selected face highlight — the current (latest) picked face in the active pick session.
  const selectedFacePositions = useMemo(() => {
    if (!selectedFace || !boundaryMeshTopo) return null;
    return buildFacePositions(
      selectedFace.nodeIds,
      boundaryMeshTopo.triangles,
      nodeMap,
    );
  }, [selectedFace, boundaryMeshTopo, nodeMap]);

  // Pending faces — accumulated via shift-click during this pick session.
  const pendingFacePositions = useMemo(() => {
    if (pendingFaces.length === 0 || !boundaryMeshTopo) return null;
    const allNodeIds = pendingFaces.flatMap((f) => f.nodeIds);
    return buildFacePositions(allNodeIds, boundaryMeshTopo.triangles, nodeMap);
  }, [pendingFaces, boundaryMeshTopo, nodeMap]);

  // BC face highlights — all committed faces across all BC groups.
  // When in pick mode targeting a specific group, that group is highlighted separately (below).
  const bcFaceHighlights = useMemo(() => {
    if (!boundaryMeshTopo) return null;
    return bcGroups
      .flatMap((g) =>
        g.faces.map((f) => ({
          groupId: g.id,
          positions: buildFacePositions(
            f.nodeIds,
            boundaryMeshTopo.triangles,
            nodeMap,
          ),
        })),
      )
      .filter((h) => h.positions !== null) as {
      groupId: number;
      positions: Float32Array;
    }[];
  }, [bcGroups, boundaryMeshTopo, nodeMap]);

  // Load face highlights — all committed faces across all load groups.
  const loadFaceHighlights = useMemo(() => {
    if (!boundaryMeshTopo) return null;
    return loadGroups
      .flatMap((g) =>
        g.faces.map((f) => ({
          groupId: g.id,
          positions: buildFacePositions(
            f.nodeIds,
            boundaryMeshTopo.triangles,
            nodeMap,
          ),
        })),
      )
      .filter((h) => h.positions !== null) as {
      groupId: number;
      positions: Float32Array;
    }[];
  }, [loadGroups, boundaryMeshTopo, nodeMap]);

  // BC marker: centroid + quaternion that orients triangles outward from the model
  const bcMarkerData = useMemo(() => {
    if (constraints.length === 0 || nodes.length === 0) return null;
    const ids = new Set(constraints.map((c) => c.nodeId));
    let cx = 0,
      cy = 0,
      cz = 0,
      count = 0;
    for (const id of ids) {
      const e = nodeMap.get(id);
      if (e) {
        cx += e.n.x;
        cy += e.n.y;
        cz += e.n.z;
        count++;
      }
    }
    if (count === 0) return null;
    cx /= count;
    cy /= count;
    cz /= count;

    // Outward normal: direction from model centroid toward BC face centroid
    let mx = 0,
      my = 0,
      mz = 0;
    for (const n of nodes) {
      mx += n.x;
      my += n.y;
      mz += n.z;
    }
    mx /= nodes.length;
    my /= nodes.length;
    mz /= nodes.length;
    const dx = cx - mx,
      dy = cy - my,
      dz = cz - mz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const outward = new THREE.Vector3(dx / len, dy / len, dz / len);

    // Rotate group so that -Y (cone base direction) aligns with outward normal
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), outward);
    return { pos: [cx, cy, cz] as [number, number, number], quaternion: q };
  }, [constraints, nodeMap, nodes]);

  // Load glyphs — one arrow per force/pressure group, at the centroid of its
  // loaded nodes. Force arrows point along the applied force; pressure arrows
  // point into the loaded face (positive pressure pushes inward). Driven by
  // loadGroups because force/pressure loads reach the solver as surface tractions
  // rather than nodal forces. Moments carry no single resultant, so they are
  // skipped.
  const loadArrows = useMemo(() => {
    if (loadGroups.length === 0 || nodes.length === 0) return [];
    // Model centroid — used to orient pressure arrows inward.
    let mx = 0,
      my = 0,
      mz = 0;
    for (const n of nodes) {
      mx += n.x;
      my += n.y;
      mz += n.z;
    }
    mx /= nodes.length;
    my /= nodes.length;
    mz /= nodes.length;

    const up = new THREE.Vector3(0, 1, 0);
    const arrows: {
      groupId: number;
      pos: [number, number, number];
      quaternion: THREE.Quaternion;
    }[] = [];
    for (const g of loadGroups) {
      const kind = loadKind(g);
      if (kind === "moment") continue;
      let cx = 0,
        cy = 0,
        cz = 0,
        count = 0;
      for (const f of g.faces) {
        for (const id of f.nodeIds) {
          const e = nodeMap.get(id);
          if (e) {
            cx += e.n.x;
            cy += e.n.y;
            cz += e.n.z;
            count++;
          }
        }
      }
      if (count === 0) continue;
      cx /= count;
      cy /= count;
      cz /= count;

      let dir: THREE.Vector3;
      if (kind === "pressure") {
        dir = new THREE.Vector3(mx - cx, my - cy, mz - cz);
      } else {
        const vec = loadComponents(g);
        dir = new THREE.Vector3(vec[0], vec[1], vec[2]);
      }
      if (dir.lengthSq() < 1e-30) continue;
      dir.normalize();
      const q = new THREE.Quaternion();
      q.setFromUnitVectors(up, dir);
      arrows.push({ groupId: g.id, pos: [cx, cy, cz], quaternion: q });
    }
    return arrows;
  }, [loadGroups, nodes, nodeMap]);

  // Per-node load glyphs — one arrow at every loaded node, sized by the
  // work-equivalent load that node carries: its tributary-area share of the
  // group total (force ⇒ totalForce·Aᵢ/A, pressure ⇒ p·Aᵢ, both in N). This is
  // what actually reaches the solver as a surface traction, in contrast to the
  // single statically-equivalent resultant. Shown when loadDisplay === "nodal".
  // Force arrows point along the applied force; pressure arrows point into the
  // surface along the per-node inward normal. Moments carry no resultant force
  // and are skipped, matching the resultant view (issue #196).
  const nodalLoadArrows = useMemo(() => {
    if (loadGroups.length === 0 || nodes.length === 0) return [];

    // Model centroid — used to orient pressure arrows inward.
    let mx = 0,
      my = 0,
      mz = 0;
    for (const n of nodes) {
      mx += n.x;
      my += n.y;
      mz += n.z;
    }
    mx /= nodes.length;
    my /= nodes.length;
    mz /= nodes.length;
    const modelCentroid = new THREE.Vector3(mx, my, mz);

    const posOf = (id: number): THREE.Vector3 | null => {
      const e = nodeMap.get(id);
      return e ? new THREE.Vector3(e.n.x, e.n.y, e.n.z) : null;
    };

    // Accumulated per node across all groups: load direction (unit) and
    // magnitude (N). A node shared by two groups gets the larger arrow.
    type NodalLoad = { dir: THREE.Vector3; mag: number };
    const byNode = new Map<number, NodalLoad>();

    for (const g of loadGroups) {
      const kind = loadKind(g);
      if (kind === "moment") continue;

      const nodeSet = new Set<number>();
      for (const f of g.faces) for (const id of f.nodeIds) nodeSet.add(id);
      if (nodeSet.size === 0) continue;

      // Tributary area per node and (for pressure) accumulated inward normal,
      // integrated over the boundary faces that lie entirely on the group's
      // selected faces — the same membership test the solver uses to apply the
      // surface traction, so the per-node share matches the FE load.
      const tribArea = new Map<number, number>();
      const inward = new Map<number, THREE.Vector3>();
      let totalArea = 0;

      const addFace = (ids: number[]) => {
        if (!ids.every((id) => nodeSet.has(id))) return;
        const pts = ids.map(posOf);
        if (pts.some((p) => p === null)) return;
        const p = pts as THREE.Vector3[];

        // Area + outward normal: triangle directly, quad via its diagonals.
        let area: number;
        const normal = new THREE.Vector3();
        if (p.length === 3) {
          normal
            .copy(p[1])
            .sub(p[0])
            .cross(new THREE.Vector3().copy(p[2]).sub(p[0]));
          area = 0.5 * normal.length();
        } else {
          normal
            .copy(p[2])
            .sub(p[0])
            .cross(new THREE.Vector3().copy(p[3]).sub(p[1]));
          area = 0.5 * normal.length();
        }
        if (area < 1e-30) return;
        normal.normalize();
        totalArea += area;

        // Orient the face normal inward (positive pressure pushes in).
        const fc = new THREE.Vector3();
        for (const v of p) fc.add(v);
        fc.divideScalar(p.length);
        if (normal.dot(new THREE.Vector3().copy(modelCentroid).sub(fc)) < 0)
          normal.negate();

        const share = area / p.length;
        for (const id of ids) {
          tribArea.set(id, (tribArea.get(id) ?? 0) + share);
          if (kind === "pressure") {
            const acc = inward.get(id) ?? new THREE.Vector3();
            inward.set(id, acc.addScaledVector(normal, area));
          }
        }
      };

      for (const tri of boundaryTriFaceIds) addFace(tri);
      for (const quad of boundaryQuadFaceIds) addFace(quad);
      if (totalArea < 1e-30) continue;

      // Force direction is shared by every node; pressure direction is per-node.
      const force = loadComponents(g);
      const forceMag = Math.hypot(force[0], force[1], force[2]);
      const forceDir = new THREE.Vector3();
      if (kind === "force") {
        if (forceMag < 1e-30) continue;
        forceDir.set(force[0], force[1], force[2]).normalize();
      }
      // Pressure stores its (signed) magnitude in totalForce; positive pushes in.
      const pressureSign = g.totalForce < 0 ? -1 : 1;

      for (const [id, a] of tribArea) {
        let dir: THREE.Vector3;
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
        const prev = byNode.get(id);
        if (!prev || mag > prev.mag) byNode.set(id, { dir, mag });
      }
    }

    if (byNode.size === 0) return [];
    let maxMag = 0;
    for (const { mag } of byNode.values()) if (mag > maxMag) maxMag = mag;
    if (maxMag < 1e-30) return [];

    const up = new THREE.Vector3(0, 1, 0);
    const arrows: {
      nodeId: number;
      pos: [number, number, number];
      quaternion: THREE.Quaternion;
      frac: number;
    }[] = [];
    for (const [id, { dir, mag }] of byNode) {
      const e = nodeMap.get(id);
      if (!e) continue;
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
      arrows.push({
        nodeId: id,
        pos: [e.n.x, e.n.y, e.n.z],
        quaternion: q,
        frac: mag / maxMag,
      });
    }
    return arrows;
  }, [loadGroups, nodes, nodeMap, boundaryTriFaceIds, boundaryQuadFaceIds]);

  return (
    <group>
      {/* BC face highlights — persistent coloured overlay for all committed BC faces */}
      {!showResult &&
        bcFaceHighlights?.map((h, i) => (
          <mesh key={`bc-face-${h.groupId}-${i}`} renderOrder={1}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[h.positions, 3]}
              />
            </bufferGeometry>
            <meshBasicMaterial
              color="#dc2626"
              transparent
              opacity={pickTargetGroupId === h.groupId ? 0.45 : 0.25}
              depthTest={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}

      {/* Load face highlights — persistent coloured overlay for all committed load faces */}
      {!showResult &&
        loadFaceHighlights?.map((h, i) => (
          <mesh key={`load-face-${h.groupId}-${i}`} renderOrder={1}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[h.positions, 3]}
              />
            </bufferGeometry>
            <meshBasicMaterial
              color="#d97706"
              transparent
              opacity={pickTargetGroupId === h.groupId ? 0.45 : 0.25}
              depthTest={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        ))}

      {/* Pending faces — accumulated via shift-click, same colour as selection but slightly dimmer */}
      {pendingFacePositions && (
        <mesh renderOrder={2}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[pendingFacePositions, 3]}
            />
          </bufferGeometry>
          <meshBasicMaterial
            color="#e05533"
            transparent
            opacity={0.45}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Selected face highlight — the latest picked face (brightest) */}
      {selectedFacePositions && (
        <mesh renderOrder={3}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[selectedFacePositions, 3]}
            />
          </bufferGeometry>
          <meshBasicMaterial
            color="#e05533"
            transparent
            opacity={0.65}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* BC markers — triangular fixed-support symbols (3-sided cone, apex at face, base outward) */}
      {!showResult && bcMarkerData && (
        <group position={bcMarkerData.pos} quaternion={bcMarkerData.quaternion}>
          <mesh position={[0, -modelSize * 0.075, 0]}>
            <coneGeometry args={[modelSize * 0.09, modelSize * 0.15, 3]} />
            <meshStandardMaterial color="#dc2626" />
          </mesh>
          {/* Backing strip representing the fixed wall */}
          <mesh
            position={[0, -modelSize * 0.165, 0]}
            rotation={[Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[modelSize * 0.22, modelSize * 0.03]} />
            <meshStandardMaterial color="#dc2626" side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}

      {/* Resultant load arrows — one per force/pressure group, cylinder shaft + cone head */}
      {!showResult &&
        loadDisplay === "resultant" &&
        loadArrows.map((arrow) => {
          const shaftLen = modelSize * 0.22;
          const headLen = modelSize * 0.09;
          const shaftR = modelSize * 0.012;
          const headR = modelSize * 0.038;
          return (
            <group
              key={`arrow-${arrow.groupId}`}
              position={arrow.pos}
              quaternion={arrow.quaternion}
            >
              <mesh position={[0, shaftLen / 2, 0]}>
                <cylinderGeometry args={[shaftR, shaftR, shaftLen, 8]} />
                <meshStandardMaterial color="#d97706" />
              </mesh>
              <mesh position={[0, shaftLen + headLen / 2, 0]}>
                <coneGeometry args={[headR, headLen, 8]} />
                <meshStandardMaterial color="#d97706" />
              </mesh>
            </group>
          );
        })}

      {/* Per-node load arrows — one per loaded node, length scaled by the load
          that node carries (relative to the largest in the model) */}
      {!showResult &&
        loadDisplay === "nodal" &&
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
              position={arrow.pos}
              quaternion={arrow.quaternion}
            >
              <mesh position={[0, shaftLen / 2, 0]}>
                <cylinderGeometry args={[shaftR, shaftR, shaftLen, 6]} />
                <meshStandardMaterial color="#d97706" />
              </mesh>
              <mesh position={[0, shaftLen + headLen / 2, 0]}>
                <coneGeometry args={[headR, headLen, 8]} />
                <meshStandardMaterial color="#d97706" />
              </mesh>
            </group>
          );
        })}
    </group>
  );
}
