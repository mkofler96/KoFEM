import { useState, useRef, type ChangeEvent } from "react";
import { useModelStore } from "../../store/modelStore";
import styles from "./WelcomeScreen.module.css";
import { sendToWorker } from "../../workers/sharedWorker";

export function WelcomeScreen() {
  const startWithExample = useModelStore((s) => s.startWithExample);

  const setStepSurface = useModelStore((s) => s.setStepSurface);
  const stepImportError = useModelStore((s) => s.stepImportError);
  const setStepImportError = useModelStore((s) => s.setStepImportError);
  const loadModel = useModelStore((s) => s.loadModel);
  const isRunning = useModelStore((s) => s.isRunning);
  const setRunning = useModelStore((s) => s.setRunning);

  const [isImportingStep, setIsImportingStep] = useState(false);
  const [inpError, setInpError] = useState<string | null>(null);

  const inpRef = useRef<HTMLInputElement | null>(null);
  const stepRef = useRef<HTMLInputElement | null>(null);

  async function handleInpFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setRunning(true);
    const text = await file.text();
    sendToWorker<{ model: Parameters<typeof loadModel>[0] }>("parse", { text })
      .then(({ model }) => {
        if (model.nodes?.length) loadModel(model);
        else setInpError("No nodes found.");
      })
      .catch((err) => setInpError(`Parse error: ${err.message}`))
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
    <div className={styles.backdrop}>
      <div className={styles.card}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.logoRow}>
            <div className={styles.logoMark}>K</div>
            <span className={styles.logoName}>KoFEM</span>
          </div>
          <p className={styles.tagline}>
            Finite element analysis · in your browser
          </p>
        </div>

        {/* Example button */}
        <button className={styles.exampleBtn} onClick={startWithExample}>
          <div className={styles.exampleIcon}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M6 3.5L11.5 8L6 12.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div className={styles.exampleText}>
            <span className={styles.exampleTitle}>Start with example</span>
            <span className={styles.exampleDesc}>
              Cantilever beam · 1.0 × 0.1 × 0.1 m · Steel · F<sub>y</sub> = −10
              kN
            </span>
          </div>
          <span className={styles.exampleBadge}>CHEXA8 · 75 N · 40 E</span>
        </button>

        {/* Divider */}
        <div className={styles.divider}>
          <span>or define a new model</span>
        </div>

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

          <button
            className={styles.importCard}
            disabled={isRunning}
            onClick={() => inpRef.current?.click()}
          >
            <svg className={styles.cardIcon} viewBox="0 0 20 20" fill="none">
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
          {/* setEditing(null); */}
        </div>

        {stepImportError && (
          <div
            data-testid="step-error"
            style={{ color: "#dc2626", fontSize: 12, padding: "4px 0" }}
          >
            {stepImportError}
          </div>
        )}
        {inpError && (
          <div
            data-testid="inp-error"
            style={{ color: "#dc2626", fontSize: 12, padding: "4px 0" }}
          >
            {inpError}
          </div>
        )}
      </div>
    </div>
  );
}
