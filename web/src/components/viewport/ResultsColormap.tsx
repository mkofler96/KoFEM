// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results overlay: the deformed boundary surface vertex-coloured by the
// selected result field (displacement components / magnitude, von Mises).
// Mounted only in results mode.

import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { useModelStore } from "../../store/modelStore";
import type { ResultType } from "../../store/modelStore";
import { nodeVonMisesField } from "../../lib/resultField";
import type { MeshTopology } from "./useMeshTopology";

interface ResultsColormapProps {
  topology: MeshTopology;
  deformScale: number;
  onFacePick?: (e: ThreeEvent<MouseEvent>) => void;
}

export function ResultsColormap({
  topology,
  deformScale,
  onFacePick,
}: ResultsColormapProps) {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);

  const { nodeMap, boundaryQuadFaceIds, boundaryTriFaceIds } = topology;

  // Per-node von Mises: volume-weighted average of the element-level stresses,
  // shared with the colorbar range in resultField so the two stay identical.
  const nodeVonMises = useMemo(
    () => (result ? nodeVonMisesField(result, nodes, elements) : null),
    [result, nodes, elements],
  );

  const deformedSurface = useMemo(() => {
    if (!result) return null;
    const hasQuads = boundaryQuadFaceIds.length > 0;
    const hasTris = boundaryTriFaceIds.length > 0;
    if (!hasQuads && !hasTris) return null;

    const d = result.displacements;

    // Compute per-node scalar value for the selected result type
    const nodeValue = (i: number, rt: ResultType): number => {
      switch (rt) {
        case "Ux":
          return d[i * 3] ?? 0;
        case "Uy":
          return d[i * 3 + 1] ?? 0;
        case "Uz":
          return d[i * 3 + 2] ?? 0;
        case "Von Mises stress":
          return nodeVonMises?.[i] ?? 0;
        default: {
          const ux = d[i * 3] ?? 0,
            uy = d[i * 3 + 1] ?? 0,
            uz = d[i * 3 + 2] ?? 0;
          return Math.sqrt(ux * ux + uy * uy + uz * uz);
        }
      }
    };

    let minVal = Infinity,
      maxVal = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const v = nodeValue(i, resultType);
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    const range = maxVal - minVal || 1;

    const positions: number[] = [];
    const colors: number[] = [];

    const deformedPos = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!;
      return [
        n.x + (d[i * 3] ?? 0) * deformScale,
        n.y + (d[i * 3 + 1] ?? 0) * deformScale,
        n.z + (d[i * 3 + 2] ?? 0) * deformScale,
      ];
    };
    const nodeColor = (id: number): [number, number, number] => {
      const { i } = nodeMap.get(id)!;
      const t = (nodeValue(i, resultType) - minVal) / range;
      const c = new THREE.Color();
      c.setHSL(0.667 * (1 - t), 1, 0.5);
      return [c.r, c.g, c.b];
    };

    for (const [a, b, c_, dd] of boundaryQuadFaceIds) {
      const pa = deformedPos(a),
        pb = deformedPos(b),
        pc = deformedPos(c_),
        pd = deformedPos(dd);
      const ca = nodeColor(a),
        cb = nodeColor(b),
        cc = nodeColor(c_),
        cd = nodeColor(dd);
      positions.push(...pa, ...pb, ...pc, ...pa, ...pc, ...pd);
      colors.push(...ca, ...cb, ...cc, ...ca, ...cc, ...cd);
    }
    for (const [a, b, c_] of boundaryTriFaceIds) {
      const pa = deformedPos(a),
        pb = deformedPos(b),
        pc = deformedPos(c_);
      const ca = nodeColor(a),
        cb = nodeColor(b),
        cc = nodeColor(c_);
      positions.push(...pa, ...pb, ...pc);
      colors.push(...ca, ...cb, ...cc);
    }

    return {
      positions: new Float32Array(positions),
      colors: new Float32Array(colors),
    };
  }, [
    result,
    resultType,
    nodeVonMises,
    boundaryQuadFaceIds,
    boundaryTriFaceIds,
    nodeMap,
    nodes,
    deformScale,
  ]);

  if (!deformedSurface) return null;

  return (
    <mesh onClick={onFacePick}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[deformedSurface.positions, 3]}
        />
        <bufferAttribute
          attach="attributes-color"
          args={[deformedSurface.colors, 3]}
        />
      </bufferGeometry>
      <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}
