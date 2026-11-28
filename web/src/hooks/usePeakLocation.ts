// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import { nodalResultValues } from "../lib/resultField";
import { fieldPeakLocation, type PeakLocation } from "../lib/resultStatistics";
import { useFemModule } from "./useFemModule";
import { useLocale } from "../i18n/useLocale";

export type PeakReading =
  ({ kind: "value" } & PeakLocation) | { kind: "unreadable"; reason: string };

// Where the von Mises stress of the current result peaks, and the supports and
// loads on that node (KOF-495): null while there is no von Mises plot or no
// result, or while the Rust module loads. Read from the same nodal field as
// the legend and the Max row, so it is the node that row shows.
export function usePeakLocation(): PeakReading | null {
  const { ready, error } = useFemModule();
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const shellSurface = useModelStore((s) => s.shellSurface);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const locale = useLocale();
  return useMemo((): PeakReading | null => {
    if (!result || resultType !== "Von Mises stress") return null;
    if (error !== null) return { kind: "unreadable", reason: error };
    if (!ready) return null;
    try {
      const values = nodalResultValues(
        result,
        resultType,
        nodes,
        elements,
        shellSurface,
      );
      if (!values) return null;
      return {
        kind: "value",
        ...fieldPeakLocation(
          values,
          nodes,
          elements,
          bcGroups,
          loadGroups,
          couplingGroups,
        ),
      };
    } catch (err) {
      return {
        kind: "unreadable",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }, [
    ready,
    error,
    nodes,
    elements,
    result,
    resultType,
    shellSurface,
    bcGroups,
    loadGroups,
    couplingGroups,
    locale,
  ]);
}
