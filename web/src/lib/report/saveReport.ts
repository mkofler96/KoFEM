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
import { captureFigures } from "./figures";
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

export async function saveReport(): Promise<void> {
  const text = tr(reportMessages);
  const state = useModelStore.getState();
  const { result, nodes, elements } = state;
  if (result === null) throw new Error(text.noResult);
  if (state.activeResult === "density" && state.densityResult !== null)
    throw new Error(text.densityShown);
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
  await loadFemModule();
  const figures = await captureFigures();
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
