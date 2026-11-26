// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import { nodalResultValues } from "../lib/resultField";
import { fieldPercentiles, RESULT_PERCENTILES } from "../lib/resultStatistics";
import { useFemModule } from "./useFemModule";
import { useLocale } from "../i18n/useLocale";

export type PercentileReadings =
  | { kind: "value"; values: { percent: number; value: number }[] }
  | { kind: "unreadable"; reason: string };

// The von Mises percentiles by volume of the current result (KOF-477): null
// while there is no von Mises plot or no result, or while the Rust module
// loads. They are read from the same nodal field as the legend and the min
// and max, so they cannot exceed the max listed beside them.
export function useFieldPercentiles(): PercentileReadings | null {
  const { ready, error } = useFemModule();
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const properties = useModelStore((s) => s.properties);
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const shellSurface = useModelStore((s) => s.shellSurface);
  const locale = useLocale();
  return useMemo((): PercentileReadings | null => {
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
      const percentiles = fieldPercentiles(
        values,
        nodes,
        elements,
        properties,
        RESULT_PERCENTILES,
      );
      return {
        kind: "value",
        values: RESULT_PERCENTILES.map((share, i) => ({
          percent: Math.round(share * 100),
          value: percentiles[i],
        })),
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
    properties,
    result,
    resultType,
    shellSurface,
    locale,
  ]);
}
