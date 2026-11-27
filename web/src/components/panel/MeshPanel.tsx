// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { useMesh } from "../../hooks/useMesh";
import { useEngineGate } from "../../store/engineStore";
import {
  isCadBody,
  meshSizesChanged,
  suppressionMismatch,
  type MeshSizes,
} from "../../store/geometrySlice";
import { estimateElementCount } from "../../lib/meshSizing";
import { bodyGroupOf, solidName, solidsWithOwnSize } from "../../lib/regions";
import { itemSelection } from "../../store/viewSlice";
import type { Property } from "../../store/modelStore";
import type { GeometryMeasure } from "../../lib/meshSizing";
import { LogSection } from "./LogSection";
import { MeshOverlapCard } from "./MeshOverlapCard";
import { FaceSizeSection } from "./FaceSizeSection";
import { faceListLabel } from "../../lib/faceSizes";
import { useIntlTag, useT } from "../../i18n/useLocale";
import { meshMessages } from "../../i18n/messages/mesh";
import styles from "./Panel.module.css";

type MeshText = (typeof meshMessages)["en"];

// Bounding box of the import, as "x × y × z". Three significant digits keep a
// 0.8 mm part and a 2400 mm weldment equally readable.
function formatExtent({ dx, dy, dz }: GeometryMeasure): string {
  const round = (value: number) => Number(value.toPrecision(3)).toString();
  return `${round(dx)} × ${round(dy)} × ${round(dz)}`;
}

// Rough element count the current max size implies, as "12K"/"1.2M" — the size
// fields are unbounded, so this is what tells the user a value is about to cost
// them minutes of meshing before they click.
function formatEstimate(measure: GeometryMeasure, size: string): string | null {
  const parsed = parseFloat(size);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const count = estimateElementCount(measure, parsed);
  if (!Number.isFinite(count)) return null;
  if (count >= 1e6) return `${(count / 1e6).toPrecision(2)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}K`;
  return `${Math.round(count)}`;
}

function formatSizes({ max, min }: MeshSizes, text: MeshText): string {
  return text.sizes(String(max), String(min));
}

// Whether the model has more than one body or region. Only then do sizes per
// body matter next to the global one: a single body just meshes at its size.
function hasSeveralSolids(properties: Property[]): boolean {
  return properties.filter(isCadBody).length > 1;
}

// A solid of a body a split cut into several regions; otherwise the solid is
// the whole body.
function isRegion(properties: Property[], solidId: number): boolean {
  return bodyGroupOf(properties, solidId).regions.length > 1;
}

// What Apply to all changes, in the words the model tree uses: "1 body: Body 2",
// "2 regions: Body 1 · Region 1, Body 1 · Region 2". Past three names the rest
// is a count, so the note stays one or two lines.
function describeSolids(
  properties: Property[],
  solids: Property[],
  text: MeshText,
): string {
  const names = solids.map((p) => solidName(properties, p.id));
  const regions = solids.filter((p) => isRegion(properties, p.id)).length;
  const bodies = names.length - regions;
  const plural = names.length > 1;
  const noun =
    regions === 0
      ? plural
        ? text.severalBodies
        : text.oneBody
      : bodies === 0
        ? plural
          ? text.severalRegions
          : text.oneRegion
        : text.bodiesAndRegions;
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length > 3 ? text.andMore(names.length - 3) : "";
  return text.changesSolids(names.length, noun, `${shown}${rest}`);
}

// The Mesh entry of the model tree. Before there is a mesh it is the mesh
// settings and a Generate action; once there is one it is that mesh — what it
// is, the settings it answers to, and a Regenerate action that applies them.
export function MeshPanel() {
  const hasMesh = useModelStore((s) => s.nodes.length > 0);
  const remeshNotice = useModelStore((s) => s.remeshNotice);
  const setRemeshNotice = useModelStore((s) => s.setRemeshNotice);
  const { stepSurface, isMeshing, meshError, setMeshError, logs, ...mesh } =
    useMesh();
  const text = useT(meshMessages);

  return (
    <>
      {meshError && (
        <div className={styles.errorBanner} data-testid="meshing-error">
          <span>{meshError}</span>
          <button onClick={() => setMeshError(null)}>×</button>
        </div>
      )}

      <MeshOverlapCard
        maxElementSize={mesh.maxElementSize}
        minElementSize={mesh.minElementSize}
      />

      {hasMesh && <MeshSummary />}

      {stepSurface ? (
        <MeshSettings hasMesh={hasMesh} isMeshing={isMeshing} mesh={mesh} />
      ) : hasMesh ? (
        // A mesh with no geometry behind it (no example ships one; a model
        // opened from elsewhere can) cannot be re-meshed. Say so instead of
        // silently leaving out the mesh controls.
        <div className={styles.errorBanner} data-testid="mesh-no-geometry">
          <span>{text.noGeometryToRemesh}</span>
        </div>
      ) : (
        <div className={styles.empty}>{text.noMesh}</div>
      )}

      {remeshNotice && (
        <div className={styles.inlineForm} data-testid="remesh-notice">
          <span className={styles.hint}>{remeshNotice}</span>
          <div className={styles.formBtns}>
            <button
              className={styles.cancelBtn}
              onClick={() => setRemeshNotice(null)}
            >
              {text.ok}
            </button>
          </div>
        </div>
      )}

      <LogSection logs={logs} busy={isMeshing} />
    </>
  );
}

// What the current mesh is: its size and the element sizes it was made with.
function MeshSummary() {
  const nodeCount = useModelStore((s) => s.nodes.length);
  const elementCount = useModelStore((s) => s.elements.length);
  const meshSizes = useModelStore((s) => s.meshSizes);
  const properties = useModelStore((s) => s.properties);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const text = useT(meshMessages);
  const intlTag = useIntlTag();
  const editable = hasSeveralSolids(properties);
  // A region's size is edited on its own tree entry; a body of one region has
  // only the body entry.
  const openSolid = (id: number) =>
    selectTreeNode(
      isRegion(properties, id)
        ? itemSelection("geometry", "region", id)
        : itemSelection("geometry", "body", bodyGroupOf(properties, id).body),
    );
  return (
    <div data-testid="mesh-summary">
      <div className={styles.statRow}>
        <span className={styles.statKey}>{text.nodes}</span>
        <span className={styles.statVal}>
          {nodeCount.toLocaleString(intlTag)}
        </span>
      </div>
      <div className={styles.statRow}>
        <span className={styles.statKey}>{text.elements}</span>
        <span className={styles.statVal}>
          {elementCount.toLocaleString(intlTag)}
        </span>
      </div>
      {meshSizes && (
        <div className={styles.statRow}>
          <span className={styles.statKey}>{text.madeWith}</span>
          <span className={styles.statVal} data-testid="mesh-made-with">
            {formatSizes(meshSizes, text)}
          </span>
        </div>
      )}
      {meshSizes &&
        Object.entries(meshSizes.regions)
          .filter(([id]) => properties.some((p) => p.id === Number(id)))
          .map(([key, size]) => {
            const id = Number(key);
            const name = solidName(properties, id);
            return (
              <div key={id} className={styles.statRow}>
                <span className={styles.statKey}>{name}</span>
                <span className={styles.statValWithAction}>
                  <span
                    className={styles.statVal}
                    data-testid={`mesh-region-size-${id}`}
                  >
                    {text.maxSize(String(size))}
                  </span>
                  {editable && (
                    <button
                      className={styles.iconBtn}
                      data-testid={`mesh-region-edit-${id}`}
                      title={text.editElementSize(name)}
                      aria-label={text.editElementSize(name)}
                      onClick={() => openSolid(id)}
                    >
                      ✎
                    </button>
                  )}
                </span>
              </div>
            );
          })}
      {meshSizes &&
        Object.entries(meshSizes.faces).map(([key, size]) => {
          const id = Number(key);
          return (
            <div key={`face-${id}`} className={styles.statRow}>
              <span className={styles.statKey}>{faceListLabel([id])}</span>
              <span
                className={styles.statVal}
                data-testid={`mesh-face-size-${id}`}
              >
                {text.maxSize(String(size))}
              </span>
            </div>
          );
        })}
    </div>
  );
}

type MeshControls = Omit<
  ReturnType<typeof useMesh>,
  "stepSurface" | "isMeshing" | "meshError" | "setMeshError" | "logs"
>;

// The mesh settings and the action that applies them: Generate before there is
// a mesh, Regenerate after — highlighted, with the reason, once the settings or
// the bodies no longer match the mesh.
function MeshSettings({
  hasMesh,
  isMeshing,
  mesh,
}: {
  hasMesh: boolean;
  isMeshing: boolean;
  mesh: MeshControls;
}) {
  const isRunning = useModelStore((s) => s.isRunning);
  const meshSizes = useModelStore((s) => s.meshSizes);
  const properties = useModelStore((s) => s.properties);
  const meshSuppressedIds = useModelStore((s) => s.meshSuppressedIds);
  const faceSizes = useModelStore((s) => s.faceSizes);
  const clearRegionMaxElementSizes = useModelStore(
    (s) => s.clearRegionMaxElementSizes,
  );
  const engine = useEngineGate();
  const text = useT(meshMessages);
  const {
    elementOrder,
    setElementOrder,
    maxElementSize,
    setMaxElementSize,
    minElementSize,
    setMinElementSize,
    geometryMeasure,
    meshVolume,
  } = mesh;

  const sizesChanged =
    hasMesh &&
    meshSizesChanged(
      meshSizes,
      maxElementSize,
      minElementSize,
      properties,
      faceSizes,
    );
  const bodies = suppressionMismatch(properties, meshSuppressedIds, hasMesh);
  const bodiesChanged =
    bodies.stillMeshed.length > 0 || bodies.missing.length > 0;
  const estimate =
    geometryMeasure && formatEstimate(geometryMeasure, maxElementSize);
  // Bodies and regions with a size of their own ignore the max size here;
  // a single body is left as it is.
  const ownSize = hasSeveralSolids(properties)
    ? solidsWithOwnSize(properties)
    : [];

  return (
    <>
      <div className={styles.sectionLabel}>{text.meshSettings}</div>
      {geometryMeasure && (
        <div className={styles.hint} data-testid="geometry-extent">
          {text.modelExtent(formatExtent(geometryMeasure))}
          {estimate && text.elementEstimate(estimate)}
        </div>
      )}
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.maxElementSize}</span>
        <input
          className={styles.formInput}
          data-testid="max-element-size"
          type="number"
          step="any"
          value={maxElementSize}
          disabled={isMeshing}
          onChange={(e) => setMaxElementSize(e.target.value)}
          title={text.maxElementSizeTip}
        />
        <span className={styles.toleranceUnit}>mm</span>
      </div>
      {ownSize.length > 0 && (
        <div className={styles.applyAll}>
          <button
            className={styles.applyAllBtn}
            data-testid="mesh-size-apply-all"
            disabled={isMeshing}
            title={text.applyToAllBodiesTip}
            onClick={clearRegionMaxElementSizes}
          >
            {text.applyToAllBodies}
          </button>
          <span
            className={styles.applyAllNote}
            data-testid="mesh-size-apply-all-note"
          >
            {describeSolids(properties, ownSize, text)}
          </span>
        </div>
      )}
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.minElementSize}</span>
        <input
          className={styles.formInput}
          data-testid="min-element-size"
          type="number"
          step="any"
          value={minElementSize}
          disabled={isMeshing}
          onChange={(e) => setMinElementSize(e.target.value)}
          title={text.minElementSizeTip}
        />
        <span className={styles.toleranceUnit}>mm</span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.elementOrder}</span>
        <select
          className={styles.formSelect}
          value={elementOrder}
          onChange={(e) => setElementOrder(Number(e.target.value))}
          title={text.elementOrderTip}
        >
          <option value={1}>{text.linear}</option>
          <option value={2}>{text.quadratic}</option>
        </select>
      </div>
      <FaceSizeSection disabled={isMeshing} />
      {sizesChanged && meshSizes && (
        <p className={styles.formNote} data-testid="mesh-sizes-changed">
          {text.sizesChanged(formatSizes(meshSizes, text))}
        </p>
      )}
      {bodiesChanged && (
        <p className={styles.formNote} data-testid="mesh-bodies-changed">
          {text.bodiesChanged}
        </p>
      )}
      <button
        className={
          hasMesh && !sizesChanged && !bodiesChanged
            ? styles.outlineBtn
            : styles.meshVolBtn
        }
        data-testid="mesh-generate"
        // A mesh queued behind a running import, split or solve would mesh
        // with settings from before it — and its worker reset would kill it.
        disabled={isMeshing || isRunning || engine.blocked}
        title={engine.reason}
        onClick={meshVolume}
      >
        {isMeshing
          ? text.meshing
          : hasMesh
            ? text.regenerateMesh
            : text.generateMesh}
      </button>
    </>
  );
}
