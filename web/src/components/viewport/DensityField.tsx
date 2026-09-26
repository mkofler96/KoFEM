// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topology-optimization result overlay (KOF-233): the optimized density field
// drawn either as a smooth isosurface of the nodal field at the threshold (the
// default — a level-set run contours its own φ, a SIMP run the node-averaged
// density) or as the boundary surface of the elements kept at the threshold,
// flat-shaded by each element's density. Mounted for the final run in Results
// and for the live iteration during a run (KOF-240) — see useDisplayedDensity.
// Unlike ResultsColormap this is a per-element solid field with a visibility
// cutoff, not a node-averaged deformed surface.

import { useMemo } from "react";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import {
  buildDensitySurface,
  buildSmoothDensitySurface,
  levelSetField,
  nodalDensity,
} from "../../lib/densityField";

export function DensityField({ density }: { density: Float64Array }) {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const threshold = useModelStore((s) => s.densityThreshold);
  const smooth = useModelStore((s) => s.densitySmooth);
  const densityResult = useModelStore((s) => s.densityResult);
  // The level set belongs to the final run only; a live iteration streams just
  // the element densities, so it is contoured through their nodal average.
  const levelSet =
    densityResult?.density === density ? densityResult.levelSet : undefined;

  const field = useMemo(() => {
    if (!smooth) return null;
    return levelSet
      ? levelSetField(levelSet)
      : nodalDensity(nodes, elements, density);
  }, [smooth, levelSet, nodes, elements, density]);

  const surface = useMemo(
    () =>
      field
        ? buildSmoothDensitySurface(nodes, elements, field, threshold)
        : buildDensitySurface(nodes, elements, density, threshold),
    [field, nodes, elements, density, threshold],
  );

  if (!surface) return null;

  return (
    <mesh>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[surface.positions, 3]}
        />
        <bufferAttribute
          attach="attributes-normal"
          args={[surface.normals, 3]}
        />
        <bufferAttribute attach="attributes-color" args={[surface.colors, 3]} />
      </bufferGeometry>
      <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
    </mesh>
  );
}
