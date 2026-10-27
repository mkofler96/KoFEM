// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import { guideTargets } from "../../lib/sampleGuide";
import type { MeshTopology } from "./useMeshTopology";
import { useSampleGuideStep } from "./useSampleGuideStep";

const TARGET_COLOR = "#facc15";

// The faces the sample guide asks the user to pick, marked on the mesh: the
// mesh's own boundary triangles of those CAD faces, so the mark sits exactly
// on what a click picks. Depth-tested, so it marks only what is in view. A face
// already in the current pick loses its mark, so what is marked is what is
// left to click.
export function SampleGuideTargets({ topology }: { topology: MeshTopology }) {
  const step = useSampleGuideStep();
  const targets = step === null ? null : guideTargets(step);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const { boundaryMeshTopo, nodeMap } = topology;

  const positions = useMemo(() => {
    const faceIds = boundaryMeshTopo?.faceIds;
    if (!targets || !boundaryMeshTopo || !faceIds) return null;
    const wanted = new Set(targets);
    for (const f of selectedFace
      ? [...pendingFaces, selectedFace]
      : pendingFaces)
      if (f.cadFaceId !== undefined) wanted.delete(f.cadFaceId);
    const out: number[] = [];
    boundaryMeshTopo.triangles.forEach((tri, t) => {
      const face = faceIds[t];
      if (face === undefined || !wanted.has(face)) return;
      for (const id of tri) {
        const n = nodeMap.get(id)?.n;
        if (!n)
          throw new Error(
            `Sample guide target references node ${id} missing from the mesh`,
          );
        out.push(n.x, n.y, n.z);
      }
    });
    return out.length > 0 ? new Float32Array(out) : null;
  }, [targets, pendingFaces, selectedFace, boundaryMeshTopo, nodeMap]);

  if (!positions) return null;
  return (
    <mesh renderOrder={1}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshBasicMaterial
        color={TARGET_COLOR}
        transparent
        opacity={0.6}
        depthWrite={false}
        side={THREE.DoubleSide}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}
