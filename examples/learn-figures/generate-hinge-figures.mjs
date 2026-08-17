// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regenerate the two SVG figures in /learn/hinge-bracket-stiffness/:
//
//   web/public/learn/hinge-bc.svg          — the model and its boundary conditions,
//                                            drawn from the mesh the engine produces
//   web/public/learn/hinge-convergence.svg — k_w against mesh size, both element orders
//
// The boundary-condition figure is projected from a real KoFEM mesh rather than
// drawn by hand, so it cannot drift out of step with the geometry. The
// convergence data is measured by analyze-hinge.mjs in this directory; re-run
// that first and paste its numbers into CONVERGENCE below if the model changes.
//
// Usage (from web/):  bun ../examples/learn-figures/generate-hinge-figures.mjs

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(__dirname, "../../web/src/wasm/pkg");
const IGES = join(__dirname, "../../web/public/examples/scharnier.igs");
const OUT_DIR = join(__dirname, "../../web/public/learn");

const CLAMP_FACE = 6;
const BORE_FACES = new Set([22, 25]);

// Measured by analyze-hinge.mjs. k in N/mm.
const CONVERGENCE = {
  linear: [
    { h: 10, nodes: 5699, k: 11889.6 },
    { h: 8, nodes: 6353, k: 11812.7 },
    { h: 6, nodes: 7051, k: 11803.7 },
    { h: 5, nodes: 8111, k: 11750.3 },
    { h: 4, nodes: 9542, k: 11704.8 },
    { h: 3, nodes: 10524, k: 11575.0 },
    { h: 2.5, nodes: 11056, k: 11549.0 },
    { h: 2, nodes: 12690, k: 11364.0 },
  ],
  quadratic: [
    { h: 10, nodes: 5699, k: 10168.9 },
    { h: 8, nodes: 6353, k: 10102.6 },
    { h: 6, nodes: 7051, k: 10123.0 },
    { h: 5, nodes: 8111, k: 10143.5 },
    { h: 4, nodes: 9542, k: 10185.0 },
  ],
};

const f1 = (n) => n.toFixed(1);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

// ── figure 1: the model and its boundary conditions ──────────────────────────

async function boundaryConditionFigure() {
  const wasmBinary = readFileSync(join(wasmPkg, "kofem_wasm_emcc.wasm")).buffer;
  const { default: createModule } = await import(
    join(wasmPkg, "kofem_wasm_emcc.js")
  );
  const Module = await createModule({
    wasmBinary,
    print: () => {},
    printErr: (t) => console.error("[wasm:err]", t),
  });

  Module.tessellate_step(
    new Uint8Array(readFileSync(IGES)),
    JSON.stringify({
      format: "iges",
      deflection_relative: 0.001,
      angular_deflection: 0.5,
    }),
  );
  // Deliberately coarse: this mesh is only the figure's drawing primitive, so
  // it trades element quality for a page-weight-sized triangle count.
  const mesh = Module.generate_fem_mesh(
    JSON.stringify({
      max_element_size: 9,
      min_element_size: 3.5,
      grading: 0.5,
      second_order: false,
      elementsperedge: 1,
      elementspercurve: 1,
      optsteps_2d: 2,
      optsteps_3d: 1,
    }),
  );

  const V = mesh.vertices;
  const T = mesh.surfaceTriangles;
  const FID = mesh.surfaceFaceIds;

  // Physical "up" for this part is +y (the plate lies in the x-z plane). The
  // camera sits BELOW the horizon so the mounting face — on the underside — is
  // visible; a conventional top-down isometric hides the very face the figure
  // is about.
  const AZ = (-38 * Math.PI) / 180;
  const EL = (-16 * Math.PI) / 180;
  const dir = unit([
    Math.cos(EL) * Math.sin(AZ),
    Math.sin(EL),
    Math.cos(EL) * Math.cos(AZ),
  ]);
  const right = unit(cross([0, 1, 0], dir));
  const up = cross(dir, right);
  // → [screen x, screen y, depth]; depth grows toward the camera.
  const proj = (p) => [dot(p, right), dot(p, up), dot(p, dir)];
  const P = (i) => proj([V[3 * i], V[3 * i + 1], V[3 * i + 2]]);

  const tris = [];
  for (let t = 0; t < T.length / 3; t++) {
    const p = [T[3 * t], T[3 * t + 1], T[3 * t + 2]].map(P);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = cross(u, v);
    const len = Math.hypot(...n) || 1;
    if (n[2] / len < 0) continue; // back-facing → hidden
    tris.push({
      p,
      nz: n[2] / len,
      depth: (p[0][2] + p[1][2] + p[2][2]) / 3,
      kind:
        FID[t] === CLAMP_FACE
          ? "clamp"
          : BORE_FACES.has(FID[t])
            ? "load"
            : "body",
    });
  }
  tris.sort((a, b) => a.depth - b.depth); // painter's algorithm: far first

  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  for (const t of tris)
    for (const q of t.p)
      for (const k of [0, 1]) {
        lo[k] = Math.min(lo[k], q[k]);
        hi[k] = Math.max(hi[k], q[k]);
      }
  const W = 780;
  const H = 400;
  const s = Math.min((W - 300) / (hi[0] - lo[0]), (H - 148) / (hi[1] - lo[1]));
  const ox = (W - (hi[0] - lo[0]) * s) / 2;
  const oy = (H - (hi[1] - lo[1]) * s) / 2;
  const SX = (q) => (q[0] - lo[0]) * s + ox;
  const SY = (q) => H - ((q[1] - lo[1]) * s + oy); // SVG y grows downward
  const xy = (p3) => {
    const q = proj(p3);
    return [SX(q), SY(q)];
  };

  const o = [];
  o.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="bcTitle">`,
  );
  o.push(
    `<title id="bcTitle">Hinge bracket seen from below: the mounting face is fully clamped and a 1000 N load in +z is spread over the eye bore.</title>`,
  );
  o.push(`<style>
  .body{fill:#8f98ac;stroke:#5c6478;stroke-width:.3;stroke-opacity:.45}
  .clamp{fill:#2f54eb;fill-opacity:.85;stroke:#2f54eb;stroke-width:.3}
  .load{fill:#e5484d;fill-opacity:.9;stroke:#e5484d;stroke-width:.3}
  .lbl{font:600 15px Geist,system-ui,sans-serif;fill:#e9ecf3}
  .sub{font:400 12.5px Geist,system-ui,sans-serif;fill:#9aa0ad}
  .arw{stroke:#e5484d;stroke-width:2.6;fill:none;marker-end:url(#ah)}
  .lead{stroke:#9aa0ad;stroke-width:1;fill:none;stroke-dasharray:3 3}
  [data-theme="light"] .lbl{fill:#0d1117}
  [data-theme="light"] .sub{fill:#5b616e}
</style>`);
  o.push(
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#e5484d"/></marker></defs>`,
  );

  for (const t of tris) {
    const d = `M${t.p.map((q) => `${f1(SX(q))} ${f1(SY(q))}`).join("L")}Z`;
    const shade =
      t.kind === "body"
        ? ` fill-opacity="${(0.34 + 0.54 * t.nz).toFixed(2)}"`
        : "";
    o.push(`<path class="${t.kind}"${shade} d="${d}"/>`);
  }

  const [bx, by] = xy([0, 4, 0]); // eye bore centre
  const [tx, ty] = xy([0, 4, 52]); // 52 mm along +z
  o.push(`<path class="arw" d="M${f1(bx)} ${f1(by)} L${f1(tx)} ${f1(ty)}"/>`);
  o.push(
    `<text class="lbl" x="${f1(tx + 12)}" y="${f1(ty + 5)}">F<tspan font-size="11" dy="3">w</tspan><tspan dy="-3">&#160;= 1000 N in +z</tspan></text>`,
  );
  o.push(
    `<text class="sub" x="${f1(tx + 12)}" y="${f1(ty + 24)}">spread over the bore; w is read back from it</text>`,
  );

  const [cx, cy] = xy([76, -20, -6]); // on the clamped face
  o.push(
    `<path class="lead" d="M${f1(cx)} ${f1(cy)} L${f1(cx + 46)} ${f1(cy + 40)}"/>`,
  );
  o.push(
    `<text class="lbl" x="${f1(cx + 52)}" y="${f1(cy + 45)}">clamped face</text>`,
  );
  o.push(
    `<text class="sub" x="${f1(cx + 52)}" y="${f1(cy + 63)}">all DOF fixed, y = &#8722;20 mm</text>`,
  );
  o.push(`</svg>`);

  writeFileSync(join(OUT_DIR, "hinge-bc.svg"), o.join("\n") + "\n");
  console.log(`hinge-bc.svg           — ${tris.length} visible triangles`);
}

// ── figure 2: convergence ────────────────────────────────────────────────────

function convergenceFigure() {
  const { linear, quadratic } = CONVERGENCE;
  const W = 780;
  const H = 400;
  const L = 78;
  const R = 30;
  const TOP = 52;
  const BOT = 66;
  const PW = W - L - R;
  const PH = H - TOP - BOT;
  const x0 = 5200;
  const x1 = 13200;
  const y0 = 9800;
  const y1 = 12200;
  const SX = (n) => L + ((n - x0) / (x1 - x0)) * PW;
  const SY = (k) => TOP + PH - ((k - y0) / (y1 - y0)) * PH;

  const o = [];
  o.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="cvTitle">`,
  );
  o.push(
    `<title id="cvTitle">Computed stiffness against mesh size. Linear tetrahedra fall steadily from 11,890 to 11,364 N/mm without settling, while quadratic elements on the same meshes sit flat at about 10,130 N/mm from the coarsest mesh onward.</title>`,
  );
  o.push(`<style>
  .ax{stroke:#3a3f4b;stroke-width:1;fill:none}
  .gr{stroke:#2a2e38;stroke-width:1;stroke-dasharray:3 4;fill:none}
  .tk{font:400 11.5px Geist,system-ui,sans-serif;fill:#9aa0ad}
  .al{font:500 12.5px Geist,system-ui,sans-serif;fill:#9aa0ad}
  .lg{font:500 13px Geist,system-ui,sans-serif}
  .lin{stroke:#e5484d;stroke-width:2.4;fill:none}
  .lind{fill:#e5484d}
  .qua{stroke:#2f54eb;stroke-width:2.4;fill:none}
  .quad{fill:#2f54eb}
  [data-theme="light"] .ax{stroke:#c9cdd6}
  [data-theme="light"] .gr{stroke:#e7e9ee}
  [data-theme="light"] .tk,[data-theme="light"] .al{fill:#5b616e}
</style>`);

  for (let k = y0; k <= y1; k += 400) {
    o.push(`<path class="gr" d="M${L} ${f1(SY(k))} H${L + PW}"/>`);
    o.push(
      `<text class="tk" x="${L - 11}" y="${f1(SY(k) + 4)}" text-anchor="end">${k.toLocaleString("en-US")}</text>`,
    );
  }
  for (const d of linear) {
    o.push(
      `<text class="tk" x="${f1(SX(d.nodes))}" y="${TOP + PH + 20}" text-anchor="middle">${(d.nodes / 1000).toFixed(1)}k</text>`,
    );
    o.push(
      `<text class="tk" x="${f1(SX(d.nodes))}" y="${TOP + PH + 36}" text-anchor="middle" opacity=".7">${d.h}</text>`,
    );
  }
  o.push(`<path class="ax" d="M${L} ${TOP} V${TOP + PH} H${L + PW}"/>`);

  const line = (rows) =>
    `M` + rows.map((d) => `${f1(SX(d.nodes))} ${f1(SY(d.k))}`).join("L");
  o.push(`<path class="lin" d="${line(linear)}"/>`);
  o.push(`<path class="qua" d="${line(quadratic)}"/>`);
  for (const d of linear)
    o.push(
      `<circle class="lind" cx="${f1(SX(d.nodes))}" cy="${f1(SY(d.k))}" r="3.6"/>`,
    );
  for (const d of quadratic)
    o.push(
      `<circle class="quad" cx="${f1(SX(d.nodes))}" cy="${f1(SY(d.k))}" r="3.6"/>`,
    );

  o.push(
    `<text class="al" x="${L + PW / 2}" y="${H - 10}" text-anchor="middle">mesh nodes (top) &#183; max element size in mm (bottom)</text>`,
  );
  o.push(
    `<text class="al" transform="translate(18 ${TOP + PH / 2}) rotate(-90)" text-anchor="middle">k&#8348; [N/mm]</text>`,
  );
  o.push(
    `<circle class="lind" cx="${L + 6}" cy="${TOP - 26}" r="4"/><text class="lg" x="${L + 18}" y="${TOP - 22}" fill="#e5484d">linear tetrahedra &#8212; still falling</text>`,
  );
  o.push(
    `<circle class="quad" cx="${L + 6}" cy="${TOP - 8}" r="4"/><text class="lg" x="${L + 18}" y="${TOP - 4}" fill="#2f54eb">quadratic elements &#8212; flat from the start</text>`,
  );
  o.push(`</svg>`);

  writeFileSync(join(OUT_DIR, "hinge-convergence.svg"), o.join("\n") + "\n");
  console.log(
    `hinge-convergence.svg  — ${linear.length} linear + ${quadratic.length} quadratic points`,
  );
}

mkdirSync(OUT_DIR, { recursive: true });
await boundaryConditionFigure();
convergenceFigure();
