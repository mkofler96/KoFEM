// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useRef, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Material } from "../../store/modelStore";
import { fmt } from "../../lib/modelDisplay";
import { useGeometry } from "../../hooks/useGeometry";
import { MeshPanel } from "./MeshPanel";
import styles from "./LeftPanel.module.css";

function MaterialForm({
  mat,
  onSave,
  onCancel,
}: {
  mat?: Material;
  onSave(v: Omit<Material, "id">): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(mat?.name ?? "Material");
  const [young, setYoung] = useState(String(mat?.young ?? 210000));
  const [poisson, setPoisson] = useState(String(mat?.poisson ?? 0.3));
  const [density, setDensity] = useState(String(mat?.density ?? 7.85e-9));
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    const e = parseFloat(young);
    const nu = parseFloat(poisson);
    const rho = parseFloat(density);

    if (!isFinite(e) || e <= 0) {
      setError("Young's modulus must be a positive number");
      return;
    }
    // ν must lie in (-1, 0.5); ν = 0 is physically valid (e.g. auxetic foams,
    // cork) and must not be silently replaced by the steel default.
    if (!isFinite(nu) || nu <= -1 || nu >= 0.5) {
      setError("Poisson's ratio must be in the range (-1, 0.5)");
      return;
    }
    if (!isFinite(rho) || rho < 0) {
      setError("Density must be a non-negative number");
      return;
    }
    onSave({ name: name || "Material", young: e, poisson: nu, density: rho });
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

// Single-part models carry exactly one material, applied to the whole part
// (issue #275). Per-body materials arrive with multibody support (issue #317),
// so materials cannot be added here; delete is offered only to trim legacy
// analyses saved with several.
function MaterialSection() {
  const materials = useModelStore((s) => s.materials);
  const updateMaterial = useModelStore((s) => s.updateMaterial);
  const deleteMaterial = useModelStore((s) => s.deleteMaterial);

  const [editingMatId, setEditingMatId] = useState<number | null>(null);

  return (
    <>
      <div className={styles.sectionLabel}>Material</div>
      {materials.length === 0 && (
        <div className={styles.empty}>No material</div>
      )}
      {materials.length > 1 && (
        <div
          className={styles.errorBanner}
          data-testid="material-count-warning"
        >
          <span>
            Only one material is supported — it is applied to the whole part.
            Remove the extra materials before solving.
          </span>
        </div>
      )}
      {materials.map((m) => (
        <div key={m.id}>
          <div className={styles.treeItem}>
            <div className={styles.treeItemBody}>
              <div className={styles.treeItemName}>{m.name}</div>
              <div className={styles.treeItemDetail}>
                E = {fmt(m.young, 3)} MPa · ν = {m.poisson}
              </div>
            </div>
            <div className={styles.treeItemActions}>
              <button
                className={styles.iconBtn}
                title="Edit material"
                onClick={() => setEditingMatId(m.id)}
              >
                ✎
              </button>
              {materials.length > 1 && (
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Remove material"
                  onClick={() => deleteMaterial(m.id)}
                >
                  ×
                </button>
              )}
            </div>
          </div>
          {editingMatId === m.id && (
            <MaterialForm
              mat={m}
              onSave={(v) => {
                updateMaterial(m.id, v);
                setEditingMatId(null);
              }}
              onCancel={() => setEditingMatId(null)}
            />
          )}
        </div>
      ))}
      {materials.length === 1 && (
        <div className={styles.empty}>Applied to the whole part.</div>
      )}
    </>
  );
}

export function GeometryPanel() {
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
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {/* ── Inputs ─────────────────────────────────────────── */}
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
              <svg className={styles.cardIcon} viewBox="0 0 20 20" fill="none">
                <path
                  d="M10 2l2.4 5H18l-4.2 3.1 1.6 5L10 12.2 4.6 15.1l1.6-5L2 7h5.6z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
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

        {/* ── Mesh ─────────────────────────────────────────────── */}
        <MeshPanel />

        {/* ── Material ──────────────────────────────────────────── */}
        <MaterialSection />
      </div>
    </div>
  );
}
