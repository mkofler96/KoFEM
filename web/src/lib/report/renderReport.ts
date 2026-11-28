// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report as one HTML file (KOF-391): inline CSS and fonts, the
// figures as data URLs, no script and no address to fetch, so it opens
// offline and prints to PDF from the browser. It is set like a technical
// paper: STIX Two text, symbols and numbers in Computer Modern (MathML, see
// tex.ts), grid tables, numbered figures and tables, A4 pages with a footer.
// Each section is a block that print moves to the next page whole, and no
// table shares a row with a figure. Test ids and data-* attributes carry the
// exact numbers for the e2e test.

import { formatSafetyFactor } from "../safetyFactor";
import type {
  BodyRow,
  ReportDocument,
  ReportRefinement,
  ReportTopology,
} from "./buildReport";
import {
  DENSITY_GRADIENT,
  LEGEND_GRADIENT,
  legendTicks,
  type Legend,
} from "../legend";
import { preconditionerLabel } from "../solve/amg";
import {
  reactionBalance,
  reactionComponent,
  type ReactionSummary,
  type Vec3,
} from "../solve/reactions";
import type { SolveRun } from "../../store/modelStore";
import type { FigureImage } from "./figures";
import { scientificChart } from "./chart";
import { escapeHtml, tex } from "./tex";
import { intlTag, tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";
import { resultsMessages } from "../../i18n/messages/results";

const STYLE = `
:root{--a:#16181d;--chart:#26667f;--rl:#c9ced6;--lb:#f3f4f6;--f:"STIX Two Text","Times New Roman",serif;--hf:Caladea,Cambria,serif;--n:"KoFEM Math","Latin Modern Math",serif;color-scheme:light}
*{box-sizing:border-box}
html{background:#fff}
body{margin:0;color:#16181d;font:10pt/1.5 var(--f)}
main{max-width:178mm;margin:0 auto;padding:14mm 0}
.hd{display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:2.5px solid var(--a);padding-bottom:10px;margin-bottom:6px}
.hd .l{display:flex;gap:10px;align-items:center;min-width:0}
.hd .lo{width:36px;height:36px;flex:none}.hd .lo svg{width:100%;height:100%;display:block}
.hd .tt{font:700 1.55em/1.15 var(--hf)}.hd .st{color:#3f4650;overflow-wrap:anywhere}
.hd .hr{text-align:right;color:#5d6470;font-size:.85em;line-height:1.6;flex:none}
section.blk{break-inside:avoid;padding-top:10px}
h2{font:700 1.2em/1.3 var(--hf);color:var(--a);display:flex;align-items:center;gap:10px;margin:10px 0 6px;break-after:avoid}
h2:after{content:"";flex:1;height:1px;background:#dfe2e6}
p{margin:4px 0}
table{border-collapse:collapse;width:100%;font-size:inherit;color:inherit}
th,td{text-align:left;padding:4px 7px;vertical-align:top;border:1px solid var(--rl)}
thead th{font-weight:600;font-size:.9em;background:var(--lb)}
.n{text-align:right;white-space:nowrap}
.kv th{font-weight:400;color:#4b5563;width:42%}
math{font-family:"KoFEM Math",math;font-size:1.06em;math-style:normal}
.tcap{font-size:.9em;margin:8px 0 3px}.tcap b,figcaption b{font-family:var(--hf)}
.note{color:#5d6470;font-size:.9em}
.ok{color:#15803d}.bad{color:#b91c1c}
ul{margin:4px 0;padding-left:20px}
figure{margin:0;break-inside:avoid}
figcaption{font-size:.9em;margin-top:4px}
.ff{display:flex;gap:6px;align-items:flex-start}.ff img{flex:1;min-width:0;width:100%;height:auto}
.lg{flex:none;border:.5px solid #888;background:#fff;padding:3px 5px;font-size:6.8pt}
.lgt{font-weight:600;margin-bottom:2px;white-space:nowrap}
.lgb{display:flex;gap:4px}
.lgbar{position:relative;width:8px;height:84px}
.lgk{display:flex;flex-direction:column;justify-content:space-between;height:84px;line-height:1;font-family:var(--n)}
.cut{position:absolute;left:-3px;right:-3px;border-top:2px solid #d62728}
.lgc{margin-top:3px;color:#b91c1c;white-space:nowrap}
.figs{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.single{width:62%;margin:0 auto}
.chart{display:block;width:100%;height:auto;overflow:visible}
.chart text{font:10.5px "KoFEM Math",serif;fill:#16181d}
@page{size:A4;margin:16mm 16mm 20mm;
@bottom-left{content:FOOTER;font:8pt "STIX Two Text",serif;color:#6b7280}
@bottom-right{content:PAGE_OF;font:8pt "STIX Two Text",serif;color:#6b7280}}
@media print{main{max-width:none;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media (max-width:640px){main{padding:16px}.figs,.pair{grid-template-columns:1fr}.single{width:100%}.hd{flex-wrap:wrap}.hd .hr{text-align:left}}
`;

// A CSS string literal; < is escaped so text cannot close the style element.
const cssString = (value: string): string =>
  `"${value
    .replace(/[\\"]/g, "\\$&")
    .replace(/</g, "\\3c ")
    .replace(/[\n\r]/g, " ")}"`;

// "Page 2 of 5" as CSS content: the localized words around the counters.
function pageOfContent(): string {
  const words = tr(reportMessages).pageOf("\u0000", "\u0001");
  const [before, rest] = words.split("\u0000");
  const [between, after] = rest.split("\u0001");
  return [
    cssString(before),
    "counter(page)",
    cssString(between),
    "counter(pages)",
    after === "" ? "" : cssString(after),
  ]
    .filter(Boolean)
    .join(" ");
}

// Digits in groups of three with thin spaces, as SI writes numbers of five
// digits or more.
function grouped(digits: string): string {
  const [whole, fraction] = digits.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const bare = sign ? whole.slice(1) : whole;
  const spaced =
    bare.length > 4 ? bare.replace(/\B(?=(\d{3})+(?!\d))/g, " ") : bare;
  return `${sign}${spaced}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** A number in tex source: four significant digits, a power of ten when it
 *  is very small or very large. */
export function texNumber(value: number, digits: number): string {
  if (!Number.isFinite(value))
    throw new Error(`report: ${value} is not a number to print`);
  if (value === 0) return "0";
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -3 || exponent >= 6) {
    const [mantissa, power] = value.toExponential(digits - 1).split("e");
    return `${Number(mantissa)}×10^{${Number(power)}}`;
  }
  return grouped(String(Number(value.toPrecision(digits))));
}

// Four significant digits, as the report prints its numbers; five where
// refinement levels differ only in the fifth.
const sig4 = (value: number) => texNumber(value, 4);
const sig5 = (value: number) => texNumber(value, 5);
const count = (value: number) => grouped(String(value));
const math = (source: string) => tex(`$${source}$`);
// unit: upright symbols separated by spaces, as "N mm".
const withUnit = (value: string, unit: string) =>
  math(
    `${value}~${unit
      .split(" ")
      .map((symbol) => `\\u{${symbol}}`)
      .join("~")}`,
  );

// Numbered tables and figures, in the order the report shows them.
class Numbering {
  private tables = 0;
  private figures = 0;
  table(caption: string): string {
    const text = tr(reportMessages);
    return `<p class="tcap"><b>${escapeHtml(text.tableLabel(++this.tables))}</b> ${caption}</p>`;
  }
  figure(caption: string): string {
    const text = tr(reportMessages);
    return `<figcaption><b>${escapeHtml(text.figureLabel(++this.figures))}</b> ${caption}</figcaption>`;
  }
}

const block = (content: string, attributes = "") =>
  `<section class="blk"${attributes}>${content}</section>`;
const heading = (title: string) => `<h2>${tex(title)}</h2>`;

// heads are tex source; cells are HTML. numeric marks right-aligned columns.
function table(heads: string[], rows: string[][], numeric: number[] = []) {
  const cls = (i: number) => (numeric.includes(i) ? ' class="n"' : "");
  return `<table><thead><tr>${heads.map((h, i) => `<th${cls(i)}>${tex(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${row.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

// [label (tex source), value (HTML), attributes of the value cell].
type KvRow = [string, string, string?];
const kv = (rows: KvRow[]) =>
  `<table class="kv"><tbody>${rows
    .map(
      ([k, v, attributes = ""]) =>
        `<tr><th>${tex(k)}</th><td${attributes}>${v}</td></tr>`,
    )
    .join("")}</tbody></table>`;

function header(doc: ReportDocument): string {
  const text = tr(reportMessages);
  return `<header class="hd"><div class="l"><span class="lo">${doc.assets.logo}</span><div><div class="tt">${escapeHtml(text.title)}</div><div class="st" data-testid="report-model-name">${escapeHtml(doc.modelName)}</div></div></div><div class="hr">${escapeHtml(doc.date)}<br>KoFEM ${escapeHtml(doc.version)} · N, mm, MPa</div></header>`;
}

const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

function keyResults(doc: ReportDocument): string {
  const text = tr(reportMessages);
  const results = tr(resultsMessages);
  const value = (
    label: string,
    testId: string,
    v: number,
    unit: string,
  ): KvRow => [
    label,
    withUnit(sig4(v), unit),
    ` data-testid="${testId}" data-value="${v}"`,
  ];
  const { stats } = doc;
  const rows: KvRow[] = [
    value(
      text.maxDisplacement,
      "report-max-displacement",
      stats.maxDisplacement,
      "mm",
    ),
    value(text.maxVonMises, "report-max-von-mises", stats.maxVonMises, "MPa"),
    value(text.p99VonMises, "report-p99-von-mises", stats.p99VonMises, "MPa"),
  ];
  for (const row of doc.safety)
    for (const [label, id, factor] of [
      [text.safetyOnMax, "max", row.maxFactor],
      [text.safetyOnP99, "p99", row.p99Factor],
    ] as const)
      rows.push([
        label,
        `${escapeHtml(formatSafetyFactor(factor))} · ${escapeHtml(row.body)}`,
        ` data-testid="report-safety-${id}-${row.key}" data-value="${factor}"`,
      ]);
  if (doc.reactions !== null) {
    const balance = reactionBalance(doc.reactions);
    const scale = reactionScale(doc.reactions);
    rows.push([
      text.equilibrium,
      balance.balanced
        ? `<span class="ok">${escapeHtml(results.balanced)}</span>${tex(text.balancedDetail)}`
        : `<span class="bad">${escapeHtml(results.offBy(reactionComponent(norm(balance.difference), scale)))}</span>`,
      ` data-testid="report-balance" data-balanced="${balance.balanced}"`,
    ]);
  }
  return block(
    `${heading(text.results)}${kv(rows)}<p class="note">${escapeHtml(text.resultsNote)}</p>`,
  );
}

function legendBox(
  title: string,
  gradient: string,
  ticks: string[],
  cutoff: number | null = null,
  testId = "",
): string {
  const text = tr(reportMessages);
  const marker =
    cutoff === null
      ? ""
      : `<i class="cut" style="bottom:${cutoff * 100}%"></i>`;
  const cutoffLine =
    cutoff === null
      ? ""
      : `<div class="lgc" data-testid="report-density-cutoff" data-value="${cutoff}">${escapeHtml(text.cutoff(cutoff.toFixed(2)))}</div>`;
  return `<div class="lg"${testId ? ` data-testid="${testId}"` : ""}><div class="lgt">${title}</div><div class="lgb"><div class="lgbar" style="background:${gradient}">${marker}</div><div class="lgk">${ticks
    .map((t) => `<span>${escapeHtml(t)}</span>`)
    .join("")}</div></div>${cutoffLine}</div>`;
}

const fieldLegendBox = (legend: Legend, testId = "") =>
  legendBox(
    escapeHtml(legend.title),
    LEGEND_GRADIENT,
    legendTicks(legend).map(({ label }) => label),
    null,
    testId,
  );

const image = (testId: string, figure: FigureImage, alt: string) =>
  `<img data-testid="${testId}" src="${figure.src}" width="${figure.width}" height="${figure.height}" alt="${escapeHtml(alt)}">`;

function staticFigures(doc: ReportDocument, numbering: Numbering): string {
  const text = tr(reportMessages);
  const figure = (
    testId: string,
    img: FigureImage,
    caption: string,
    legendId = "",
  ) =>
    `<figure><div class="ff">${image(testId, img, caption)}${fieldLegendBox(doc.legend, legendId)}</div>${numbering.figure(escapeHtml(caption))}</figure>`;
  return block(
    `<div class="figs">${figure(
      "report-figure-current",
      doc.figures.current,
      text.currentView(doc.figureField),
      "report-legend",
    )}${figure(
      "report-figure-iso",
      doc.figures.isometric,
      text.isometricView(doc.figureField),
    )}</div>`,
  );
}

function reactionScale(reactions: ReactionSummary): number {
  return Math.max(
    norm(reactions.applied),
    ...reactions.supports.map((s) => norm(s.force)),
  );
}

function reactionsSection(
  reactions: ReactionSummary | null,
  supportNames: string[],
  numbering: Numbering,
): string {
  const text = tr(reportMessages);
  const results = tr(resultsMessages);
  const head = heading(text.reactions);
  if (reactions === null)
    return block(`${head}<p>${escapeHtml(text.reactionsNotRecorded)}</p>`);
  const balance = reactionBalance(reactions);
  const scale = reactionScale(reactions);
  const cells = (v: Vec3) =>
    [...v, norm(v)]
      .map(
        (c) =>
          `<td class="n">${math(sig4(Number(reactionComponent(c, scale))))}</td>`,
      )
      .join("");
  const rows = reactions.supports.map(
    (s) =>
      `<tr><td>${escapeHtml(supportNames[s.support] ?? results.support(s.support + 1))}</td>${
        s.vertices === 0
          ? `<td colspan="4">${escapeHtml(results.notInMesh)}</td>`
          : cells(s.force)
      }</tr>`,
  );
  rows.push(
    `<tr data-testid="report-reaction-sum" data-force="${balance.reaction.join(",")}"><td>${tex(text.sumOfReactions)}</td>${cells(balance.reaction)}</tr>`,
    `<tr><td>${escapeHtml(results.applied)}</td>${cells(balance.applied)}</tr>`,
  );
  const heads = [
    text.support,
    "$F_x$ (N)",
    "$F_y$ (N)",
    "$F_z$ (N)",
    "$|F|$ (N)",
  ];
  return block(
    `${head}${numbering.table(escapeHtml(results.reactionForces))}<table aria-label="${escapeHtml(results.reactionForces)}"><thead><tr>${heads
      .map((h, i) => `<th${i > 0 ? ' class="n"' : ""}>${tex(h)}</th>`)
      .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
  );
}

function bodiesSection(bodies: BodyRow[], numbering: Numbering): string {
  const text = tr(reportMessages);
  const heads = [
    text.body,
    text.material,
    "$E$ (MPa)",
    "$ν$",
    "$ρ$ ($\\u{t}/\\u{mm}^3$)",
    text.elementType,
    text.elements,
  ];
  const rows = bodies.map((body) => {
    const thickness =
      body.thickness === null ? "" : ` data-thickness="${body.thickness}"`;
    const { material } = body;
    const cells = [
      escapeHtml(body.name),
      escapeHtml(material.name),
      math(sig4(material.young)),
      math(sig4(material.poisson)),
      math(sig4(material.density)),
      escapeHtml(body.elementType),
      math(count(body.elementCount)),
    ];
    const n = [2, 3, 4, 6];
    return `<tr data-testid="report-body-${body.propertyId}" data-element="${body.family}"${thickness}>${cells
      .map((c, i) => `<td${n.includes(i) ? ' class="n"' : ""}>${c}</td>`)
      .join("")}</tr>`;
  });
  return block(
    `${heading(text.model)}${numbering.table(escapeHtml(text.bodies))}<table><thead><tr>${heads
      .map(
        (h, i) =>
          `<th${[2, 3, 4, 6].includes(i) ? ' class="n"' : ""}>${tex(h)}</th>`,
      )
      .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
  );
}

function boundarySection(doc: ReportDocument, numbering: Numbering): string {
  const text = tr(reportMessages);
  const faces = (list: string[]) => escapeHtml(list.join(", "));
  const supports =
    doc.supports.length === 0
      ? `<p>${escapeHtml(text.noSupports)}</p>`
      : numbering.table(escapeHtml(text.supports)) +
        table(
          [text.support, text.faces, text.heldDofs, `${text.prescribed} (mm)`],
          doc.supports.map((s) => [
            escapeHtml(s.name),
            faces(s.faces),
            escapeHtml(s.dofs),
            math(sig4(s.value)),
          ]),
          [3],
        );
  const loads =
    doc.loads.length === 0
      ? doc.temperature === null
        ? `<p>${escapeHtml(text.noLoads)}</p>`
        : ""
      : numbering.table(escapeHtml(text.loads)) +
        table(
          [text.load, text.kind, text.faces, text.value],
          doc.loads.map((l) => [
            escapeHtml(l.name),
            escapeHtml(l.kind),
            faces(l.faces),
            withUnit(
              l.value.length === 1
                ? sig4(l.value[0])
                : `(${l.value.map(sig4).join(",~")})`,
              l.unit,
            ),
          ]),
          [3],
        );
  const temperature =
    doc.temperature === null ? "" : `<p>${escapeHtml(doc.temperature)}</p>`;
  const total =
    doc.appliedTotal === null
      ? ""
      : `<p data-testid="report-applied-total" data-force="${doc.appliedTotal.join(",")}">${escapeHtml(text.totalApplied)}: ${math(
          `(${doc.appliedTotal.map((c) => sig4(c)).join(",~")})~\\u{N}`,
        )}</p>`;
  return block(
    `${heading(text.boundaryConditions)}${supports}${loads}${temperature}${total}`,
  );
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

function meshSolverSection(doc: ReportDocument, numbering: Numbering): string {
  const text = tr(reportMessages);
  const rows: KvRow[] = [
    [text.nodes, math(count(doc.mesh.nodes))],
    [text.elements, math(count(doc.mesh.elements))],
  ];
  for (const [label, size] of doc.mesh.sizes ?? [])
    rows.push([escapeHtml(label), withUnit(sig4(size), "mm")]);
  const { run } = doc;
  if (run === null)
    rows.push([
      text.path,
      escapeHtml(text.runNotRecorded),
      ' data-testid="report-solver-path"',
    ]);
  else
    rows.push(
      [
        text.elementOrder,
        escapeHtml(run.elementOrder === 2 ? text.quadratic : text.linear),
      ],
      [
        text.path,
        escapeHtml(pathLabel(run.path)),
        ` data-testid="report-solver-path" data-path="${run.path}"`,
      ],
      [
        text.deformation,
        escapeHtml(
          run.largeDeformation === null
            ? text.smallDeformation
            : text.largeDeformation(run.largeDeformation.increments),
        ),
      ],
      [
        text.preconditioner,
        escapeHtml(preconditionerLabel(run.preconditioner)),
      ],
    );
  const sizesNote =
    doc.mesh.sizes === null
      ? `<p class="note">${escapeHtml(text.sizesNotRecorded)}</p>`
      : "";
  return block(
    `${heading(text.meshAndSolver)}${numbering.table(escapeHtml(text.meshAndSolver))}${kv(rows)}${sizesNote}`,
  );
}

function warningsSection(run: SolveRun | null): string {
  const text = tr(reportMessages);
  const head = heading(text.warnings);
  if (run === null)
    return block(`${head}<p>${escapeHtml(text.runNotRecorded)}</p>`);
  if (run.warnings.length === 0)
    return block(`${head}<p>${escapeHtml(text.noWarnings)}</p>`);
  return block(
    `${head}<ul data-testid="report-warnings">${run.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`,
  );
}

const CHART = { width: 330, height: 236 };

// A log axis from below the fewest elements to above the most, holding at
// least one decade so it has a labelled tick.
function elementRange(counts: number[]): [number, number] {
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return [Math.min(lo / 1.5, 10 ** Math.floor(Math.log10(hi))), hi * 1.5];
}

function refinementSection(
  study: ReportRefinement,
  numbering: Numbering,
): string {
  const text = tr(reportMessages);
  const { levels } = study;
  const last = levels.length - 1;
  const elements = levels.map((l) => l.elements);
  const xRange = elementRange(elements);
  const displacement = scientificChart({
    ...CHART,
    xScale: "log",
    xRange,
    xs: elements,
    ys: levels.map((l) => l.maxDisplacement),
    ends: [
      [0, sig5(levels[0].maxDisplacement), "right"],
      [last, sig5(levels[last].maxDisplacement), "left"],
    ],
    xLabel: text.axisElements,
    yLabel: text.axisMaxDisplacement,
  });
  const stressed = levels.filter(
    (l): l is typeof l & { maxVonMises: number } => l.maxVonMises !== null,
  );
  const stress =
    stressed.length === 0
      ? `<p class="note">${escapeHtml(text.noStudyStress)}</p>`
      : scientificChart({
          ...CHART,
          xScale: "log",
          xRange,
          xs: stressed.map((l) => l.elements),
          ys: stressed.map((l) => l.maxVonMises),
          ends: [
            [0, sig4(stressed[0].maxVonMises), "right"],
            [
              stressed.length - 1,
              sig4(stressed[stressed.length - 1].maxVonMises),
              "left",
            ],
          ],
          xLabel: text.axisElements,
          yLabel: text.axisMaxVonMises,
        });
  const charts = block(
    `${heading(text.refinement)}<figure><div class="pair">${displacement}${stress}</div>${numbering.figure(
      `${tex(text.refinementCaption)} <span class="${study.converged ? "ok" : "bad"}">${escapeHtml(study.verdict)}</span>`,
    )}</figure>`,
  );
  const rows = levels.map((level, k) => {
    const change =
      k === 0
        ? "–"
        : math(
            `${level.maxDisplacement >= levels[k - 1].maxDisplacement ? "+" : ""}${texNumber(
              ((level.maxDisplacement - levels[k - 1].maxDisplacement) /
                levels[k - 1].maxDisplacement) *
                100,
              3,
            )}~\\u{%}`,
          );
    const cells = [
      math(String(k + 1)),
      math(texNumber(level.sizes.max, 3)),
      math(count(level.elements)),
      math(count(level.nodes)),
      math(sig5(level.maxDisplacement)),
      change,
      level.maxVonMises === null ? "–" : math(sig4(level.maxVonMises)),
    ];
    return `<tr data-testid="report-refinement-level" data-elements="${level.elements}" data-max-displacement="${level.maxDisplacement}">${cells
      .map((c) => `<td class="n">${c}</td>`)
      .join("")}</tr>`;
  });
  const heads = [
    text.level,
    `${text.maxSize} (mm)`,
    text.elements,
    text.nodes,
    "Max $|U|$ (mm)",
    text.change,
    "Max $σ_{\\u{vm}}$ (MPa)",
  ];
  const levelTable = block(
    `${numbering.table(escapeHtml(text.refinementLevels))}<table><thead><tr>${heads
      .map((h) => `<th class="n">${tex(h)}</th>`)
      .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
  );
  return `<div data-testid="report-refinement">${charts}${levelTable}</div>`;
}

function topologySettings(topology: ReportTopology): KvRow[] {
  const text = tr(reportMessages);
  const { run, history, density, iterations, converged } = topology.result;
  const first = history[0].compliance;
  const final = history[history.length - 1].compliance;
  const outcome: KvRow[] = [
    [
      text.iterations,
      `${math(String(iterations))} (${escapeHtml(converged ? text.converged : text.notConverged)})`,
      ` data-testid="report-topology-iterations" data-value="${iterations}"`,
    ],
    [text.compliance, withUnit(`${sig4(first)} → ${sig4(final)}`, "N mm")],
    [text.designElements, math(count(density.length))],
  ];
  if (run === undefined)
    return [[text.method, escapeHtml(text.settingsNotRecorded)], ...outcome];
  const levelSet = run.method === "level_set";
  const rows: KvRow[] = [
    [
      text.method,
      escapeHtml(
        `${levelSet ? text.methodLevelSet : text.methodSimp}, ${
          run.objective === "min_volume" ? text.minVolume : text.minCompliance
        }`,
      ),
    ],
  ];
  const { volumeFraction, complianceLimit, maxStress } = run.constraints;
  if (volumeFraction !== undefined)
    rows.push([text.volumeFraction, math(sig4(volumeFraction))]);
  if (complianceLimit !== undefined)
    rows.push([text.complianceLimit, withUnit(sig4(complianceLimit), "N mm")]);
  if (maxStress !== undefined)
    rows.push([text.maxStress, withUnit(sig4(maxStress), "MPa")]);
  if (!levelSet && run.penalty !== undefined)
    rows.push([text.penalty, math(sig4(run.penalty))]);
  rows.push([
    levelSet ? text.regularization : text.filterRadius,
    withUnit(sig4(run.filterRadius), "mm"),
  ]);
  if (!levelSet && run.moveLimit !== undefined)
    rows.push([text.moveLimit, math(sig4(run.moveLimit))]);
  rows.push(
    [text.maxIterations, math(String(run.maxIterations))],
    [text.tolerance, math(sig4(run.tolerance))],
  );
  return [...rows, ...outcome];
}

function topologySection(
  topology: ReportTopology,
  numbering: Numbering,
): string {
  const text = tr(reportMessages);
  const { history, iterations, converged } = topology.result;
  const its = history.map((h) => h.it);
  const xRange: [number, number] = [0, Math.max(...its) + 2];
  const compliance = history.map((h) => h.compliance);
  const last = history.length - 1;
  const complianceChart = scientificChart({
    ...CHART,
    xScale: "linear",
    xRange,
    xs: its,
    ys: compliance,
    ends: [
      [0, sig4(compliance[0]), "right"],
      [last, sig4(compliance[last]), "aboveLeft"],
    ],
    xLabel: text.axisIteration,
    yLabel: text.axisCompliance,
  });
  const target = topology.result.run?.constraints.volumeFraction;
  const volumeChart =
    target === undefined
      ? scientificChart({
          ...CHART,
          xScale: "linear",
          xRange,
          xs: its,
          ys: history.map((h) => h.volume),
          xLabel: text.axisIteration,
          yLabel: text.axisVolume,
        })
      : scientificChart({
          ...CHART,
          xScale: "linear",
          xRange,
          xs: its,
          ys: history.map((h) => ((h.volume - target) / target) * 100),
          refY: 0,
          xLabel: text.axisIteration,
          yLabel: text.axisVolumeDeviation,
        });
  const caption =
    target === undefined
      ? text.topologyCaptionVolume(iterations, converged)
      : text.topologyCaption(sig4(target), iterations, converged);
  const charts = block(
    `${heading(text.topology)}<figure><div class="pair">${complianceChart}${volumeChart}</div>${numbering.figure(tex(caption))}</figure>`,
  );
  const cutoff = topology.threshold;
  const densityCaption = text.densityCaption(cutoff.toFixed(2));
  const densityFigure = block(
    `<div class="single"><figure><div class="ff">${image(
      "report-figure-density",
      topology.figure,
      densityCaption.replace(/\$/g, ""),
    )}${legendBox(
      tex(text.densityLegend),
      DENSITY_GRADIENT,
      ["1.00", "0.75", "0.50", "0.25", "0.00"],
      cutoff,
    )}</div>${numbering.figure(tex(densityCaption))}</figure></div>`,
  );
  const settings = block(
    `${numbering.table(escapeHtml(text.topologySettings))}${kv(topologySettings(topology))}`,
  );
  return `<div data-testid="report-topology">${charts}${densityFigure}${settings}</div>`;
}

export function renderReport(doc: ReportDocument): string {
  const text = tr(reportMessages);
  const numbering = new Numbering();
  const style = STYLE.replace(
    "FOOTER",
    cssString(text.footer(doc.modelName)),
  ).replace("PAGE_OF", pageOfContent());
  const sections = [
    keyResults(doc),
    staticFigures(doc, numbering),
    reactionsSection(
      doc.reactions,
      doc.supports.map((s) => s.name),
      numbering,
    ),
    bodiesSection(doc.bodies, numbering),
    boundarySection(doc, numbering),
    meshSolverSection(doc, numbering),
    doc.refinement === null ? "" : refinementSection(doc.refinement, numbering),
    doc.topology === null ? "" : topologySection(doc.topology, numbering),
    warningsSection(doc.run),
  ];
  return `<!doctype html>
<html lang="${intlTag()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${text.title}: ${doc.modelName}`)}</title>
<style>${doc.assets.fontCss}
${style}</style>
</head>
<body>
<main>
${header(doc)}
${sections.join("\n")}
</main>
</body>
</html>
`;
}
