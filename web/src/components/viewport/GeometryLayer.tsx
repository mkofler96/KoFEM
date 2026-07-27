// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry representation: the OCCT tessellation of the imported STEP shape.
// Display-only approximation of the CAD surface — not a mesh.
//
// The tessellation is split per body (CAD solid, issue #353) so each body can
// be painted in its assigned material's colour, dimmed when another body is
// being assigned, or hidden entirely via the eye control in the Bodies panel.

import { useMemo } from "react";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";

interface GeometryLayerProps {
  wireframe: boolean;
}

// Fallback body colour when a body has no material assignment yet (or an
// analysis predates per-body colours). Matches the former single-colour look.
const DEFAULT_BODY_COLOR = "#7a9bbf";
// Opacity applied to the bodies that are NOT the one currently being assigned.
const DIMMED_OPACITY = 0.15;

interface BodyGeometry {
  bodyId: number;
  positions: Float32Array;
  normals: Float32Array;
}

export function GeometryLayer({ wireframe }: GeometryLayerProps) {
  const stepSurface = useModelStore((s) => s.stepSurface);
  const properties = useModelStore((s) => s.properties);
  const materials = useModelStore((s) => s.materials);
  const highlightBodyId = useModelStore((s) => s.highlightBodyId);
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);

  // Build one flat position/normal buffer per body. Rebuilt only when the
  // tessellation changes — colour, dimming and visibility are cheap material
  // props applied at render time, so they never trigger a geometry rebuild.
  const bodyGeometries = useMemo<BodyGeometry[]>(() => {
    if (!stepSurface || stepSurface.triangles.length === 0) return [];
    const { points, triangles, bodyIds } = stepSurface;

    const triIndicesByBody = new Map<number, number[]>();
    for (let t = 0; t < triangles.length; t++) {
      // eslint-disable-next-line kofem/no-silent-fallback -- bodyIds is absent on analyses saved before per-body colours; StepTessellation documents body 1 for the whole tessellation in that case
      const body = bodyIds?.[t] ?? 1;
      let list = triIndicesByBody.get(body);
      if (!list) {
        list = [];
        triIndicesByBody.set(body, list);
      }
      list.push(t);
    }

    const out: BodyGeometry[] = [];
    for (const [bodyId, triIndices] of triIndicesByBody) {
      const positions = new Float32Array(triIndices.length * 9);
      const normals = new Float32Array(triIndices.length * 9);
      let pi = 0;
      for (const t of triIndices) {
        const [a, b, c] = triangles[t];
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
        // eslint-disable-next-line kofem/no-silent-fallback -- div-by-zero guard: a degenerate (zero-area) triangle has no defined normal
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        for (let k = 0; k < 3; k++) {
          normals[pi + 3 * k] = nx;
          normals[pi + 3 * k + 1] = ny;
          normals[pi + 3 * k + 2] = nz;
        }
        pi += 9;
      }
      out.push({ bodyId, positions, normals });
    }
    return out;
  }, [stepSurface]);

  // body id → its assigned material's colour (via the body's property).
  const bodyColor = useMemo(() => {
    const matById = new Map(materials.map((mat) => [mat.id, mat]));
    return (bodyId: number): string => {
      const prop = properties.find((p) => p.id === bodyId);
      const mat = prop ? matById.get(prop.materialId) : undefined;
      // eslint-disable-next-line kofem/no-silent-fallback -- display colour only: a body with no material assigned yet is drawn in the neutral default and never reaches the solver
      return mat?.color ?? DEFAULT_BODY_COLOR;
    };
  }, [properties, materials]);

  if (bodyGeometries.length === 0) return null;

  return (
    <group>
      {bodyGeometries.map(({ bodyId, positions, normals }) => {
        if (hiddenBodyIds.includes(bodyId)) return null;
        // When a body is being assigned (highlightBodyId set), every other body
        // fades back so the one in question reads clearly against the assembly.
        const dimmed = highlightBodyId != null && highlightBodyId !== bodyId;
        return (
          <mesh key={bodyId}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[positions, 3]}
              />
              <bufferAttribute attach="attributes-normal" args={[normals, 3]} />
            </bufferGeometry>
            <meshStandardMaterial
              color={bodyColor(bodyId)}
              side={THREE.DoubleSide}
              wireframe={wireframe}
              transparent={dimmed}
              opacity={dimmed ? DIMMED_OPACITY : 1}
              depthWrite={!dimmed}
            />
          </mesh>
        );
      })}
    </group>
  );
}
