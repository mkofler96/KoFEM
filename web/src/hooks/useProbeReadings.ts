// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import {
  fieldExtremes,
  readProbes,
  type ExtremeReading,
  type ProbeReading,
  type ResultProbe,
} from "../lib/resultProbe";

export interface ProbeReadings {
  // The placed probes with what each reads; null readings while there is no
  // result (a probe kept through a re-mesh waits for the next solve).
  placed: { probe: ResultProbe; reading: ProbeReading | null }[];
  // The min and max of the plotted field: null without a result, the reason
  // when the field cannot be read. Always read: the panel lists them, and the
  // viewport labels them only while showExtremeProbes is on.
  extremes:
    | { kind: "value"; min: ExtremeReading; max: ExtremeReading }
    | { kind: "unreadable"; reason: string }
    | null;
}

// The probes with what each reads on the current mesh, result and plotted
// field (KOF-389). Shared by the Results panel rows and the viewport labels.
export function useProbeReadings(): ProbeReadings {
  const probes = useModelStore((s) => s.probes);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  return useMemo((): ProbeReadings => {
    if (!result)
      return {
        placed: probes.map((probe) => ({ probe, reading: null })),
        extremes: null,
      };
    const model = { nodes, elements, surfaceTriangles, surfaceFaceIds, result };
    const readings = readProbes(probes, model, resultType);
    let extremes: ProbeReadings["extremes"];
    try {
      extremes = { kind: "value", ...fieldExtremes(model, resultType) };
    } catch (err) {
      extremes = {
        kind: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      placed: probes.map((probe, i) => ({ probe, reading: readings[i] })),
      extremes,
    };
  }, [
    probes,
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
    result,
    resultType,
  ]);
}
