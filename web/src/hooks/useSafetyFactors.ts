// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo } from "react";
import { useModelStore } from "../store/modelStore";
import {
  safetyFactors,
  safetyRowLabel,
  safetyModel,
  type SafetyFactorRow,
} from "../lib/safetyFactor";
import { useFemModule } from "./useFemModule";
import { useLocale } from "../i18n/useLocale";

export interface LabelledSafetyRow {
  row: SafetyFactorRow;
  label: string;
}

export type SafetyReadings =
  | { kind: "value"; rows: LabelledSafetyRow[] }
  | { kind: "unreadable"; reason: string };

// The safety factors against yield of the current result (KOF-496): null
// while there is no result with stresses, or while the Rust module loads. The
// bodies and their materials are the solve's, so a material reassigned since
// does not pair its yield strength with stresses it did not produce; only the
// yield strength is read as it is now, so setting one after the solve shows
// the factor without solving again.
export function useSafetyFactors(): SafetyReadings | null {
  const { ready, error } = useFemModule();
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const properties = useModelStore((s) => s.properties);
  const materials = useModelStore((s) => s.materials);
  const vonMises = useModelStore((s) => s.result?.vonMises);
  const run = useModelStore((s) => s.result?.run);
  const locale = useLocale();
  return useMemo((): SafetyReadings | null => {
    if (vonMises === undefined) return null;
    if (error !== null) return { kind: "unreadable", reason: error };
    if (!ready) return null;
    try {
      const solved = safetyModel(run, properties, materials);
      const rows = safetyFactors(
        vonMises,
        nodes,
        elements,
        solved.properties,
        solved.materials,
      );
      return {
        kind: "value",
        rows: rows.map((row) => ({
          row,
          label: safetyRowLabel(row, solved.properties, solved.materials),
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
    materials,
    vonMises,
    run,
    locale,
  ]);
}
