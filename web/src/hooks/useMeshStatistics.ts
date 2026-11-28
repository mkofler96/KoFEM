// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import {
  meshBodyStatistics,
  type BodyMeshStatistics,
} from "../lib/meshStatistics";
import { useFemModule } from "./useFemModule";

export type MeshStatisticsReading =
  | { kind: "value"; bodies: BodyMeshStatistics[] }
  | { kind: "unreadable"; reason: string };

// Each body's mean element edge length, volume and mass in the current mesh
// (KOF-497): null without a mesh or while the Rust module loads.
export function useMeshStatistics(): MeshStatisticsReading | null {
  const { ready, error } = useFemModule();
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const properties = useModelStore((s) => s.properties);
  const materials = useModelStore((s) => s.materials);
  return useMemo((): MeshStatisticsReading | null => {
    if (elements.length === 0) return null;
    if (error !== null) return { kind: "unreadable", reason: error };
    if (!ready) return null;
    try {
      return {
        kind: "value",
        bodies: meshBodyStatistics(nodes, elements, properties, materials),
      };
    } catch (err) {
      return {
        kind: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }, [ready, error, nodes, elements, properties, materials]);
}
