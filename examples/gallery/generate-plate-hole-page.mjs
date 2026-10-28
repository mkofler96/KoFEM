// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Writes the benchmark write-up of the plate with a hole, served at
// /examples/plate-with-hole/ (site/plate-with-hole/index.html).
//
// No number on the page is typed by hand. Each one is computed here from the
// example's definition (examples.mjs) and from the files the gallery ships —
// examples.json and the solved plate-with-hole.vtu / plate-with-hole-shell.vtu
// — and the script refuses to write the page when those disagree. The figure
// kofem-web-von-mises.png is a capture of the app opened on the shipped example
// (web/tests/example-page-capture.spec.ts). After the example changes, re-run:
//
//   bun run examples:generate plate-with-hole
//   bun run capture:example-pages
//   bun run examples:generate-plate-hole-page

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import examples from "./examples.mjs";
import { siteHeader, siteFooter } from "../../web/site-layout.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "site");
const ID = "plate-with-hole";
const SHELL_ID = "plate-with-hole-shell";
const ORIGIN = "https://kofem.org";
const REPO = "https://github.com/mkofler96/KoFEM/blob/main";
const FIGURE = "kofem-web-von-mises.png";

const ex = examples.find((e) => e.id === ID);
if (!ex) throw new Error(`examples.mjs defines no "${ID}" example`);
const { a, b, t, sigma, rings, sectors, grade } = ex.geometry;
const { vertices, hexahedra } = ex.mesh;
const pagePath = `/examples/${ex.page}`;
const pageUrl = `${ORIGIN}${pagePath}`;
const figurePath = `${pagePath}${FIGURE}`;
const appPath = `/app/?example=${ID}`;

// ── Shipped data ──────────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(site, "examples.json"), "utf8"));
function card(id) {
  const entry = manifest.find((e) => e.id === id);
  if (!entry)
    throw new Error(`site/examples.json has no "${id}" entry to describe`);
  return entry;
}
const solidCard = card(ID);
const shellCard = card(SHELL_ID);
if (solidCard.page !== ex.page)
  throw new Error(
    `site/examples.json links "${ID}" to "${solidCard.page}", examples.mjs to "${ex.page}" — re-run \`bun run examples:generate ${ID}\``,
  );

// The ascii VTU written by generate.mjs / generate-plate-hole-shell.mjs.
function readVtu(file) {
  const path = join(site, file);
  const xml = readFileSync(path, "utf8");
  const piece = xml.match(/<Piece NumberOfPoints="(\d+)" NumberOfCells="(\d+)">/);
  if (!piece) throw new Error(`${path} has no <Piece> header`);
  const array = (name) => {
    const m = xml.match(
      new RegExp(
        `<DataArray [^>]*Name="${name}"[^>]*format="ascii">\\n([^<]*)\\n</DataArray>`,
      ),
    );
    if (!m) throw new Error(`${path} has no ascii DataArray "${name}"`);
    return m[1].trim().split(/\s+/).map(Number);
  };
  return { path, nPoints: Number(piece[1]), nCells: Number(piece[2]), array };
}

// PNG width and height, from the IHDR chunk.
function pngSize(path) {
  const png = readFileSync(path);
  if (png.toString("latin1", 12, 16) !== "IHDR")
    throw new Error(
      `${path} is not a PNG — capture it with \`bun run capture:example-pages\``,
    );
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// Kirsch's infinite plate under remote uniaxial stress σ along x, hole radius
// a: von Mises at (r, θ), θ from the load axis, in plane stress (Kirsch 1898;
// Timoshenko & Goodier, Theory of Elasticity, §35).
function kirschVonMises(r, theta) {
  const q = (a * a) / (r * r);
  const c = Math.cos(2 * theta),
    s = Math.sin(2 * theta);
  const rr = (sigma / 2) * (1 - q) + (sigma / 2) * (1 - 4 * q + 3 * q * q) * c;
  const tt = (sigma / 2) * (1 + q) - (sigma / 2) * (1 + 3 * q * q) * c;
  const rt = -(sigma / 2) * (1 + 2 * q - 3 * q * q) * s;
  return Math.sqrt(rr * rr - rr * tt + tt * tt + 3 * rt * rt);
}

// ── Solid model ───────────────────────────────────────────────────────────────

const solid = readVtu(`${ID}.vtu`);
if (solid.nPoints !== vertices.length || solid.nCells !== hexahedra.length)
  throw new Error(
    `${solid.path} has ${solid.nPoints} nodes / ${solid.nCells} cells, examples.mjs ${vertices.length} / ${hexahedra.length} — re-run \`bun run examples:generate ${ID}\``,
  );
const vm = solid.array("VonMises");

// Element e = ring·sectors + sector (plateWithHoleMesh); ring 0 touches the
// hole, and its largest value is the example's Kt (examples.mjs feValue).
let peak = 0;
for (let e = 1; e < sectors; e++) if (vm[e] > vm[peak]) peak = e;
const kt = vm[peak] / sigma;
if (Math.abs(kt - solidCard.feValue) > 1e-12 * kt)
  throw new Error(
    `${solid.path} gives Kt = ${kt}, site/examples.json ${solidCard.feValue} — they come from different runs; re-run \`bun run examples:generate ${ID}\``,
  );
// Where that element samples the stress: its centre, as a distance from the
// hole centre and an angle from the load axis folded into the first quadrant.
const centre = [0, 1].map(
  (k) => hexahedra[peak].reduce((s, v) => s + vertices[v][k], 0) / 8,
);
const peakR = Math.hypot(...centre);
const peakTheta = Math.atan2(Math.abs(centre[1]), Math.abs(centre[0]));
const kirschAtPeak = kirschVonMises(peakR, peakTheta) / sigma;

// Finite width: Heywood's net-section factor Kt,n = 2 + (1 − d/W)³, converted
// to the gross section the remote stress σ is measured on.
const dOverW = a / b;
const ktHeywood = (2 + (1 - dOverW) ** 3) / (1 - dOverW);

const firstRingDepth = (b - a) * (1 / rings) ** grade; // on the transverse axis
const ringArc = (2 * Math.PI * a) / sectors;

// ── Shell model: the gallery's other plate, compared in one table row ─────────

const shell = readVtu(`${SHELL_ID}.vtu`);
const shellPoints = shell.array("Points");
const shellConn = shell.array("connectivity");
const shellOffsets = shell.array("offsets");
const shellVm = shell.array("VonMises");
const onHole = (n) =>
  Math.abs(Math.hypot(shellPoints[3 * n], shellPoints[3 * n + 1]) - a) <
  1e-6 * a;
let shellPeak = 0;
for (let e = 0, start = 0; e < shell.nCells; start = shellOffsets[e++])
  if (shellConn.slice(start, shellOffsets[e]).some(onHole))
    shellPeak = Math.max(shellPeak, shellVm[e]);
const ktShell = shellPeak / sigma;
const shellShown = shellCard.metrics?.[0]?.v;
if (shellShown !== ktShell.toFixed(2))
  throw new Error(
    `${shell.path} gives Kt = ${ktShell.toFixed(3)}, the gallery card shows "${shellShown}" — re-run \`bun run examples:generate-plate-hole-shell\``,
  );

const figure = pngSize(join(site, ex.page, FIGURE));

// ── Formatting ────────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const int = (n) => Math.round(n).toLocaleString("en-US");
const fix = (n, d) => n.toFixed(d);
const pct = (fe, ref) => {
  const p = ((fe - ref) / ref) * 100;
  return `${p < 0 ? "−" : "+"}${Math.abs(p).toFixed(1)}%`;
};
const deg = (rad) => `${fix((rad * 180) / Math.PI, 1)}°`;
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sci = (n, d) => {
  const [m, e] = n.toExponential(d).split("e");
  const exp = [...String(Math.abs(Number(e)))].map((c) => SUPERSCRIPT[c]);
  return `${m} × 10${Number(e) < 0 ? "⁻" : ""}${exp.join("")}`;
};

const ktStr = fix(kt, 3);
const errVsKirsch = pct(kt, ex.reference);
const errVsPoint = pct(kt, kirschAtPeak);

// ── Page ──────────────────────────────────────────────────────────────────────

const title = "Plate with a Hole FEA Benchmark (Kirsch Kt = 3) — KoFEM";
const headline = "Plate with a hole in tension: Kirsch stress concentration";
const description = `A steel plate with a central hole in tension, solved in the browser with KoFEM: model, mesh and the FE stress concentration Kt = ${ktStr} against Kirsch's 3.`;
const figureAlt = `Von Mises stress around the hole of the plate in KoFEM web: red at the top and bottom of the hole, peaking at ${int(vm[peak])} MPa, about ${int(sigma)} MPa far from it.`;

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "TechArticle",
      headline,
      description,
      url: pageUrl,
      mainEntityOfPage: pageUrl,
      image: {
        "@type": "ImageObject",
        url: `${ORIGIN}${figurePath}`,
        width: figure.width,
        height: figure.height,
      },
      inLanguage: "en",
      isAccessibleForFree: true,
      about: ["Stress concentration", "Finite element method"],
      keywords:
        "plate with a hole, Kirsch, stress concentration factor, Kt, FEA benchmark, von Mises",
      author: { "@type": "Organization", name: "KoFEM", url: `${ORIGIN}/` },
      publisher: {
        "@type": "Organization",
        name: "KoFEM",
        url: `${ORIGIN}/`,
        logo: { "@type": "ImageObject", url: `${ORIGIN}/kofem_logo.svg` },
      },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "KoFEM", item: `${ORIGIN}/` },
        {
          "@type": "ListItem",
          position: 2,
          name: "Examples",
          item: `${ORIGIN}/examples/`,
        },
        { "@type": "ListItem", position: 3, name: solidCard.title, item: pageUrl },
      ],
    },
  ],
};

const html = `<!doctype html>
<!-- Generated by examples/gallery/generate-plate-hole-page.mjs — do not edit;
     change the generator and re-run \`bun run examples:generate-plate-hole-page\`. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />

    <link rel="icon" href="/favicon.ico" sizes="any" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/svg+xml" href="/kofem_logo.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />

    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${pageUrl}" />
    <meta name="robots" content="index, follow" />

    <!-- Open Graph / social -->
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="KoFEM" />
    <meta property="og:title" content="${esc(headline)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${pageUrl}" />
    <meta property="og:image" content="${ORIGIN}${figurePath}" />
    <meta property="og:image:width" content="${figure.width}" />
    <meta property="og:image:height" content="${figure.height}" />
    <meta property="og:image:alt" content="${esc(figureAlt)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(headline)}" />
    <meta name="twitter:description" content="${esc(description)}" />
    <meta name="twitter:image" content="${ORIGIN}${figurePath}" />

    <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
    </script>

    <!-- Self-hosted fonts (SIL OFL) — see public/fonts/README.md -->
    <link href="/fonts/ibm-plex.css" rel="stylesheet" />
    <link href="/case-page.css" rel="stylesheet" />


    <style>
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.6;
        -webkit-font-smoothing: antialiased;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      sub {
        line-height: 0;
      }
      code {
        font-family: var(--mono);
        font-size: 0.86em;
        overflow-wrap: anywhere;
      }

      /* Header and footer as on the gallery page. */
      :root[data-theme="light"] .icon-sun {
        display: none;
      }
      :root[data-theme="light"] .icon-moon {
        display: block;
      }
      .btn,
      .btn-ghost {
        display: inline-flex;
        font-weight: 600;
        font-size: 14px;
        padding: 8px 15px;
        border-radius: 9px;
      }
      .btn {
        background: var(--accent);
        color: #fff;
      }
      .btn-ghost {
        color: var(--text);
        border: 1px solid var(--border2);
      }
      .btn:hover,
      .btn-ghost:hover {
        text-decoration: none;
        filter: brightness(1.08);
      }

      main {
        max-width: 820px;
        margin: 0 auto;
        padding: 24px 32px 64px;
      }
      .breadcrumb {
        font-size: 13px;
        color: var(--muted);
        margin-bottom: 32px;
      }
      .breadcrumb a {
        color: var(--muted);
      }
      h1 {
        font-size: clamp(28px, 4.6vw, 40px);
        line-height: 1.12;
        letter-spacing: -0.025em;
        font-weight: 600;
        margin: 0 0 14px;
        text-wrap: balance;
      }
      .lede {
        color: var(--muted);
        font-size: 17px;
        margin: 0 0 22px;
      }
      .cta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 28px;
      }
      figure {
        margin: 0 0 36px;
      }
      figure img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 12px;
        border: 1px solid var(--border);
      }
      figcaption {
        font-size: 14px;
        color: var(--muted);
        margin-top: 8px;
      }
      h2 {
        font-size: 22px;
        letter-spacing: -0.015em;
        font-weight: 600;
        margin: 36px 0 12px;
      }
      p,
      li {
        color: color-mix(in srgb, var(--text) 86%, var(--muted));
      }
      ul,
      ol {
        padding-left: 22px;
      }
      li {
        margin-bottom: 6px;
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: 12px;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        font-size: 14.5px;
      }
      th,
      td {
        text-align: left;
        padding: 9px 14px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      tr:last-child th,
      tr:last-child td {
        border-bottom: 0;
      }
      thead th {
        font-size: 13px;
        font-weight: 600;
        color: var(--muted);
        background: var(--panel2);
      }
      tbody th {
        font-weight: 500;
        color: var(--muted);
        width: 28%;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      @media (max-width: 760px) {
        main {
          padding-left: 20px;
          padding-right: 20px;
        }
        th,
        td {
          padding: 8px 10px;
          font-size: 13.5px;
        }
        table.results td:first-child {
          min-width: 12em;
        }
      }
    </style>
    <link href="/site.css" rel="stylesheet" />
  </head>

  <body>
    ${siteHeader("examples")}

    <main>
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="/">Home</a> / <a href="/examples/">Examples</a> / ${esc(solidCard.title)}
      </nav>

      <h1>${esc(solidCard.title)}</h1>
      <p class="lede">
        A steel plate in tension. Compare the stress around the hole with
        Kirsch's analytical solution.
      </p>
      <div class="cta">
        <a class="btn" id="open-in-kofem" href="${appPath}">Open in KoFEM</a>
        <a class="btn-ghost" href="/examples/">All examples</a>
      </div>

      <figure>
        <img src="${figurePath}" width="${figure.width}" height="${figure.height}" alt="${esc(figureAlt)}" />
        <figcaption>Von Mises stress in KoFEM web, zoomed to the hole; load along x.</figcaption>
      </figure>

      <h2>Model</h2>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><th scope="row">Plate</th><td>${int(2 * b)} × ${int(2 * b)} × ${int(t)} mm, modelled whole</td></tr>
            <tr><th scope="row">Hole</th><td>Ø ${int(2 * a)} mm, centred (d/W = ${fix(dOverW, 2)})</td></tr>
            <tr><th scope="row">Material</th><td>${esc(ex.material.name)}, linear elastic: E = ${int(ex.material.young_modulus)} MPa, ν = ${ex.material.poisson_ratio}</td></tr>
            <tr><th scope="row">Fixed</th><td>left end face, U<sub>x</sub> = U<sub>y</sub> = U<sub>z</sub> = 0 (${ex.fixed.length} nodes)</td></tr>
            <tr><th scope="row">Load</th><td>right end face, P = ${sci(ex.load.totalForce, 1)} N in +x as a uniform traction: σ = ${int(sigma)} MPa</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Mesh</h2>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><th scope="row">Elements</th><td>${int(hexahedra.length)} linear hexahedra (CHEXA): ${rings} rings × ${sectors} sectors × 1 layer</td></tr>
            <tr><th scope="row">Nodes</th><td>${int(vertices.length)}</td></tr>
            <tr><th scope="row">At the hole</th><td>first ring ${fix(firstRingDepth, 1)} mm deep, ${fix(ringArc, 1)} mm long; the hole is a ${sectors}-sided polygon</td></tr>
            <tr><th scope="row">Stress</th><td>von Mises per element, at the element centre</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Results</h2>
      <div class="table-wrap">
        <table class="results">
          <thead>
            <tr><th>K<sub>t</sub> = peak von Mises / σ</th><th class="num">KoFEM</th><th class="num">Reference</th><th class="num">Difference</th></tr>
          </thead>
          <tbody>
            <tr><td>Kirsch, at the hole edge</td><td class="num" data-testid="kt-fe">${ktStr}</td><td class="num">${fix(ex.reference, 3)}</td><td class="num" data-testid="err-kirsch">${errVsKirsch}</td></tr>
            <tr><td>Kirsch, at the element centre (r = ${fix(peakR / a, 3)}a, θ = ${deg(peakTheta)})</td><td class="num">${ktStr}</td><td class="num">${fix(kirschAtPeak, 3)}</td><td class="num">${errVsPoint}</td></tr>
            <tr><td><a href="/app/?example=${SHELL_ID}">Shell model</a>, ${int(shell.nCells)} CTRIA3</td><td class="num" data-testid="kt-shell">${fix(ktShell, 3)}</td><td class="num">${fix(ex.reference, 3)}</td><td class="num">${pct(ktShell, ex.reference)}</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        The peak element touches the hole, transverse to the load. Its centre
        is ${int(peakR - a)} mm from the edge, where Kirsch's stress has already
        fallen to ${fix(kirschAtPeak, 3)}σ; that, not the solve, is why the
        element value reads below 3.
      </p>

      <h2>Limitations</h2>
      <ul>
        <li>Linear elastic, small strain: no yielding at the hole.</li>
        <li>K<sub>t</sub> = 3 is for an infinite plate; a strip with d/W = ${fix(dOverW, 2)} gives about ${fix(ktHeywood, 2)} (Heywood).</li>
        <li>One mesh, sampled at element centres: a finer first ring moves the value towards 3. Not a convergence study.</li>
        <li>One element through the thickness: close to plane stress, no through-thickness variation.</li>
        <li>A structured hex mesh from a script, not a Netgen mesh of STEP geometry, so it cannot be re-meshed in the app.</li>
      </ul>

      <h2>Reproduce</h2>
      <p>
        <a href="${appPath}">Open in KoFEM</a> loads the solved model; Solve
        re-runs it in the browser with the same result. The model is defined in
        <a href="${REPO}/examples/gallery/examples.mjs"><code>examples.mjs</code></a>,
        this page is written by
        <a href="${REPO}/examples/gallery/generate-plate-hole-page.mjs"><code>generate-plate-hole-page.mjs</code></a>.
      </p>

      <h2>References</h2>
      <ol>
        <li>G. Kirsch, “Die Theorie der Elastizität und die Bedürfnisse der Festigkeitslehre”, <em>Zeitschrift des Vereines deutscher Ingenieure</em> 42 (1898), 797–807.</li>
        <li>R. B. Heywood, <em>Designing by Photoelasticity</em>, Chapman &amp; Hall, 1952.</li>
      </ol>
    </main>

    ${siteFooter()}

  </body>
</html>
`;

writeFileSync(join(site, ex.page, "index.html"), html);
console.log(
  `${pagePath}: Kt ${ktStr} (${errVsKirsch} vs 3, ${errVsPoint} vs Kirsch at r = ${fix(peakR / a, 3)}a, θ = ${deg(peakTheta)}), shell Kt ${fix(ktShell, 3)} → ${join(site, ex.page, "index.html")}`,
);
