// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry representation: the OCCT tessellation of the imported STEP shape.
// Display-only approximation of the CAD surface — not a mesh.

import { useMemo } from "react";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";

interface GeometryLayerProps {
  wireframe: boolean;
}

export function GeometryLayer({ wireframe }: GeometryLayerProps) {
  const stepSurface = useModelStore((s) => s.stepSurface);

  const stepGeometry = useMemo(() => {
    if (!stepSurface || stepSurface.triangles.length === 0) return null;
    const { points, triangles } = stepSurface;
    const positions = new Float32Array(triangles.length * 9);
    const normals = new Float32Array(triangles.length * 9);
    let pi = 0;
    for (const [a, b, c] of triangles) {
      const pa = points[a],
        pb = points[b],
        pc = points[c];
      positions[pi] = pa[0];
      positions[pi + 1] = pa[1];
      positions[pi + 2] = pa[2];
      positions[pi + 3] = pb[0];
      positions[pi + 4] = pb[1];
      positions[pi + 5] = pb[2];
      positions[pi + 6] = pc[0];
      positions[pi + 7] = pc[1];
      positions[pi + 8] = pc[2];
      const ax = pb[0] - pa[0],
        ay = pb[1] - pa[1],
        az = pb[2] - pa[2];
      const bx = pc[0] - pa[0],
        by = pc[1] - pa[1],
        bz = pc[2] - pa[2];
      let nx = ay * bz - az * by,
        ny = az * bx - ax * bz,
        nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      normals[pi] = nx;
      normals[pi + 1] = ny;
      normals[pi + 2] = nz;
      normals[pi + 3] = nx;
      normals[pi + 4] = ny;
      normals[pi + 5] = nz;
      normals[pi + 6] = nx;
      normals[pi + 7] = ny;
      normals[pi + 8] = nz;
      pi += 9;
    }
    return { positions, normals };
  }, [stepSurface]);

  if (!stepGeometry) return null;

  return (
    <mesh>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[stepGeometry.positions, 3]}
        />
        <bufferAttribute
          attach="attributes-normal"
          args={[stepGeometry.normals, 3]}
        />
      </bufferGeometry>
      <meshStandardMaterial
        color="#7a9bbf"
        side={THREE.DoubleSide}
        wireframe={wireframe}
      />
    </mesh>
  );
}
