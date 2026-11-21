// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Solve the coupling article's models (coupling-models.mjs) through the app's
// Rust solve and compare them with the committed record; never transcribe
// measured values into the article. --report records a new snapshot: the
// numbers (public/theory/couplings.json), the 3D viewer payloads and their
// static section figures (public/theory/viewers/coupling-*.{json,png}).
//
//   bun theory/numerical-methods/coupling-evidence.mjs            # check (from web/)
//   bun theory/numerical-methods/coupling-evidence.mjs --report   # record
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { femModuleId } from "../../../examples/validation/lib/provenance.mjs";
import {
  renderPng,
  pngSize,
} from "../../../examples/validation/lib/render.mjs";
import { clipSurface, sectionMesh } from "../../public/theory/section.js";
import {
  BAR,
  KINDS,
  MATERIAL,
  SCREW,
  cantilever,
  screwHead,
} from "./coupling-models.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const publicTheory = new URL("../../public/theory/", import.meta.url);
const recordFile = new URL("couplings.json", publicTheory);
const report = process.argv.includes("--report");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const point = (model, id) => [
  model.nodes[id].x,
  model.nodes[id].y,
  model.nodes[id].z,
];
const translation = (result, id) =>
  [0, 1, 2].map((k) => result.displacements[3 * id + k]);

/** Solve a 3×3 system by Cramer's rule. */
function solve3(a, b) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(a);
  if (!(Math.abs(d) > 0)) throw new Error("singular rigid fit");
  return [0, 1, 2]
    .map((col) =>
      det(a.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)))),
    )
    .map((v) => v / d);
}

/**
 * The least-squares rigid rotation of a set of nodes, about their centroid —
 * the motion a distributing coupling measures, and exactly the motion of a
 * patch a kinematic coupling holds rigid.
 */
function rigidRotation(model, result, ids) {
  const centre = [0, 0, 0];
  const mean = [0, 0, 0];
  for (const id of ids)
    for (let k = 0; k < 3; k++) {
      centre[k] += point(model, id)[k] / ids.length;
      mean[k] += result.displacements[3 * id + k] / ids.length;
    }
  const inertia = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const moment = [0, 0, 0];
  for (const id of ids) {
    const r = point(model, id).map((v, k) => v - centre[k]);
    const u = translation(result, id).map((v, k) => v - mean[k]);
    const rr = r[0] ** 2 + r[1] ** 2 + r[2] ** 2;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        inertia[i][j] += (i === j ? rr : 0) - r[i] * r[j];
    moment[0] += r[1] * u[2] - r[2] * u[1];
    moment[1] += r[2] * u[0] - r[0] * u[2];
    moment[2] += r[0] * u[1] - r[1] * u[0];
  }
  return solve3(inertia, moment);
}

/** The largest distance of a node from the set's best-fit rigid motion. */
function rigidResidual(model, result, ids) {
  const centre = [0, 0, 0];
  const mean = [0, 0, 0];
  for (const id of ids)
    for (let k = 0; k < 3; k++) {
      centre[k] += point(model, id)[k] / ids.length;
      mean[k] += result.displacements[3 * id + k] / ids.length;
    }
  const theta = rigidRotation(model, result, ids);
  return Math.max(
    ...ids.map((id) => {
      const r = point(model, id).map((v, k) => v - centre[k]);
      const rigid = [
        mean[0] + theta[1] * r[2] - theta[2] * r[1],
        mean[1] + theta[2] * r[0] - theta[0] * r[2],
        mean[2] + theta[0] * r[1] - theta[1] * r[0],
      ];
      return Math.hypot(...translation(result, id).map((v, k) => v - rigid[k]));
    }),
  );
}

/**
 * uz along the line y = 0 of the top face z = thickness, sampled at `xs` by
 * linear interpolation on its surface triangles (the vertex field a linear
 * triangle carries).
 */
function topProfile(built, xs) {
  const { mesh, model, result } = built;
  const tris = [];
  for (let t = 0; t < mesh.surfaceTriangles.length / 3; t++) {
    const tri = [0, 1, 2].map((k) => mesh.surfaceTriangles[3 * t + k]);
    if (tri.every((id) => Math.abs(model.nodes[id].z - SCREW.thickness) < 1e-6))
      tris.push(tri);
  }
  return xs.map((x) => {
    for (const tri of tris) {
      const [a, b, c] = tri.map((id) => point(model, id));
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      const l1 =
        ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (0 - a[1])) / det;
      const l2 =
        ((b[0] - a[0]) * (0 - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
      const l0 = 1 - l1 - l2;
      if (l0 >= -1e-9 && l1 >= -1e-9 && l2 >= -1e-9)
        return [l0, l1, l2].reduce(
          (sum, l, k) => sum + l * result.displacements[3 * tri[k] + 2],
          0,
        );
    }
    throw new Error(`no triangle of the top face contains (${x}, 0)`);
  });
}

/** Largest element (centre) von Mises stress in each band of width `band` along z. */
function bandPeaks(built, band) {
  const { model, result } = built;
  const peaks = new Map();
  model.elements.forEach((element, e) => {
    const z = element.nodeIds.reduce((s, id) => s + model.nodes[id].z, 0) / 4;
    const key = Math.min(Math.floor(z / band), BAR.length / band - 1);
    peaks.set(key, Math.max(peaks.get(key) ?? 0, result.vonMises[e]));
  });
  return [...peaks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, peak]) => [(key + 0.5) * band, peak]);
}

const maxOver = (values, ids) => Math.max(...ids.map((id) => values[id]));

/**
 * The solved displacement at any point of the solid, interpolated linearly
 * over the tetrahedron that contains it (the vertex field of a linear
 * tetrahedron). A point on the curved bore lies a hair outside the faceted
 * mesh, so the tetrahedron that comes closest to containing it is used.
 */
function sampler(built) {
  const { model, result } = built;
  const cell = 2;
  const bins = new Map();
  const tets = model.elements.map((element) =>
    element.nodeIds.map((id) => point(model, id)),
  );
  tets.forEach((corners, e) => {
    const lo = [0, 1].map((k) =>
      Math.floor(Math.min(...corners.map((c) => c[k])) / cell),
    );
    const hi = [0, 1].map((k) =>
      Math.floor(Math.max(...corners.map((c) => c[k])) / cell),
    );
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++) {
        const key = `${i},${j}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(e);
      }
  });
  const barycentric = ([a, b, c, d], p) => {
    const m = [0, 1, 2].map((k) => [b[k] - a[k], c[k] - a[k], d[k] - a[k]]);
    const [l1, l2, l3] = solve3(
      m,
      [0, 1, 2].map((k) => p[k] - a[k]),
    );
    return [1 - l1 - l2 - l3, l1, l2, l3];
  };
  return (p) => {
    let best = null;
    const key = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    for (const e of bins.get(key) ?? []) {
      const weights = barycentric(tets[e], p);
      const worst = Math.min(...weights);
      if (!best || worst > best.worst) best = { e, weights, worst };
    }
    if (!best || best.worst < -0.05)
      throw new Error(`no tetrahedron near (${p.join(", ")})`);
    const ids = model.elements[best.e].nodeIds;
    return [0, 1, 2].map((k) =>
      best.weights.reduce(
        (sum, w, i) => sum + w * result.displacements[3 * ids[i] + k],
        0,
      ),
    );
  };
}

/** How far from the axis the article's section figure reaches (mm). */
const SECTION_REACH = 11;

/**
 * The structured grid the article's section figure draws on the plane y = 0,
 * around the hole: from the hole edge to the head's edge in four cells, then
 * out to SECTION_REACH in cells of about 0.75 mm, mirrored; six layers through
 * the thickness. The bore's back wall (y > 0, seen through the hole) is
 * sampled at 15° steps.
 */
function sectionGrid() {
  const { holeRadius: a, headRadius: r, thickness: t } = SCREW;
  const outer = Math.round((SECTION_REACH - r) / 0.75);
  const right = [
    ...Array.from({ length: 5 }, (_, i) => a + (i * (r - a)) / 4),
    ...Array.from(
      { length: outer },
      (_, i) => r + ((i + 1) * (SECTION_REACH - r)) / outer,
    ),
  ];
  return {
    xs: [...right.map((x) => -x).reverse(), ...right],
    zs: Array.from({ length: 7 }, (_, k) => (k * t) / 6),
    phis: Array.from({ length: 13 }, (_, i) => i * 15),
  };
}

// ── The record ───────────────────────────────────────────────────────────────

const G = MATERIAL.young / (2 * (1 + MATERIAL.poisson));
const I = BAR.side ** 4 / 12;
const A = BAR.side ** 2;
// Saint-Venant torsion of a square section (Timoshenko & Goodier, table of
// rectangular sections, b/a = 1): J = 0.1406 a⁴, τ_max = T / (0.208 a³).
const J = 0.1406 * BAR.side ** 4;
const theory = {
  eulerBernoulliDeflection:
    (BAR.force * BAR.length ** 3) / (3 * MATERIAL.young * I),
  shearDeflection: (BAR.force * BAR.length) / ((5 / 6) * G * A),
  saintVenantTwist: (BAR.torque * BAR.length) / (G * J),
  saintVenantVonMises: (Math.sqrt(3) * BAR.torque) / (0.208 * BAR.side ** 3),
};

const profileXs = Array.from(
  { length: 4 * SCREW.halfWidth + 1 },
  (_, i) => -SCREW.halfWidth + i * 0.5,
).filter((x) => Math.abs(x) >= SCREW.holeRadius);

const solved = { screw: {}, bending: {}, torsion: {} };
const record = {
  material: MATERIAL,
  screw: { model: SCREW, grid: sectionGrid(), kinds: {} },
  bar: { model: BAR, theory, bending: {}, torsion: {} },
};
for (const kind of KINDS) {
  const screw = (solved.screw[kind] = await screwHead(kind));
  const plateNodes = screw.model.elements.flatMap((e) => e.nodeIds);
  const near = [...new Set(plateNodes)].filter(
    (id) =>
      Math.hypot(screw.model.nodes[id].x, screw.model.nodes[id].y) <=
      2 * SCREW.headRadius,
  );
  // How far the coupled ring departs from a rigid motion: the largest
  // distance of a ring node from where the ring's best-fit rigid motion
  // (about its centroid) would put it.
  const ringDeformation = rigidResidual(screw.model, screw.result, screw.ring);
  const at = sampler(screw);
  const grid = sectionGrid();
  const rad = (deg) => (deg * Math.PI) / 180;
  record.screw.kinds[kind] = {
    pointDeflection: -translation(screw.result, screw.point)[2],
    ringDeformation,
    section: grid.zs.map((z) => grid.xs.map((x) => at([x, 0, z]))),
    boreBack: grid.zs.map((z) =>
      grid.phis.map((phi) =>
        at([
          SCREW.holeRadius * Math.cos(rad(phi)),
          SCREW.holeRadius * Math.sin(rad(phi)),
          z,
        ]),
      ),
    ),
    peakNearHead: maxOver(screw.result.nodalVonMises, near),
    profile: topProfile(screw, profileXs).map((uz, i) => [profileXs[i], uz]),
  };

  const bending = (solved.bending[kind] = await cantilever(kind, "bending"));
  record.bar.bending[kind] = {
    tipDeflection: -translation(bending.result, bending.point)[1],
  };

  const torsion = (solved.torsion[kind] = await cantilever(kind, "torsion"));
  const slab = (z) =>
    [...new Set(torsion.model.elements.flatMap((e) => e.nodeIds))].filter(
      (id) => Math.abs(torsion.model.nodes[id].z - z) <= 1,
    );
  record.bar.torsion[kind] = {
    tipTwist: rigidRotation(torsion.model, torsion.result, torsion.ring)[2],
    twistOneSideFromTip: rigidRotation(
      torsion.model,
      torsion.result,
      slab(BAR.length - BAR.side),
    )[2],
    bandPeaks: bandPeaks(torsion, BAR.side / 4),
  };
}

const niceBelow = (value) => {
  const power = 10 ** Math.floor(Math.log10(value));
  return [5, 2, 1].map((m) => m * power).find((v) => v <= value);
};
// One enlargement for the article's section figure and the screw viewers:
// the deepest point of the section drawn 1.2 mm deep.
const deepest = Math.max(
  ...Object.values(record.screw.kinds).flatMap((kind) =>
    kind.section.flat().map(([, , uz]) => -uz),
  ),
);
record.screw.enlargement = niceBelow(1.2 / deepest);

// ── Check or record ──────────────────────────────────────────────────────────

/** Every number in the record, by its path. */
function flatten(value, path = "", out = new Map()) {
  if (typeof value === "number") out.set(path, value);
  else if (Array.isArray(value))
    value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object")
    for (const [key, v] of Object.entries(value))
      flatten(v, path ? `${path}.${key}` : key, out);
  return out;
}

if (!report) {
  const committed = JSON.parse(readFileSync(recordFile, "utf8"));
  const expected = flatten({
    material: committed.material,
    screw: committed.screw,
    bar: committed.bar,
  });
  const actual = flatten(record);
  const problems = [];
  for (const [path, value] of expected) {
    const now = actual.get(path);
    // Both runs stop the solver at the same tolerance on the same mesh; the
    // numbers agree far inside this, and a changed formulation moves them far
    // outside it.
    if (
      now === undefined ||
      Math.abs(now - value) > 1e-6 * Math.max(1, Math.abs(value))
    )
      problems.push(`${path}: recorded ${value}, now ${now}`);
  }
  for (const path of actual.keys())
    if (!expected.has(path)) problems.push(`${path}: not in the record`);
  if (problems.length > 0) {
    console.error(
      `The coupling comparisons no longer match public/theory/couplings.json:\n  ${problems.slice(0, 20).join("\n  ")}\nInvestigate the change; record a new snapshot with --report only once it is understood.`,
    );
    process.exit(1);
  }
  console.log(
    `Coupling comparisons match their record (${expected.size} numbers).`,
  );
  process.exit(0);
}

// ── Viewer payloads and their static section figures ────────────────────────

const round = (value, digits) => Number(value.toPrecision(digits));

/** A viewer payload of one solved model, on the vertex nodes its elements use. */
function payload(id, built, { title, range, deformScale, section, view }) {
  const { model, mesh, result, ring } = built;
  const used = [...new Set(model.elements.flatMap((e) => e.nodeIds))].sort(
    (a, b) => a - b,
  );
  const index = new Map(used.map((n, i) => [n, i]));
  const at = (n) => {
    const i = index.get(n);
    if (i === undefined)
      throw new Error(`${id}: node ${n} is not in the solid`);
    return i;
  };
  const triangles = Array.from(mesh.surfaceTriangles, at);
  const edges = new Set();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  // At most 48 spider legs, spread evenly over the coupled nodes.
  const step = Math.max(1, Math.ceil(ring.length / 48));
  const legs = [...ring].sort((a, b) => a - b).filter((_, i) => i % step === 0);
  return {
    id,
    title,
    field: "von Mises stress",
    unit: "MPa",
    min: range[0],
    max: range[1],
    deformScale,
    section,
    view,
    positions: used.flatMap((n) => point(model, n).map((v) => round(v, 7))),
    displacements: used.flatMap((n) =>
      translation(result, n).map((v) => round(v, 6)),
    ),
    values: used.map((n) => round(result.nodalVonMises[n], 5)),
    triangles,
    edges: [...edges].flatMap((key) => key.split(",").map(Number)),
    tets: model.elements.flatMap((e) => e.nodeIds.map(at)),
    spider: {
      origin: point(model, built.point),
      originDisplacement: translation(result, built.point).map((v) =>
        round(v, 6),
      ),
      targets: legs.map(at),
    },
  };
}

/** Keep the part of a cut surface with |x[axis]| ≤ reach. */
function crop(surface, axis, reach) {
  const mirror = (positions) =>
    positions.map((v, i) => (i % 3 === axis ? -v : v));
  const near = clipSurface(surface, axis, reach);
  const both = clipSurface(
    { ...near, positions: mirror(near.positions) },
    axis,
    reach,
  );
  return { ...both, positions: mirror(both.positions) };
}

/**
 * The static figure: the deformed model, cut by its default section and seen
 * along its view. A view with a `target` frames a box of half-width `half`
 * about it, and a `crop` keeps only the part of the model drawn there.
 */
function sectionFigure(data, cropTo) {
  const n = data.values.length;
  const deformed = data.positions.map(
    (v, i) => v + data.deformScale * data.displacements[i],
  );
  let cut = sectionMesh(
    {
      positions: deformed,
      values: data.values,
      triangles: data.triangles,
      tets: data.tets,
    },
    data.section.axis,
    data.section.level,
  );
  if (cropTo) cut = crop(cut, cropTo.axis, cropTo.reach);
  if (n === 0 || cut.triangles.length === 0)
    throw new Error(`${data.id}: the default section cuts nothing`);
  const { direction, up, target, half, aspect } = data.view;
  return renderPng(
    {
      positions: cut.positions,
      displacements: new Array(cut.positions.length).fill(0),
      scalars: cut.values,
      triangles: cut.triangles,
      edgeMask: new Array(cut.triangles.length / 3).fill(0),
    },
    {
      width: 900,
      view: direction,
      up,
      deformScale: 0,
      range: [data.min, data.max],
      ...(target ? { focus: { center: target, half, aspect } } : {}),
    },
  );
}

const pairs = [
  {
    key: "screw",
    title: (kind) =>
      `Screw head, ${kind === "kinematic" ? "kinematic (RBE2)" : "distributing (RBE3)"}`,
    // Cut through the screw axis (y = 0), keeping y ≤ 0, seen square on to
    // the cut and framed around the hole: the section of the article's
    // figure, at its enlargement.
    section: { axis: 1, level: 0 },
    view: {
      direction: [0, -1, 0],
      up: [0, 0, 1],
      target: [0, 0, SCREW.thickness / 2],
      half: SECTION_REACH + 1,
      aspect: 0.32,
    },
    crop: { axis: 0, reach: SECTION_REACH },
    deformScale: () => record.screw.enlargement,
  },
  {
    key: "torsion",
    title: (kind) =>
      `Bar in torsion, ${kind === "kinematic" ? "kinematic (RBE2)" : "distributing (RBE3)"}`,
    // Cut along the bar axis (x = 0), keeping x ≤ 0, seen from +x.
    section: { axis: 0, level: 0 },
    view: { direction: [-1, -0.45, -0.5], up: [0, 1, 0], fit: 1 },
    crop: null,
    deformScale: (size, maxU) => niceBelow((0.08 * size) / maxU),
  },
];
record.viewers = {};
for (const pair of pairs) {
  const models = KINDS.map((kind) => solved[pair.key][kind]);
  const values = models.flatMap((m) => {
    const used = new Set(m.model.elements.flatMap((e) => e.nodeIds));
    return [...used].map((n) => m.result.nodalVonMises[n]);
  });
  const range = [0, round(Math.max(...values), 4)];
  const size = Math.max(
    ...[0, 1, 2].map((k) => {
      const c = models[0].model.nodes.map(
        (node) => [node.x, node.y, node.z][k],
      );
      return Math.max(...c) - Math.min(...c);
    }),
  );
  const maxU = Math.max(
    ...models.flatMap((m) => Array.from(m.result.displacements, Math.abs)),
  );
  const deformScale = pair.deformScale(size, maxU);
  for (const [i, kind] of KINDS.entries()) {
    const id = `coupling-${pair.key}-${kind}`;
    const data = payload(id, models[i], {
      title: pair.title(kind),
      range,
      deformScale,
      section: pair.section,
      view: pair.view,
    });
    writeFileSync(
      new URL(`viewers/${id}.json`, publicTheory),
      `${JSON.stringify(data)}\n`,
    );
    const png = sectionFigure(data, pair.crop);
    writeFileSync(new URL(`viewers/${id}.png`, publicTheory), png);
    record.viewers[id] = {
      title: data.title,
      range,
      deformScale,
      ...pngSize(png),
    };
  }
}

writeFileSync(
  recordFile,
  `${JSON.stringify(
    {
      sourceRevision: git("rev-parse", "HEAD"),
      femModule: femModuleId(),
      recordedAt: new Date().toISOString(),
      ...record,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Recorded ${fileURLToPath(recordFile)} and ${Object.keys(record.viewers).length} viewers.`,
);
