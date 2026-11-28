// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef, useState, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Property } from "../../store/modelStore";
import {
  isCadBody,
  shellSectionsOf,
  suppressionMismatch,
} from "../../store/geometrySlice";
import { itemSelection, type TreeTarget } from "../../store/viewSlice";
import { useGeometry } from "../../hooks/useGeometry";
import { useEngineGate } from "../../store/engineStore";
import { SplitSection } from "./SplitSection";
import { BooleanSection } from "./BooleanSection";
import { EYE_ICON, EYE_OFF_ICON } from "./bodyIcons";
import { unconnectedBodies } from "../../lib/interfaces";
import {
  bodyGroupOf,
  bodyGroups,
  OPTIMIZATION_ROLES,
  roleOf,
  type BodyGroup,
  type OptimizationRole,
} from "../../lib/regions";
import { useT } from "../../i18n/useLocale";
import { geometryMessages } from "../../i18n/messages/geometry";
import type { ShellRoute, ShellRouteReason } from "../../wasm/pkg/kofem_wasm";
import styles from "./Panel.module.css";

type GeometryText = (typeof geometryMessages)["en"];

// Tooltip for a body's name: what the last mesh made of its walls. Empty for a
// body the mesh left solid, so only shelled bodies carry the hint.
function sectionsTip(
  sections: Property[],
  text: GeometryText,
): string | undefined {
  if (sections.length === 0) return undefined;
  const thicknesses = sections
    .map((s) => (s.thickness === undefined ? "?" : `${s.thickness} mm`))
    .join(", ");
  return text.shellSections(sections.length, thicknesses);
}

// How the last mesh meshed a body marked Shell (KOF-498): its mid-surface
// from the paired CAD faces, or from its volume mesh and why.
function shellRouteText(route: ShellRoute, text: GeometryText): string {
  if (route.path === "cad")
    return text.shellRouteCad(
      route.walls.length,
      route.walls.map((w) => `${w.thickness} mm`).join(", "),
    );
  const why: Record<ShellRouteReason, string> = {
    no_thin_wall: text.shellRouteNoThinWall,
    no_opposite_face: text.shellRouteNoOppositeFace,
    varying_thickness: text.shellRouteVaryingThickness,
    unsupported_surface: text.shellRouteUnsupportedSurface,
    partial_overlap: text.shellRoutePartialOverlap,
  };
  return text.shellRouteMesh(route.face, why[route.reason]);
}

const STEP_CARD_ICON = (
  <svg className={styles.cardIcon} viewBox="0 0 20 20" fill="none">
    <rect
      x="3"
      y="2"
      width="14"
      height="16"
      rx="2"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path
      d="M7 7h6M7 10h6M7 13h4"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

const IGES_CARD_ICON = (
  <svg className={styles.cardIcon} viewBox="0 0 20 20" fill="none">
    <path
      d="M10 2l2.4 5H18l-4.2 3.1 1.6 5L10 12.2 4.6 15.1l1.6-5L2 7h5.6z"
      stroke="currentColor"
      strokeWidth="1.4"
    />
  </svg>
);

// STEP / IGES import cards with their hidden file inputs.
function ImportSection() {
  const { isImporting, isRunning, stepImportError, importCadFile } =
    useGeometry();
  // A file picked while the engine loads waits for it; a failed engine
  // blocks the import with the reason on hover.
  const engine = useEngineGate();
  const text = useT(geometryMessages);
  const importLabel = engine.waiting ? text.waitingForEngine : text.importing;

  const stepRef = useRef<HTMLInputElement | null>(null);
  const igesRef = useRef<HTMLInputElement | null>(null);

  async function handleCadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await importCadFile(file);
  }

  return (
    <>
      <input
        ref={(el) => {
          stepRef.current = el;
        }}
        type="file"
        accept=".stp,.step"
        style={{ display: "none" }}
        onChange={handleCadFile}
      />
      <input
        ref={(el) => {
          igesRef.current = el;
        }}
        type="file"
        accept=".igs,.iges"
        style={{ display: "none" }}
        onChange={handleCadFile}
      />

      <div className={styles.cardGrid}>
        <button
          className={styles.importCard}
          disabled={isImporting || isRunning || engine.blocked}
          title={engine.reason}
          onClick={() => stepRef.current?.click()}
        >
          {STEP_CARD_ICON}
          <span className={styles.cardTitle}>
            {isImporting ? importLabel : text.importStep}
          </span>
          <span className={styles.cardSub}>.step / .stp</span>
        </button>

        <button
          className={styles.importCard}
          disabled={isImporting || isRunning || engine.blocked}
          title={engine.reason}
          onClick={() => igesRef.current?.click()}
        >
          {IGES_CARD_ICON}
          <span className={styles.cardTitle}>
            {isImporting ? importLabel : text.importIges}
          </span>
          <span className={styles.cardSub}>.igs / .iges</span>
        </button>
      </div>
      {/* KOF-392: files are read and processed in this browser only. */}
      <p className={styles.localNote}>{text.cadStaysLocal}</p>

      {stepImportError && (
        <div
          data-testid="step-error"
          style={{ color: "#dc2626", fontSize: 12, padding: "4px 0" }}
        >
          {stepImportError}
        </div>
      )}
    </>
  );
}

// One body, opened from the model tree: visibility, material, element type and
// the edits that cut it (the split tool).
function BodyDetail({ id }: { id: number }) {
  const prop = useModelStore((s) => s.properties.find((p) => p.id === id));
  const properties = useModelStore((s) => s.properties);
  const shellRoutes = useModelStore((s) => s.shellRoutes);
  const materials = useModelStore((s) => s.materials);
  const assignBodyMaterial = useModelStore((s) => s.assignBodyMaterial);
  const confirmBodyMaterial = useModelStore((s) => s.confirmBodyMaterial);
  const setBodyDiscretization = useModelStore((s) => s.setBodyDiscretization);
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);
  const toggleBodyVisibility = useModelStore((s) => s.toggleBodyVisibility);
  const setBodySuppressed = useModelStore((s) => s.setBodySuppressed);
  const meshSuppressedIds = useModelStore((s) => s.meshSuppressedIds);
  const nodeCount = useModelStore((s) => s.nodes.length);
  const interfaces = useModelStore((s) => s.interfaces);
  const globalMaxSize = useModelStore((s) => s.maxElementSize);
  const setRegionMaxElementSize = useModelStore(
    (s) => s.setRegionMaxElementSize,
  );
  const setRegionOptimizationRole = useModelStore(
    (s) => s.setRegionOptimizationRole,
  );
  const promoteRegion = useModelStore((s) => s.promoteRegion);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const text = useT(geometryMessages);
  if (!prop) return null;
  const roleLabels: Record<OptimizationRole, string> = {
    design: text.roleDesign,
    solid: text.roleSolid,
    void: text.roleVoid,
  };
  // A region of a body with several: it can be promoted to a body of its own.
  const group = bodyGroupOf(properties, prop.id);
  const isRegion = group.regions.length > 1;

  const hidden = hiddenBodyIds.includes(prop.id);
  const bodies = properties.filter(isCadBody);
  // Several bodies, not just several regions of one: the regions of a body are
  // connected by construction, so the bonding note is about bodies only.
  const assembly = bodyGroups(properties).length > 1;
  const suppressed = prop.suppressed === true;
  // The last body still in the model cannot go — there would be nothing left.
  const lastBody =
    !suppressed && bodies.every((b) => b.id === prop.id || b.suppressed);
  const mismatch = suppressionMismatch(
    properties,
    meshSuppressedIds,
    nodeCount > 0,
  );
  const stillMeshed = mismatch.stillMeshed.includes(prop.id);
  const notMeshed = mismatch.missing.includes(prop.id);
  const tip = sectionsTip(shellSectionsOf(properties, prop.id), text);
  // How the last mesh meshed this body, when it is marked Shell (KOF-498).
  const route =
    prop.discretization === "shell"
      ? shellRoutes.find((r) => r.body === prop.id)
      : undefined;
  const unbonded = unconnectedBodies(interfaces, properties).includes(prop.id);
  // The material a body the mesh added was offered (KOF-413). A deleted one has
  // nothing to keep; the solve's pre-flight names that case.
  const offeredMaterial = materials.find((m) => m.id === prop.materialId);
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.visible}</span>
        <button
          className={`${styles.visBtn}${hidden ? ` ${styles.visBtnOff}` : ""}`}
          data-testid={`body-visibility-${prop.id}`}
          title={hidden ? text.showBody : text.hideBody}
          aria-pressed={hidden}
          onClick={() => toggleBodyVisibility(prop.id)}
        >
          {hidden ? EYE_OFF_ICON : EYE_ICON}
        </button>
      </div>
      <label
        className={styles.formRow}
        title={lastBody ? text.lastBodyCannotBeSuppressed : text.suppressTip}
      >
        <span className={styles.formLabel}>{text.suppressed}</span>
        <input
          type="checkbox"
          data-testid={`body-suppressed-${prop.id}`}
          checked={suppressed}
          disabled={lastBody}
          onChange={(e) => setBodySuppressed(prop.id, e.target.checked)}
        />
      </label>
      {stillMeshed && (
        <p className={styles.formNote} data-testid="suppressed-remesh-note">
          {text.suppressedStillMeshed}
        </p>
      )}
      {notMeshed && (
        <p className={styles.formNote} data-testid="restored-remesh-note">
          {text.restoredNotMeshed}
        </p>
      )}
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.material}</span>
        <select
          className={styles.formSelect}
          data-testid={`body-material-${prop.id}`}
          value={prop.materialId}
          onChange={(e) => assignBodyMaterial(prop.id, Number(e.target.value))}
        >
          {materials.map((mat) => (
            <option key={mat.id} value={mat.id}>
              {mat.name}
            </option>
          ))}
        </select>
      </div>
      {prop.materialUnconfirmed && (
        <>
          <p
            className={styles.fieldError}
            data-testid="body-material-unconfirmed"
          >
            {text.materialUnconfirmed}
          </p>
          {offeredMaterial && (
            <div className={styles.formRow}>
              <span className={styles.formLabel} />
              <button
                className={styles.outlineBtn}
                data-testid={`body-material-confirm-${prop.id}`}
                onClick={() => confirmBodyMaterial(prop.id)}
              >
                {text.keepMaterial(offeredMaterial.name)}
              </button>
            </div>
          )}
        </>
      )}
      <div className={styles.formRow} title={text.elementTypeTip}>
        <span className={styles.formLabel}>{text.elementType}</span>
        <select
          className={styles.formSelect}
          data-testid={`body-type-${prop.id}`}
          // eslint-disable-next-line kofem/no-silent-fallback -- selected option for a body left at the default discretization; absent means solid, matching how geometrySlice assigns it
          value={prop.discretization ?? "solid"}
          onChange={(e) =>
            setBodyDiscretization(prop.id, e.target.value as "shell" | "solid")
          }
        >
          <option value="solid">{text.solid}</option>
          <option value="shell">{text.shell}</option>
        </select>
      </div>
      {tip && <p className={styles.formNote}>{tip}</p>}
      {route && (
        <p
          className={styles.formNote}
          data-testid={`body-shell-route-${prop.id}`}
        >
          {shellRouteText(route, text)}
        </p>
      )}
      <div className={styles.formRow} title={text.regionSizeTip}>
        <span className={styles.formLabel}>{text.maxElementSize}</span>
        <input
          className={styles.formInput}
          data-testid={`region-max-size-${prop.id}`}
          type="number"
          step="any"
          // An empty field is how "use the global size" is shown.
          value={prop.maxElementSize ?? ""}
          placeholder={text.meshSettingPlaceholder(globalMaxSize)}
          onChange={(e) => setRegionMaxElementSize(prop.id, e.target.value)}
        />
        <span className={styles.toleranceUnit}>mm</span>
      </div>
      <div className={styles.formRow} title={text.roleTip}>
        <span className={styles.formLabel}>{text.optimization}</span>
        <select
          className={styles.formSelect}
          data-testid={`region-role-${prop.id}`}
          value={roleOf(prop)}
          onChange={(e) =>
            setRegionOptimizationRole(
              prop.id,
              e.target.value as OptimizationRole,
            )
          }
        >
          {OPTIMIZATION_ROLES.map((role) => (
            <option key={role} value={role}>
              {roleLabels[role]}
            </option>
          ))}
        </select>
      </div>
      {unbonded ? (
        <p className={styles.fieldError} data-testid="body-unbonded-note">
          {text.unbondedNote}
        </p>
      ) : (
        assembly && <p className={styles.formNote}>{text.bodiesNote}</p>
      )}
      {isRegion && (
        <button
          className={styles.outlineBtn}
          data-testid={`region-promote-${prop.id}`}
          title={text.promoteTip}
          onClick={() => {
            promoteRegion(prop.id);
            const promoted = useModelStore
              .getState()
              .properties.find((p) => p.id === prop.id);
            if (promoted?.body !== undefined)
              selectTreeNode(itemSelection("geometry", "body", promoted.body));
          }}
        >
          {text.promoteToBody}
        </button>
      )}
      {!suppressed && <SplitSection bodyId={prop.id} />}
    </>
  );
}

// A body a split cut into regions: what holds for the whole body (visibility,
// suppression) and its regions, each opened from the tree or the list here.
function RegionedBody({ group }: { group: BodyGroup }) {
  const properties = useModelStore((s) => s.properties);
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);
  const setBodiesHidden = useModelStore((s) => s.setBodiesHidden);
  const setBodySuppressed = useModelStore((s) => s.setBodySuppressed);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const text = useT(geometryMessages);
  const ids = group.regions.map((r) => r.id);
  const hidden = ids.every((id) => hiddenBodyIds.includes(id));
  const suppressed = group.regions.every((r) => r.suppressed === true);
  // The last body still in the model cannot go — there would be nothing left.
  const lastBody =
    !suppressed &&
    bodyGroups(properties).every(
      (g) => g.body === group.body || g.regions.every((r) => r.suppressed),
    );
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.visible}</span>
        <button
          className={`${styles.visBtn}${hidden ? ` ${styles.visBtnOff}` : ""}`}
          data-testid={`body-visibility-${group.body}`}
          title={hidden ? text.showBody : text.hideBody}
          aria-pressed={hidden}
          onClick={() => setBodiesHidden(ids, !hidden)}
        >
          {hidden ? EYE_OFF_ICON : EYE_ICON}
        </button>
      </div>
      <label
        className={styles.formRow}
        title={lastBody ? text.lastBodyCannotBeSuppressed : text.suppressTip}
      >
        <span className={styles.formLabel}>{text.suppressed}</span>
        <input
          type="checkbox"
          data-testid={`body-suppressed-${group.body}`}
          checked={suppressed}
          disabled={lastBody}
          onChange={(e) => {
            for (const id of ids) setBodySuppressed(id, e.target.checked);
          }}
        />
      </label>
      <p className={styles.formNote}>{text.regionsNote}</p>
      <div className={styles.sectionLabel}>{text.regions}</div>
      {group.regions.map((r, k) => (
        <button
          key={r.id}
          className={styles.outlineBtn}
          data-testid={`body-region-${r.id}`}
          onClick={() =>
            selectTreeNode(itemSelection("geometry", "region", r.id))
          }
        >
          {text.regionName(k + 1)}
        </button>
      ))}
    </>
  );
}

// A body entry of the tree: the body's own settings when it is one region,
// the regioned view when a split cut it.
function BodyEntry({ body }: { body: number }) {
  const properties = useModelStore((s) => s.properties);
  const group = bodyGroups(properties).find((g) => g.body === body);
  if (!group) return null;
  if (group.regions.length === 1)
    return <BodyDetail id={group.regions[0].id} />;
  return <RegionedBody group={group} />;
}

// Geometry → + Add: import a CAD file (replacing the current model) or make a
// body from a Boolean of the bodies already there.
function AddGeometry() {
  const [source, setSource] = useState<"import" | "boolean">("import");
  const text = useT(geometryMessages);
  return (
    <>
      <div
        className={`${styles.segToggle} ${styles.addSource}`}
        role="group"
        aria-label={text.addGeometry}
      >
        {(
          [
            ["import", text.importFile],
            ["boolean", text.fromBoolean],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-testid={`add-geometry-${id}`}
            className={`${styles.segBtn} ${source === id ? styles.segBtnActive : ""}`}
            aria-pressed={source === id}
            onClick={() => setSource(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {source === "import" ? <ImportSection /> : <BooleanSection />}
    </>
  );
}

// The Geometry entries: "+ Add" imports or combines, and each body has its own
// properties and edits.
export function GeometryPanel({ target }: { target: TreeTarget }) {
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {target.type === "add" && <AddGeometry />}
        {target.type === "item" && target.kind === "body" && (
          <BodyEntry body={target.id} />
        )}
        {target.type === "item" && target.kind === "region" && (
          <BodyDetail id={target.id} />
        )}
      </div>
    </div>
  );
}
