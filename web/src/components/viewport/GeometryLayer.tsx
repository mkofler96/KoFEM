// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry representation: the OCCT tessellation of the imported STEP shape.
// Display-only approximation of the CAD surface — not a mesh.
//
// The tessellation is split per body (CAD solid, issue #353) so each body can
// be painted in its assigned material's colour, dimmed when another body is
// being assigned, or hidden entirely via the eye control in the Bodies panel.
//
// The CAD face boundaries are drawn over it, so the faces — and every line the
// split tool adds — are visible. While the split tool is picking, a click
// toggles the CAD face under the cursor; the picked faces and the cutting plane
// are drawn on top.

import { useMemo } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import {
  cadFaceOutline,
  cadFaceTriangles,
  planePreview,
  tessellationBounds,
} from "../../lib/cadFaces";

interface GeometryLayerProps {
  wireframe: boolean;
  // CAD body to highlight, already resolved against this tessellation by
  // MeshScene (resolveHighlightedBody). null = highlight nothing, which is not
  // the same as "dim everything": an id no body carries must leave the assembly
  // fully lit, or the model reads as gone.
  highlightBodyId: number | null;
}

// Fallback body colour when a body has no material assignment yet (or an
// analysis predates per-body colours). Matches the former single-colour look.
const DEFAULT_BODY_COLOR = "#7a9bbf";
// Opacity applied to the bodies that are NOT the one currently being assigned.
const DIMMED_OPACITY = 0.15;
// Face outlines contrast with the body they are drawn on: dark lines on a light
// material, light lines on a dark one (the default steel blue shades dark).
const OUTLINE_ON_LIGHT = "#1f2937";
const OUTLINE_ON_DARK = "#e5edf7";
// Faces picked for a split, and the cutting plane — the selection colour of the
// BC/load pick (BoundaryConditionLayer), so a pick reads as a pick everywhere.
const SPLIT_PICK_COLOR = "#e05533";
const SPLIT_PLANE_COLOR = "#2563eb";

function outlineColor(bodyColor: string): string {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(bodyColor).getHSL(hsl);
  return hsl.l > 0.6 ? OUTLINE_ON_LIGHT : OUTLINE_ON_DARK;
}

interface BodyGeometry {
  bodyId: number;
  positions: Float32Array;
  normals: Float32Array;
  // Global tessellation index of each of this body's triangles, in buffer order
  // — maps a raycast's faceIndex back to the triangle (and its CAD face).
  triIndices: number[];
  // The body's CAD face boundaries as line segments; null when the
  // tessellation carries no face ids (an analysis saved before them).
  outline: Float32Array | null;
}

export function GeometryLayer({
  wireframe,
  highlightBodyId,
}: GeometryLayerProps) {
  const stepSurface = useModelStore((s) => s.stepSurface);
  const properties = useModelStore((s) => s.properties);
  const materials = useModelStore((s) => s.materials);
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);

  // Build one flat position/normal buffer per body. Rebuilt only when the
  // tessellation changes — colour, dimming and visibility are cheap material
  // props applied at render time, so they never trigger a geometry rebuild.
  const bodyGeometries = useMemo<BodyGeometry[]>(() => {
    if (!stepSurface || stepSurface.triangles.length === 0) return [];
    const { points, triangles, bodyIds, faceIds } = stepSurface;

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
      const outline = faceIds
        ? cadFaceOutline({ points, triangles, faceIds }, triIndices)
        : null;
      out.push({ bodyId, positions, normals, triIndices, outline });
    }
    return out;
  }, [stepSurface]);

  const splitPicking = useModelStore((s) => s.splitPicking);
  const splitFaceIds = useModelStore((s) => s.splitFaceIds);
  const toggleSplitFace = useModelStore((s) => s.toggleSplitFace);
  const splitDraft = useModelStore((s) => s.splitDraft);

  // A tessellation saved before CAD face ids existed has none: it draws, but
  // has no faces to outline or pick.
  const faced = useMemo(
    () =>
      stepSurface?.faceIds
        ? {
            points: stepSurface.points,
            triangles: stepSurface.triangles,
            faceIds: stepSurface.faceIds,
          }
        : null,
    [stepSurface],
  );
  const pickedFaces = useMemo(
    () =>
      faced && splitFaceIds.length > 0
        ? cadFaceTriangles(faced, splitFaceIds)
        : null,
    [faced, splitFaceIds],
  );
  const bounds = useMemo(
    () => (stepSurface ? tessellationBounds(stepSurface.points) : null),
    [stepSurface],
  );
  const plane = useMemo(
    () =>
      bounds && splitDraft
        ? planePreview(bounds, splitDraft.axis, splitDraft.position)
        : null,
    [bounds, splitDraft],
  );

  // Split-tool picking: the clicked triangle's CAD face joins (or leaves) the
  // faces the next split cuts.
  const pickFace = (triIndices: number[]) => (e: ThreeEvent<MouseEvent>) => {
    if (e.faceIndex == null || !faced) return;
    e.stopPropagation();
    const tri = triIndices[e.faceIndex];
    if (tri === undefined) return;
    toggleSplitFace(faced.faceIds[tri]);
  };

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
      {bodyGeometries.map(
        ({ bodyId, positions, normals, triIndices, outline }) => {
          if (hiddenBodyIds.includes(bodyId)) return null;
          // When a body is being assigned (highlightBodyId set), every other body
          // fades back so the one in question reads clearly against the assembly.
          const dimmed = highlightBodyId !== null && highlightBodyId !== bodyId;
          return (
            <group key={bodyId}>
              <mesh
                onClick={
                  splitPicking && faced ? pickFace(triIndices) : undefined
                }
              >
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    args={[positions, 3]}
                  />
                  <bufferAttribute
                    attach="attributes-normal"
                    args={[normals, 3]}
                  />
                </bufferGeometry>
                <meshStandardMaterial
                  color={bodyColor(bodyId)}
                  side={THREE.DoubleSide}
                  wireframe={wireframe}
                  transparent={dimmed}
                  opacity={dimmed ? DIMMED_OPACITY : 1}
                  depthWrite={!dimmed}
                  // Push the faces back a little so the outlines drawn on them
                  // win the depth test instead of flickering in and out.
                  polygonOffset
                  polygonOffsetFactor={1}
                  polygonOffsetUnits={1}
                />
              </mesh>
              {outline && !wireframe && (
                <lineSegments>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      args={[outline, 3]}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial
                    color={outlineColor(bodyColor(bodyId))}
                    transparent={dimmed}
                    opacity={dimmed ? DIMMED_OPACITY : 1}
                  />
                </lineSegments>
              )}
            </group>
          );
        },
      )}
      {pickedFaces && (
        <mesh renderOrder={1}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[pickedFaces, 3]}
            />
          </bufferGeometry>
          <meshBasicMaterial
            color={SPLIT_PICK_COLOR}
            transparent
            opacity={0.45}
            depthTest={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {plane && (
        <mesh renderOrder={2}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[plane, 3]} />
          </bufferGeometry>
          <meshBasicMaterial
            color={SPLIT_PLANE_COLOR}
            transparent
            opacity={0.18}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}
