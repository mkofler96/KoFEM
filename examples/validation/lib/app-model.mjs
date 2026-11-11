// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// An example as the app holds it, and the three things made from it:
//
//   solveModel()    the solve, with the loads built exactly as the app builds
//                   them (web/src/store/boundarySlice.ts), so the number on an
//                   example's page is the number the app computes;
//   analysisFile()  the .vtu that /app/?example=<id> opens (the format of
//                   web/src/lib/analysisFile.ts);
//   resultSurface() the solved boundary surface, for the page's figure.
//
// A model, in the app's units (N · mm · MPa · tonne):
//
//   { title,                                  the model name in the app
//     mesh: { vertices, hexahedra },          8-node hexahedra
//     bodies?,                                body (property id) per hex; all 1
//     material: { name, young_modulus, poisson_ratio, density },
//     order,                                  1 linear, 2 quadratic
//     support: { nodes, label },              Ux Uy Uz fixed
//       or supports: [{ nodes, label, dofs }] each fixing the listed DOFs
//     load: { kind, axis, value, nodes, label },
//     ties?: [{ name, a: { nodes, label }, b: { nodes, label },
//               extent, searchDistance, method }],
//     tieFormulation?,                        override how ties weigh their
//                                             nodes ("mortar" | "projection");
//                                             the app picks it from the order
//     resultType }                            the field the app shows
//
// `load.kind` is "force" (value in N along `axis`), "moment" (N·mm about
// `axis`) or "pressure" (MPa, along the inward normal; no axis). Node lists are
// 0-based vertex indices. A tie joins two separately meshed bodies exactly as
// the app's Tie connection does (web/src/lib/tie.ts); only the constraint
// method ("mpc", web/src/lib/tieConstraints.ts) is supported here, and it is
// computed by the app's own code — so a model with ties runs under Bun, which
// loads that TypeScript directly.

// The app's constraint tie, loaded only when Bun can run its TypeScript; the
// examples without ties keep running under plain Node.
const appTies = globalThis.Bun
  ? await import("../../../web/src/lib/tieConstraints.ts")
  : null;

/** The supports of a model: `supports`, or the single clamp `support`. */
export function supportsOf(model) {
  if (model.supports) return model.supports;
  return [{ ...model.support, dofs: [0, 1, 2] }];
}

/** The body (property id) of every hex. */
export function bodiesOf(model) {
  const bodies = model.bodies ?? model.mesh.hexahedra.map(() => 1);
  if (bodies.length !== model.mesh.hexahedra.length)
    throw new Error(
      `model "${model.title}": ${bodies.length} bodies for ${model.mesh.hexahedra.length} hexahedra`,
    );
  return bodies;
}

// The app's tie definitions for a model (web/src/lib/tie.ts TieDefinition),
// in 0-based vertex ids.
function tieDefinitions(model) {
  return model.ties.map((tie) => {
    if (tie.method !== "mpc")
      throw new Error(
        `tie "${tie.name}": the validation models support the constraint method only, got "${tie.method}"`,
      );
    return {
      name: tie.name,
      facesA: [{ nodeIds: tie.a.nodes }],
      facesB: [{ nodeIds: tie.b.nodes }],
      extent: tie.extent,
      searchDistance: tie.searchDistance,
      method: tie.method,
    };
  });
}

/**
 * The constraints the model's ties make, computed by the app's own code: one
 * per tied node, `{ tie, slaveId, masterIds, weights, point, distance }`
 * (web/src/lib/tieConstraints.ts), in vertex indices. Refuses a tie that
 * joins nothing, as the app's solve does.
 */
export function tieConstraintsOf(model) {
  if (!model.ties?.length) return [];
  if (!appTies)
    throw new Error(
      `model "${model.title}" has ties, which are computed by the app's TypeScript: run it with Bun (cd web && bun ../examples/validation/run.mjs)`,
    );
  const bodies = bodiesOf(model);
  const { constraints, reports } = appTies.tieConstraints(
    model.mesh.vertices.map(([x, y, z], id) => ({ id, x, y, z })),
    model.mesh.hexahedra.map((nodeIds, e) => ({
      nodeIds,
      propertyId: bodies[e],
    })),
    tieDefinitions(model),
    model.tieFormulation ?? appTies.tieFormulation(model.order),
  );
  for (const report of reports)
    if (report.nPaired === 0 && report.nShared === 0)
      throw new Error(`tie "${report.name}" connected no nodes`);
  return constraints;
}

// The engine's CSR form of the tie constraints (engine/cpp/tie_constraints.h).
function engineTieConstraints(constraints) {
  const slave = [];
  const offsets = [0];
  const master = [];
  const weights = [];
  for (const c of constraints) {
    slave.push(c.slaveId);
    master.push(...c.masterIds);
    weights.push(...c.weights);
    offsets.push(master.length);
  }
  return { slave, offsets, master, weights };
}

// Steel as the app seeds it (web/src/store/modelStore.ts).
export const STEEL = {
  name: "Steel",
  young_modulus: 210000,
  poisson_ratio: 0.3,
  density: 7.85e-9,
};

const HEX_FACES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 3, 7, 4],
  [1, 2, 6, 5],
];

// Every hex face whose four nodes all belong to `nodes`, once each: the app's
// loadedFaces(). The engine matches them to its boundary elements by vertex
// set, so the winding does not matter.
export function facesOn(hexahedra, nodes) {
  const inSet = new Set(nodes);
  const seen = new Set();
  const faces = [];
  for (const hex of hexahedra)
    for (const local of HEX_FACES) {
      const face = local.map((i) => hex[i]);
      if (!face.every((v) => inSet.has(v))) continue;
      const key = [...face].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push(face);
    }
  if (!faces.length)
    throw new Error("the loaded node set spans no element face");
  return faces;
}

// The app's momentToNodalForces(): tangential forces F = (M/S)·(axis × r)
// about the centroid of the loaded nodes, S = Σ|r⊥|². Zero net force, net
// moment M.
function momentForces(vertices, nodes, axis, moment) {
  const c = [0, 1, 2].map(
    (k) => nodes.reduce((s, v) => s + vertices[v][k], 0) / nodes.length,
  );
  const r = (v) => [0, 1, 2].map((k) => vertices[v][k] - c[k]);
  const perp = ([x, y, z]) =>
    axis === 0 ? y * y + z * z : axis === 1 ? x * x + z * z : x * x + y * y;
  const S = nodes.reduce((s, v) => s + perp(r(v)), 0);
  if (S === 0) throw new Error("every loaded node lies on the moment axis");
  const k = moment / S;
  return nodes.map((vertex) => {
    const [x, y, z] = r(vertex);
    const force =
      axis === 0
        ? [0, -k * z, k * y]
        : axis === 1
          ? [k * z, 0, -k * x]
          : [-k * y, k * x, 0];
    return { vertex, force };
  });
}

/** The engine's boundary conditions for a model, built as the app builds them. */
export function solverBcs(model) {
  const { vertices, hexahedra } = model.mesh;
  const { kind, axis, value, nodes } = model.load;
  // The app's groupDirichlet(): the DOFs every support fixes, per node; a node
  // with all three is fully fixed.
  const dofsByNode = new Map();
  for (const support of supportsOf(model))
    for (const v of support.nodes) {
      const dofs = dofsByNode.get(v) ?? new Set();
      for (const dof of support.dofs) dofs.add(dof);
      dofsByNode.set(v, dofs);
    }
  const bcs = { fixed_vertices: [], fixed_dofs: [] };
  for (const [vertex, dofs] of dofsByNode)
    if (dofs.size === 3) bcs.fixed_vertices.push(vertex);
    else bcs.fixed_dofs.push({ vertex, dofs: [...dofs].sort() });
  const ties = tieConstraintsOf(model);
  if (ties.length) bcs.tie_constraints = engineTieConstraints(ties);
  if (kind === "force") {
    const force = [0, 0, 0];
    force[axis] = value;
    bcs.surface_loads = [
      { type: "force", force, faces: facesOn(hexahedra, nodes) },
    ];
  } else if (kind === "pressure") {
    bcs.surface_loads = [
      { type: "pressure", pressure: value, faces: facesOn(hexahedra, nodes) },
    ];
  } else if (kind === "moment") {
    bcs.point_loads = momentForces(vertices, nodes, axis, value);
  } else throw new Error(`unknown load kind "${kind}"`);
  return bcs;
}

export function solveModel(solve, model) {
  return solve(model.mesh, model.material, solverBcs(model), model.order);
}

// ── The analysis file ─────────────────────────────────────────────────────────

function fieldData(json) {
  const data = Buffer.from(json, "utf8");
  const bytes = Buffer.alloc(4 + data.length);
  bytes.writeUInt32LE(data.length, 0);
  data.copy(bytes, 4);
  return { b64: bytes.toString("base64"), byteLength: data.length };
}

const dataArray = (type, name, body, components) =>
  `<DataArray type="${type}" Name="${name}"${components === undefined ? "" : ` NumberOfComponents="${components}"`} format="ascii">\n${body}\n</DataArray>`;

const tuples = (values, stride) => {
  const lines = [];
  for (let i = 0; i < values.length; i += stride)
    lines.push(values.slice(i, i + stride).join(" "));
  return lines.join("\n");
};

/** The setup the app restores from the file: materials, support, load. */
export function analysisSetup(model) {
  const { hexahedra } = model.mesh;
  const { kind, axis, value } = model.load;
  const ids = (nodes) => nodes.map((v) => v + 1); // node ids are 1-based
  const group =
    kind === "pressure"
      ? { dof: 0, totalForce: value, kind }
      : { dof: kind === "moment" ? 3 + axis : axis, totalForce: value, kind };
  // Face entries are numbered across every group, as the app numbers them.
  let faceId = 0;
  const entry = ({ label, nodes }) => ({
    id: ++faceId,
    label,
    nodeIds: ids(nodes),
  });
  const bcGroups = supportsOf(model).map((support, i) => ({
    id: i + 1,
    name: `BC${i + 1}`,
    dofs: support.dofs,
    value: 0,
    faces: [entry(support)],
  }));
  const loadGroups = [
    { id: 1, name: "Load1", ...group, faces: [entry(model.load)] },
  ];
  const tieGroups = (model.ties ?? []).map((tie, i) => ({
    id: i + 1,
    name: tie.name,
    facesA: [entry(tie.a)],
    facesB: [entry(tie.b)],
    extent: tie.extent,
    searchDistance: tie.searchDistance,
    method: tie.method,
  }));
  const bodyIds = [...new Set(bodiesOf(model))].sort((p, q) => p - q);
  return {
    format: "kofem-analysis",
    version: 1,
    modelName: model.title,
    mode: "results",
    viewRepr: "surface",
    resultType: model.resultType,
    elementTypes: hexahedra.map(() => "CHEXA"),
    materials: [
      {
        id: 1,
        name: model.material.name,
        young: model.material.young_modulus,
        poisson: model.material.poisson_ratio,
        density: model.material.density,
      },
    ],
    properties: bodyIds.map((id) => ({ id, type: "PSOLID", materialId: 1 })),
    bcGroups,
    loadGroups,
    nextBcGroupId: bcGroups.length + 1,
    nextLoadGroupId: 2,
    ...(tieGroups.length
      ? { tieGroups, nextTieGroupId: tieGroups.length + 1 }
      : {}),
    nextFaceEntryId: faceId + 1,
    nextMatId: 2,
    stepSurface: null,
    volMesh: null,
    surfaceTriangles: null,
    surfaceFaceIds: null,
    elementOrder: model.order,
  };
}

/** The .vtu the app opens: the model, solved. */
export function analysisFile(model, result) {
  const { vertices, hexahedra } = model.mesh;
  const encoded = fieldData(JSON.stringify(analysisSetup(model)));
  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encoded.byteLength}" format="binary">`,
    encoded.b64,
    `</DataArray>`,
    `</FieldData>`,
    `<Piece NumberOfPoints="${vertices.length}" NumberOfCells="${hexahedra.length}">`,
    `<Points>`,
    dataArray(
      "Float64",
      "Points",
      vertices.map((v) => v.join(" ")).join("\n"),
      3,
    ),
    `</Points>`,
    `<Cells>`,
    dataArray(
      "Int64",
      "connectivity",
      hexahedra.map((h) => h.join(" ")).join("\n"),
    ),
    dataArray(
      "Int64",
      "offsets",
      hexahedra.map((_, i) => 8 * (i + 1)).join(" "),
    ),
    dataArray("UInt8", "types", hexahedra.map(() => 12).join(" ")), // VTK_HEXAHEDRON
    `</Cells>`,
    `<PointData>`,
    dataArray("Int64", "NodeId", vertices.map((_, i) => i + 1).join(" ")),
    dataArray("Float64", "Displacement", tuples(result.displacements, 3), 3),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", hexahedra.map((_, i) => i + 1).join(" ")),
    dataArray("Int64", "PropertyId", bodiesOf(model).join(" ")),
    dataArray("Float64", "VonMises", tuples(result.von_mises, 1)),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

/** The setup block embedded in an analysis file, for checking it against a model. */
export function readAnalysisSetup(vtu) {
  const m = /<DataArray type="UInt8" Name="KoFEM"[^>]*>\n([^<\n]+)\n/.exec(vtu);
  if (!m) throw new Error("not a KoFEM analysis file: no KoFEM field data");
  const bytes = Buffer.from(m[1], "base64");
  return JSON.parse(
    bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString("utf8"),
  );
}

// ── What the app shows ────────────────────────────────────────────────────────

const COMPONENT = { Ux: 0, Uy: 1, Uz: 2 };

/**
 * A displacement read-out of the app's Result summary ("Max Ux", "Min Uy",
 * "Max |U|"), printed as the app prints it: toExponential(3) and the unit.
 */
export function appReadout(result, field, stat) {
  const d = result.displacements;
  const n = d.length / 3;
  const value = (i) =>
    field === "|U|"
      ? Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2])
      : d[3 * i + COMPONENT[field]];
  if (field !== "|U|" && COMPONENT[field] === undefined)
    throw new Error(`no app read-out for field "${field}"`);
  if (stat !== "Min" && stat !== "Max")
    throw new Error(`stat must be "Min" or "Max", got "${stat}"`);
  let out = stat === "Min" ? Infinity : -Infinity;
  for (let i = 0; i < n; i++)
    out = stat === "Min" ? Math.min(out, value(i)) : Math.max(out, value(i));
  return `${out.toExponential(3)} mm`;
}

// ── The solved surface, for the figure ────────────────────────────────────────

/**
 * The boundary of a solved hex model as triangles, for lib/render.mjs:
 * undeformed positions, displacements and one scalar per vertex — the
 * displacement magnitude, or the element von Mises stress averaged to the
 * nodes as the app averages it.
 */
export function resultSurface(model, result, field = "displacement") {
  const { vertices, hexahedra } = model.mesh;
  const faces = new Map();
  hexahedra.forEach((hex, e) => {
    for (const local of HEX_FACES) {
      const face = local.map((i) => hex[i]);
      const key = [...face].sort((a, b) => a - b).join(",");
      const entry = faces.get(key);
      if (entry) entry.count++;
      else faces.set(key, { face, count: 1, e });
    }
  });
  let nodal;
  if (field === "displacement") {
    const d = result.displacements;
    nodal = vertices.map((_, i) =>
      Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2]),
    );
  } else if (field === "vonMises") {
    const sum = new Float64Array(vertices.length);
    const count = new Uint32Array(vertices.length);
    hexahedra.forEach((hex, e) => {
      for (const v of hex) {
        sum[v] += result.von_mises[e];
        count[v]++;
      }
    });
    nodal = Array.from(sum, (s, i) => s / count[i]);
  } else throw new Error(`unknown surface field "${field}"`);

  const index = new Map();
  const positions = [];
  const displacements = [];
  const scalars = [];
  const at = (v) => {
    let i = index.get(v);
    if (i === undefined) {
      i = index.size;
      index.set(v, i);
      positions.push(...vertices[v]);
      displacements.push(
        result.displacements[3 * v],
        result.displacements[3 * v + 1],
        result.displacements[3 * v + 2],
      );
      scalars.push(nodal[v]);
    }
    return i;
  };
  // Each boundary quad as two triangles; the edge mask leaves out the
  // diagonal a–c (bit i: the edge opposite the triangle's i-th vertex).
  const triangles = [];
  const edgeMask = [];
  for (const { face, count } of faces.values()) {
    if (count !== 1) continue;
    const [a, b, c, d] = face.map(at);
    triangles.push(a, b, c, a, c, d);
    edgeMask.push(0b101, 0b011);
  }
  return { positions, displacements, scalars, triangles, edgeMask };
}
