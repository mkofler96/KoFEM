// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useRef, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Material } from "../../store/modelStore";
import { pickMaterialColor } from "../../store/materialSlice";
import { fmt } from "../../lib/modelDisplay";
import { useGeometry } from "../../hooks/useGeometry";
import { MeshPanel } from "./MeshPanel";
import styles from "./LeftPanel.module.css";

function MaterialForm({
  mat,
  defaultColor,
  onSave,
  onCancel,
}: {
  mat?: Material;
  defaultColor?: string;
  onSave(v: Omit<Material, "id">): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(mat?.name ?? "Material");
  const [young, setYoung] = useState(String(mat?.young ?? 210000));
  const [poisson, setPoisson] = useState(String(mat?.poisson ?? 0.3));
  const [density, setDensity] = useState(String(mat?.density ?? 7.85e-9));
  const [color, setColor] = useState(mat?.color ?? defaultColor ?? "#4e79a7");
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    const youngModulus = parseFloat(young);
    const poissonRatio = parseFloat(poisson);
    const densityValue = parseFloat(density);

    if (!isFinite(youngModulus) || youngModulus <= 0) {
      setError("Young's modulus must be a positive number");
      return;
    }
    // ν must lie in (-1, 0.5); ν = 0 is physically valid (e.g. auxetic foams,
    // cork) and must not be silently replaced by the steel default.
    if (!isFinite(poissonRatio) || poissonRatio <= -1 || poissonRatio >= 0.5) {
      setError("Poisson's ratio must be in the range (-1, 0.5)");
      return;
    }
    if (!isFinite(densityValue) || densityValue < 0) {
      setError("Density must be a non-negative number");
      return;
    }
    onSave({
      name: name || "Material",
      young: youngModulus,
      poisson: poissonRatio,
      density: densityValue,
      color,
    });
  }

  return (
    <div className={styles.inlineForm}>
      {error && (
        <div className={styles.errorBanner} data-testid="material-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Name</span>
        <input
          className={styles.formInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Colour</span>
        <input
          className={styles.colorInput}
          type="color"
          value={color}
          data-testid="material-color"
          onChange={(e) => setColor(e.target.value)}
          title="Colour used to paint the bodies made of this material"
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>E (MPa)</span>
        <input
          className={styles.formInput}
          type="number"
          value={young}
          step="1000"
          onChange={(e) => setYoung(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>ν</span>
        <input
          className={styles.formInput}
          type="number"
          value={poisson}
          step="0.01"
          onChange={(e) => setPoisson(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>ρ (t/mm³)</span>
        <input
          className={styles.formInput}
          type="number"
          value={density}
          step="1e-9"
          onChange={(e) => setDensity(e.target.value)}
          title="Stored with the material but not used by the current static solver (reserved for future gravity / inertial loads)."
        />
      </div>
      <p className={styles.formNote}>
        Not used by the current static solver — reserved for future gravity /
        inertial loads.
      </p>
      <div className={styles.formBtns}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button className={styles.primaryBtn} onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
}

// Material definitions with per-body assignment (#317/#353). A single-body
// part keeps the old behaviour — one material, applied to the whole part; a
// multibody assembly lists every body with a material dropdown (the body ↔
// material mapping made explicit — the confusion behind #275).
function MaterialSection() {
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const updateMaterial = useModelStore((s) => s.updateMaterial);
  const deleteMaterial = useModelStore((s) => s.deleteMaterial);
  const createMaterial = useModelStore((s) => s.createMaterial);

  const [editingMatId, setEditingMatId] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const isAssigned = (matId: number) =>
    properties.some((p) => p.materialId === matId);

  return (
    <>
      <div className={styles.sectionLabel}>Materials</div>
      {materials.length === 0 && (
        <div className={styles.empty}>No material</div>
      )}
      {materials.map((mat) => (
        <div key={mat.id}>
          <div className={styles.treeItem}>
            <span
              className={styles.materialSwatch}
              style={{ background: mat.color }}
              title={`Body colour ${mat.color}`}
            />
            <div className={styles.treeItemBody}>
              <div className={styles.treeItemName}>{mat.name}</div>
              <div className={styles.treeItemDetail}>
                E = {fmt(mat.young, 3)} MPa · ν = {mat.poisson}
              </div>
            </div>
            <div className={styles.treeItemActions}>
              <button
                className={styles.iconBtn}
                title="Edit material"
                onClick={() => setEditingMatId(mat.id)}
              >
                ✎
              </button>
              {materials.length > 1 && !isAssigned(mat.id) && (
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Remove material"
                  onClick={() => deleteMaterial(mat.id)}
                >
                  ×
                </button>
              )}
            </div>
          </div>
          {editingMatId === mat.id && (
            <MaterialForm
              mat={mat}
              onSave={(values) => {
                updateMaterial(mat.id, values);
                setEditingMatId(null);
              }}
              onCancel={() => setEditingMatId(null)}
            />
          )}
        </div>
      ))}
      {isAdding ? (
        <MaterialForm
          defaultColor={pickMaterialColor(materials)}
          onSave={(values) => {
            createMaterial(values);
            setIsAdding(false);
          }}
          onCancel={() => setIsAdding(false)}
        />
      ) : (
        <button
          className={styles.outlineBtn}
          data-testid="add-material"
          onClick={() => setIsAdding(true)}
        >
          + Add material
        </button>
      )}
      {materials.length === 1 && properties.length <= 1 && (
        <div className={styles.empty}>Applied to the whole part.</div>
      )}
      <BodiesSection />
    </>
  );
}

// Minimalist eye / eye-off glyphs for the per-body visibility toggle.
const EYE_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
    <path
      d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);

const EYE_OFF_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden>
    <path
      d="M2 12s3.5-7 10-7c1.6 0 3 .4 4.3 1M22 12s-3.5 7-10 7c-1.6 0-3-.4-4.3-1M9.5 9.6a3.5 3.5 0 0 0 4.9 4.9M4 4l16 16"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Body ↔ material assignment for multibody assemblies (#353): one row per
// body of the imported CAD file, each with an eye (show/hide), a material-colour
// swatch and a material dropdown. Hovering or focusing a row highlights that
// body in the viewport (others dim). Hidden for single-body parts, where the
// sole material applies to the whole part.
const BODIES_TIP =
  "Hover a body to highlight it in the geometry view; use the eye to hide it. " +
  "Touching bodies are bonded at their shared faces — a body that touches " +
  "nothing floats, so constrain it or check the assembly.";

const TIE_TIP =
  "Bonded tie for parts that touch without a shared face (e.g. a pin in a hook " +
  "eye — a line contact). Nodes of different bodies within this distance are " +
  "welded so load transfers. 0 = off. Keep it below the element size to avoid " +
  "distorting the mesh.";

const ELEMENT_TYPE_TIP =
  "How this body is discretised. Solid meshes it as tetrahedra (linear or " +
  "quadratic per the Element order above). Shell idealises a thin-walled body's " +
  "walls as Kirchhoff shells coupled to the solid bodies — far more robust for " +
  "thin parts. Thin-walled bodies are preselected Shell automatically.";

function BodiesSection() {
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const assignBodyMaterial = useModelStore((s) => s.assignBodyMaterial);
  const setBodyDiscretization = useModelStore((s) => s.setBodyDiscretization);
  const setHighlightBodyId = useModelStore((s) => s.setHighlightBodyId);
  const hiddenBodyIds = useModelStore((s) => s.hiddenBodyIds);
  const toggleBodyVisibility = useModelStore((s) => s.toggleBodyVisibility);
  const tieDistance = useModelStore((s) => s.tieDistance);
  const setTieDistance = useModelStore((s) => s.setTieDistance);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const setViewRepr = useModelStore((s) => s.setViewRepr);

  if (properties.length <= 1) return null;

  const matColor = (materialId: number) =>
    materials.find((mat) => mat.id === materialId)?.color ?? "#7a9bbf";

  // Highlighting a body dims the others in the geometry (coloured-tessellation)
  // view; the FEM mesh views are a single neutral colour and can't show it. So
  // when the user reaches for a body, switch to the geometry view where the
  // highlight is visible. (The FEM surface is suppressed there, so no overlap.)
  const highlight = (id: number) => {
    setHighlightBodyId(id);
    if (viewRepr !== "geometry" && viewRepr !== "wireframe")
      setViewRepr("geometry");
  };

  return (
    <>
      <div className={styles.sectionLabel} title={BODIES_TIP}>
        Bodies
      </div>
      {properties.map((prop) => {
        const hidden = hiddenBodyIds.includes(prop.id);
        return (
          <div
            className={styles.bodyRow}
            key={prop.id}
            onMouseEnter={() => highlight(prop.id)}
            onMouseLeave={() => setHighlightBodyId(null)}
          >
            <span
              className={styles.materialSwatch}
              style={{ background: matColor(prop.materialId) }}
            />
            <span className={styles.bodyLabel}>Body {prop.id}</span>
            <button
              className={`${styles.visBtn}${hidden ? ` ${styles.visBtnOff}` : ""}`}
              data-testid={`body-visibility-${prop.id}`}
              title={hidden ? "Show body" : "Hide body"}
              aria-pressed={hidden}
              onClick={() => toggleBodyVisibility(prop.id)}
            >
              {hidden ? EYE_OFF_ICON : EYE_ICON}
            </button>
            <select
              className={styles.formSelect}
              data-testid={`body-material-${prop.id}`}
              value={prop.materialId}
              onFocus={() => highlight(prop.id)}
              onBlur={() => setHighlightBodyId(null)}
              onChange={(e) =>
                assignBodyMaterial(prop.id, Number(e.target.value))
              }
            >
              {materials.map((mat) => (
                <option key={mat.id} value={mat.id}>
                  {mat.name}
                </option>
              ))}
            </select>
            <select
              className={styles.formSelect}
              data-testid={`body-type-${prop.id}`}
              title={ELEMENT_TYPE_TIP}
              value={prop.discretization ?? "solid"}
              onFocus={() => highlight(prop.id)}
              onBlur={() => setHighlightBodyId(null)}
              onChange={(e) =>
                setBodyDiscretization(
                  prop.id,
                  e.target.value as "shell" | "solid",
                )
              }
            >
              <option value="solid">Solid</option>
              <option value="shell">Shell</option>
            </select>
          </div>
        );
      })}

      <div className={styles.formRow} title={TIE_TIP}>
        <span className={styles.formLabel}>Tie distance</span>
        <input
          className={styles.formInput}
          type="number"
          min={0}
          step={0.5}
          value={tieDistance}
          data-testid="tie-distance"
          onChange={(e) => setTieDistance(Number(e.target.value))}
        />
        <span className={styles.toleranceUnit}>mm</span>
      </div>
    </>
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
          disabled={isImporting || isRunning}
          onClick={() => stepRef.current?.click()}
        >
          {STEP_CARD_ICON}
          <span className={styles.cardTitle}>
            {isImporting ? "Importing…" : "Import STEP"}
          </span>
          <span className={styles.cardSub}>.step / .stp</span>
        </button>

        <button
          className={styles.importCard}
          disabled={isImporting || isRunning}
          onClick={() => igesRef.current?.click()}
        >
          {IGES_CARD_ICON}
          <span className={styles.cardTitle}>
            {isImporting ? "Importing…" : "Import IGES"}
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

export function GeometryPanel() {
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <ImportSection />
        <MeshPanel />
        <MaterialSection />
      </div>
    </div>
  );
}
