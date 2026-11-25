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
import { useT } from "../../i18n/useLocale";
import { viewportMessages } from "../../i18n/messages/viewport";
import styles from "./SampleGuide.module.css";

type Step = Exclude<GuideStep, "done">;

const fy = `${SAMPLE.loadFy < 0 ? "−" : ""}${Math.abs(SAMPLE.loadFy)} N`;

type StepText = { title: string; how: string; action: string };

function stepTexts(
  text: (typeof viewportMessages)["en"],
): Record<Step, StepText> {
  return {
    mesh: {
      title: text.meshTitle,
      how: text.meshHow,
      action: text.meshAction,
    },
    support: {
      title: text.supportTitle,
      how: text.supportHow,
      action: text.supportAction,
    },
    load: {
      title: text.loadTitle,
      how: text.loadHow(fy),
      action: text.loadAction,
    },
    run: { title: text.runTitle, how: text.runHow, action: text.runAction },
  };
}

const sameSelection = (a: TreeSelection, b: TreeSelection) =>
  JSON.stringify(a) === JSON.stringify(b);

// The guide through the sample (KOF-261): a slim strip along the top of the
// viewport with the four steps of every analysis. Hovering (or focusing) a
// step says what to do; the current one has a shortcut to its panel.
// It follows the model, not clicks on it — a step is done when the model has
// it (lib/sampleGuide).
export function SampleGuide() {
  const step = useSampleGuideStep();
  const treeSelection = useModelStore((s) => s.treeSelection);
  const selectTreeNode = useModelStore((s) => s.selectTreeNode);
  const text = useT(viewportMessages);
  if (step === null) return null;
  const steps = stepTexts(text);

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
      aria-label={text.sampleGuide}
    >
      <span className={styles.title}>{text.sample}</span>
      <ol className={styles.steps}>
        {GUIDE_STEPS.map((s, i) => {
          const state =
            i < currentIndex ? "done" : i === currentIndex ? "current" : "todo";
          const stepText = steps[s];
          return (
            <li key={s} className={styles.step} data-state={state}>
              <span
                className={styles.chip}
                tabIndex={0}
                aria-describedby={`sample-guide-tip-${s}`}
                data-testid={
                  state === "current" ? "sample-guide-current" : undefined
                }
              >
                <span className={styles.marker} aria-hidden>
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className={styles.stepTitle}>{stepText.title}</span>
              </span>
              <span
                className={styles.tip}
                id={`sample-guide-tip-${s}`}
                role="tooltip"
              >
                {stepText.how}
              </span>
              {state === "current" &&
                !sameSelection(treeSelection, destination(s)) && (
                  <button
                    className={styles.action}
                    data-testid="sample-guide-action"
                    onClick={() => go(s)}
                  >
                    {stepText.action}
                  </button>
                )}
            </li>
          );
        })}
        {step === "done" && (
          <li className={styles.step} data-state="current">
            <span
              className={styles.chip}
              tabIndex={0}
              aria-describedby="sample-guide-tip-done"
              data-testid="sample-guide-done"
            >
              <span className={styles.stepTitle}>{text.done}</span>
            </span>
            <span
              className={styles.tip}
              id="sample-guide-tip-done"
              role="tooltip"
            >
              {text.doneTip}
            </span>
          </li>
        )}
      </ol>
      <button
        className={styles.close}
        title={text.closeGuide}
        aria-label={text.closeGuide}
        onClick={dismissSampleGuide}
      >
        ×
      </button>
    </section>
  );
}
