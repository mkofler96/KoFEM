import { useState, useRef, useEffect, type ChangeEvent } from "react";
import { useModelStore, RESULT_TYPES } from "../../store/modelStore";
import type {
  AppMode,
  Material,
  Node,
  Element,
  ResultType,
} from "../../store/modelStore";
import { fmt } from "../../lib/modelDisplay";
import {
  computeResultRange,
  resultFieldSymbol,
  resultUnit,
} from "../../lib/resultField";
import {
  sendToWorker,
  setLogCallback,
  resetWorker,
} from "../../workers/sharedWorker";
import styles from "./LeftPanel.module.css";

// ── Geometry mode ─────────────────────────────────────────────────────────────

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
  const [young, setYoung] = useState(String(mat?.young ?? 210e9));
  const [poisson, setPoisson] = useState(String(mat?.poisson ?? 0.3));
  const [density, setDensity] = useState(String(mat?.density ?? 7850));
  return (
    <div className={styles.inlineForm}>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Name</span>
        <input
          className={styles.formInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>E (Pa)</span>
        <input
          className={styles.formInput}
          type="number"
          value={young}
          step="1e9"
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
        <span className={styles.formLabel}>ρ (kg/m³)</span>
        <input
          className={styles.formInput}
          type="number"
          value={density}
          step="100"
          onChange={(e) => setDensity(e.target.value)}
        />
      </div>
      <div className={styles.formBtns}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button
          className={styles.primaryBtn}
          onClick={() =>
            onSave({
              name: name || "Material",
              young: parseFloat(young) || 210e9,
              poisson: parseFloat(poisson) || 0.3,
              density: parseFloat(density) || 7850,
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

function GeometryPanel() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const setStepSurface = useModelStore((s) => s.setStepSurface);
  const stepImportError = useModelStore((s) => s.stepImportError);
  const setStepImportError = useModelStore((s) => s.setStepImportError);
  const isRunning = useModelStore((s) => s.isRunning);
  const setRunning = useModelStore((s) => s.setRunning);
  const materials = useModelStore((s) => s.materials);
  const createMaterial = useModelStore((s) => s.createMaterial);
  const updateMaterial = useModelStore((s) => s.updateMaterial);
  const deleteMaterial = useModelStore((s) => s.deleteMaterial);
  const stepSurface = useModelStore((s) => s.stepSurface);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const setMeshing = useModelStore((s) => s.setMeshing);
  const applyMeshResult = useModelStore((s) => s.applyMeshResult);

  const [editingMatId, setEditingMatId] = useState<number | "new" | null>(null);
  const [isImportingStep, setIsImportingStep] = useState(false);
  const [maxElementSize, setMaxElementSize] = useState(20);
  // Floor for curvature-driven refinement; 0 lets Netgen refine fillets without
  // limit, which can produce >10x more elements than the max size suggests.
  const [minElementSize, setMinElementSize] = useState(2);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  const stepRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setLogCallback((msg) => {
      console.log("[mesh-log]", msg);
      setLogs((prev) => [...prev, msg]);
    });
    return () => setLogCallback(null);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function handleStepFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setStepImportError(null);
    setIsImportingStep(true);
    setRunning(true);
    const bytes = new Uint8Array(await file.arrayBuffer());
    sendToWorker<{
      points: [number, number, number][];
      triangles: [number, number, number][];
    }>("parse_step", { bytes })
      .then(({ points, triangles }) => {
        if (points.length === 0) setStepImportError("No geometry found.");
        else setStepSurface({ points, triangles });
      })
      .catch((err) => setStepImportError(err.message ?? "STEP import failed"))
      .finally(() => {
        setIsImportingStep(false);
        setRunning(false);
      });
  }

  async function handleVolMesh() {
    if (!stepSurface) return;
    setMeshing(true);
    setLogs([]);
    try {
      const {
        nodes: n,
        elements: e,
        surfaceTriangles,
        surfaceFaceIds,
      } = await sendToWorker<{
        nodes: Node[];
        elements: Element[];
        surfaceTriangles: [number, number, number][] | null;
        surfaceFaceIds: number[] | null;
      }>("volume_mesh", {
        surface: stepSurface,
        maxElementSize,
        minElementSize,
      });
      applyMeshResult(
        n,
        e,
        "STEP Volume Mesh",
        surfaceTriangles,
        surfaceFaceIds,
      );
      // Netgen's Ng_Init() installs global C++ state that contaminates the WASM
      // runtime for subsequent MFEM solves.  Resetting the worker here gives the
      // solve a clean module instance, preventing an infinite loop on first call.
      resetWorker();
    } catch (err) {
      console.error("[meshing] volume mesh failed:", err);
      setMeshError(`Volume meshing failed: ${err}`);
    } finally {
      setMeshing(false);
    }
  }

  const hexCount = elements.filter((e) => e.type === "CHEXA").length;
  const tetCount = elements.filter((e) => e.type === "CTETRA").length;
  const showLogs = logs.length > 0 || isMeshing;

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
            onChange={handleStepFile}
          />

          <div className={styles.cardGrid}>
            <button
              className={styles.importCard}
              disabled={isImportingStep || isRunning}
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
                {isImportingStep ? "Importing…" : "Import STEP"}
              </span>
              <span className={styles.cardSub}>.step / .stp</span>
            </button>

            <button className={styles.importCard} disabled>
              <svg className={styles.cardIcon} viewBox="0 0 20 20" fill="none">
                <path
                  d="M10 2l2.4 5H18l-4.2 3.1 1.6 5L10 12.2 4.6 15.1l1.6-5L2 7h5.6z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
              <span className={styles.cardTitle}>Import IGES</span>
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
        <>
          {meshError && (
            <div className={styles.errorBanner} data-testid="meshing-error">
              <span>{meshError}</span>
              <button onClick={() => setMeshError(null)}>×</button>
            </div>
          )}

          {nodes.length === 0 ? (
            stepSurface ? (
              <>
                <div className={styles.sectionLabel}>Mesh controls</div>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>Max element size</span>
                  <input
                    className={styles.formInput}
                    type="number"
                    min={0.5}
                    max={500}
                    step={0.5}
                    value={maxElementSize}
                    disabled={isMeshing}
                    onChange={(e) =>
                      setMaxElementSize(Math.max(0.5, Number(e.target.value)))
                    }
                  />
                  <span className={styles.toleranceUnit}>mm</span>
                </div>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>Min element size</span>
                  <input
                    className={styles.formInput}
                    type="number"
                    min={0}
                    max={500}
                    step={0.5}
                    value={minElementSize}
                    disabled={isMeshing}
                    onChange={(e) =>
                      setMinElementSize(Math.max(0, Number(e.target.value)))
                    }
                  />
                  <span className={styles.toleranceUnit}>mm</span>
                </div>
                <button
                  className={styles.meshVolBtn}
                  disabled={isMeshing}
                  onClick={handleVolMesh}
                >
                  {isMeshing ? "Meshing…" : "▶  Mesh STEP volume"}
                </button>
              </>
            ) : (
              <div className={styles.empty}>
                No mesh — import a STEP file to mesh.
              </div>
            )
          ) : (
            <>
              <div className={styles.sectionLabel}>Mesh</div>
              <div className={styles.statGroup}>
                <div className={styles.statRow}>
                  <span className={styles.statKey}>Nodes</span>
                  <span className={styles.statVal}>{nodes.length}</span>
                </div>
                <div className={styles.statRow}>
                  <span className={styles.statKey}>Elements</span>
                  <span className={styles.statVal}>{elements.length}</span>
                </div>
                {hexCount > 0 && (
                  <div className={styles.statRow}>
                    <span className={styles.statKey}>CHEXA</span>
                    <span className={styles.statVal}>{hexCount}</span>
                  </div>
                )}
                {tetCount > 0 && (
                  <div className={styles.statRow}>
                    <span className={styles.statKey}>CTETRA</span>
                    <span className={styles.statVal}>{tetCount}</span>
                  </div>
                )}
              </div>

              <div className={styles.meshOkBadge}>
                <span className={styles.okDot} />
                Mesh is solver-ready
              </div>

              {stepSurface && (
                <>
                  <div
                    className={styles.sectionLabel}
                    style={{ marginTop: 12 }}
                  >
                    Mesh controls
                  </div>
                  <div className={styles.formRow}>
                    <span className={styles.formLabel}>Max element size</span>
                    <input
                      className={styles.formInput}
                      type="number"
                      min={0.5}
                      max={500}
                      step={0.5}
                      value={maxElementSize}
                      disabled={isMeshing}
                      onChange={(e) =>
                        setMaxElementSize(Math.max(0.5, Number(e.target.value)))
                      }
                    />
                    <span className={styles.toleranceUnit}>mm</span>
                  </div>
                  <div className={styles.formRow}>
                    <span className={styles.formLabel}>Min element size</span>
                    <input
                      className={styles.formInput}
                      type="number"
                      min={0}
                      max={500}
                      step={0.5}
                      value={minElementSize}
                      disabled={isMeshing}
                      onChange={(e) =>
                        setMinElementSize(Math.max(0, Number(e.target.value)))
                      }
                    />
                    <span className={styles.toleranceUnit}>mm</span>
                  </div>
                  <button
                    className={styles.outlineBtn}
                    disabled={isMeshing}
                    onClick={handleVolMesh}
                  >
                    {isMeshing ? "Meshing…" : "⟳ Re-mesh STEP volume"}
                  </button>
                </>
              )}
            </>
          )}

          {/* VSCode-style collapsable log panel */}
          {showLogs && (
            <div className={styles.logSection}>
              <button
                className={styles.logHeader}
                onClick={() => setLogsOpen((v) => !v)}
              >
                <span
                  className={`${styles.logChevron} ${logsOpen ? styles.logChevronOpen : ""}`}
                >
                  ▶
                </span>
                <span>LOGS</span>
                {isMeshing && <span className={styles.logSpinner}>●</span>}
                {logs.length > 0 && (
                  <span className={styles.logBadge}>{logs.length}</span>
                )}
              </button>
              {logsOpen && (
                <div className={styles.logBody}>
                  {logs.length === 0 ? (
                    <div className={styles.logEmpty}>Waiting…</div>
                  ) : (
                    logs.map((line, i) => (
                      <div
                        key={i}
                        className={`${styles.logLine} ${i === logs.length - 1 ? styles.logLineLast : ""}`}
                      >
                        {line}
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              )}
            </div>
          )}
        </>

        {/* ── Materials ─────────────────────────────────────────── */}
        <>
          <div className={styles.sectionLabel}>Materials</div>
          {materials.length === 0 && (
            <div className={styles.empty}>No materials</div>
          )}
          {materials.map((m) => (
            <div key={m.id}>
              <div className={styles.treeItem}>
                <div className={styles.treeItemBody}>
                  <div className={styles.treeItemName}>{m.name}</div>
                  <div className={styles.treeItemDetail}>
                    E = {fmt(m.young, 3)} Pa · ν = {m.poisson}
                  </div>
                </div>
                <div className={styles.treeItemActions}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => setEditingMatId(m.id)}
                  >
                    ✎
                  </button>
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    onClick={() => deleteMaterial(m.id)}
                  >
                    ×
                  </button>
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
          {editingMatId === "new" && (
            <MaterialForm
              onSave={(v) => {
                createMaterial(v);
                setEditingMatId(null);
              }}
              onCancel={() => setEditingMatId(null)}
            />
          )}
          <button
            className={styles.outlineBtn}
            onClick={() => setEditingMatId("new")}
          >
            + Add material
          </button>
        </>
      </div>
    </div>
  );
}

// ── Constraints mode ──────────────────────────────────────────────────────────

function ConstraintsPanel() {
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const pickTargetGroupId = useModelStore((s) => s.pickTargetGroupId);
  const setPickMode = useModelStore((s) => s.setPickMode);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);
  const createBcGroup = useModelStore((s) => s.createBcGroup);
  const addFaceToBcGroup = useModelStore((s) => s.addFaceToBcGroup);
  const removeFaceFromBcGroup = useModelStore((s) => s.removeFaceFromBcGroup);
  const deleteBcGroup = useModelStore((s) => s.deleteBcGroup);
  const createLoadGroup = useModelStore((s) => s.createLoadGroup);
  const addFaceToLoadGroup = useModelStore((s) => s.addFaceToLoadGroup);
  const removeFaceFromLoadGroup = useModelStore(
    (s) => s.removeFaceFromLoadGroup,
  );
  const deleteLoadGroup = useModelStore((s) => s.deleteLoadGroup);

  const [checkedDofs, setCheckedDofs] = useState([
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  const [loadDof, setLoadDof] = useState(1);
  const [loadForce, setLoadForce] = useState("-10000");
  const [bcValue, setBcValue] = useState("0");

  const DOF_LABELS = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];
  const LOAD_LABELS = ["Fx", "Fy", "Fz", "Mx", "My", "Mz"];

  const targetBcGroup =
    pickTargetGroupId !== null
      ? (bcGroups.find((g) => g.id === pickTargetGroupId) ?? null)
      : null;
  const targetLoadGroup =
    pickTargetGroupId !== null
      ? (loadGroups.find((g) => g.id === pickTargetGroupId) ?? null)
      : null;

  const allPickedFaces = selectedFace
    ? [...pendingFaces, selectedFace]
    : pendingFaces;

  function removePickedFace(index: number) {
    if (index < pendingFaces.length) {
      setPendingFaces(pendingFaces.filter((_, i) => i !== index));
    } else {
      setSelectedFace(null);
    }
  }

  function cancelPick() {
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  function applyBc() {
    if (allPickedFaces.length === 0) return;
    const existingCount = targetBcGroup?.faces.length ?? 0;
    const faceEntries = allPickedFaces.map((f, i) => ({
      label: `Face ${existingCount + i + 1}`,
      nodeIds: f.nodeIds,
    }));
    if (targetBcGroup) {
      for (const fe of faceEntries) addFaceToBcGroup(targetBcGroup.id, fe);
    } else {
      const dofs = checkedDofs
        .map((c, i) => (c ? i : -1))
        .filter((i) => i >= 0);
      createBcGroup(faceEntries, dofs, parseFloat(bcValue) || 0);
    }
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  function applyLoad() {
    if (allPickedFaces.length === 0) return;
    const existingCount = targetLoadGroup?.faces.length ?? 0;
    const faceEntries = allPickedFaces.map((f, i) => ({
      label: `Face ${existingCount + i + 1}`,
      nodeIds: f.nodeIds,
    }));
    if (targetLoadGroup) {
      for (const fe of faceEntries) addFaceToLoadGroup(targetLoadGroup.id, fe);
    } else {
      createLoadGroup(faceEntries, loadDof, parseFloat(loadForce) || 0);
    }
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {/* ── BC section ────────────────────────────────────── */}
        <div className={styles.sectionLabel}>Fixed displacement</div>

        {pickMode !== "bc" && (
          <button
            className={styles.pickBtn}
            onClick={() => setPickMode("bc", null)}
          >
            + Add BC
          </button>
        )}

        {pickMode === "bc" && (
          <div className={styles.pickPanel}>
            <div className={styles.pickPanelHeader}>
              <span className={styles.pickPanelTitle}>
                {targetBcGroup ? `Add face to ${targetBcGroup.name}` : "New BC"}
              </span>
              <button
                className={styles.iconBtn}
                onClick={cancelPick}
                title="Cancel"
              >
                ✕
              </button>
            </div>

            {allPickedFaces.length === 0 ? (
              <div className={styles.pickHint}>
                Click a face in the 3D viewport
              </div>
            ) : (
              <div>
                {allPickedFaces.map((f, i) => (
                  <div key={i} className={styles.bcFaceRow}>
                    <span className={styles.bcFaceName}>{f.label}</span>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title="Remove face"
                      onClick={() => removePickedFace(i)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {allPickedFaces.length > 0 && !targetBcGroup && (
              <>
                <div className={styles.dofGrid}>
                  {/* Solid (H1 displacement) elements have only translational
                      DOFs — Ux, Uy, Uz. Rotational constraints carry no
                      stiffness and are not offered. */}
                  {DOF_LABELS.slice(0, 3).map((d, i) => (
                    <label key={d} className={styles.dofCheck}>
                      <input
                        type="checkbox"
                        checked={checkedDofs[i]}
                        onChange={() =>
                          setCheckedDofs((p) =>
                            p.map((v, j) => (j === i ? !v : v)),
                          )
                        }
                      />
                      {d}
                    </label>
                  ))}
                </div>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>Value</span>
                  <input
                    className={styles.formInput}
                    type="number"
                    value={bcValue}
                    step="0.001"
                    onChange={(e) => setBcValue(e.target.value)}
                  />
                </div>
                <button className={styles.primaryBtn} onClick={applyBc}>
                  Apply BC
                </button>
              </>
            )}

            {allPickedFaces.length > 0 && targetBcGroup && (
              <button className={styles.primaryBtn} onClick={applyBc}>
                {allPickedFaces.length === 1
                  ? "Add Face"
                  : `Add ${allPickedFaces.length} Faces`}
              </button>
            )}
          </div>
        )}

        {/* BC group list */}
        {bcGroups.map((g) => (
          <div key={g.id} className={styles.bcGroup}>
            <div className={styles.bcGroupHeader}>
              <span className={styles.bcDot} />
              <span className={styles.bcGroupName}>{g.name}</span>
              <span className={styles.bcGroupMeta}>
                {g.dofs.map((d) => DOF_LABELS[d]).join(", ")} = {g.value}
              </span>
              <div className={styles.treeItemActions}>
                <button
                  className={styles.iconBtn}
                  title="Add face"
                  onClick={() => {
                    setPickMode("bc", g.id);
                    setSelectedFace(null);
                    setPendingFaces([]);
                  }}
                >
                  ✏
                </button>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Delete BC"
                  onClick={() => deleteBcGroup(g.id)}
                >
                  ✕
                </button>
              </div>
            </div>
            {g.faces.map((f) => (
              <div key={f.id} className={styles.bcFaceRow}>
                <span className={styles.bcFaceIndent}>└</span>
                <span className={styles.bcFaceName}>{f.label}</span>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Remove face"
                  onClick={() => removeFaceFromBcGroup(g.id, f.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}

        {/* ── Load section ───────────────────────────────────── */}
        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Applied loads
        </div>

        {pickMode !== "load" && (
          <button
            className={styles.pickBtn}
            onClick={() => setPickMode("load", null)}
          >
            + Add Load
          </button>
        )}

        {pickMode === "load" && (
          <div className={styles.pickPanel}>
            <div className={styles.pickPanelHeader}>
              <span className={styles.pickPanelTitle}>
                {targetLoadGroup
                  ? `Add face to ${targetLoadGroup.name}`
                  : "New Load"}
              </span>
              <button
                className={styles.iconBtn}
                onClick={cancelPick}
                title="Cancel"
              >
                ✕
              </button>
            </div>

            {allPickedFaces.length === 0 ? (
              <div className={styles.pickHint}>
                Click a face in the 3D viewport
              </div>
            ) : (
              <div>
                {allPickedFaces.map((f, i) => (
                  <div key={i} className={styles.bcFaceRow}>
                    <span className={styles.bcFaceName}>{f.label}</span>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title="Remove face"
                      onClick={() => removePickedFace(i)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {allPickedFaces.length > 0 && !targetLoadGroup && (
              <>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>DOF</span>
                  <select
                    className={styles.formSelect}
                    value={loadDof}
                    onChange={(e) => setLoadDof(Number(e.target.value))}
                  >
                    {LOAD_LABELS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>
                    {loadDof <= 2 ? "Total (N)" : "Total (N·m)"}
                  </span>
                  <input
                    className={styles.formInput}
                    type="number"
                    value={loadForce}
                    step="100"
                    onChange={(e) => setLoadForce(e.target.value)}
                  />
                </div>
                <div className={styles.pickNote}>
                  {allPickedFaces.reduce((s, f) => s + f.nodeIds.length, 0)}{" "}
                  nodes →{" "}
                  {loadDof <= 2
                    ? `${(parseFloat(loadForce) / allPickedFaces.reduce((s, f) => s + f.nodeIds.length, 0)).toFixed(1)} N/node`
                    : "distributed as equivalent nodal forces"}
                </div>
                <button className={styles.loadBtn} onClick={applyLoad}>
                  Apply Load
                </button>
              </>
            )}

            {allPickedFaces.length > 0 && targetLoadGroup && (
              <button className={styles.loadBtn} onClick={applyLoad}>
                {allPickedFaces.length === 1
                  ? "Add Face"
                  : `Add ${allPickedFaces.length} Faces`}
              </button>
            )}
          </div>
        )}

        {/* Load group list */}
        {loadGroups.map((g) => (
          <div key={g.id} className={styles.bcGroup}>
            <div className={styles.bcGroupHeader}>
              <span className={styles.loadDot} />
              <span className={styles.bcGroupName}>{g.name}</span>
              <span className={styles.bcGroupMeta}>
                {LOAD_LABELS[g.dof]} = {fmt(g.totalForce)}{" "}
                {g.dof <= 2 ? "N" : "N·m"}
              </span>
              <div className={styles.treeItemActions}>
                <button
                  className={styles.iconBtn}
                  title="Add face"
                  onClick={() => {
                    setPickMode("load", g.id);
                    setSelectedFace(null);
                    setPendingFaces([]);
                  }}
                >
                  ✏
                </button>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Delete Load"
                  onClick={() => deleteLoadGroup(g.id)}
                >
                  ✕
                </button>
              </div>
            </div>
            {g.faces.map((f) => (
              <div key={f.id} className={styles.bcFaceRow}>
                <span className={styles.bcFaceIndent}>└</span>
                <span className={styles.bcFaceName}>{f.label}</span>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Remove face"
                  onClick={() => removeFaceFromLoadGroup(g.id, f.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Solve mode ────────────────────────────────────────────────────────────────

function SolvePanel() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const isRunning = useModelStore((s) => s.isRunning);
  const setRunning = useModelStore((s) => s.setRunning);
  const setResult = useModelStore((s) => s.setResult);
  const setMode = useModelStore((s) => s.setMode);
  const [error, setError] = useState<string | null>(null);

  const meshOk = nodes.length > 0;
  const matOk = materials.length > 0;
  const bcOk = constraints.length > 0;
  const loadOk = loads.length > 0;
  const allOk = meshOk && matOk && bcOk && loadOk;

  function handleSolve() {
    setRunning(true);
    sendToWorker<{ displacements: number[]; vonMises: number[] }>("solve", {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads,
    })
      .then(({ displacements, vonMises }) => {
        setResult({
          displacements: new Float64Array(displacements),
          vonMises: vonMises ? new Float64Array(vonMises) : undefined,
        });
        setMode("results");
      })
      .catch((err) => {
        console.error("[solve] solver failed:", err.message);
        setError(`Solver error: ${err.message}`);
      })
      .finally(() => setRunning(false));
  }

  // Expose for Playwright E2E tests — allows bypassing the button's disabled-state
  // timing uncertainty in CI without requiring UI interaction.
  useEffect(() => {
    (
      window as Window & { __kofemTriggerSolve?: () => void }
    ).__kofemTriggerSolve = handleSolve;
  });

  const checks: [boolean, string][] = [
    [
      meshOk,
      `Mesh ready · ${nodes.length} nodes · ${elements.length} elements`,
    ],
    [
      matOk,
      materials.length > 0
        ? `Material assigned · ${materials[0].name} · E=${fmt(materials[0].young, 3)} Pa`
        : "No material assigned",
    ],
    [
      bcOk,
      bcOk
        ? `BCs applied · ${new Set(constraints.map((c) => c.nodeId)).size} nodes fixed`
        : "No boundary conditions",
    ],
    [
      loadOk,
      loadOk ? `Loads applied · ${loads.length} load DOFs` : "No loads applied",
    ],
  ];

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner}>
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        <div className={styles.sectionLabel}>Pre-flight check</div>
        {checks.map(([ok, label], i) => (
          <div key={i} className={styles.checkRow}>
            <span className={ok ? styles.checkOk : styles.checkFail}>
              {ok ? "✓" : "✗"}
            </span>
            <span className={styles.checkLabel}>{label}</span>
          </div>
        ))}

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Solver settings
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Step</span>
          <span className={styles.statVal}>Static · Step-1</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Solver</span>
          <span className={styles.statVal}>Direct</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Output</span>
          <span className={styles.statVal}>U, S, RF</span>
        </div>

        <button
          className={styles.solveBtn}
          disabled={!allOk || isRunning}
          onClick={handleSolve}
        >
          {isRunning ? "Solving…" : "▶  Run static solve"}
        </button>
      </div>
    </div>
  );
}

// ── Results mode ──────────────────────────────────────────────────────────────

function ResultsPanel() {
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const setResultType = useModelStore((s) => s.setResultType);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.tabContent}>
          <div className={styles.empty}>No results — run the solver first</div>
        </div>
      </div>
    );
  }

  // Min/max of the selected scalar field over all nodes — the same field and
  // node averaging used for the viewport coloring and colorbar legend.
  const stats = computeResultRange(result, resultType, nodes, elements);

  const fieldSymbol = resultFieldSymbol(resultType);
  const unit = resultUnit(resultType);

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.sectionLabel}>Field</div>
        <select
          className={styles.formSelect}
          style={{ marginBottom: 12 }}
          value={resultType}
          onChange={(e) => setResultType(e.target.value as ResultType)}
        >
          {RESULT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <div className={styles.sectionLabel}>Result summary</div>
        {stats ? (
          <>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Min {fieldSymbol}</span>
              <span className={styles.statVal}>
                {stats.min.toExponential(3)} {unit}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Max {fieldSymbol}</span>
              <span className={styles.statVal}>
                {stats.max.toExponential(3)} {unit}
              </span>
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            {resultType === "Von Mises stress"
              ? "Von Mises data not available — re-run the solver"
              : "No nodal data"}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────

const MODES: { id: AppMode; label: string }[] = [
  { id: "geometry", label: "Geometry" },
  { id: "constraints", label: "Constraints" },
  { id: "solve", label: "Solve" },
  { id: "results", label: "Results" },
];

function PanelNav() {
  const mode = useModelStore((s) => s.mode);
  const setMode = useModelStore((s) => s.setMode);
  const nodes = useModelStore((s) => s.nodes);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const result = useModelStore((s) => s.result);

  function isValid(m: AppMode): boolean {
    if (m === "geometry") return nodes.length > 0;
    if (m === "constraints") return constraints.length > 0 || loads.length > 0;
    if (m === "solve" || m === "results") return result !== null;
    return false;
  }

  return (
    <nav className={styles.modeNav}>
      {MODES.map(({ id, label }) => {
        const active = id === mode;
        const valid = isValid(id);
        return (
          <button
            key={id}
            className={`${styles.navTab} ${active ? styles.navTabActive : styles.navTabFuture}`}
            onClick={() => setMode(id)}
          >
            {valid ? (
              <span className={`${styles.navDot} ${styles.navDotDone}`}>
                <svg viewBox="0 0 8 8" width="5" height="5">
                  <path
                    d="M1.5 4L3 5.5L6.5 2"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    fill="none"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            ) : (
              <span className={styles.navDot} />
            )}
            <span className={styles.navTabLabel}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function LeftPanel() {
  const mode = useModelStore((s) => s.mode);
  return (
    <aside className={styles.aside}>
      <PanelNav />
      {mode === "geometry" && <GeometryPanel />}
      {mode === "constraints" && <ConstraintsPanel />}
      {mode === "solve" && <SolvePanel />}
      {mode === "results" && <ResultsPanel />}
    </aside>
  );
}
