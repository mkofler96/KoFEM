// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment } from "react";
import { useModelStore, loadKind } from "../../store/modelStore";
import type { PickMode } from "../../store/modelStore";
import { APP_VERSION } from "../../lib/version";
import { consentBanner } from "../../lib/analytics";
import { EngineStatus } from "./EngineStatus";
import { useT } from "../../i18n/useLocale";
import { statusMessages } from "../../i18n/messages/shell";
import type { PickGeometry } from "../../lib/facePick";
import styles from "./StatusBar.module.css";

type ViewRepr = "geometry" | "surface" | "volume" | "wireframe";

type StatusText = (typeof statusMessages)["en"];

// What the face being picked is for, shown next to the pick indicator.
function pickPurpose(text: StatusText, mode: PickMode): string {
  return {
    bc: text.purposeBc,
    load: text.purposeLoad,
    tie: text.purposeTie,
    coupling: text.purposeCoupling,
  }[mode];
}

function pickTarget(text: StatusText, geometry: PickGeometry): string {
  return { face: text.pickFace, edge: text.pickEdge, point: text.pickPoint }[
    geometry
  ];
}

// The face and nodal-DOF load counts, faces first.
function loadCountLabels(
  text: StatusText,
  nodalLoadDofs: number,
  faceLoads: number,
): string[] {
  const parts: string[] = [];
  if (faceLoads > 0) parts.push(text.faceLoads(faceLoads));
  if (nodalLoadDofs > 0) parts.push(text.nodalLoadDofs(nodalLoadDofs));
  return parts;
}

function reprLabels(
  text: StatusText,
  id: ViewRepr,
): { label: string; tooltip: string } {
  return {
    geometry: { label: text.reprGeometry, tooltip: text.reprGeometryTip },
    surface: { label: text.reprSurface, tooltip: text.reprSurfaceTip },
    volume: { label: text.reprVolume, tooltip: text.reprVolumeTip },
    wireframe: { label: text.reprWireframe, tooltip: text.reprWireframeTip },
  }[id];
}

const REPR_BUTTONS: {
  id: ViewRepr;
  icon: React.ReactNode;
}[] = [
  {
    id: "geometry",
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
  const surfaceLoads = useModelStore((s) => s.surfaceLoads);
  const result = useModelStore((s) => s.result);
  const mode = useModelStore((s) => s.mode);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pickMode = useModelStore((s) => s.pickMode);
  const pickGeometry = useModelStore((s) => s.pickGeometry);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const setViewRepr = useModelStore((s) => s.setViewRepr);
  const showUndeformedOverlay = useModelStore((s) => s.showUndeformedOverlay);
  const setShowUndeformedOverlay = useModelStore(
    (s) => s.setShowUndeformedOverlay,
  );
  const loadGroups = useModelStore((s) => s.loadGroups);
  const loadDisplay = useModelStore((s) => s.loadDisplay);
  const setLoadDisplay = useModelStore((s) => s.setLoadDisplay);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const text = useT(statusMessages);

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

  // Load glyphs are only drawn outside the deformed-result view. Moment arrows
  // look identical in both display modes (they have no per-node form), so the
  // resultant/nodal toggle is offered only when a force/pressure arrow — the
  // kind the toggle actually changes — is on screen.
  const showingResult = !!result && mode === "results";
  const showLoadDisplayToggle =
    !showingResult && loadGroups.some((g) => loadKind(g) !== "moment");

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
            {text.pick(
              pickTarget(text, pickGeometry),
              pickPurpose(text, pickMode),
            )}
          </span>
        )}

        {selectedFace && !pickMode && (
          <span className={styles.selChip}>
            {text.selected(selectedFace.label)}
          </span>
        )}

        {nodes.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{text.nodes(nodes.length)}</span>
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
              {text.nodesFixed(new Set(constraints.map((c) => c.nodeId)).size)}
            </span>
          </>
        )}

        {loadCountLabels(text, loads.length, surfaceLoads.length).map(
          (count) => (
            <Fragment key={count}>
              <span className={styles.sep}>·</span>
              <span className={styles.stat}>{count}</span>
            </Fragment>
          ),
        )}
      </div>

      {/* Center — repr toolbar + undeformed overlay toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div className={styles.reprGroup}>
          {REPR_BUTTONS.map(({ id, icon }, i) => (
            <button
              key={id}
              disabled={isDisabled(id)}
              onClick={() => setViewRepr(id)}
              className={`${styles.reprBtn} ${viewRepr === id ? styles.reprBtnActive : ""}`}
              aria-label={reprLabels(text, id).label}
              data-tooltip={reprLabels(text, id).tooltip}
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
            aria-label={text.undeformedToggle}
            data-tooltip={text.undeformedTip}
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
            {text.undeformed}
          </button>
        )}
        {showLoadDisplayToggle && (
          <button
            onClick={() =>
              setLoadDisplay(loadDisplay === "nodal" ? "resultant" : "nodal")
            }
            className={`${styles.reprBtn} ${loadDisplay === "nodal" ? styles.reprBtnActive : ""}`}
            aria-label={text.nodalToggle}
            data-tooltip={text.nodalTip}
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
              {/* three small down-arrows — the per-node load field */}
              <path
                d="M3 2v8M3 10l-1.6-1.8M3 10l1.6-1.8M8 2v9M8 11l-1.6-1.8M8 11l1.6-1.8M13 2v8M13 10l-1.6-1.8M13 10l1.6-1.8"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {text.nodalLoads}
          </button>
        )}
      </div>

      {/* Right */}
      <div className={styles.right}>
        {result ? (
          <span className={styles.resultChip}>
            <span className={styles.okDot} />
            {text.solved}
          </span>
        ) : meshOk ? (
          <span className={styles.meshChip}>
            <span className={styles.okDot} />
            {text.meshOk}
          </span>
        ) : null}
        <EngineStatus />
        <span className={styles.muted}>m · N · Pa · {APP_VERSION}</span>
        <a
          className={styles.discLink}
          href="https://github.com/mkofler96/KoFEM/blob/main/DISCLAIMER.md"
          target="_blank"
          rel="noopener"
          title={text.noWarrantyTip}
        >
          {text.noWarranty}
        </a>
        {consentBanner() && (
          <a
            className={styles.discLink}
            href="#cookie-settings"
            onClick={(e) => {
              e.preventDefault();
              consentBanner()?.removeAttribute("hidden");
            }}
          >
            {text.cookieSettings}
          </a>
        )}
      </div>
    </div>
  );
}
