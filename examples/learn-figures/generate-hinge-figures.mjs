// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rebuild both figures in /learn/hinge-bracket-stiffness/ and inline them into
// the article.
//
//   web/public/learn/hinge-bc.svg          — the model and its boundary conditions,
//                                            projected here out of a real KoFEM mesh
//   web/public/learn/hinge-convergence.svg — k_w against mesh size, drawn by
//                                            plot_hinge_convergence.py (matplotlib)
//
// The figures are INLINED into the HTML rather than referenced with <img>. An
// <img>-loaded SVG is an isolated document: it cannot see the page's
// data-theme attribute, so the site's light/dark toggle does not reach it, and
// it cannot use the page's webfont either. Inlined, both work — the figures
// carry classes and a palette scoped to their own root element.
//
// Requires python3 with matplotlib for the chart (see README.md).
//
// Usage (from web/):  bun run learn:figures

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(__dirname, "../../web/src/wasm/pkg");
const IGES = join(__dirname, "../../web/public/examples/scharnier.igs");
const OUT_DIR = join(__dirname, "../../web/public/learn");
const ARTICLE = join(
  __dirname,
  "../../web/learn/hinge-bracket-stiffness/index.html",
);

const CLAMP_FACE = 6;
const BORE_FACES = new Set([22, 25]);

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
          ? "kf-clamp"
          : BORE_FACES.has(FID[t])
            ? "kf-load"
            : "kf-body",
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
    `<svg class="kf-fig" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="kfBcTitle">`,
  );
  o.push(
    `<title id="kfBcTitle">Hinge bracket seen from below: the mounting face is fully clamped and a 1000 N load in +z is spread over the eye bore.</title>`,
  );
  // Class names are kf- prefixed and the palette is scoped to the figure's own
  // root class: inlined, this <style> is a document-wide stylesheet, so an
  // unprefixed `.body` rule would restyle the page.
  o.push(`<style>
.kf-fig{width:100%;height:auto;display:block;
  --fig-ink:#e9ecf3;--fig-muted:#9aa0ad;--fig-solid:#8f98ac;--fig-edge:#5c6478}
[data-theme="light"] .kf-fig{
  --fig-ink:#0d1117;--fig-muted:#5b616e;--fig-solid:#8a93a6;--fig-edge:#6b7386}
.kf-body{fill:var(--fig-solid);stroke:var(--fig-edge);stroke-width:.3;stroke-opacity:.45}
.kf-clamp{fill:#2f54eb;fill-opacity:.85;stroke:#2f54eb;stroke-width:.3}
.kf-load{fill:#e5484d;fill-opacity:.9;stroke:#e5484d;stroke-width:.3}
.kf-lbl{font:600 15px Geist,system-ui,sans-serif;fill:var(--fig-ink)}
.kf-sub{font:400 12.5px Geist,system-ui,sans-serif;fill:var(--fig-muted)}
.kf-arw{stroke:#e5484d;stroke-width:2.6;fill:none;marker-end:url(#kfArrowHead)}
.kf-lead{stroke:var(--fig-muted);stroke-width:1;fill:none;stroke-dasharray:3 3}
</style>`);
  o.push(
    `<defs><marker id="kfArrowHead" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#e5484d"/></marker></defs>`,
  );

  for (const t of tris) {
    const d = `M${t.p.map((q) => `${f1(SX(q))} ${f1(SY(q))}`).join("L")}Z`;
    const shade =
      t.kind === "kf-body"
        ? ` fill-opacity="${(0.34 + 0.54 * t.nz).toFixed(2)}"`
        : "";
    o.push(`<path class="${t.kind}"${shade} d="${d}"/>`);
  }

  const [bx, by] = xy([0, 4, 0]); // eye bore centre
  const [tx, ty] = xy([0, 4, 52]); // 52 mm along +z
  o.push(`<path class="kf-arw" d="M${f1(bx)} ${f1(by)} L${f1(tx)} ${f1(ty)}"/>`);
  o.push(
    `<text class="kf-lbl" x="${f1(tx + 12)}" y="${f1(ty + 5)}">F<tspan font-size="11" dy="3">w</tspan><tspan dy="-3">&#160;= 1000 N in +z</tspan></text>`,
  );
  o.push(
    `<text class="kf-sub" x="${f1(tx + 12)}" y="${f1(ty + 24)}">spread over the bore; w is read back from it</text>`,
  );

  const [cx, cy] = xy([76, -20, -6]); // on the clamped face
  o.push(
    `<path class="kf-lead" d="M${f1(cx)} ${f1(cy)} L${f1(cx + 46)} ${f1(cy + 40)}"/>`,
  );
  o.push(
    `<text class="kf-lbl" x="${f1(cx + 52)}" y="${f1(cy + 45)}">clamped face</text>`,
  );
  o.push(
    `<text class="kf-sub" x="${f1(cx + 52)}" y="${f1(cy + 63)}">all DOF fixed, y = &#8722;20 mm</text>`,
  );
  o.push(`</svg>`);

  const svg = o.join("\n") + "\n";
  writeFileSync(join(OUT_DIR, "hinge-bc.svg"), svg);
  console.log(
    `hinge-bc.svg           — ${(svg.length / 1024).toFixed(1)} kB, ${tris.length} visible triangles`,
  );
}

// ── figure 2: convergence (matplotlib) ───────────────────────────────────────

function convergenceFigure() {
  const script = join(__dirname, "plot_hinge_convergence.py");
  const r = spawnSync("python3", [script], { encoding: "utf8" });
  if (r.error || r.status !== 0)
    throw new Error(
      `plot_hinge_convergence.py failed (${r.error?.message ?? `exit ${r.status}`}).\n` +
        `matplotlib is required for this figure — see examples/learn-figures/README.md\n` +
        (r.stderr ?? ""),
    );
  process.stdout.write(r.stdout);
}

// ── inline both figures into the article ─────────────────────────────────────

// Each figure sits between a pair of HTML comments so this script owns the SVG
// markup and the article keeps everything around it.
function inlineIntoArticle() {
  let html = readFileSync(ARTICLE, "utf8");
  const figures = [
    ["hinge-bc", "hinge-bc.svg"],
    ["hinge-convergence", "hinge-convergence.svg"],
  ];

  for (const [marker, file] of figures) {
    const open = `<!-- figure:${marker} -->`;
    const close = `<!-- /figure:${marker} -->`;
    const start = html.indexOf(open);
    const end = html.indexOf(close);
    if (start < 0 || end < 0)
      throw new Error(
        `marker pair ${open} … ${close} not found in ${ARTICLE} — ` +
          `the article must keep them so the figures can be re-inlined`,
      );
    const svg = readFileSync(join(OUT_DIR, file), "utf8").trim();
    html = html.slice(0, start + open.length) + "\n" + svg + "\n" + html.slice(end);
  }

  writeFileSync(ARTICLE, html);
  console.log(`inlined both figures into learn/hinge-bracket-stiffness/`);
}

mkdirSync(OUT_DIR, { recursive: true });
await boundaryConditionFigure();
convergenceFigure();
inlineIntoArticle();
