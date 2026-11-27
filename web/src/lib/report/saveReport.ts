// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results → Save report (KOF-391): build the analysis report from the store
// and save it as one HTML file. Everything happens in this tab: the numbers
// come from the Rust module, the figures from the viewport's canvas, and the
// file goes to the browser's downloads. Analytics records that a report was
// saved, never what it says.

import { useModelStore } from "../../store/modelStore";
import { reportStats } from "../../wasm/fem/kofem_wasm.js";
import { loadFemModule } from "../femModule";
import { nodalResultValues } from "../resultField";
import { fieldLegend, reactionLegend } from "../legend";
import { APP_VERSION } from "../version";
import { track, workflowParams } from "../analytics";
import { captureViews, type FigureImage, type ReportFigures } from "./figures";
import { loadReportAssets } from "./assets";
import { buildReport, type ReportStats } from "./buildReport";
import { renderReport } from "./renderReport";
import { intlTag, tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";
import { resultFieldMessages } from "../../i18n/messages/results";

// The report's numbers from the nodal fields the app draws.
function stats(
  displacements: Float64Array,
  vonMises: Float64Array,
): ReportStats {
  const [maxDisplacement, , maxVonMises, p99VonMises] = reportStats(
    displacements,
    vonMises,
  );
  return { maxDisplacement, maxVonMises, p99VonMises };
}

export const reportFileName = (modelName: string): string =>
  `${modelName.replace(/[^\w-]+/g, "_")}-report.html`;

// The density figure, when there is an optimized layout: the current view
// switched to the density for the capture and back, so the static figures
// show the static result whichever the user was looking at.
async function captureFigures(withDensity: boolean): Promise<{
  figures: ReportFigures;
  density: FigureImage | null;
}> {
  const store = useModelStore;
  const shown = store.getState().activeResult;
  try {
    let density: FigureImage | null = null;
    if (withDensity) {
      store.setState({ activeResult: "density" });
      density = (await captureViews(false)).current;
    }
    store.setState({ activeResult: "static" });
    const { current, isometric } = await captureViews(true);
    if (isometric === null) throw new Error(tr(reportMessages).noViewport);
    return { figures: { current, isometric }, density };
  } finally {
    store.setState({ activeResult: shown });
  }
}

export async function saveReport(): Promise<void> {
  const text = tr(reportMessages);
  const state = useModelStore.getState();
  const { result, nodes, elements } = state;
  if (result === null) throw new Error(text.noResult);
  const vonMises = nodalResultValues(
    result,
    "Von Mises stress",
    nodes,
    elements,
    state.shellSurface,
  );
  if (vonMises === null) throw new Error(text.noStress);
  const legend = state.reactionsShown
    ? reactionLegend(result, state.reactionsDisplay)
    : (fieldLegend(
        result,
        state.resultType,
        nodes,
        elements,
        state.shellSurface,
        state.legendRange,
      )?.legend ?? null);
  if (legend === null) throw new Error(text.noStress);
  const [assets] = await Promise.all([loadReportAssets(), loadFemModule()]);
  const { densityResult } = state;
  const { figures, density } = await captureFigures(densityResult !== null);
  const doc = buildReport({
    modelName: state.modelName,
    createdAt: new Date().toLocaleString(intlTag(), {
      dateStyle: "long",
      timeStyle: "short",
    }),
    version: APP_VERSION,
    nodes,
    elements,
    properties: state.properties,
    materials: state.materials,
    bcGroups: state.bcGroups,
    loadGroups: state.loadGroups,
    temperature: state.temperature,
    meshSizes: state.meshSizes,
    result,
    stats: stats(result.displacements, vonMises),
    figures,
    assets,
    refinement: state.refinementStudy,
    topology:
      densityResult === null || density === null
        ? null
        : {
            result: densityResult,
            threshold: state.densityThreshold,
            figure: density,
          },
    legend,
    figureField: state.reactionsShown
      ? text.reactionArrows
      : tr(resultFieldMessages)[state.resultType],
  });
  const url = URL.createObjectURL(
    new Blob([renderReport(doc)], { type: "text/html" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = reportFileName(doc.modelName);
  anchor.click();
  URL.revokeObjectURL(url);
  track("report_saved", workflowParams());
}
