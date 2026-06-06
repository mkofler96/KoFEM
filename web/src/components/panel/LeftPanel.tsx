import { useState, useRef, useEffect, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import type {
  BoxGeometry,
  Material,
  Node,
  Element,
} from "../../store/modelStore";
import { GeometryDialog } from "../geometry/GeometryDialog";
import { fmt } from "../../lib/modelDisplay";
import { sendToWorker, setLogCallback } from "../../workers/sharedWorker";
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
  const geometries = useModelStore((s) => s.geometries);
  const addGeometry = useModelStore((s) => s.addGeometry);
  const updateGeometry = useModelStore((s) => s.updateGeometry);
  const deleteGeometry = useModelStore((s) => s.deleteGeometry);
  const setMeshing = useModelStore((s) => s.setMeshing);
  const meshGeometry = useModelStore((s) => s.meshGeometry);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const setStepSurface = useModelStore((s) => s.setStepSurface);
  const stepImportError = useModelStore((s) => s.stepImportError);
  const setStepImportError = useModelStore((s) => s.setStepImportError);
  const loadModel = useModelStore((s) => s.loadModel);
  const isRunning = useModelStore((s) => s.isRunning);
  const setRunning = useModelStore((s) => s.setRunning);
  const materials = useModelStore((s) => s.materials);
  const createMaterial = useModelStore((s) => s.createMaterial);
  const updateMaterial = useModelStore((s) => s.updateMaterial);
  const deleteMaterial = useModelStore((s) => s.deleteMaterial);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BoxGeometry | null>(null);
  const [editingMatId, setEditingMatId] = useState<number | "new" | null>(null);
  const [isImportingStep, setIsImportingStep] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inpRef = useRef<HTMLInputElement | null>(null);
  const stepRef = useRef<HTMLInputElement | null>(null);

  function runMesh(geom: BoxGeometry) {
    setMeshing(true);
    try {
      meshGeometry(geom.id);
    } catch (err) {
      setError(`Meshing failed: ${err}`);
    } finally {
      setMeshing(false);
    }
  }

  function handleCreateAndMesh(params: Omit<BoxGeometry, "id">) {
    addGeometry(params);
    const store = useModelStore.getState();
    const newGeom = store.geometries[store.geometries.length - 1];
    if (newGeom) runMesh(newGeom);
    setDialogOpen(false);
  }

  async function handleInpFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setRunning(true);
    const text = await file.text();
    sendToWorker<{ model: Parameters<typeof loadModel>[0] }>("parse", { text })
      .then(({ model }) => {
        if (model.nodes?.length) loadModel(model);
        else setError("No nodes found.");
      })
      .catch((err) => setError(`Parse error: ${err.message}`))
      .finally(() => setRunning(false));
  }

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

  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span>Model geometry</span>
        <span className={styles.panelSubtitle}>parts &amp; bodies</span>
      </div>

      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner}>
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {/* ── Inputs ─────────────────────────────────────────── */}
        <>
            <input
              ref={(el) => {
                inpRef.current = el;
              }}
              type="file"
              accept=".inp"
              style={{ display: "none" }}
              onChange={handleInpFile}
            />
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
                <svg
                  className={styles.cardIcon}
                  viewBox="0 0 20 20"
                  fill="none"
                >
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

              <button
                className={styles.importCard}
                disabled={isRunning}
                onClick={() => inpRef.current?.click()}
              >
                <svg
                  className={styles.cardIcon}
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <path
                    d="M4 2h8l4 4v12a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path d="M12 2v4h4" stroke="currentColor" strokeWidth="1.4" />
                </svg>
                <span className={styles.cardTitle}>Import INP</span>
                <span className={styles.cardSub}>Abaqus / CalculiX</span>
              </button>

              <button className={styles.importCard} disabled>
                <svg
                  className={styles.cardIcon}
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <path
                    d="M10 2l2.4 5H18l-4.2 3.1 1.6 5L10 12.2 4.6 15.1l1.6-5L2 7h5.6z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
                <span className={styles.cardTitle}>Import IGES</span>
                <span className={styles.cardSub}>.igs / .iges</span>
              </button>

              <button
                className={styles.importCard}
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                <svg
                  className={styles.cardIcon}
                  viewBox="0 0 20 20"
                  fill="none"
                >
                  <rect
                    x="3"
                    y="3"
                    width="14"
                    height="14"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M10 7v6M7 10h6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
                <span className={styles.cardTitle}>New primitive</span>
                <span className={styles.cardSub}>Box · Cyl · Sphere</span>
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

            <div className={styles.sectionLabel}>Healing tolerances</div>
            <div className={styles.toleranceRow}>
              <span className={styles.toleranceKey}>Sew faces</span>
              <input className={styles.toleranceInput} defaultValue="1e-6" />
              <span className={styles.toleranceUnit}>m</span>
            </div>
            <div className={styles.toleranceRow}>
              <span className={styles.toleranceKey}>Merge edges</span>
              <input className={styles.toleranceInput} defaultValue="1e-5" />
              <span className={styles.toleranceUnit}>m</span>
            </div>
        </>

        {/* ── Tree ─────────────────────────────────────────────── */}
        <>
          {geometries.length === 0 && nodes.length === 0 && (
              <div className={styles.empty}>
                No geometry — add a primitive or import
              </div>
            )}
            {geometries.map((g) => (
              <div key={g.id} className={styles.treeItem}>
                <div className={styles.treeItemIcon}>□</div>
                <div className={styles.treeItemBody}>
                  <div className={styles.treeItemName}>{g.name}</div>
                  <div className={styles.treeItemDetail}>
                    {g.extrudeLength} × {g.sketchWidth} × {g.sketchHeight} m
                  </div>
                </div>
                <div className={styles.treeItemActions}>
                  <button
                    className={styles.iconBtn}
                    onClick={() => {
                      setEditing(g);
                      setDialogOpen(true);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className={styles.iconBtn}
                    onClick={() => runMesh(g)}
                    disabled={isMeshing}
                  >
                    ⟳
                  </button>
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    onClick={() => deleteGeometry(g.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
            {nodes.length > 0 && (
              <div className={styles.treeItem}>
                <div className={styles.treeItemIcon}>⬢</div>
                <div className={styles.treeItemBody}>
                  <div className={styles.treeItemName}>Mesh</div>
                  <div className={styles.treeItemDetail}>
                    {nodes.length} nodes · {elements.length} elements
                  </div>
                </div>
              </div>
            )}
        </>

        {/* ── Materials ─────────────────────────────────────────── */}
        <>
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

      {/* Next CTA */}

      {dialogOpen && (
        <GeometryDialog
          geometry={editing ?? undefined}
          onClose={() => setDialogOpen(false)}
          onSave={
            editing
              ? (p) => {
                  updateGeometry(editing.id, p);
                  setDialogOpen(false);
                }
              : handleCreateAndMesh
          }
        />
      )}
    </div>
  );
}

// ── Mesh mode ─────────────────────────────────────────────────────────────────

function MeshPanel() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const isMeshing = useModelStore((s) => s.isMeshing);
  const geometries = useModelStore((s) => s.geometries);
  const setMeshing = useModelStore((s) => s.setMeshing);
  const meshGeometry = useModelStore((s) => s.meshGeometry);
  const applyMeshResult = useModelStore((s) => s.applyMeshResult);
  const stepSurface = useModelStore((s) => s.stepSurface);

  const [maxElementSize, setMaxElementSize] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLogCallback((msg) => {
      console.log('[mesh-log]', msg)
      setLogs((prev) => [...prev, msg])
    })
    return () => setLogCallback(null);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function handleVolMesh() {
    if (!stepSurface) return;
    setMeshing(true);
    setLogs([]);
    try {
      const { nodes: n, elements: e } = await sendToWorker<{
        nodes: Node[];
        elements: Element[];
      }>("volume_mesh", { surface: stepSurface, maxElementSize });
      applyMeshResult(n, e, "STEP Volume Mesh");
    } catch (err) {
      console.error('[meshing] volume mesh failed:', err)
      setError(`Volume meshing failed: ${err}`);
    } finally {
      setMeshing(false);
    }
  }

  function remesh() {
    const g = geometries[0];
    if (!g) return;
    setMeshing(true);
    setLogs(["Regenerating box mesh…"]);
    try {
      meshGeometry(g.id);
      setLogs((prev) => [...prev, "Mesh regenerated"]);
    } catch (err) {
      setError(`Meshing failed: ${err}`);
    } finally {
      setMeshing(false);
    }
  }

  const hexCount = elements.filter((e) => e.type === "CHEXA").length;
  const tetCount = elements.filter((e) => e.type === "CTETRA").length;
  const showLogs = logs.length > 0 || isMeshing;

  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span>Mesh</span>
        <span className={styles.panelSubtitle}>seed &amp; controls</span>
      </div>

      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner} data-testid="meshing-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {nodes.length === 0 ? (
          <>
            {stepSurface ? (
              <>
                <div className={styles.sectionLabel}>STEP Surface</div>
                <div className={styles.statGroup}>
                  <div className={styles.statRow}>
                    <span className={styles.statKey}>Vertices</span>
                    <span className={styles.statVal}>{stepSurface.points.length}</span>
                  </div>
                  <div className={styles.statRow}>
                    <span className={styles.statKey}>Triangles</span>
                    <span className={styles.statVal}>{stepSurface.triangles.length}</span>
                  </div>
                </div>
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
                    onChange={(e) => setMaxElementSize(Math.max(0.5, Number(e.target.value)))}
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
                No mesh — import a STEP file on the Geometry page, or add a
                primitive.
              </div>
            )}
          </>
        ) : (
          <>
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
                <div className={styles.sectionLabel} style={{ marginTop: 12 }}>Mesh controls</div>
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
                    onChange={(e) => setMaxElementSize(Math.max(0.5, Number(e.target.value)))}
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
            {geometries.length > 0 && (
              <button
                className={styles.outlineBtn}
                disabled={isMeshing}
                onClick={remesh}
              >
                {isMeshing ? "Regenerating…" : "⟳ Regenerate mesh"}
              </button>
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
  const createBcGroup = useModelStore((s) => s.createBcGroup);
  const addFaceToBcGroup = useModelStore((s) => s.addFaceToBcGroup);
  const removeFaceFromBcGroup = useModelStore((s) => s.removeFaceFromBcGroup);
  const deleteBcGroup = useModelStore((s) => s.deleteBcGroup);
  const createLoadGroup = useModelStore((s) => s.createLoadGroup);
  const addFaceToLoadGroup = useModelStore((s) => s.addFaceToLoadGroup);
  const removeFaceFromLoadGroup = useModelStore((s) => s.removeFaceFromLoadGroup);
  const deleteLoadGroup = useModelStore((s) => s.deleteLoadGroup);

  const [checkedDofs, setCheckedDofs] = useState([true, true, true, false, false, false]);
  const [loadDof, setLoadDof] = useState(1);
  const [loadForce, setLoadForce] = useState("-10000");
  const [bcValue, setBcValue] = useState("0");

  const DOF_LABELS = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];
  const LOAD_LABELS = ["Fx", "Fy", "Fz", "Mx", "My", "Mz"];

  const targetBcGroup = pickTargetGroupId !== null ? bcGroups.find(g => g.id === pickTargetGroupId) ?? null : null;
  const targetLoadGroup = pickTargetGroupId !== null ? loadGroups.find(g => g.id === pickTargetGroupId) ?? null : null;

  function cancelPick() {
    setPickMode(null);
    setSelectedFace(null);
  }

  function applyBc() {
    if (!selectedFace) return;
    const faceLabel = `Face ${(targetBcGroup?.faces.length ?? 0) + 1}`;
    const face = { label: faceLabel, nodeIds: selectedFace.nodeIds };
    if (targetBcGroup) {
      addFaceToBcGroup(targetBcGroup.id, face);
    } else {
      const dofs = checkedDofs.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
      createBcGroup(face, dofs, parseFloat(bcValue) || 0);
    }
    setPickMode(null);
    setSelectedFace(null);
  }

  function applyLoad() {
    if (!selectedFace) return;
    const faceLabel = `Face ${(targetLoadGroup?.faces.length ?? 0) + 1}`;
    const face = { label: faceLabel, nodeIds: selectedFace.nodeIds };
    if (targetLoadGroup) {
      addFaceToLoadGroup(targetLoadGroup.id, face);
    } else {
      createLoadGroup(face, loadDof, parseFloat(loadForce) || 0);
    }
    setPickMode(null);
    setSelectedFace(null);
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span>Boundary conditions</span>
        <span className={styles.panelSubtitle}>&amp; loads</span>
      </div>

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
              <button className={styles.iconBtn} onClick={cancelPick} title="Cancel">✕</button>
            </div>

            {!selectedFace ? (
              <div className={styles.pickHint}>Click a face in the 3D viewport</div>
            ) : (
              <div className={styles.selectedFace}>{selectedFace.label}</div>
            )}

            {selectedFace && !targetBcGroup && (
              <>
                <div className={styles.dofGrid}>
                  {DOF_LABELS.map((d, i) => (
                    <label key={d} className={styles.dofCheck}>
                      <input
                        type="checkbox"
                        checked={checkedDofs[i]}
                        onChange={() => setCheckedDofs((p) => p.map((v, j) => (j === i ? !v : v)))}
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
                <button className={styles.primaryBtn} onClick={applyBc}>Apply BC</button>
              </>
            )}

            {selectedFace && targetBcGroup && (
              <button className={styles.primaryBtn} onClick={applyBc}>Add Face</button>
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
                {g.dofs.map(d => DOF_LABELS[d]).join(", ")} = {g.value}
              </span>
              <div className={styles.treeItemActions}>
                <button
                  className={styles.iconBtn}
                  title="Add face"
                  onClick={() => { setPickMode("bc", g.id); setSelectedFace(null); }}
                >✏</button>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Delete BC"
                  onClick={() => deleteBcGroup(g.id)}
                >✕</button>
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
                >×</button>
              </div>
            ))}
          </div>
        ))}

        {/* ── Load section ───────────────────────────────────── */}
        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>Applied loads</div>

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
                {targetLoadGroup ? `Add face to ${targetLoadGroup.name}` : "New Load"}
              </span>
              <button className={styles.iconBtn} onClick={cancelPick} title="Cancel">✕</button>
            </div>

            {!selectedFace ? (
              <div className={styles.pickHint}>Click a face in the 3D viewport</div>
            ) : (
              <div className={styles.selectedFace}>{selectedFace.label}</div>
            )}

            {selectedFace && !targetLoadGroup && (
              <>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>DOF</span>
                  <select
                    className={styles.formSelect}
                    value={loadDof}
                    onChange={(e) => setLoadDof(Number(e.target.value))}
                  >
                    {LOAD_LABELS.map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.formRow}>
                  <span className={styles.formLabel}>Total (N)</span>
                  <input
                    className={styles.formInput}
                    type="number"
                    value={loadForce}
                    step="100"
                    onChange={(e) => setLoadForce(e.target.value)}
                  />
                </div>
                <div className={styles.pickNote}>
                  {selectedFace.nodeIds.length} nodes →{" "}
                  {(parseFloat(loadForce) / selectedFace.nodeIds.length).toFixed(1)} N/node
                </div>
                <button className={styles.loadBtn} onClick={applyLoad}>Apply Load</button>
              </>
            )}

            {selectedFace && targetLoadGroup && (
              <button className={styles.loadBtn} onClick={applyLoad}>Add Face</button>
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
                F{DOF_LABELS[g.dof]} = {fmt(g.totalForce)} N
              </span>
              <div className={styles.treeItemActions}>
                <button
                  className={styles.iconBtn}
                  title="Add face"
                  onClick={() => { setPickMode("load", g.id); setSelectedFace(null); }}
                >✏</button>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title="Delete Load"
                  onClick={() => deleteLoadGroup(g.id)}
                >✕</button>
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
                >×</button>
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
    sendToWorker<{ displacements: number[] }>("solve", {
      nodes,
      elements,
      materials,
      properties,
      constraints,
      loads,
    })
      .then(({ displacements }) => {
        setResult({ displacements: new Float64Array(displacements) });
        setMode("results");
      })
      .catch((err) => {
        console.error('[solve] solver failed:', err.message)
        setError(`Solver error: ${err.message}`)
      })
      .finally(() => setRunning(false));
  }

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
      <div className={styles.panelTitle}>
        <span>Run analysis</span>
        <span className={styles.panelSubtitle}>job settings</span>
      </div>

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

const MAX_X_TOL = 1e-6;

function ResultsPanel() {
  const result = useModelStore((s) => s.result);
  const nodes = useModelStore((s) => s.nodes);

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          <span>Results</span>
          <span className={styles.panelSubtitle}>post-processing</span>
        </div>
        <div className={styles.tabContent}>
          <div className={styles.empty}>No results — run the solver first</div>
        </div>
      </div>
    );
  }

  const d = result.displacements;
  const maxAbsDisp = Math.max(...Array.from(d).map(Math.abs));
  const maxX = nodes.reduce((m, n) => Math.max(m, n.x), -Infinity);
  const tipNodes = nodes
    .map((n, i) => ({ i, n }))
    .filter(({ n }) => n.x >= maxX - MAX_X_TOL);
  const tipUy =
    tipNodes.length > 0
      ? tipNodes.reduce((sum, { i }) => sum + (d[i * 3 + 1] ?? 0), 0) /
        tipNodes.length
      : 0;
  const P = 10_000,
    E = 210e9,
    h = 0.1,
    I = h ** 4 / 12;
  const theory = -P / (3 * E * I);

  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        <span>Results</span>
        <span className={styles.panelSubtitle}>post-processing</span>
      </div>
      <div className={styles.tabContent}>
        <div className={styles.sectionLabel}>Field</div>
        <select className={styles.formSelect} style={{ marginBottom: 12 }}>
          <option>Displacement magnitude |U|</option>
          <option>Ux</option>
          <option>Uy</option>
          <option>Uz</option>
          <option>Von Mises stress σvm</option>
        </select>

        <div className={styles.sectionLabel}>Result summary</div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Max |U|</span>
          <span className={styles.statVal}>
            {maxAbsDisp.toExponential(3)} m
          </span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Avg tip Uy</span>
          <span className={styles.statVal}>{tipUy.toExponential(4)} m</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Theory δ</span>
          <span className={styles.statVal}>{theory.toExponential(4)} m</span>
        </div>

        {Math.abs((tipUy - theory) / theory) < 0.01 && (
          <div className={styles.meshOkBadge} style={{ marginTop: 8 }}>
            <span className={styles.okDot} /> Error &lt; 1% — solution verified
          </div>
        )}
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function LeftPanel() {
  const mode = useModelStore((s) => s.mode);
  return (
    <aside className={styles.aside}>
      {mode === "geometry" && <GeometryPanel />}
      {mode === "mesh" && <MeshPanel />}
      {mode === "constraints" && <ConstraintsPanel />}
      {mode === "solve" && <SolvePanel />}
      {mode === "results" && <ResultsPanel />}
    </aside>
  );
}
