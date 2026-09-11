// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Topology-optimization result overlay (KOF-233): the optimized density field
// drawn as the boundary surface of the elements kept at the current threshold,
// flat-shaded by each element's density. Mounted only in results mode when a
// density run is the active result. Unlike ResultsColormap this is a per-element
// solid field with a visibility cutoff, not a node-averaged deformed surface.

import { useMemo } from "react";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import { buildDensitySurface } from "../../lib/densityField";

export function DensityField() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const densityResult = useModelStore((s) => s.densityResult);
  const threshold = useModelStore((s) => s.densityThreshold);

  const surface = useMemo(() => {
    if (!densityResult) return null;
    return buildDensitySurface(
      nodes,
      elements,
      densityResult.density,
      threshold,
    );
  }, [nodes, elements, densityResult, threshold]);

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
