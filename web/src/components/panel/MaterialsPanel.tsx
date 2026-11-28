// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Material } from "../../store/modelStore";
import { isCadBody } from "../../store/geometrySlice";
import { pickMaterialColor } from "../../store/materialSlice";
import type { TreeTarget } from "../../store/viewSlice";
import { useT } from "../../i18n/useLocale";
import { materialsMessages } from "../../i18n/messages/materials";
import styles from "./Panel.module.css";

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
  // Form seeds for the "new material" dialog (`mat` undefined): structural
  // steel, shown in the editable fields and validated in handleSave before it
  // becomes a material. Nothing here reaches the solver unseen.
  /* eslint-disable kofem/no-silent-fallback -- prefilled form values the user sees and edits, not a substitute for missing solver data */
  const [name, setName] = useState(mat?.name ?? "Material");
  const [young, setYoung] = useState(String(mat?.young ?? 210000));
  const [poisson, setPoisson] = useState(String(mat?.poisson ?? 0.3));
  const [density, setDensity] = useState(String(mat?.density ?? 7.85e-9));
  const [color, setColor] = useState(mat?.color ?? defaultColor ?? "#4e79a7");
  /* eslint-enable kofem/no-silent-fallback */
  // α: blank for a material without one; a temperature change on it is then
  // refused at the solve.
  const [expansion, setExpansion] = useState(
    mat?.expansion === undefined ? "" : String(mat.expansion),
  );
  // Blank for a material without a yield strength; Results then show no
  // safety factor for it.
  const [yieldStrength, setYieldStrength] = useState(
    mat?.yieldStrength === undefined ? "" : String(mat.yieldStrength),
  );
  const [error, setError] = useState<string | null>(null);
  const text = useT(materialsMessages);

  function handleSave() {
    const youngModulus = parseFloat(young);
    const poissonRatio = parseFloat(poisson);
    const densityValue = parseFloat(density);

    if (!isFinite(youngModulus) || youngModulus <= 0) {
      setError(text.youngInvalid);
      return;
    }
    // ν must lie in (-1, 0.5); ν = 0 is physically valid (e.g. auxetic foams,
    // cork) and must not be silently replaced by the steel default.
    if (!isFinite(poissonRatio) || poissonRatio <= -1 || poissonRatio >= 0.5) {
      setError(text.poissonInvalid);
      return;
    }
    if (!isFinite(densityValue) || densityValue < 0) {
      setError(text.densityInvalid);
      return;
    }
    const expansionValue =
      expansion.trim() === "" ? undefined : Number(expansion);
    if (expansionValue !== undefined && !Number.isFinite(expansionValue)) {
      setError(text.expansionInvalid);
      return;
    }
    const yieldValue =
      yieldStrength.trim() === "" ? undefined : Number(yieldStrength);
    if (
      yieldValue !== undefined &&
      (!Number.isFinite(yieldValue) || yieldValue <= 0)
    ) {
      setError(text.yieldInvalid);
      return;
    }
    onSave({
      // eslint-disable-next-line kofem/no-silent-fallback -- label for a material the user left unnamed; cosmetic, the physical constants above are all validated
      name: name || "Material",
      young: youngModulus,
      poisson: poissonRatio,
      density: densityValue,
      // Always present, so clearing a field removes the saved α or σy.
      expansion: expansionValue,
      yieldStrength: yieldValue,
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
        <span className={styles.formLabel}>{text.name}</span>
        <input
          className={styles.formInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.colour}</span>
        <input
          className={styles.colorInput}
          type="color"
          value={color}
          data-testid="material-color"
          onChange={(e) => setColor(e.target.value)}
          title={text.colourTitle}
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
          title={text.densityTitle}
        />
      </div>
      <p className={styles.formNote}>{text.densityNote}</p>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>α (1/°C)</span>
        <input
          className={styles.formInput}
          type="number"
          value={expansion}
          step="1e-6"
          placeholder={text.expansionPlaceholder}
          data-testid="material-expansion"
          aria-label={text.expansionLabel}
          onChange={(e) => setExpansion(e.target.value)}
          title={text.expansionTitle}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>σy (MPa)</span>
        <input
          className={styles.formInput}
          type="number"
          value={yieldStrength}
          step="10"
          placeholder={text.expansionPlaceholder}
          data-testid="material-yield"
          aria-label={text.yieldLabel}
          onChange={(e) => setYieldStrength(e.target.value)}
          title={text.yieldTitle}
        />
      </div>
      <div className={styles.formBtns}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          {text.cancel}
        </button>
        <button className={styles.primaryBtn} onClick={handleSave}>
          {text.save}
        </button>
      </div>
    </div>
  );
}

// One material, opened from the model tree: its editor, the bodies made of it,
// and removal once nothing uses it.
function MaterialDetail({ id }: { id: number }) {
  const mat = useModelStore((s) => s.materials.find((m) => m.id === id));
  const materialCount = useModelStore((s) => s.materials.length);
  const properties = useModelStore((s) => s.properties);
  const updateMaterial = useModelStore((s) => s.updateMaterial);
  const deleteMaterial = useModelStore((s) => s.deleteMaterial);
  // Remount the form on save so its fields show the stored values again.
  const [revision, setRevision] = useState(0);
  const text = useT(materialsMessages);
  if (!mat) return null;

  const bodies = properties.filter(
    (p) => isCadBody(p) && p.materialId === mat.id,
  );
  const assigned = properties.some((p) => p.materialId === mat.id);
  return (
    <>
      <MaterialForm
        key={revision}
        mat={mat}
        onSave={(values) => {
          updateMaterial(mat.id, values);
          setRevision((r) => r + 1);
        }}
        onCancel={() => setRevision((r) => r + 1)}
      />
      <div className={styles.sectionLabel}>{text.usedBy}</div>
      {bodies.length === 0 ? (
        <div className={styles.empty}>{text.noBody}</div>
      ) : (
        bodies.map((p) => (
          <div key={p.id} className={styles.statRow}>
            <span className={styles.statKey}>Body {p.id}</span>
          </div>
        ))
      )}
      {materialCount > 1 && !assigned && (
        <button
          className={styles.outlineBtn}
          onClick={() => deleteMaterial(mat.id)}
        >
          {text.removeMaterial}
        </button>
      )}
    </>
  );
}

function NewMaterial() {
  const materials = useModelStore((s) => s.materials);
  const createMaterial = useModelStore((s) => s.createMaterial);
  const [revision, setRevision] = useState(0);
  return (
    <MaterialForm
      key={revision}
      defaultColor={pickMaterialColor(materials)}
      onSave={(values) => createMaterial(values)}
      onCancel={() => setRevision((r) => r + 1)}
    />
  );
}

// Materials (#317/#353): "+ Add" defines one, each entry edits one. Which
// body uses which material is set on the body (Geometry) — the body ↔
// material mapping made explicit, the confusion behind #275.
export function MaterialsPanel({ target }: { target: TreeTarget }) {
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {target.type === "add" && <NewMaterial />}
        {target.type === "item" && <MaterialDetail id={target.id} />}
      </div>
    </div>
  );
}
