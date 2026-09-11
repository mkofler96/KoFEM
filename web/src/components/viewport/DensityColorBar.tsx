// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Legend for the topology-optimization density field (KOF-233): the grayscale
// 0→1 density ramp with a marker at the current visibility threshold, so the
// user reads which densities the cutoff keeps. Shown only when a density run is
// the active result in the Results view.

import { useModelStore } from "../../store/modelStore";
import { densityColor } from "../../lib/densityField";

const GRADIENT_STOPS = 12;
const BAR_HEIGHT = 160;

const gradient = (() => {
  const stops: string[] = [];
  for (let i = 0; i <= GRADIENT_STOPS; i++) {
    const frac = i / GRADIENT_STOPS;
    stops.push(`${densityColor(frac).getStyle()} ${frac * 100}%`);
  }
  return `linear-gradient(to top, ${stops.join(", ")})`;
})();

export function DensityColorBar() {
  const mode = useModelStore((s) => s.mode);
  const activeResult = useModelStore((s) => s.activeResult);
  const densityResult = useModelStore((s) => s.densityResult);
  const threshold = useModelStore((s) => s.densityThreshold);

  if (mode !== "results" || activeResult !== "density" || !densityResult)
    return null;

  const ticks = [1, 0.75, 0.5, 0.25, 0];

  return (
    <div
      data-testid="density-colorbar"
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
        Density ρ
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <div style={{ position: "relative", width: 16, height: BAR_HEIGHT }}>
          <div
            style={{
              width: "100%",
              height: "100%",
              background: gradient,
              border: "1px solid #9ca3af",
              borderRadius: 3,
            }}
          />
          {/* Threshold marker — everything below this density is hidden. */}
          <div
            data-testid="density-threshold-marker"
            style={{
              position: "absolute",
              left: -2,
              right: -2,
              top: `${(1 - threshold) * 100}%`,
              height: 0,
              borderTop: "2px solid #d62728",
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            height: BAR_HEIGHT,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {ticks.map((v) => (
            <span key={v} style={{ whiteSpace: "nowrap", lineHeight: 1 }}>
              {v.toFixed(2)}
            </span>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 6, color: "#b91c1c", whiteSpace: "nowrap" }}>
        cutoff {threshold.toFixed(2)}
      </div>
    </div>
  );
}
