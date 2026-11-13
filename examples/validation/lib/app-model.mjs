// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// An example as the app holds it, and the things made from it: a STEP file
// meshed by Netgen, supports and loads on whole CAD faces, solved by the app's
// own code (lib/pipeline.mjs buildFromRecipe).
//
//   buildAnalysisFile()   the .vtu that /app/?example=<id> opens: geometry,
//                         mesh, groups and the static study, UNSOLVED, with
//                         the hand check the Results panel reads;
//   buildResultSurface()  the solved boundary surface, for the page's figure;
//   buildMeshStats()      elements, nodes and DOFs of the solved mesh;
//   appReadout()          a Result-summary line of the solved model.
//
// The structured hex adapter below (solveModel) is not an example: it serves
// the Theory Guide's axial-bar mesh study (../axial-bar-study.mjs), which
// needs meshes that halve exactly. A hex model, in the app's units
// (N · mm · MPa · tonne):
//
//   { title,                                  the model name
//     mesh: { vertices, hexahedra },          8-node hexahedra
//     material: { name, young_modulus, poisson_ratio, density },
//     order,                                  1 linear, 2 quadratic
//     support: { nodes, label },              Ux Uy Uz fixed
//     load: { kind, axis, value, nodes, label },
//     resultType }
//
// `load.kind` is "force" (value in N along `axis`), "moment" (N·mm about
// `axis`) or "pressure" (MPa, along the inward normal; no axis). Node lists are
// 0-based vertex indices.

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
  const bcs = { fixed_vertices: model.support.nodes };
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

/** The setup block embedded in an analysis file. */
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

// ── Builds from a recipe (lib/pipeline.mjs) ───────────────────────────────────

/**
 * The setup block of a recipe build's analysis file: what the app holds after
 * the recipe's steps (import, splits, mesh, material, supports, loads), opening
 * UNSOLVED on the static study, so the first thing to do is press Run. The
 * fields follow web/src/lib/analysisFile.ts.
 */
export function buildAnalysisSetup(build, title) {
  return {
    format: "kofem-analysis",
    version: 1,
    modelName: title,
    mode: "solve",
    viewRepr: "surface",
    resultType: "Displacement (magnitude)",
    elementTypes: build.elements.map((e) => e.type),
    materials: build.materials,
    properties: build.properties,
    bcGroups: build.bcGroups,
    loadGroups: build.loadGroups,
    tieGroups: build.tieGroups,
    couplingGroups: [],
    nextBcGroupId: build.bcGroups.length + 1,
    nextLoadGroupId: build.loadGroups.length + 1,
    nextTieGroupId: build.tieGroups.length + 1,
    nextCouplingGroupId: 1,
    nextFaceEntryId: build.nextFaceEntryId,
    nextMatId: build.materials.length + 1,
    stepSurface: build.stepSurface,
    volMesh: null,
    surfaceTriangles: build.surfaceTriangles,
    surfaceFaceIds: build.surfaceFaceIds,
    elementOrder: build.meshSettings.order,
    ...(build.optimization
      ? optimizeSetup(build.optimization.settings)
      : { handCheck: build.handCheck }),
  };
}

// A recipe with an optimize step opens on its optimization study instead,
// with the Optimize panel filled in as a user types it (strings, as the
// store holds them), ready to run; it carries no hand check.
function optimizeSetup(settings) {
  return {
    mode: "optimize",
    topOpt: {
      method: settings.method,
      objective: settings.objective,
      volumeFraction: String(settings.constraints.volumeFraction),
      complianceLimit: "",
      penalty: String(settings.penalty),
      filterRadius: String(settings.filterRadius),
      moveLimit: String(settings.moveLimit),
      maxIterations: String(settings.maxIterations),
      tolerance: String(settings.tolerance),
    },
  };
}

// The element types a recipe build makes: Netgen's tetrahedra, and the shell
// facets the app idealises a Shell body into (web/src/lib/analysisFile.ts
// vtkCellType).
const VTK_CELL = {
  CTETRA: { nodes: 4, type: 10 }, // VTK_TETRA
  CTRIA3: { nodes: 3, type: 5 }, // VTK_TRIANGLE
};

/** The .vtu of a recipe build, unsolved: no result arrays. */
export function buildAnalysisFile(build, title) {
  const { nodes, elements } = build;
  for (const e of elements)
    if (VTK_CELL[e.type]?.nodes !== e.nodeIds.length)
      throw new Error(
        `analysis file: element ${e.id} is a ${e.nodeIds.length}-node ${e.type}, not a 4-node tetrahedron or a 3-node shell facet`,
      );
  let offset = 0;
  const offsets = elements.map((e) => (offset += e.nodeIds.length));
  const encoded = fieldData(JSON.stringify(buildAnalysisSetup(build, title)));
  return [
    `<?xml version="1.0"?>`,
    `<VTKFile type="UnstructuredGrid" version="1.0" byte_order="LittleEndian" header_type="UInt32">`,
    `<UnstructuredGrid>`,
    `<FieldData>`,
    `<DataArray type="UInt8" Name="KoFEM" NumberOfTuples="${encoded.byteLength}" format="binary">`,
    encoded.b64,
    `</DataArray>`,
    `</FieldData>`,
    `<Piece NumberOfPoints="${nodes.length}" NumberOfCells="${elements.length}">`,
    `<Points>`,
    dataArray(
      "Float64",
      "Points",
      nodes.map((n) => `${n.x} ${n.y} ${n.z}`).join("\n"),
      3,
    ),
    `</Points>`,
    `<Cells>`,
    // Node ids equal point indices, as after meshing in the app.
    dataArray(
      "Int64",
      "connectivity",
      elements.map((e) => e.nodeIds.join(" ")).join("\n"),
    ),
    dataArray("Int64", "offsets", offsets.join(" ")),
    dataArray(
      "UInt8",
      "types",
      elements.map((e) => VTK_CELL[e.type].type).join(" "),
    ),
    `</Cells>`,
    `<PointData>`,
    dataArray("Int64", "NodeId", nodes.map((n) => n.id).join(" ")),
    `</PointData>`,
    `<CellData>`,
    dataArray("Int64", "ElementId", elements.map((e) => e.id).join(" ")),
    dataArray(
      "Int64",
      "PropertyId",
      elements.map((e) => e.propertyId).join(" "),
    ),
    `</CellData>`,
    `</Piece>`,
    `</UnstructuredGrid>`,
    `</VTKFile>`,
    ``,
  ].join("\n");
}

/**
 * The solved boundary of a recipe build for lib/render.mjs: the mesh's surface
 * triangles with the displacement magnitude, or the nodal von Mises stress the
 * caller averaged as the app does (pipeline nodalVonMises).
 */
export function buildResultSurface(build, field, nodalVonMises) {
  const d = build.result.displacements;
  let scalars;
  if (field === "displacement")
    scalars = build.nodes.map((_, i) =>
      Math.hypot(d[3 * i], d[3 * i + 1], d[3 * i + 2]),
    );
  else if (field === "vonMises") scalars = Array.from(nodalVonMises);
  else throw new Error(`unknown surface field "${field}"`);
  return {
    positions: build.nodes.flatMap((n) => [n.x, n.y, n.z]),
    displacements: Array.from(d),
    scalars,
    triangles: build.surfaceTriangles.flat(),
  };
}

/**
 * Elements, nodes and DOFs of a recipe build — a quadratic tetrahedron adds a
 * node on every edge, a shell node carries six DOFs — and the mesher settings,
 * so the page states them.
 */
export function buildMeshStats(build) {
  const { order, maxElementSize, minElementSize } = build.meshSettings;
  const types = new Set(build.elements.map((e) => e.type));
  if (types.size !== 1 || !(types.has("CTETRA") || types.has("CTRIA3")))
    throw new Error(
      `mesh stats: a recipe build is all tetrahedra or all shell facets, got ${[...types].join(", ")}`,
    );
  if (types.has("CTRIA3")) {
    // A DKT/CST facet is linear whatever order the mesh panel shows.
    const shellNodes = build.nodes.length;
    return {
      order: 1,
      elementType: "CTRIA3",
      elements: build.elements.length,
      vertices: shellNodes,
      nodes: shellNodes,
      dofs: 6 * shellNodes,
      maxElementSize,
      minElementSize,
    };
  }
  let nodes = build.nodes.length;
  if (order === 2) {
    const edges = new Set();
    for (const { nodeIds: t } of build.elements)
      for (let i = 0; i < 4; i++)
        for (let j = i + 1; j < 4; j++)
          edges.add(t[i] < t[j] ? `${t[i]},${t[j]}` : `${t[j]},${t[i]}`);
    nodes += edges.size;
  }
  return {
    order,
    elementType: "CTETRA",
    elements: build.elements.length,
    vertices: build.nodes.length,
    nodes,
    dofs: 3 * nodes,
    maxElementSize,
    minElementSize,
  };
}
