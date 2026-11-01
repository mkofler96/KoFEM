// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Page text: the MBB beam, minimum-compliance topology optimization
// (examples/gallery/generate-mbb-topopt.mjs).

import { mbbFigure } from "../lib/figures.mjs";
import { REF } from "./refs.mjs";

/** Compliance against iteration, linear axes, as inline SVG. */
function historyChart(history) {
  const W = 440,
    H = 230,
    l = 48,
    r = 14,
    t = 22,
    b = 36;
  const c = history.map((h) => h.objective);
  const top = Math.ceil(Math.max(...c) / 50) * 50;
  const n = history.length;
  const X = (i) => l + (i / (n - 1)) * (W - l - r);
  const Y = (v) => t + (1 - v / top) * (H - t - b);
  const f = (v) => v.toFixed(1);
  const grid = [];
  for (let v = 0; v <= top; v += 50)
    grid.push(
      `<line class="grid" x1="${l}" x2="${W - r}" y1="${f(Y(v))}" y2="${f(Y(v))}"/>`,
      `<text class="tick" x="${l - 6}" y="${f(Y(v) + 3.5)}" text-anchor="end">${v}</text>`,
    );
  for (let i = 0; i < n; i += 20)
    grid.push(
      `<text class="tick" x="${f(X(i))}" y="${H - b + 15}" text-anchor="middle">${i + 1}</text>`,
    );
  const path = c
    .map((v, i) => `${i ? "L" : "M"}${f(X(i))} ${f(Y(v))}`)
    .join(" ");
  return `<svg class="conv" viewBox="0 0 ${W} ${H}" role="img" aria-label="Compliance against optimizer iteration: it falls steeply in the first iterations and levels off">
            <text class="axis-title" x="${l}" y="${t - 9}">compliance (N·mm)</text>
            ${grid.join("\n            ")}
            <line class="axis" x1="${l}" x2="${W - r}" y1="${H - b}" y2="${H - b}"/>
            <line class="axis" x1="${l}" x2="${l}" y1="${t}" y2="${H - b}"/>
            <path class="line s1" d="${path}"/>
            <text class="axis-title" x="${W - r}" y="${H - 4}" text-anchor="end">iteration</text>
          </svg>`;
}

const last = (row) => row.history[row.history.length - 1];

export default {
  description:
    "The MBB beam, the standard minimum-compliance topology optimization benchmark, solved in KoFEM with SIMP and MMA on a Netgen mesh: settings, convergence and the resulting truss.",
  opens: "Opens the model in the app, ready to optimize.",
  figure: () => mbbFigure(),
  intro: () => `
        <p>Topology optimization decides where material should go. The MBB
        beam is its standard test: a simply supported beam with a load at
        mid-span, and half of the block's volume to spend. The stiffest
        layout is a truss, with a compression chord on top, a tension tie
        along the bottom and diagonals between them. The model opens in the
        Optimize step, ready to run.</p>`,
  theoryTitle: "The optimization problem",
  theory: ({ tex, texBlock, row }) => `
        <p>Each element ${tex("e")} gets a density ${tex("ρ_{e}")} between
        0 (void) and 1 (solid). SIMP (solid isotropic material with
        penalisation) scales the element's stiffness with a power of its
        density,</p>
        ${texBlock(`E_{e} = ρ_{e}^{p} E, \\quad p = ${row.settings.penalty},`)}
        <p>so intermediate densities give little stiffness for their volume
        and the optimum is pushed towards 0 or 1. The problem is to minimise
        the compliance, the work done by the load, at a fixed volume:</p>
        ${texBlock(`\\mathrm{min}_{ρ} \\; c(ρ) = F^{\\mathrm{T}} u(ρ) \\quad \\text{subject to} \\quad \\frac{V(ρ)}{V_{0}} = ${row.settings.volumeFraction}.`)}
        <p>Lower compliance means a stiffer structure. The sensitivities are
        filtered over a radius ${tex(`r_{\\mathrm{min}} = ${row.settings.filterRadius}\\text{ mm}`)},
        which prevents checkerboard patterns and makes the layout independent
        of the mesh. The densities are updated by MMA, the method of moving
        asymptotes, with a move limit of ${row.settings.moveLimit} per
        iteration.</p>
        <p>There is no closed-form answer to compare with. The check is that
        the run converges and that the layout matches the published one.</p>`,
  model: ({ row, tex }) => `
        <p>The block is a STEP file, cut with the app's split tool so that
        the two supports and the load each sit on their own CAD face. Netgen
        meshes it at ${row.mesh.maxElementSize}&nbsp;mm. The whole beam is
        modelled rather than the symmetric half. The optimizer stops when no
        density changes by more than ${row.settings.tolerance} between
        iterations, or after ${row.settings.maxIterations}. The figure shows
        the elements with ${tex(`ρ ≥ ${row.settings.threshold}`)}.</p>`,
  results: ({ row, num }) => {
    const first = row.history[0];
    const end = last(row);
    return `
      <div class="table-wrap">
        <table class="spec">
          <tr><th scope="row">Iterations</th><td>${row.history.length}, converged (largest density change ${num(end.maxChange)})</td></tr>
          <tr><th scope="row">Compliance</th><td>${num(first.objective)}&nbsp;N·mm at the start, <strong>${num(end.objective)}&nbsp;N·mm</strong> at the end</td></tr>
          <tr><th scope="row">Volume</th><td>${end.volume.toFixed(3)} of the block (target ${row.settings.volumeFraction})</td></tr>
          <tr><th scope="row">Elements</th><td>${row.solid.toLocaleString("en-US")} solid (ρ &gt; 0.9), ${row.void.toLocaleString("en-US")} void (ρ &lt; 0.1)</td></tr>
        </table>
      </div>
      <figure class="chart">
        ${historyChart(row.history)}
        <figcaption>Compliance at each optimizer iteration.</figcaption>
      </figure>`;
  },
  discussion: ({ row }) => {
    const end = last(row);
    const drop = (1 - end.objective / row.history[0].objective) * 100;
    return `
        <p>The compliance falls by ${drop.toFixed(0)}&nbsp;% from the
        uniform start, most of it in the first iterations, while the volume
        stays at the target. The layout is the one in the literature: a
        chord along the top, a tie along the bottom and diagonals between
        them, as in Sigmund's 99-line and Andreassen's 88-line codes.</p>
        <p>The tetrahedral mesh leaves a ragged surface where the threshold
        cuts through elements. The layout is the result, not the final part:
        export it, smooth it and check it with a solve of the solid
        design.</p>`;
  },
  references: [REF.bendsoe, REF.sigmund99, REF.andreassen, REF.svanberg],
};
