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

    const disp = result.displacements;
    // A remesh can change the node count/ids after a solve completes but
    // before `result` is invalidated. Rendering `disp` against a mismatched
    // nodeMap would silently zero-fill out-of-range nodes and draw a
    // plausible-looking but wrong colormap/deformed shape — bail instead.
    if (disp.length !== nodeMap.size * 3) return null;

    // `SolverResult.vonMises` is optional, so an analysis file written before
    // the field existed (or produced elsewhere) legitimately lacks it. Filling
    // the missing field with zeros paints every node the same colour, which
    // reads as a valid uniform-stress result — the same silent zero-fill the
    // guard above rejects. Bail instead; ResultsPanel already reports
    // "Von Mises data not available — re-run the solver".
    if (resultType === "Von Mises stress" && !nodeVonMises) return null;

    // Compute per-node scalar value for the selected result type
    const nodeValue = (i: number, rt: ResultType): number => {
      switch (rt) {
        case "Ux":
          return disp[i * 3];
        case "Uy":
          return disp[i * 3 + 1];
        case "Uz":
          return disp[i * 3 + 2];
        case "Von Mises stress":
          if (!nodeVonMises)
            throw new Error(
              "von Mises node field is unavailable although it was requested",
            );
          return nodeVonMises[i];
        default: {
          const ux = disp[i * 3],
            uy = disp[i * 3 + 1],
            uz = disp[i * 3 + 2];
          return Math.sqrt(ux * ux + uy * uy + uz * uz);
        }
      }
    };

    let minVal = Infinity,
      maxVal = -Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const val = nodeValue(i, resultType);
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
    }
    // eslint-disable-next-line kofem/no-silent-fallback -- div-by-zero guard: a uniform field has zero range and every node then maps to frac 0
    const range = maxVal - minVal || 1;

    const positions: number[] = [];
    const colors: number[] = [];

    const deformedPos = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!;
      return [
        n.x + disp[i * 3] * deformScale,
        n.y + disp[i * 3 + 1] * deformScale,
        n.z + disp[i * 3 + 2] * deformScale,
      ];
    };
    const nodeColor = (id: number): [number, number, number] => {
      const { i } = nodeMap.get(id)!;
      const frac = (nodeValue(i, resultType) - minVal) / range;
      const color = new THREE.Color();
      color.setHSL(0.667 * (1 - frac), 1, 0.5);
      return [color.r, color.g, color.b];
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
