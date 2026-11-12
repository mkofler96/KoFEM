// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The recipe of an example (KOF-322): the steps a user takes in the KoFEM GUI
// to build it from one STEP file — import, optional splits, mesh, material,
// supports, loads, solve — and the Results-panel read-out that gives the
// number on its page. One recipe drives three things:
//
//   1. the node-side build (lib/pipeline.mjs): STEP → OCCT → split_geometry →
//      Netgen → app BCs on whole CAD faces → solve, which writes the analysis
//      file, the .step and the published number;
//   2. the GUI test (web/tests/examples-by-hand.spec.ts), which performs the
//      same steps with real clicks and reads the same number in the Results
//      panel;
//   3. the rule check (CI): every example has a recipe, a .step, no hexahedra,
//      every BC on whole CAD faces, and a read-out the Results panel shows.
//
// Units are the app's: N · mm · MPa · tonne.
//
// Faces are named by a point on them (`at`), never by an id: an id depends on
// OCCT's numbering after a split, a point is what a user clicks. Both the
// build and the GUI test resolve `at` with resolveFaceAt() below: the CAD face
// of the display tessellation's triangles nearest the point, within the
// tessellation's chordal deflection (the worker's deflection_relative 0.001 ×
// model size, the bounding-box diagonal of the tessellation — so a point on
// the true surface of a curved face resolves even where the facets cut inside
// it). Exactly one face may lie within that tolerance; none, or two (a point
// on or near an edge), throws. Keep `at` well inside its face, farther than
// that tolerance from every edge. The GUI test clicks the screen projection of
// the same point.
//
// @typedef {[number, number, number]} Point
//
// @typedef {{ at: Point }} FaceRef
//
// @typedef {object} Split               the "Split faces or bodies with a plane…" tool
// @property {"faces" | "bodies"} mode
// @property {FaceRef[]} [faces]         mode "faces": the faces to cut
// @property {Point} origin              a point on the cutting plane
// @property {Point} normal              the plane normal (an axis in the GUI)
//
// @typedef {object} MeshStep            the mesher options a user sets
// @property {number} maxElementSize     mm
// @property {number} [minElementSize]   mm; absent: maxElementSize / 10 (the
//                                       worker's default; the GUI test types
//                                       it into the Mesh panel's min field)
// @property {1 | 2} order               linear or quadratic elements
// @property {{ faces: FaceRef[], size: number }[]} [localSizes]
//                                       per-face sizes, only if the app's
//                                       mesher UI offers them
//
// @typedef {{ kind: "solid" } | { kind: "shell", thickness: number }} Discretization
//
// @typedef {object} Material
// @property {string} name
// @property {number} young              MPa
// @property {number} poisson
// @property {number} density            tonne/mm³
//
// @typedef {object} Support
// @property {string} name
// @property {FaceRef[]} faces
// @property {(0|1|2)[]} dofs            Ux Uy Uz (shells may add 3 4 5 if the app offers them)
// @property {number} value              prescribed displacement, usually 0
//
// @typedef {object} Load
// @property {string} name
// @property {"force" | "pressure" | "moment"} kind
// @property {FaceRef[]} faces
// @property {Point} [components]        kind "force": total force [Fx, Fy, Fz] in N,
//                                       not all zero
// @property {number} [value]            kind "pressure": MPa along the inward normal;
//                                       kind "moment": N·mm about `axis`; non-zero
// @property {0 | 1 | 2} [axis]          kind "moment"
//
// @typedef {object} Probe               what the Results panel's hand check reads
//   One of:
//   { kind: "displacement", component: 0|1|2, faces: FaceRef[] }
//       mean displacement component over the nodes of the faces (mm) — the
//       distinct mesh vertices of the faces' surface triangles
//   { kind: "displacement", component: 0|1|2, at: Point }
//       the displacement component at the mesh node nearest `at` (mm)
//   { kind: "twist", axis: 0|1|2, faces: FaceRef[] }
//       mean rotation about `axis` through the faces' node centroid:
//       mean over nodes off the axis of (r × u)_axis / |r⊥|² (rad), where a
//       node is off the axis when |r⊥| exceeds 1e-6 of the largest |r⊥|
//   { kind: "stress", field: "vonMises", stat: "max", faces?: FaceRef[] }
//       the largest nodal von Mises stress (averaged to the nodes as the app
//       averages it), over the faces' nodes or the whole model (MPa)
//   Any probe may carry `divideBy` (a positive number, e.g. the nominal
//   stress, to read Kt) and must carry `unit` ("mm", "rad", "MPa", "").
//
//   A topology optimisation (`optimize`) is read out by one more kind:
//   { kind: "compliance", unit: "N·mm" }
//       the final compliance F·u of the run: the last iteration's compliance,
//       which the Results panel's Run summary shows as "Final compliance".
//       An optimum has no closed form, so this read-out carries no formula
//       and no reference; the page publishes the app's own value.
//
// @typedef {object} Readout             the hand check on the example's page
// @property {string} quantity           e.g. "Tip deflection"
// @property {Probe} probe
// @property {string} [formula]          e.g. "−P·L³ / (3·E·I)"; none for compliance
// @property {number} [reference]        signed like the probe, in its unit;
//                                       none for compliance
//
// @typedef {object} Optimize            the Optimize panel of a topology-optimisation
//                                       study (SIMP, minimum compliance): the values
//                                       a user types. The run takes the place of the
//                                       static solve.
// @property {"min_compliance"} objective
// @property {number} volumeFraction     "Volume frac.", in (0, 1)
// @property {number} penalty            "Penalty p", ≥ 1
// @property {number} filterRadius       "Filter r_min", mm, > 0
// @property {number} moveLimit          Advanced → "Move limit", in (0, 1]
// @property {number} maxIterations      Advanced → "Max iters", a whole number > 0
// @property {number} tolerance          Advanced → "Tolerance", > 0
//
// @typedef {object} Recipe
// @property {() => string} step         the STEP text of the geometry file the
//                                       page links (written as site/<id>.step)
// @property {Split[]} splits            applied in order, after import
// @property {Discretization} discretization
// @property {MeshStep} mesh
// @property {Material} material
// @property {Support[]} supports
// @property {Load[]} loads
// @property {Optimize} [optimize]       a topology optimisation instead of the
//                                       static solve; read out by "compliance"
// @property {Readout} readout

/** Steel as the app seeds it (web/src/store/materialSlice.ts DEFAULT_MATERIAL). */
export const APP_STEEL = Object.freeze({
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
});

// ── Resolving a face from a point ─────────────────────────────────────────────

/** The worker's tessellation chord tolerance, relative to the model size. */
export const DEFLECTION_RELATIVE = 0.001;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Distance from p to triangle abc (closest point by Voronoi region, Ericson,
 * Real-Time Collision Detection §5.1.5).
 */
export function triangleDistance(p, a, b, c) {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  const vc = d1 * d4 - d3 * d2;
  const vb = d5 * d2 - d1 * d6;
  const va = d3 * d6 - d5 * d4;
  const along = (o, d, t) => [
    o[0] + t * d[0],
    o[1] + t * d[1],
    o[2] + t * d[2],
  ];
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else if (d3 >= 0 && d4 <= d3) q = b;
  else if (d6 >= 0 && d5 <= d6) q = c;
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = along(a, ab, d1 / (d1 - d3));
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = along(a, ac, d2 / (d2 - d6));
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    q = along(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)));
  else {
    const denom = 1 / (va + vb + vc);
    q = along(along(a, ab, vb * denom), ac, vc * denom);
  }
  return Math.sqrt(dot(sub(p, q), sub(p, q)));
}

/** Bounding-box diagonal of points: the "model size". */
export function modelSize(points) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/**
 * The distance from `at` to the nearest triangle of every face, nearest
 * first: [[faceId, distance], …]. `surface` is { points: Point[], triangles:
 * [i, j, k][], faceIds: number[] } — a display tessellation as the store holds
 * it (stepSurface), or a mesh's surface triangles with their CAD face ids.
 */
export function faceDistances(surface, at) {
  const { points, triangles, faceIds } = surface;
  if (triangles.length !== faceIds.length)
    throw new Error(
      `faceDistances: ${triangles.length} triangles but ${faceIds.length} face ids`,
    );
  const best = new Map();
  triangles.forEach(([i, j, k], t) => {
    const d = triangleDistance(at, points[i], points[j], points[k]);
    const prev = best.get(faceIds[t]);
    if (prev === undefined || d < prev) best.set(faceIds[t], d);
  });
  return [...best].sort((x, y) => x[1] - y[1]);
}

/**
 * The CAD face (its 1-based id in `tess.faceIds`) a recipe's `at` names: the
 * one face of the display tessellation within its chordal deflection
 * (DEFLECTION_RELATIVE × model size) of the point. Throws when no face, or more
 * than one (a point on or near an edge), lies within it.
 * @param {{ points: Point[], triangles: [number, number, number][], faceIds: number[] }} tess
 * @param {Point} at
 * @returns {number}
 */
export function resolveFaceAt(tess, at) {
  if (!isPoint(at))
    throw new Error(
      `resolveFaceAt: expected a point, got ${JSON.stringify(at)}`,
    );
  const tol = DEFLECTION_RELATIVE * modelSize(tess.points);
  const dist = faceDistances(tess, at);
  const near = dist.filter(([, d]) => d <= tol).map(([id]) => id);
  if (near.length !== 1) {
    const nearest = dist
      .slice(0, 3)
      .map(([id, d]) => `face ${id} at ${d.toPrecision(3)} mm`)
      .join(", ");
    throw new Error(
      `the point [${at.join(", ")}] must lie on exactly one CAD face (within ${tol.toPrecision(3)} mm), ` +
        `found ${near.length ? `faces [${near.join(", ")}]` : "none"}; nearest: ${nearest}`,
    );
  }
  return near[0];
}

const isPoint = (p) =>
  Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(v));

function faceRefs(refs, where) {
  if (!Array.isArray(refs) || refs.length === 0)
    throw new Error(`${where}: needs at least one face ({ at: [x, y, z] })`);
  refs.forEach((r, i) => {
    if (!r || !isPoint(r.at))
      throw new Error(`${where}.faces[${i}]: expected { at: [x, y, z] }`);
  });
}

/**
 * Checks a recipe's shape and throws a precise error on the first problem.
 * The build and the GUI test both call it, so neither guesses a default.
 * @param {string} id
 * @param {Recipe} r
 */
export function validateRecipe(id, r) {
  const at = `recipe "${id}"`;
  if (!r || typeof r !== "object") throw new Error(`${at}: missing`);
  if (typeof r.step !== "function")
    throw new Error(`${at}: step must be a function returning STEP text`);
  if (!Array.isArray(r.splits))
    throw new Error(`${at}: splits must be an array`);
  r.splits.forEach((s, i) => {
    if (s.mode !== "faces" && s.mode !== "bodies")
      throw new Error(`${at}.splits[${i}]: mode must be "faces" or "bodies"`);
    if (s.mode === "faces") faceRefs(s.faces, `${at}.splits[${i}]`);
    if (!isPoint(s.origin) || !isPoint(s.normal))
      throw new Error(`${at}.splits[${i}]: origin and normal must be points`);
  });
  const d = r.discretization;
  if (!d || (d.kind !== "solid" && d.kind !== "shell"))
    throw new Error(`${at}: discretization.kind must be "solid" or "shell"`);
  if (d.kind === "shell" && !(d.thickness > 0))
    throw new Error(`${at}: a shell needs a positive thickness`);
  if (!(r.mesh?.maxElementSize > 0))
    throw new Error(`${at}: mesh.maxElementSize must be positive`);
  if (
    r.mesh.minElementSize !== undefined &&
    !(
      r.mesh.minElementSize >= 0 &&
      r.mesh.minElementSize <= r.mesh.maxElementSize
    )
  )
    throw new Error(
      `${at}: mesh.minElementSize must lie in [0, maxElementSize]`,
    );
  if (r.mesh.order !== 1 && r.mesh.order !== 2)
    throw new Error(`${at}: mesh.order must be 1 or 2`);
  const m = r.material;
  if (!m || typeof m.name !== "string" || !(m.young > 0) || !(m.density > 0))
    throw new Error(`${at}: material needs name, young > 0 and density > 0`);
  if (!(m.poisson > -1 && m.poisson < 0.5))
    throw new Error(`${at}: material.poisson must lie in (−1, 0.5)`);
  if (!Array.isArray(r.supports) || r.supports.length === 0)
    throw new Error(`${at}: needs at least one support`);
  r.supports.forEach((s, i) => {
    faceRefs(s.faces, `${at}.supports[${i}]`);
    if (!Array.isArray(s.dofs) || s.dofs.length === 0)
      throw new Error(`${at}.supports[${i}]: dofs must be a non-empty array`);
    if (!Number.isFinite(s.value))
      throw new Error(`${at}.supports[${i}]: value must be a number`);
  });
  if (!Array.isArray(r.loads) || r.loads.length === 0)
    throw new Error(`${at}: needs at least one load`);
  // A load the app's Load panel would refuse is refused here too, by the same
  // rule (web/src/components/panel/bcFormUtils.ts): a pressure must be non-zero
  // (parsePressure), a force or moment vector must not be all zero
  // (parseLoadVector) — a recipe's moment is one non-zero component.
  r.loads.forEach((l, i) => {
    const w = `${at}.loads[${i}]`;
    faceRefs(l.faces, w);
    if (l.kind === "force" && !isPoint(l.components))
      throw new Error(`${w}: a force needs components [Fx, Fy, Fz]`);
    if (l.kind === "force" && l.components.every((v) => v === 0))
      throw new Error(`${w}: an all-zero force — the app rejects it`);
    if (l.kind === "pressure" && !Number.isFinite(l.value))
      throw new Error(`${w}: a pressure needs a value`);
    if (l.kind === "pressure" && l.value === 0)
      throw new Error(`${w}: a zero pressure — the app rejects it`);
    if (
      l.kind === "moment" &&
      (![0, 1, 2].includes(l.axis) || !Number.isFinite(l.value))
    )
      throw new Error(`${w}: a moment needs an axis (0, 1, 2) and a value`);
    if (l.kind === "moment" && l.value === 0)
      throw new Error(`${w}: a zero moment — the app rejects it`);
    if (!["force", "pressure", "moment"].includes(l.kind))
      throw new Error(`${w}: kind must be force, pressure or moment`);
  });
  const ro = r.readout;
  if (r.optimize !== undefined || ro?.probe?.kind === "compliance")
    return validateOptimization(at, r);
  if (!ro || typeof ro.quantity !== "string" || typeof ro.formula !== "string")
    throw new Error(`${at}: readout needs quantity and formula`);
  if (!Number.isFinite(ro.reference))
    throw new Error(`${at}: readout.reference must be a number`);
  const p = ro.probe;
  if (!p || typeof p.unit !== "string")
    throw new Error(`${at}: readout.probe needs a unit`);
  if (p.divideBy !== undefined && !(p.divideBy > 0))
    throw new Error(`${at}: readout.probe.divideBy must be positive`);
  if (p.kind === "displacement") {
    if (![0, 1, 2].includes(p.component))
      throw new Error(`${at}: displacement probe needs component 0, 1 or 2`);
    if ((p.faces === undefined) === (p.at === undefined))
      throw new Error(
        `${at}: displacement probe needs exactly one of faces or at`,
      );
    if (p.faces) faceRefs(p.faces, `${at}.readout.probe`);
    else if (!isPoint(p.at)) throw new Error(`${at}: probe.at must be a point`);
  } else if (p.kind === "twist") {
    if (![0, 1, 2].includes(p.axis))
      throw new Error(`${at}: twist probe needs axis 0, 1 or 2`);
    faceRefs(p.faces, `${at}.readout.probe`);
  } else if (p.kind === "stress") {
    if (p.field !== "vonMises" || p.stat !== "max")
      throw new Error(
        `${at}: stress probe supports field "vonMises", stat "max"`,
      );
    if (p.faces !== undefined) faceRefs(p.faces, `${at}.readout.probe`);
  } else throw new Error(`${at}: unknown probe kind "${p.kind}"`);
}

// A topology-optimisation recipe: the Optimize panel's settings, read out by
// the final compliance, and nothing a static read-out has.
function validateOptimization(at, r) {
  const o = r.optimize;
  if (!o || typeof o !== "object")
    throw new Error(
      `${at}: a compliance read-out needs an optimize step (the Optimize panel's settings)`,
    );
  if (o.objective !== "min_compliance")
    throw new Error(
      `${at}: optimize.objective must be "min_compliance", the objective a compliance read-out reports`,
    );
  const check = (key, ok, requirement) => {
    if (typeof o[key] !== "number" || !ok(o[key]))
      throw new Error(`${at}: optimize.${key} must be ${requirement}`);
  };
  check("volumeFraction", (v) => v > 0 && v < 1, "in (0, 1)");
  check("penalty", (v) => v >= 1, "≥ 1");
  check("filterRadius", (v) => v > 0, "positive");
  check("moveLimit", (v) => v > 0 && v <= 1, "in (0, 1]");
  check(
    "maxIterations",
    (v) => Number.isInteger(v) && v > 0,
    "a whole number > 0",
  );
  check("tolerance", (v) => v > 0, "positive");
  if (r.mesh.order !== 1)
    throw new Error(
      `${at}: the optimizer runs on linear tetrahedra; mesh.order must be 1`,
    );
  const ro = r.readout;
  if (!ro || typeof ro.quantity !== "string")
    throw new Error(`${at}: readout needs a quantity`);
  if (ro.probe?.kind !== "compliance" || ro.probe.unit !== "N·mm")
    throw new Error(
      `${at}: an optimisation is read out by its final compliance, probe { kind: "compliance", unit: "N·mm" }`,
    );
  if (ro.probe.divideBy !== undefined)
    throw new Error(`${at}: a compliance probe takes no divideBy`);
  if (ro.formula !== undefined || ro.reference !== undefined)
    throw new Error(
      `${at}: an optimum has no closed form, so a compliance read-out carries no formula or reference`,
    );
}
