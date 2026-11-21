// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The section plane's cut (KOF-390): the filled cap where the plane cuts the
// solid elements and the lines where it cuts the shell facets, coloured by the
// plotted field on the legend's scale. The Rust module computes the cut
// (lib/sectionCut); it is loaded the first time a section is shown. The drawn
// result surface is clipped at the same plane (ResultsColormap,
// FemMeshLayer), so the cap closes it.

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import { loadFemModule } from "../../lib/femModule";
import { cutSection } from "../../lib/sectionCut";
import {
  nodalResultValues,
  resultColor,
  resultFraction,
} from "../../lib/resultField";
import type { MeshTopology } from "./useMeshTopology";
import type { DrawnSection } from "./useResultSection";

interface SectionLayerProps {
  topology: MeshTopology;
  section: DrawnSection;
}

/** Vertex colours of `values` on the legend's scale. */
function colours(values: Float64Array, min: number, max: number) {
  const out = new Float32Array(values.length * 3);
  values.forEach((value, i) => {
    const colour = resultColor(resultFraction(value, min, max));
    out[3 * i] = colour.r;
    out[3 * i + 1] = colour.g;
    out[3 * i + 2] = colour.b;
  });
  return out;
}

export function SectionLayer({ topology, section }: SectionLayerProps) {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const legendRange = useModelStore((s) => s.legendRange);
  const setSectionRange = useModelStore((s) => s.setSectionRange);
  const setSectionError = useModelStore((s) => s.setSectionError);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    loadFemModule().then(
      () => live && setReady(true),
      (error: unknown) =>
        live &&
        setSectionError(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      live = false;
    };
  }, [setSectionError]);

  const { nodeMap, tetElements, hexElements, triElements } = topology;
  const cut = useMemo(() => {
    if (!ready || !result) return null;
    const values = nodalResultValues(result, resultType, nodes, elements);
    if (!values) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const index = (id: number) => {
      const entry = nodeMap.get(id);
      if (!entry)
        throw new Error(
          `an element references node ${id}, which the mesh does not have`,
        );
      return entry.i;
    };
    try {
      const geometry = cutSection(
        section.points,
        values,
        { tets: tetElements, hexes: hexElements, shells: triElements },
        index,
        section,
      );
      // The legend's scale: manual limits if set, else the whole model's range.
      // eslint-disable-next-line kofem/no-silent-fallback -- a null legend range is the Auto setting: the scale spans the model's results
      const scale = legendRange !== null ? legendRange : { min, max };
      return {
        ...geometry,
        capColours: colours(geometry.capValues, scale.min, scale.max),
        lineColours: colours(geometry.lineValues, scale.min, scale.max),
        error: null,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [
    ready,
    result,
    resultType,
    nodes,
    elements,
    nodeMap,
    tetElements,
    hexElements,
    triElements,
    section,
    legendRange,
  ]);

  useEffect(() => {
    if (cut?.error) {
      setSectionError(cut.error);
      setSectionRange(null);
      return;
    }
    setSectionError(null);
    setSectionRange(cut && "range" in cut ? (cut.range ?? null) : null);
  }, [cut, setSectionError, setSectionRange]);

  if (!cut || cut.error !== null || !("capPositions" in cut)) return null;
  return (
    <group name="result-section">
      {cut.capTriangles.length > 0 && (
        <mesh>
          <bufferGeometry
            ref={(geometry: THREE.BufferGeometry | null) =>
              geometry?.computeVertexNormals()
            }
          >
            <bufferAttribute
              attach="attributes-position"
              args={[cut.capPositions, 3]}
            />
            <bufferAttribute
              attach="attributes-color"
              args={[cut.capColours, 3]}
            />
            <bufferAttribute attach="index" args={[cut.capTriangles, 1]} />
          </bufferGeometry>
          <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      )}
      {cut.linePositions.length > 0 && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[cut.linePositions, 3]}
            />
            <bufferAttribute
              attach="attributes-color"
              args={[cut.lineColours, 3]}
            />
          </bufferGeometry>
          <lineBasicMaterial vertexColors />
        </lineSegments>
      )}
    </group>
  );
}
