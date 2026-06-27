// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { APP_VERSION } from "../../lib/version";
import styles from "./StatusBar.module.css";

type ViewRepr = "geometry" | "surface" | "volume" | "wireframe";

const REPR_BUTTONS: {
  id: ViewRepr;
  label: string;
  tooltip: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "geometry",
    label: "Geometry",
    tooltip: "Shaded — smooth surface, no mesh edges",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path
          d="M8 2L13 5v6L8 14L3 11V5z"
          fill="currentColor"
          fillOpacity="0.25"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M8 2L8 14M3 5l5 3.5M13 5l-5 3.5"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "surface",
    label: "Surface",
    tooltip: "Surface mesh — shaded with element edges",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path
          d="M8 2L13 5v6L8 14L3 11V5z"
          fill="currentColor"
          fillOpacity="0.18"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M3 5l5 3.5M13 5l-5 3.5M8 2l-3 5.5M8 2l3 5.5M3 11l5-2M13 11l-5-2"
          stroke="currentColor"
          strokeWidth="0.9"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "volume",
    label: "Volume",
    tooltip: "Volume mesh — all tetrahedral edges",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path
          d="M8 2L13 5v6L8 14L3 11V5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M3 5l5 3.5M13 5l-5 3.5M8 8.5L8 14M3 5l5 9M13 5l-5 9M3 11l5-2.5M13 11l-5-2.5"
          stroke="currentColor"
          strokeWidth="0.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "wireframe",
    label: "Wireframe",
    tooltip: "Wireframe — edges only, no fill",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path
          d="M8 2L13 5v6L8 14L3 11V5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M8 2L8 14M3 5l5 3.5M13 5l-5 3.5"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeDasharray="2 1.5"
        />
      </svg>
    ),
  },
];

export function StatusBar() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const result = useModelStore((s) => s.result);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pickMode = useModelStore((s) => s.pickMode);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const setViewRepr = useModelStore((s) => s.setViewRepr);
  const showUndeformedOverlay = useModelStore((s) => s.showUndeformedOverlay);
  const setShowUndeformedOverlay = useModelStore(
    (s) => s.setShowUndeformedOverlay,
  );
  const stepSurface = useModelStore((s) => s.stepSurface);

  const hasGeometry = nodes.length > 0 || !!stepSurface;
  const hasSurface = nodes.length > 0;
  // A volume mesh exists whenever the model has 3D solid elements — their edges
  // are what the "all tetrahedral" representation draws.
  const hasVolume = elements.some(
    (e) => e.type === "CTETRA" || e.type === "CHEXA",
  );

  function isDisabled(id: ViewRepr) {
    if (id === "geometry" || id === "wireframe") return !hasGeometry;
    if (id === "surface") return !hasSurface;
    if (id === "volume") return !hasVolume;
    return false;
  }

  const hexCount = elements.filter((e) => e.type === "CHEXA").length;
  const tetCount = elements.filter((e) => e.type === "CTETRA").length;
  const meshOk = nodes.length > 0;

  return (
    <div className={styles.bar}>
      {/* Left */}
      <div className={styles.left}>
        {/* <span className={styles.stepChip}>
          Step {MODE_NUMS[mode]} / 05 · {MODE_LABELS[mode]}
        </span> */}

        {pickMode && (
          <span className={styles.pickChip}>
            <span className={styles.pickDot} />
            {pickMode === "bc"
              ? "Pick face — fixed displacement"
              : "Pick face — apply load"}
          </span>
        )}

        {selectedFace && !pickMode && (
          <span className={styles.selChip}>Selected: {selectedFace.label}</span>
        )}

        {nodes.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{nodes.length} nodes</span>
          </>
        )}

        {hexCount > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{hexCount} CHEXA</span>
          </>
        )}

        {tetCount > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{tetCount} CTETRA</span>
          </>
        )}

        {constraints.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>
              {new Set(constraints.map((c) => c.nodeId)).size} nodes fixed
            </span>
          </>
        )}

        {loads.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{loads.length} load DOFs</span>
          </>
        )}
      </div>

      {/* Center — repr toolbar + undeformed overlay toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div className={styles.reprGroup}>
          {REPR_BUTTONS.map(({ id, label, tooltip, icon }, i) => (
            <button
              key={id}
              disabled={isDisabled(id)}
              onClick={() => setViewRepr(id)}
              className={`${styles.reprBtn} ${viewRepr === id ? styles.reprBtnActive : ""}`}
              aria-label={label}
              data-tooltip={tooltip}
              style={{ borderLeft: i > 0 ? "1px solid #e2e5ea" : "none" }}
            >
              {icon}
            </button>
          ))}
        </div>
        {result && (
          <button
            onClick={() => setShowUndeformedOverlay(!showUndeformedOverlay)}
            className={`${styles.reprBtn} ${showUndeformedOverlay ? styles.reprBtnActive : ""}`}
            aria-label="Toggle undeformed overlay"
            data-tooltip="Show undeformed geometry as overlay"
            style={{
              width: "auto",
              padding: "0 7px",
              borderRadius: 5,
              border: "1px solid #e2e5ea",
            }}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              width="13"
              height="13"
              style={{ marginRight: 4 }}
            >
              <path
                d="M8 2L13 5v6L8 14L3 11V5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
                strokeDasharray="2.5 1.5"
              />
            </svg>
            Undeformed
          </button>
        )}
      </div>

      {/* Right */}
      <div className={styles.right}>
        {result ? (
          <span className={styles.resultChip}>
            <span className={styles.okDot} />
            Solved · converged
          </span>
        ) : meshOk ? (
          <span className={styles.meshChip}>
            <span className={styles.okDot} />
            Mesh OK
          </span>
        ) : null}
        <span className={styles.muted}>m · N · Pa · {APP_VERSION}</span>
        <a
          className={styles.discLink}
          href="https://github.com/mkofler96/KoFEM/blob/main/DISCLAIMER.md"
          target="_blank"
          rel="noopener"
          title="No warranty — FEM results are approximations. Verify independently before relying on them."
        >
          No warranty
        </a>
      </div>
    </div>
  );
}
