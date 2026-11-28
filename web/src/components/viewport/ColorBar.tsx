// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { LegendRangeControls } from "../panel/LegendRangeControls";
import panelStyles from "../panel/Panel.module.css";
import { resultUnit } from "../../lib/resultField";
import {
  fieldLegend,
  LEGEND_GRADIENT,
  legendTicks,
  reactionLegend,
  type Legend,
} from "../../lib/legend";
import { useT } from "../../i18n/useLocale";
import { viewportMessages } from "../../i18n/messages/viewport";

export function ColorBar() {
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const shellSurface = useModelStore((s) => s.shellSurface);
  const mode = useModelStore((s) => s.mode);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const legendRange = useModelStore((s) => s.legendRange);
  const activeResult = useModelStore((s) => s.activeResult);
  const densityResult = useModelStore((s) => s.densityResult);
  const reactionsShown = useModelStore((s) => s.reactionsShown);
  const reactionsDisplay = useModelStore((s) => s.reactionsDisplay);
  // The legend range popup, opened from the pencil beside the title.
  const [editing, setEditing] = useState(false);
  const text = useT(viewportMessages);
  const box = useRef<HTMLDivElement>(null);

  // Escape or a press outside the legend closes the popup.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(false);
    };
    const onPress = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node))
        setEditing(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [editing]);

  // A density run showing its own field has its own legend (DensityColorBar);
  // the static-field legend must not also paint over it.
  const showDensity = activeResult === "density" && !!densityResult;
  if (mode !== "results" || !result || showDensity) return null;
  if (reactionsShown) {
    const legend = reactionLegend(result, reactionsDisplay);
    return legend ? <LegendBox legend={legend} /> : null;
  }

  const shown = fieldLegend(
    result,
    resultType,
    nodes,
    elements,
    shellSurface,
    legendRange,
  );
  if (!shown) return null;
  const { legend, fieldRange } = shown;

  return (
    <div
      ref={box}
      data-testid="colorbar"
      // Open, its popup goes above the probe labels (zIndexRange 0–20).
      style={{ ...BOX_STYLE, zIndex: editing ? 30 : 10 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
          fontWeight: 600,
          whiteSpace: "nowrap",
        }}
      >
        {legend.title}
        <button
          data-testid="legend-edit"
          aria-label={text.editLegendRange}
          title={text.editLegendRange}
          aria-expanded={editing}
          onClick={() => setEditing((open) => !open)}
          style={{
            display: "inline-flex",
            padding: 2,
            border: "none",
            borderRadius: 3,
            background: editing ? "#e5e7eb" : "none",
            color: "#6b7280",
            cursor: "pointer",
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M11 2.5l2.5 2.5L5.5 13H3v-2.5z" />
          </svg>
        </button>
      </div>
      {editing && (
        <div
          role="dialog"
          aria-labelledby="legend-range-title"
          className={panelStyles.legendPopup}
        >
          <LegendRangeControls
            fieldRange={fieldRange}
            unit={resultUnit(resultType)}
            onClose={() => setEditing(false)}
          />
        </div>
      )}
      {legendRange && (
        <div
          data-testid="colorbar-manual"
          style={{ marginBottom: 6, color: "#6b7280", whiteSpace: "nowrap" }}
        >
          {text.manualRange}
        </div>
      )}
      <Bar legend={legend} />
    </div>
  );
}

// The reactions view's legend (KOF-387), fixed to the arrows' range, so it
// has no editor.
function LegendBox({ legend }: { legend: Legend }) {
  return (
    <div data-testid="colorbar" style={BOX_STYLE}>
      <div style={{ marginBottom: 6, fontWeight: 600, whiteSpace: "nowrap" }}>
        {legend.title}
      </div>
      <Bar legend={legend} />
    </div>
  );
}

const BOX_STYLE = {
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
} as const;

// The gradient and its ticks from max (top) to min.
function Bar({ legend }: { legend: Legend }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <div
        style={{
          width: 16,
          height: 160,
          background: LEGEND_GRADIENT,
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
        {legendTicks(legend).map(({ frac, label }, i) => (
          <span
            key={frac}
            data-testid={`colorbar-tick-${i}`}
            style={{ whiteSpace: "nowrap", lineHeight: 1 }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
