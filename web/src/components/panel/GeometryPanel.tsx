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
  OPTIMIZATION_ROLE_LABELS,
  roleOf,
  type BodyGroup,
  type OptimizationRole,
} from "../../lib/regions";
import styles from "./Panel.module.css";

const SUPPRESS_TIP =
  "Take the body out of the model as if it were deleted — it is not drawn, " +
  "meshed or analysed — while keeping its material and settings. Uncheck to " +
  "bring it back.";

// Body ↔ material assignment (#353) lives on each body's tree entry; hovering
// the entry highlights the body in the viewport (others dim).
const BODIES_NOTE =
  "Touching bodies are bonded at their shared faces — a body that touches " +
  "nothing floats, so constrain it or check the assembly.";

const UNBONDED_NOTE =
  "Not bonded to any other body — it floats unless a support or tie holds it.";

const REGIONS_NOTE =
  "A split cut this body into regions. They stay connected at the cuts and " +
  "are meshed together. Open a region to give it its own material, element " +
  "type, element size or optimization role.";

const REGION_SIZE_TIP =
  "Max element size for this region, in mm. Leave blank to use the size in " +
  "the Mesh settings. It may be finer or coarser than that size.";

const ROLE_TIP =
  "What topology optimization may do here: Design lets it remove material, " +
  "Keep solid fixes the region at full material (a mounting boss, a flange), " +
  "Keep empty keeps it free of material.";

const PROMOTE_TIP =
  "Make this region a body of its own. The cut becomes an interface between " +
  "the two bodies, listed under Boundary conditions. The mesh does not change.";

const ELEMENT_TYPE_TIP =
  "Solid uses tetrahedra. Shell uses wall mid-surfaces and retains solid material " +
  "at planar joints. Split thick or curved regions into separate Solid bodies first.";

// Tooltip for a body's name: what the last mesh made of its walls. Empty for a
// body the mesh left solid, so only shelled bodies carry the hint.
function sectionsTip(sections: Property[]): string | undefined {
  if (sections.length === 0) return undefined;
  const thicknesses = sections
    .map((s) => (s.thickness === undefined ? "?" : `${s.thickness} mm`))
    .join(", ");
  return (
    `Idealised as shells by the last mesh — ${sections.length} thickness ` +
    `section(s): ${thicknesses}. Its walls carry this body's material.`
  );
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
  const importLabel = engine.waiting ? "Waiting for engine…" : "Importing…";

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
            {isImporting ? importLabel : "Import STEP"}
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
            {isImporting ? importLabel : "Import IGES"}
          </span>
          <span className={styles.cardSub}>.igs / .iges</span>
        </button>
      </div>

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
  const materials = useModelStore((s) => s.materials);
  const assignBodyMaterial = useModelStore((s) => s.assignBodyMaterial);
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
  if (!prop) return null;
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
  const tip = sectionsTip(shellSectionsOf(properties, prop.id));
  const unbonded = unconnectedBodies(interfaces, properties).includes(prop.id);
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Visible</span>
        <button
          className={`${styles.visBtn}${hidden ? ` ${styles.visBtnOff}` : ""}`}
          data-testid={`body-visibility-${prop.id}`}
          title={hidden ? "Show body" : "Hide body"}
          aria-pressed={hidden}
          onClick={() => toggleBodyVisibility(prop.id)}
        >
          {hidden ? EYE_OFF_ICON : EYE_ICON}
        </button>
      </div>
      <label
        className={styles.formRow}
        title={
          lastBody
            ? "The last body in the model cannot be suppressed"
            : SUPPRESS_TIP
        }
      >
        <span className={styles.formLabel}>Suppressed</span>
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
          Regenerate the mesh to take it out of the analysis — the current mesh
          still contains it.
        </p>
      )}
      {notMeshed && (
        <p className={styles.formNote} data-testid="restored-remesh-note">
          Regenerate the mesh to bring it back into the analysis — the current
          mesh was made without it.
        </p>
      )}
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Material</span>
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
      <div className={styles.formRow} title={ELEMENT_TYPE_TIP}>
        <span className={styles.formLabel}>Element type</span>
        <select
          className={styles.formSelect}
          data-testid={`body-type-${prop.id}`}
          // eslint-disable-next-line kofem/no-silent-fallback -- selected option for a body left at the default discretization; absent means solid, matching how geometrySlice assigns it
          value={prop.discretization ?? "solid"}
          onChange={(e) =>
            setBodyDiscretization(prop.id, e.target.value as "shell" | "solid")
          }
        >
          <option value="solid">Solid</option>
          <option value="shell">Shell</option>
        </select>
      </div>
      {tip && <p className={styles.formNote}>{tip}</p>}
      <div className={styles.formRow} title={REGION_SIZE_TIP}>
        <span className={styles.formLabel}>Max element size</span>
        <input
          className={styles.formInput}
          data-testid={`region-max-size-${prop.id}`}
          type="number"
          step="any"
          // An empty field is how "use the global size" is shown.
          value={prop.maxElementSize ?? ""}
          placeholder={`${globalMaxSize} (mesh setting)`}
          onChange={(e) => setRegionMaxElementSize(prop.id, e.target.value)}
        />
        <span className={styles.toleranceUnit}>mm</span>
      </div>
      <div className={styles.formRow} title={ROLE_TIP}>
        <span className={styles.formLabel}>Optimization</span>
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
          {(
            Object.entries(OPTIMIZATION_ROLE_LABELS) as [
              OptimizationRole,
              string,
            ][]
          ).map(([role, label]) => (
            <option key={role} value={role}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {unbonded ? (
        <p className={styles.fieldError} data-testid="body-unbonded-note">
          {UNBONDED_NOTE}
        </p>
      ) : (
        assembly && <p className={styles.formNote}>{BODIES_NOTE}</p>
      )}
      {isRegion && (
        <button
          className={styles.outlineBtn}
          data-testid={`region-promote-${prop.id}`}
          title={PROMOTE_TIP}
          onClick={() => {
            promoteRegion(prop.id);
            const promoted = useModelStore
              .getState()
              .properties.find((p) => p.id === prop.id);
            if (promoted?.body !== undefined)
              selectTreeNode(itemSelection("geometry", "body", promoted.body));
          }}
        >
          Promote to body
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
        <span className={styles.formLabel}>Visible</span>
        <button
          className={`${styles.visBtn}${hidden ? ` ${styles.visBtnOff}` : ""}`}
          data-testid={`body-visibility-${group.body}`}
          title={hidden ? "Show body" : "Hide body"}
          aria-pressed={hidden}
          onClick={() => setBodiesHidden(ids, !hidden)}
        >
          {hidden ? EYE_OFF_ICON : EYE_ICON}
        </button>
      </div>
      <label
        className={styles.formRow}
        title={
          lastBody
            ? "The last body in the model cannot be suppressed"
            : SUPPRESS_TIP
        }
      >
        <span className={styles.formLabel}>Suppressed</span>
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
      <p className={styles.formNote}>{REGIONS_NOTE}</p>
      <div className={styles.sectionLabel}>Regions</div>
      {group.regions.map((r, k) => (
        <button
          key={r.id}
          className={styles.outlineBtn}
          data-testid={`body-region-${r.id}`}
          onClick={() =>
            selectTreeNode(itemSelection("geometry", "region", r.id))
          }
        >
          Region {k + 1}
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
  return (
    <>
      <div
        className={`${styles.segToggle} ${styles.addSource}`}
        role="group"
        aria-label="Add geometry"
      >
        {(
          [
            ["import", "Import file"],
            ["boolean", "From boolean"],
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
