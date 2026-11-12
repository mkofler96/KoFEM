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
// OCCT's numbering after a split, a point is what a user clicks. The build
// resolves `at` to the CAD face whose display tessellation contains the point
// (exactly one face within 1e-6 · model size, or it throws); the GUI test
// clicks the screen projection of the same point.
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
// @property {Point} [components]        kind "force": total force [Fx, Fy, Fz] in N
// @property {number} [value]            kind "pressure": MPa along the inward normal;
//                                       kind "moment": N·mm about `axis`
// @property {0 | 1 | 2} [axis]          kind "moment"
//
// @typedef {object} Probe               what the Results panel's hand check reads
//   One of:
//   { kind: "displacement", component: 0|1|2, faces: FaceRef[] }
//       mean displacement component over the nodes of the faces (mm)
//   { kind: "displacement", component: 0|1|2, at: Point }
//       the displacement component at the mesh node nearest `at` (mm)
//   { kind: "twist", axis: 0|1|2, faces: FaceRef[] }
//       mean rotation about `axis` through the faces' node centroid:
//       mean over nodes off the axis of (r × u)_axis / |r⊥|² (rad)
//   { kind: "stress", field: "vonMises", stat: "max", faces?: FaceRef[] }
//       the largest nodal von Mises stress (averaged to the nodes as the app
//       averages it), over the faces' nodes or the whole model (MPa)
//   Any probe may carry `divideBy` (a positive number, e.g. the nominal
//   stress, to read Kt) and must carry `unit` ("mm", "rad", "MPa", "").
//
// @typedef {object} Readout             the hand check on the example's page
// @property {string} quantity           e.g. "Tip deflection"
// @property {Probe} probe
// @property {string} formula            e.g. "−P·L³ / (3·E·I)"
// @property {number} reference          signed like the probe, in its unit
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
// @property {Readout} readout

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
  r.loads.forEach((l, i) => {
    const w = `${at}.loads[${i}]`;
    faceRefs(l.faces, w);
    if (l.kind === "force" && !isPoint(l.components))
      throw new Error(`${w}: a force needs components [Fx, Fy, Fz]`);
    if (l.kind === "pressure" && !Number.isFinite(l.value))
      throw new Error(`${w}: a pressure needs a value`);
    if (
      l.kind === "moment" &&
      (![0, 1, 2].includes(l.axis) || !Number.isFinite(l.value))
    )
      throw new Error(`${w}: a moment needs an axis (0, 1, 2) and a value`);
    if (!["force", "pressure", "moment"].includes(l.kind))
      throw new Error(`${w}: kind must be force, pressure or moment`);
  });
  const ro = r.readout;
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
