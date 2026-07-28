// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import {
  computeResultRange,
  resultColor,
  resultFieldSymbol,
  resultUnit,
} from "../../lib/resultField";

const GRADIENT_STOPS = 12;
const TICKS = 5;

// CSS gradient sampled from the same color map as the mesh, blue at the bottom
// (min) to red at the top (max).
const gradient = (() => {
  const stops: string[] = [];
  for (let i = 0; i <= GRADIENT_STOPS; i++) {
    const frac = i / GRADIENT_STOPS;
    stops.push(`${resultColor(frac).getStyle()} ${frac * 100}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
})();

export function ColorBar() {
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const mode = useModelStore((s) => s.mode);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const legendRange = useModelStore((s) => s.legendRange);

  if (mode !== "results" || !result) return null;

  const fieldRange = computeResultRange(result, resultType, nodes, elements);
  if (!fieldRange) return null;

  const { min, max } = legendRange ?? fieldRange;
  // Tick values from top (max) to bottom (min). Each tick keeps its position on
  // the bar, which is what identifies it across renders — the value changes
  // whenever the range does.
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const frac = 1 - i / (TICKS - 1);
    return { frac, value: min + frac * (max - min) };
  });
  // Manual limits clamp the colouring, so the end ticks stand for "everything
  // at or beyond this value" rather than for the extremes of the field.
  const clampsAbove = max < fieldRange.max;
  const clampsBelow = min > fieldRange.min;

  return (
    <div
      data-testid="colorbar"
      style={{
        position: "absolute",
        left: 12,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 10,
        padding: "8px 10px",
        background: "rgba(255,255,255,0.85)",
        border: "1px solid #d1d5db",
        borderRadius: 6,
        backdropFilter: "blur(4px)",
        fontFamily: "inherit",
        fontSize: 11,
        color: "#374151",
        userSelect: "none",
      }}
    >
      <div style={{ marginBottom: 6, fontWeight: 600, whiteSpace: "nowrap" }}>
        {resultFieldSymbol(resultType)} [{resultUnit(resultType)}]
      </div>
      {legendRange && (
        <div
          data-testid="colorbar-manual"
          style={{ marginBottom: 6, color: "#6b7280", whiteSpace: "nowrap" }}
        >
          manual range
        </div>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <div
          style={{
            width: 16,
            height: 160,
            background: gradient,
            border: "1px solid #9ca3af",
            borderRadius: 3,
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            height: 160,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {ticks.map(({ frac, value }, i) => (
            <span
              key={frac}
              data-testid={`colorbar-tick-${i}`}
              style={{ whiteSpace: "nowrap", lineHeight: 1 }}
            >
              {frac === 1 && clampsAbove ? "≥ " : ""}
              {frac === 0 && clampsBelow ? "≤ " : ""}
              {value.toExponential(2)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
