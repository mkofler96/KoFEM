// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report as one HTML file (KOF-391): inline CSS, the figures as
// data URLs, no script and no address to fetch, so it opens offline and
// prints to PDF from the browser. Test ids and data-* attributes carry the
// exact numbers for the e2e test.

import type { BodyRow, ReportDocument } from "./buildReport";
import { reportNumber } from "./buildReport";
import { LEGEND_GRADIENT, legendTicks, type Legend } from "../legend";
import { preconditionerLabel } from "../solve/amg";
import {
  reactionBalance,
  reactionComponent,
  type ReactionSummary,
  type Vec3,
} from "../solve/reactions";
import type { SolveRun } from "../../store/modelStore";
import { intlTag, tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";
import { resultsMessages } from "../../i18n/messages/results";

const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2937; background: #fff; }
main { max-width: 900px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 2px; }
h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 3px; border-bottom: 1px solid #d1d5db; break-after: avoid; }
p { margin: 4px 0; }
.meta { color: #6b7280; margin-bottom: 4px; }
.note { color: #6b7280; font-size: 12px; }
table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; break-inside: avoid; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
th { font-weight: 600; background: #f3f4f6; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.figures { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
figure { margin: 0; break-inside: avoid; }
.keep { break-inside: avoid; }
figure img { width: 100%; height: auto; border: 1px solid #d1d5db; border-radius: 4px; display: block; }
figcaption { color: #4b5563; font-size: 12px; margin-top: 4px; }
.legend { display: inline-flex; gap: 8px; padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 11px; color: #374151; break-inside: avoid; }
.legend-title { font-weight: 600; margin-bottom: 6px; }
.legend-bar { width: 16px; height: 160px; border: 1px solid #9ca3af; border-radius: 3px; }
.legend-ticks { display: flex; flex-direction: column; justify-content: space-between; height: 160px; font-variant-numeric: tabular-nums; line-height: 1; }
.balanced { color: #15803d; font-weight: 600; }
.imbalanced { color: #b91c1c; font-weight: 600; }
ul { margin: 4px 0; padding-left: 20px; }
@page { size: A4; margin: 14mm; }
@media print {
  body { padding: 0; font-size: 11px; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
@media (max-width: 600px) { .figures { grid-template-columns: 1fr; } body { padding: 16px; } }
`;

function table(
  heads: string[],
  rows: string[],
  { numeric = [] as number[], label = "" } = {},
): string {
  const head = heads
    .map(
      (h, i) =>
        `<th${numeric.includes(i) ? ' class="num"' : ""}>${escape(h)}</th>`,
    )
    .join("");
  return `<table${label ? ` aria-label="${escape(label)}"` : ""}><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

const cell = (value: string, attributes = "") =>
  `<td${attributes}>${escape(value)}</td>`;
const num = (value: string, attributes = "") =>
  `<td class="num"${attributes}>${escape(value)}</td>`;

function bodiesSection(bodies: BodyRow[]): string {
  const text = tr(reportMessages);
  const rows = bodies.map((body) => {
    const thickness =
      body.thickness === null ? "" : ` data-thickness="${body.thickness}"`;
    const { material } = body;
    return `<tr data-testid="report-body-${body.propertyId}" data-element="${body.family}"${thickness}>${[
      cell(body.name),
      cell(material.name),
      num(reportNumber(material.young)),
      num(reportNumber(material.poisson)),
      num(material.density.toExponential(3)),
      cell(body.elementType),
      num(body.elementCount.toLocaleString(intlTag())),
    ].join("")}</tr>`;
  });
  return `<h2>${escape(text.bodies)}</h2>${table(
    [
      text.body,
      text.material,
      "E (MPa)",
      "ν",
      `${text.density} (t/mm³)`,
      text.elementType,
      text.elements,
    ],
    rows,
    { numeric: [2, 3, 4, 6] },
  )}`;
}

function boundarySection(doc: ReportDocument): string {
  const text = tr(reportMessages);
  const faces = (list: string[]) => list.join(", ");
  const supports =
    doc.supports.length === 0
      ? `<p>${escape(text.none)}</p>`
      : table(
          [text.name, text.faces, text.heldDofs, `${text.prescribed} (mm)`],
          doc.supports.map(
            (s) =>
              `<tr>${cell(s.name)}${cell(faces(s.faces))}${cell(s.dofs)}${num(reportNumber(s.value))}</tr>`,
          ),
          { numeric: [3] },
        );
  const loadRows = doc.loads.map(
    (l) =>
      `<tr>${cell(l.name)}${cell(l.kind)}${cell(faces(l.faces))}${num(l.value)}</tr>`,
  );
  const loads =
    loadRows.length === 0 && doc.temperature === null
      ? `<p>${escape(text.none)}</p>`
      : (loadRows.length > 0
          ? table([text.name, text.kind, text.faces, text.value], loadRows, {
              numeric: [3],
            })
          : "") +
        (doc.temperature === null ? "" : `<p>${escape(doc.temperature)}</p>`);
  const total =
    doc.appliedTotal === null
      ? ""
      : `<p data-testid="report-applied-total" data-force="${doc.appliedTotal.join(",")}">${escape(text.totalApplied)}: ${escape(vectorText(doc.appliedTotal, "N"))}</p>`;
  return `<h2>${escape(text.supports)}</h2>${supports}<h2>${escape(text.loads)}</h2>${loads}${total}`;
}

const vectorText = (v: Vec3, unit: string) =>
  `(${v.map(reportNumber).join(", ")}) ${unit}`;

function meshSection(doc: ReportDocument): string {
  const text = tr(reportMessages);
  const tag = intlTag();
  const rows: [string, string][] = [
    [text.nodes, doc.mesh.nodes.toLocaleString(tag)],
    [text.elements, doc.mesh.elements.toLocaleString(tag)],
  ];
  if (doc.run !== null)
    rows.push([
      text.elementOrder,
      doc.run.elementOrder === 2 ? text.quadratic : text.linear,
    ]);
  for (const [label, size] of doc.mesh.sizes ?? [])
    rows.push([label, `${reportNumber(size)} mm`]);
  const body = rows.map(([k, v]) => `<tr>${cell(k)}${num(v)}</tr>`).join("");
  const sizesNote =
    doc.mesh.sizes === null
      ? `<p class="note">${escape(text.sizesNotRecorded)}</p>`
      : "";
  return `<h2>${escape(text.mesh)}</h2><table><tbody>${body}</tbody></table>${sizesNote}`;
}

function pathLabel(path: SolveRun["path"]): string {
  const text = tr(reportMessages);
  return {
    solid: text.pathSolid,
    shell: text.pathShell,
    coupled: text.pathCoupled,
    "auto-shell": text.pathAutoShell,
  }[path];
}

function solverSection(run: SolveRun | null): string {
  const text = tr(reportMessages);
  if (run === null)
    return `<h2>${escape(text.solver)}</h2><p data-testid="report-solver-path">${escape(text.runNotRecorded)}</p>`;
  return `<h2>${escape(text.solver)}</h2><table><tbody>
<tr>${cell(text.path)}<td data-testid="report-solver-path" data-path="${run.path}">${escape(pathLabel(run.path))}</td></tr>
<tr>${cell(text.preconditioner)}${cell(preconditionerLabel(run.preconditioner))}</tr>
</tbody></table>`;
}

function resultsSection(doc: ReportDocument): string {
  const text = tr(reportMessages);
  const row = (label: string, testId: string, value: number, unit: string) =>
    `<tr>${cell(label)}${num(`${value.toExponential(3)} ${unit}`, ` data-testid="${testId}" data-value="${value}"`)}</tr>`;
  return `<h2>${escape(text.results)}</h2><table><tbody>
${row(text.maxDisplacement, "report-max-displacement", doc.stats.maxDisplacement, "mm")}
${row(text.maxVonMises, "report-max-von-mises", doc.stats.maxVonMises, "MPa")}
${row(text.p99VonMises, "report-p99-von-mises", doc.stats.p99VonMises, "MPa")}
</tbody></table><p class="note">${escape(text.resultsNote)}</p>`;
}

const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

function reactionsSection(
  reactions: ReactionSummary | null,
  supportNames: string[],
): string {
  const text = tr(reportMessages);
  const results = tr(resultsMessages);
  const head = `<h2>${escape(text.reactions)}</h2>`;
  if (reactions === null)
    return `${head}<p>${escape(text.reactionsNotRecorded)}</p>`;
  const balance = reactionBalance(reactions);
  const scale = Math.max(
    norm(reactions.applied),
    ...reactions.supports.map((s) => norm(s.force)),
  );
  const cells = (v: Vec3) =>
    [...v, norm(v)].map((c) => num(reactionComponent(c, scale))).join("");
  const rows = reactions.supports.map(
    (s) =>
      `<tr>${cell(supportNames[s.support] ?? results.support(s.support + 1))}${
        s.vertices === 0
          ? `<td colspan="4">${escape(results.notInMesh)}</td>`
          : cells(s.force)
      }</tr>`,
  );
  rows.push(
    `<tr data-testid="report-reaction-sum" data-force="${balance.reaction.join(",")}">${cell(results.sumOfReactions)}${cells(balance.reaction)}</tr>`,
    `<tr>${cell(results.applied)}${cells(balance.applied)}</tr>`,
  );
  const offBy = norm(balance.difference);
  return `${head}<div class="keep">${table(
    [results.forcesCaption, "Fx", "Fy", "Fz", "|F|"],
    rows,
    { numeric: [1, 2, 3, 4], label: results.reactionForces },
  )}<p data-testid="report-balance" data-balanced="${balance.balanced}" class="${balance.balanced ? "balanced" : "imbalanced"}">${escape(
    balance.balanced
      ? results.balanced
      : results.offBy(reactionComponent(offBy, scale)),
  )}</p></div>`;
}

function legendHtml(legend: Legend): string {
  const ticks = legendTicks(legend)
    .map(({ label }) => `<span>${escape(label)}</span>`)
    .join("");
  return `<div class="legend" data-testid="report-legend"><div><div class="legend-title">${escape(legend.title)}</div><div style="display:flex;gap:6px"><div class="legend-bar" style="background:${LEGEND_GRADIENT}"></div><div class="legend-ticks">${ticks}</div></div></div></div>`;
}

function figuresSection(doc: ReportDocument): string {
  const text = tr(reportMessages);
  const figure = (testId: string, src: string, caption: string) =>
    `<figure><img data-testid="${testId}" src="${src}" alt="${escape(caption)}"><figcaption>${escape(caption)}</figcaption></figure>`;
  return `<h2>${escape(text.figures)}</h2><div class="figures">${figure(
    "report-figure-current",
    doc.figures.current,
    text.currentView(doc.figureField),
  )}${figure(
    "report-figure-iso",
    doc.figures.isometric,
    text.isometricView(doc.figureField),
  )}</div>${legendHtml(doc.legend)}`;
}

function warningsSection(run: SolveRun | null): string {
  const text = tr(reportMessages);
  const head = `<h2>${escape(text.warnings)}</h2>`;
  if (run === null) return `${head}<p>${escape(text.runNotRecorded)}</p>`;
  if (run.warnings.length === 0)
    return `${head}<p>${escape(text.noWarnings)}</p>`;
  return `${head}<ul data-testid="report-warnings">${run.warnings.map((w) => `<li>${escape(w)}</li>`).join("")}</ul>`;
}

export function renderReport(doc: ReportDocument): string {
  const text = tr(reportMessages);
  return `<!doctype html>
<html lang="${intlTag()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(`${text.title}: ${doc.modelName}`)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escape(text.title)}</h1>
<p class="meta" data-testid="report-model-name">${escape(doc.modelName)}</p>
<p class="meta">${escape(doc.created)}</p>
${resultsSection(doc)}
${figuresSection(doc)}
${reactionsSection(
  doc.reactions,
  doc.supports.map((s) => s.name),
)}
${bodiesSection(doc.bodies)}
${boundarySection(doc)}
${meshSection(doc)}
${solverSection(doc.run)}
${warningsSection(doc.run)}
</main>
</body>
</html>
`;
}
