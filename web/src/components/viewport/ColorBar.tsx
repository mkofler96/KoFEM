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
    const t = i / GRADIENT_STOPS;
    stops.push(`${resultColor(t).getStyle()} ${t * 100}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
})();

export function ColorBar() {
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const mode = useModelStore((s) => s.mode);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);

  if (mode !== "results" || !result) return null;

  const range = computeResultRange(result, resultType, nodes, elements);
  if (!range) return null;

  const { min, max } = range;
  // Tick values from top (max) to bottom (min).
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const t = 1 - i / (TICKS - 1);
    return min + t * (max - min);
  });

  return (
    <div
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
          {ticks.map((v, i) => (
            <span key={i} style={{ whiteSpace: "nowrap", lineHeight: 1 }}>
              {v.toExponential(2)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
