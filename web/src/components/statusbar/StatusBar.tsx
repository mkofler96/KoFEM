// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment } from "react";
import { useModelStore, loadKind } from "../../store/modelStore";
import { APP_VERSION } from "../../lib/version";
import { consentBanner } from "../../lib/analytics";
import type { ViewRepr } from "../../store/viewSlice";
import type { Projection } from "../../lib/projection";
import { EngineStatus } from "./EngineStatus";
import { useIntlTag, useT } from "../../i18n/useLocale";
import { statusMessages } from "../../i18n/messages/shell";
import { isPicking, pickedCadFaceId } from "../../lib/statusContext";
import { cadFaceLabel } from "../../lib/cadFaceProperties";
import type { CadFaceProperties } from "../../lib/cadFaceProperties";
import { MODEL_UNITS } from "../../lib/modelUnits";
import styles from "./StatusBar.module.css";

type StatusText = (typeof statusMessages)["en"];

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

function pickedCadFace(
  faces: CadFaceProperties[] | null,
  cadFaceId: number | undefined,
): { id: number; face: CadFaceProperties } | null {
  if (faces === null || cadFaceId === undefined) return null;
  const face = faces[cadFaceId - 1];
  if (face === undefined)
    throw new Error(
      `Picked CAD face ${cadFaceId}, but the geometry has ${faces.length} faces`,
    );
  return { id: cadFaceId, face };
}

function reprLabels(
  text: StatusText,
  id: ViewRepr,
): { label: string; tooltip: string } {
  return {
    geometry: { label: text.reprGeometry, tooltip: text.reprGeometryTip },
    surface: { label: text.reprSurface, tooltip: text.reprSurfaceTip },
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

// The projection toggle (KOF-429): what each projection looks like, a box
// whose far face shrinks or keeps its size.
const PROJECTION_ICON: Record<Projection, React.ReactNode> = {
  perspective: (
    <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
      <path
        d="M2 5h9v9H2zM8 2h6v6H8zM2 5l6-3M11 5l3-3M11 14l3-6M2 14l6-6"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  ),
  orthographic: (
    <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
      <path
        d="M2 5h9v9H2zM5 2h9v9H5zM2 5l3-3M11 5l3-3M11 14l3-3M2 14l3-3"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

function projectionLabels(
  text: StatusText,
  projection: Projection,
): { label: string; tooltip: string } {
  return {
    perspective: {
      label: text.projectionPerspective,
      tooltip: text.projectionPerspectiveTip,
    },
    orthographic: {
      label: text.projectionOrthographic,
      tooltip: text.projectionOrthographicTip,
    },
  }[projection];
}

export function StatusBar() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const surfaceLoads = useModelStore((s) => s.surfaceLoads);
  const result = useModelStore((s) => s.result);
  const mode = useModelStore((s) => s.mode);
  const picking = useModelStore(isPicking);
  const pickedFaceId = useModelStore(pickedCadFaceId);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const setViewRepr = useModelStore((s) => s.setViewRepr);
  const projection = useModelStore((s) => s.projection);
  const setProjection = useModelStore((s) => s.setProjection);
  const showUndeformedOverlay = useModelStore((s) => s.showUndeformedOverlay);
  const setShowUndeformedOverlay = useModelStore(
    (s) => s.setShowUndeformedOverlay,
  );
  const loadGroups = useModelStore((s) => s.loadGroups);
  const loadDisplay = useModelStore((s) => s.loadDisplay);
  const setLoadDisplay = useModelStore((s) => s.setLoadDisplay);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const cadFaces = useModelStore((s) => s.cadFaces);
  const text = useT(statusMessages);
  const intl = useIntlTag();
  const picked = pickedCadFace(cadFaces, pickedFaceId);
  const pickedLabel =
    picked &&
    cadFaceLabel(picked.id, picked.face, text, intl, MODEL_UNITS.length);

  const hasGeometry = nodes.length > 0 || !!stepSurface;
  const hasSurface = nodes.length > 0;

  function isDisabled(id: ViewRepr) {
    if (id === "geometry" || id === "wireframe") return !hasGeometry;
    return !hasSurface;
  }

  const hexCount = elements.filter((e) => e.type === "CHEXA").length;
  const tetCount = elements.filter((e) => e.type === "CTETRA").length;
  const modelCounts = [
    ...(nodes.length > 0 ? [text.nodes(nodes.length)] : []),
    ...(hexCount > 0 ? [`${hexCount} CHEXA`] : []),
    ...(tetCount > 0 ? [`${tetCount} CTETRA`] : []),
    ...(constraints.length > 0
      ? [text.nodesFixed(new Set(constraints.map((c) => c.nodeId)).size)]
      : []),
    ...loadCountLabels(text, loads.length, surfaceLoads.length),
  ];
  const meshOk = nodes.length > 0;

  // Load glyphs are only drawn outside the deformed-result view. Moment arrows
  // look identical in both display modes (they have no per-node form), so the
  // resultant/nodal toggle is offered only when a force/pressure arrow — the
  // kind the toggle actually changes — is on screen.
  const showingResult = !!result && mode === "results";
  const showLoadDisplayToggle =
    !showingResult && loadGroups.some((g) => loadKind(g) !== "moment");

  return (
    <div className={styles.bar} data-testid="status-bar">
      {/* Left: the face being picked while a tool picks, else the model */}
      <div className={styles.left}>
        {picking
          ? pickedLabel && (
              <span
                className={styles.faceInfo}
                title={pickedLabel}
                data-testid="picked-face"
              >
                {pickedLabel}
              </span>
            )
          : modelCounts.map((count, i) => (
              <Fragment key={count}>
                {i > 0 && <span className={styles.sep}>·</span>}
                <span className={styles.stat}>{count}</span>
              </Fragment>
            ))}
      </div>

      {/* Center — repr toolbar + undeformed overlay toggle */}
      <div
        role="toolbar"
        aria-label={text.viewToolbar}
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
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
          <button
            onClick={() =>
              setProjection(
                projection === "perspective" ? "orthographic" : "perspective",
              )
            }
            className={styles.reprBtn}
            aria-label={projectionLabels(text, projection).label}
            data-tooltip={projectionLabels(text, projection).tooltip}
            style={{ borderLeft: "1px solid #e2e5ea" }}
          >
            {PROJECTION_ICON[projection]}
          </button>
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
            <span className={styles.toggleLabel}>{text.undeformed}</span>
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
            <span className={styles.toggleLabel}>{text.nodalLoads}</span>
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
        <span className={styles.muted}>
          {MODEL_UNITS.length} · {MODEL_UNITS.force} · {MODEL_UNITS.stress} ·{" "}
          {APP_VERSION}
        </span>
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
