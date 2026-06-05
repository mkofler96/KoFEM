import { useModelStore } from "../../store/modelStore";
import styles from "./StatusBar.module.css";

type ViewRepr = "geometry" | "surface" | "volume" | "wireframe";

const REPR_BUTTONS: { id: ViewRepr; tooltip: string; icon: React.ReactNode }[] = [
  {
    id: "geometry",
    tooltip: "Shaded — smooth surface, no mesh edges",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path d="M8 2L13 5v6L8 14L3 11V5z" fill="currentColor" fillOpacity="0.25" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        <path d="M8 2L8 14M3 5l5 3.5M13 5l-5 3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "surface",
    tooltip: "Surface mesh — shaded with element edges",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path d="M8 2L13 5v6L8 14L3 11V5z" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        <path d="M3 5l5 3.5M13 5l-5 3.5M8 2l-3 5.5M8 2l3 5.5M3 11l5-2M13 11l-5-2" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "volume",
    tooltip: "Volume mesh — all tetrahedral edges",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path d="M8 2L13 5v6L8 14L3 11V5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        <path d="M3 5l5 3.5M13 5l-5 3.5M8 8.5L8 14M3 5l5 9M13 5l-5 9M3 11l5-2.5M13 11l-5-2.5" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "wireframe",
    tooltip: "Wireframe — edges only, no fill",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" width="13" height="13">
        <path d="M8 2L13 5v6L8 14L3 11V5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
        <path d="M8 2L8 14M3 5l5 3.5M13 5l-5 3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeDasharray="2 1.5"/>
      </svg>
    ),
  },
];

export function StatusBar() {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const constraints = useModelStore((s) => s.constraints);
  const loads = useModelStore((s) => s.loads);
  const result = useModelStore((s) => s.result);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const pickMode = useModelStore((s) => s.pickMode);
  const viewRepr = useModelStore((s) => s.viewRepr);
  const setViewRepr = useModelStore((s) => s.setViewRepr);
  const volMesh = useModelStore((s) => s.volMesh);
  const stepSurface = useModelStore((s) => s.stepSurface);

  const hasGeometry = nodes.length > 0 || !!stepSurface;
  const hasSurface = nodes.length > 0;
  const hasVolume = !!volMesh;

  function isDisabled(id: ViewRepr) {
    if (id === "geometry" || id === "wireframe") return !hasGeometry;
    if (id === "surface") return !hasSurface;
    if (id === "volume") return !hasVolume;
    return false;
  }

  const hexCount = elements.filter((e) => e.type === "CHEXA").length;
  const tetCount = elements.filter((e) => e.type === "CTETRA").length;
  const meshOk = nodes.length > 0;

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
            {pickMode === "bc"
              ? "Pick face — fixed displacement"
              : "Pick face — apply load"}
          </span>
        )}

        {selectedFace && !pickMode && (
          <span className={styles.selChip}>Selected: {selectedFace.label}</span>
        )}

        {nodes.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{nodes.length} nodes</span>
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
              {new Set(constraints.map((c) => c.nodeId)).size} nodes fixed
            </span>
          </>
        )}

        {loads.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{loads.length} load DOFs</span>
          </>
        )}
      </div>

      {/* Center — repr toolbar */}
      <div className={styles.reprGroup}>
        {REPR_BUTTONS.map(({ id, tooltip, icon }, i) => (
          <button
            key={id}
            disabled={isDisabled(id)}
            onClick={() => setViewRepr(id)}
            className={`${styles.reprBtn} ${viewRepr === id ? styles.reprBtnActive : ""}`}
            data-tooltip={tooltip}
            style={{ borderLeft: i > 0 ? "1px solid #e2e5ea" : "none" }}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Right */}
      <div className={styles.right}>
        {result ? (
          <span className={styles.resultChip}>
            <span className={styles.okDot} />
            Solved · converged
          </span>
        ) : meshOk ? (
          <span className={styles.meshChip}>
            <span className={styles.okDot} />
            Mesh OK
          </span>
        ) : null}
        <span className={styles.muted}>m · N · Pa · v0.4.1</span>
      </div>
    </div>
  );
}
