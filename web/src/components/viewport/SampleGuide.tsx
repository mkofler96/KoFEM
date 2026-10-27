// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { studyOf } from "../../store/studySlice";
import {
  addSelection,
  itemSelection,
  type TreeSelection,
} from "../../store/viewSlice";
import {
  GUIDE_STEPS,
  SAMPLE,
  dismissSampleGuide,
  type GuideStep,
} from "../../lib/sampleGuide";
import { useSampleGuideStep } from "./useSampleGuideStep";
import styles from "./SampleGuide.module.css";

type Step = Exclude<GuideStep, "done">;

const fy = `${SAMPLE.loadFy < 0 ? "−" : ""}${Math.abs(SAMPLE.loadFy)} N`;

const STEP_TEXT: Record<Step, { title: string; how: string; action: string }> =
  {
    mesh: {
      title: "Mesh the part",
      how: "Fill the solid with elements: press Mesh STEP volume.",
      action: "Open mesh",
    },
    support: {
      title: "Fix the bolt holes",
      how: "Add a support, click the three highlighted holes, then Apply.",
      action: "Add support",
    },
    load: {
      title: "Load the hub",
      how: `Add a load, click the highlighted bore, set Fy = ${fy}, then Apply.`,
      action: "Add load",
    },
    run: {
      title: "Run the analysis",
      how: "Add a static study and press Run.",
      action: "Open study",
    },
  };

const sameSelection = (a: TreeSelection, b: TreeSelection) =>
  JSON.stringify(a) === JSON.stringify(b);

// The guide through the sample (KOF-261): the four steps of every analysis,
// the current one with what to do and a shortcut to the panel it happens in.
// It follows the model, not clicks on it — a step is done when the model has
// it (lib/sampleGuide).
export function SampleGuide() {
  const step = useSampleGuideStep();
  const treeSelection = useModelStore((s) => s.treeSelection);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  if (step === null) return null;

  // Where the current step happens, so the shortcut can take the user there.
  function destination(current: Step): TreeSelection {
    const { studies } = useModelStore.getState();
    if (current === "mesh") return addSelection("mesh");
    if (current === "support")
      return { group: "boundary", target: { type: "add", kind: "bc" } };
    if (current === "load")
      return { group: "boundary", target: { type: "add", kind: "load" } };
    const study = studyOf(studies, "static");
    return study
      ? itemSelection("studies", "study", study.id)
      : addSelection("studies");
  }

  function go(current: Step) {
    const store = useModelStore.getState();
    if (current === "run" && !studyOf(store.studies, "static")) {
      const id = store.addStudy("static");
      selectTreeNode(itemSelection("studies", "study", id));
      return;
    }
    selectTreeNode(destination(current));
  }

  const currentIndex =
    step === "done" ? GUIDE_STEPS.length : GUIDE_STEPS.indexOf(step);

  return (
    <section
      className={styles.guide}
      data-testid="sample-guide"
      data-step={step}
      aria-label="Sample guide"
    >
      <header className={styles.header}>
        <span className={styles.title}>Sample · wall bracket</span>
        <button
          className={styles.close}
          title="Close the guide"
          aria-label="Close the guide"
          onClick={dismissSampleGuide}
        >
          ×
        </button>
      </header>
      <ol className={styles.steps}>
        {GUIDE_STEPS.map((s, i) => {
          const state =
            i < currentIndex ? "done" : i === currentIndex ? "current" : "todo";
          const text = STEP_TEXT[s];
          return (
            <li key={s} className={styles.step} data-state={state}>
              <span className={styles.marker} aria-hidden>
                {state === "done" ? "✓" : i + 1}
              </span>
              <div className={styles.body}>
                <span className={styles.stepTitle}>{text.title}</span>
                {state === "current" && (
                  <>
                    <p className={styles.how}>{text.how}</p>
                    {!sameSelection(treeSelection, destination(s)) && (
                      <button
                        className={styles.action}
                        data-testid="sample-guide-action"
                        onClick={() => go(s)}
                      >
                        {text.action}
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {step === "done" && (
        <p className={styles.done} data-testid="sample-guide-done">
          Done. The colours show how far each point moves under the load. Try
          von Mises stress in the Results panel to see where the bracket works
          hardest.
        </p>
      )}
    </section>
  );
}
