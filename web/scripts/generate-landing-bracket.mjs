// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import createModule from "../src/wasm/pkg/kofem_wasm_emcc.js";

const directory = new URL("../public/landing/", import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, directory)));
const previous = readJson("ge-engine-bracket-solution.json");
const geometry = readJson("ge-engine-bracket.json");
const topology = readJson("ge-engine-bracket-smooth.json");
const settings = {
  ...topology.settings,
  method: "level_set",
  constraints: { ...topology.settings.constraints, volumeFraction: 0.12 },
  filterRadius: 2,
  tolerance: 0.03,
  streamEvery: 1,
};
const network = readJson("ge-engine-bracket-network.json");
const sourcePath = process.argv[2];
if (!sourcePath)
  throw Error(
    "Usage: bun scripts/generate-landing-bracket.mjs /path/to/ge_engine_bracket-2.step",
  );
const source = readFileSync(sourcePath);
const sourceHash = createHash("sha256").update(source).digest("hex");
if (sourceHash !== previous.sourceSha256)
  throw Error(
    `STEP source hash ${sourceHash} does not match the landing geometry`,
  );
const wasmBinary = readFileSync(
  new URL("../src/wasm/pkg/kofem_wasm_emcc.wasm", import.meta.url),
);
const engine = () =>
  createModule({ wasmBinary, print: console.log, printErr: console.error });
function pack(arrays) {
  let offset = 0;
  const layout = {},
    buffers = [];
  for (const [name, array] of Object.entries(arrays)) {
    layout[name] = {
      offset,
      length: array.length,
      type: array.constructor.name,
    };
    buffers.push(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    offset += array.byteLength;
  }
  return { layout, buffer: Buffer.concat(buffers) };
}
const sourceForce = [0, 0, 1000];
const material = JSON.stringify({ young_modulus: 210000, poisson_ratio: 0.3 });
const normalY = 0.662599371078666,
  normalZ = 0.748974013865739;
// Rigid mounting frame: X is the mounting normal; Y follows the lug-bore axis.
const aligned = ([x, y, z]) => [
  normalY * y + normalZ * z,
  x + 74.0283,
  normalZ * y - normalY * z,
];
const force = [
  normalY * sourceForce[1] + normalZ * sourceForce[2],
  sourceForce[0],
  normalZ * sourceForce[1] - normalY * sourceForce[2],
];
const lugCenter = aligned([-92.1258, -12.896865742819, 71.1240283572912]);
const mountingRadii = [5.334, 5.1562, 5.1562, 5.1562];
const point = (vertices, node) =>
  Array.from(vertices.subarray(node * 3, node * 3 + 3));
const subtract = (a, b) => a.map((v, j) => v - b[j]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a.reduce((sum, v, j) => sum + v * b[j], 0);
function boundaryConditions(vertices, boundary) {
  const bores = previous.mountingHoleCentersMm.map((center, i) => {
    const selected = new Set();
    for (let node = 0; node < vertices.length / 3; node++) {
      const [x, y, z] = point(vertices, node);
      if (
        x >= -0.001 &&
        x <= 7.85 &&
        Math.abs(Math.hypot(y - center[1], z - center[2]) - mountingRadii[i]) <
          0.001
      )
        selected.add(node);
    }
    if (selected.size < 10)
      throw Error(
        `Mounting bore ${i + 1} has only ${selected.size} support nodes`,
      );
    return selected;
  });
  const loadNodes = new Set();
  for (let node = 0; node < vertices.length / 3; node++) {
    const [x, y, z] = point(vertices, node);
    if (
      Math.abs(y) <= 17.463 &&
      Math.abs(Math.hypot(x - lugCenter[0], z - lugCenter[2]) - 9.55675) < 0.001
    )
      loadNodes.add(node);
  }
  const faces = [],
    loaded = new Set();
  const centroid = [0, 0, 0];
  let area = 0;
  for (let i = 0; i < boundary.length; i += 3) {
    const face = Array.from(boundary.subarray(i, i + 3));
    if (!face.every((node) => loadNodes.has(node))) continue;
    faces.push(face);
    face.forEach((node) => loaded.add(node));
    const [a, b, c] = face.map((node) => point(vertices, node));
    const weight = Math.hypot(...cross(subtract(b, a), subtract(c, a))) / 2;
    area += weight;
    for (let j = 0; j < 3; j++)
      centroid[j] += (weight * (a[j] + b[j] + c[j])) / 3;
  }
  if (
    !faces.length ||
    ![...loaded].some((node) => vertices[node * 3 + 1] < 0) ||
    ![...loaded].some((node) => vertices[node * 3 + 1] > 0)
  )
    throw Error("The force must cover both lifting-lug bores");
  for (let j = 0; j < 3; j++) centroid[j] /= area;
  const fixed = [...new Set(bores.flatMap((bore) => [...bore]))].sort(
    (a, b) => a - b,
  );
  if (fixed.some((node) => loaded.has(node)))
    throw Error("Support and load nodes overlap");
  const nodalForces = new Map();
  for (const face of faces) {
    const [a, b, c] = face.map((node) => point(vertices, node));
    const share =
      Math.hypot(...cross(subtract(b, a), subtract(c, a))) / (6 * area);
    for (const node of face)
      nodalForces.set(node, (nodalForces.get(node) ?? 0) + share);
  }
  const resultant = [0, 0, 0],
    moment = [0, 0, 0];
  for (const [node, share] of nodalForces) {
    const f = force.map((value) => value * share);
    const m = cross(subtract(point(vertices, node), centroid), f);
    for (let j = 0; j < 3; j++) {
      resultant[j] += f[j];
      moment[j] += m[j];
    }
  }
  if (
    Math.hypot(...subtract(resultant, force)) > 1e-8 ||
    Math.hypot(...moment) > 1e-7
  )
    throw Error(
      `Load equilibrium failed: force=${resultant}, moment=${moment}`,
    );
  return {
    fixed,
    loaded: [...loaded],
    centroid,
    resultant,
    moment,
    perHole: bores.map((bore) => bore.size),
    bcs: {
      fixed_vertices: fixed,
      point_loads: [],
      surface_loads: [{ type: "force", force, faces }],
    },
  };
}

const mesher = await engine();
mesher.tessellate_step(
  new Uint8Array(source),
  JSON.stringify({
    deflection_relative: 0.001,
    angular_deflection: 0.5,
    format: "step",
  }),
);
const dto = mesher.generate_fem_mesh(JSON.stringify(previous.parameters));
const vertices = new Float64Array(dto.vertices.length);
for (let node = 0; node < vertices.length / 3; node++)
  vertices.set(aligned(point(dto.vertices, node)), node * 3);
for (let i = 0; i < vertices.length; i++)
  if (
    vertices[i] < geometry.min[i % 3] - 0.3 ||
    vertices[i] > geometry.max[i % 3] + 0.3
  )
    throw Error("The remeshed STEP does not align with the landing geometry");
const coarse = {
  vertices,
  tetrahedra: Int32Array.from(dto.tetrahedra),
  hexahedra: new Int32Array(0),
};
const boundary = Uint32Array.from(dto.surfaceTriangles);
mesher.free_geometry_cache();
const loads = boundaryConditions(vertices, boundary);
const solver = await engine();
const solved = solver.solve_linear_elastic(
  coarse,
  material,
  JSON.stringify(loads.bcs),
  1,
);
if ("error" in solved) throw Error(solved.error);
const displacements = Float32Array.from(solved.displacements);
const magnitudes = Float32Array.from({ length: vertices.length / 3 }, (_, i) =>
  Math.hypot(...displacements.subarray(i * 3, i * 3 + 3)),
);
const maxDisplacementMm = Math.max(...magnitudes);
const fixedError = Math.max(...loads.fixed.map((node) => magnitudes[node]));
if (
  !(maxDisplacementMm > 0) ||
  !Number.isFinite(maxDisplacementMm) ||
  fixedError > 1e-10
)
  throw Error(
    `Invalid static result: max=${maxDisplacementMm}, fixed error=${fixedError}`,
  );
const edges = new Map();
for (let i = 0; i < boundary.length; i += 3)
  for (let j = 0; j < 3; j++) {
    const a = boundary[i + j],
      b = boundary[i + ((j + 1) % 3)];
    edges.set(`${Math.min(a, b)},${Math.max(a, b)}`, [
      Math.min(a, b),
      Math.max(a, b),
    ]);
  }
const edgeIndices = Uint32Array.from([...edges.values()].flat());
const solutionData = pack({
  positions: Float32Array.from(vertices),
  displacements,
  magnitudes,
  triangles: boundary,
  edges: edgeIndices,
});
const meanDisplacement = [0, 0, 0];
for (const node of loads.loaded)
  for (let j = 0; j < 3; j++)
    meanDisplacement[j] += displacements[node * 3 + j] / loads.loaded.length;
let volume = 0;
function tetVolume(nodes, tets, e) {
  const [a, b, c, d] = Array.from(tets.subarray(e * 4, e * 4 + 4), (node) =>
    point(nodes, node),
  );
  return (
    Math.abs(dot(subtract(b, a), cross(subtract(c, a), subtract(d, a)))) / 6
  );
}
for (let e = 0; e < coarse.tetrahedra.length / 4; e++)
  volume += tetVolume(vertices, coarse.tetrahedra, e);
const solutionMetadata = {
  ...previous,
  nodes: vertices.length / 3,
  tetrahedra: coarse.tetrahedra.length / 4,
  boundaryTriangles: boundary.length / 3,
  volumeMm3: volume,
  fixedNodes: loads.fixed.length,
  fixedNodesPerHole: loads.perHole,
  load: "1 kN pull along bracket +Z, distributed over both lifting-lug bores; no applied moment",
  loadedNodes: loads.loaded.length,
  forceN: force,
  sourceForceN: sourceForce,
  forceCoordinateSystem:
    "forceN uses the aligned mounting frame; sourceForceN uses the original STEP frame",
  momentNmm: [0, 0, 0],
  verifiedForceN: loads.resultant,
  verifiedMomentNmm: loads.moment,
  loadCentroidMm: loads.centroid,
  meanLoadedDisplacementMm: meanDisplacement,
  maxDisplacementMm,
  fixedDisplacementErrorMm: fixedError,
  deformationScale: Math.round(10 / maxDisplacementMm),
  layout: solutionData.layout,
};
delete solutionMetadata.canonicalSha256;

const adjacency = Array.from({ length: vertices.length / 3 }, () => []);
const edgeLengths = new Float32Array(edgeIndices.length / 2);
for (let i = 0; i < edgeLengths.length; i++) {
  const a = edgeIndices[i * 2],
    b = edgeIndices[i * 2 + 1];
  const length = Math.hypot(
    ...subtract(point(vertices, a), point(vertices, b)),
  );
  edgeLengths[i] = length;
  adjacency[a].push([b, length]);
  adjacency[b].push([a, length]);
}
let seed = -1,
  nearest = Infinity;
for (let node = 0; node < adjacency.length; node++) {
  if (!adjacency[node].length) continue;
  const distance = Math.hypot(
    ...subtract(point(vertices, node), network.seedPointMm),
  );
  if (distance < nearest) {
    nearest = distance;
    seed = node;
  }
}
const distances = new Float64Array(adjacency.length).fill(Infinity);
const visited = new Uint8Array(adjacency.length);
distances[seed] = 0;
for (;;) {
  let current = -1,
    best = Infinity;
  for (let node = 0; node < distances.length; node++)
    if (!visited[node] && distances[node] < best) {
      best = distances[node];
      current = node;
    }
  if (current < 0) break;
  visited[current] = 1;
  for (const [other, length] of adjacency[current])
    distances[other] = Math.min(distances[other], best + length);
}
if (
  adjacency.some(
    (neighbors, node) => neighbors.length && !Number.isFinite(distances[node]),
  )
)
  throw Error("The boundary propagation network is disconnected");
let maxDistance = 0;
for (let edge = 0; edge < edgeLengths.length; edge++)
  maxDistance = Math.max(
    maxDistance,
    (distances[edgeIndices[edge * 2]] +
      distances[edgeIndices[edge * 2 + 1]] +
      edgeLengths[edge]) /
      2,
  );
const arrivals = Float32Array.from(distances, (value) =>
  Number.isFinite(value) ? value : -1,
);

const fineMeshSizing = { max: 2, min: 0.4 };
const fineMesher = await engine();
fineMesher.tessellate_step(
  new Uint8Array(source),
  JSON.stringify({
    deflection_relative: 0.001,
    angular_deflection: 0.5,
    format: "step",
  }),
);
const fineDto = fineMesher.generate_fem_mesh(
  JSON.stringify({
    ...previous.parameters,
    max_element_size: fineMeshSizing.max,
    min_element_size: fineMeshSizing.min,
  }),
);
const fine = {
  positions: new Float32Array(fineDto.vertices.length),
  tetrahedra: Uint32Array.from(fineDto.tetrahedra),
  boundary: Uint32Array.from(fineDto.surfaceTriangles),
};
for (let node = 0; node < fine.positions.length / 3; node++)
  fine.positions.set(aligned(point(fineDto.vertices, node)), node * 3);
fineMesher.free_geometry_cache();
const faceNormals = [],
  attachedFaces = Array.from({ length: fine.positions.length / 3 }, () => []);
for (let i = 0; i < fine.boundary.length; i += 3) {
  const face = Array.from(fine.boundary.subarray(i, i + 3));
  const [a, b, c] = face.map((node) => point(fine.positions, node));
  const normal = cross(subtract(b, a), subtract(c, a));
  const length = Math.hypot(...normal);
  if (!(length > 0))
    throw Error(`Degenerate optimization boundary triangle ${i / 3}`);
  faceNormals.push(normal.map((value) => value / length));
  for (const node of face) attachedFaces[node].push(i / 3);
}
fine.boundaryNormals = new Float32Array(fine.boundary.length * 3);
for (let corner = 0; corner < fine.boundary.length; corner++) {
  const normal = [0, 0, 0],
    face = Math.floor(corner / 3);
  for (const other of attachedFaces[fine.boundary[corner]])
    if (dot(faceNormals[face], faceNormals[other]) > Math.cos(Math.PI / 4))
      for (let axis = 0; axis < 3; axis++)
        normal[axis] += faceNormals[other][axis];
  const length = Math.hypot(...normal);
  fine.boundaryNormals.set(
    normal.map((value) => value / length),
    corner * 3,
  );
}
const fineLoads = boundaryConditions(fine.positions, fine.boundary);
const protectedNodes = new Set([...fineLoads.fixed, ...fineLoads.loaded]);
const protectedElements = [];
for (let element = 0; element < fine.tetrahedra.length / 4; element++)
  if (
    fine.tetrahedra
      .subarray(element * 4, element * 4 + 4)
      .some((node) => protectedNodes.has(node))
  )
    protectedElements.push(element);
settings.passive = { solid: protectedElements };
const nElements = fine.tetrahedra.length / 4,
  nNodes = fine.positions.length / 3;
const weights = Float64Array.from({ length: nElements }, (_, e) =>
  tetVolume(fine.positions, fine.tetrahedra, e),
);
const nodalWeights = new Float64Array(nNodes);
for (let e = 0; e < nElements; e++)
  for (let j = 0; j < 4; j++)
    nodalWeights[fine.tetrahedra[e * 4 + j]] += weights[e];
const frames = [0],
  fields = [new Float32Array(nNodes).fill(1)],
  retained = [nElements];
const optimizer = await engine();
const optimized = optimizer.optimize_topology(
  {
    vertices: Float64Array.from(fine.positions),
    tetrahedra: Int32Array.from(fine.tetrahedra),
    hexahedra: new Int32Array(0),
  },
  material,
  JSON.stringify(fineLoads.bcs),
  JSON.stringify(settings),
  (iteration, density) => {
    const sums = new Float64Array(nNodes);
    for (let e = 0; e < nElements; e++)
      for (let j = 0; j < 4; j++)
        sums[fine.tetrahedra[e * 4 + j]] += weights[e] * density[e];
    frames.push(iteration);
    fields.push(
      Float32Array.from(sums, (value, node) => value / nodalWeights[node]),
    );
    retained.push(
      density.reduce(
        (sum, value) => sum + (value >= topology.threshold ? 1 : 0),
        0,
      ),
    );
  },
);
if ("error" in optimized) throw Error(optimized.error);
if (
  settings.passive.solid.some(
    (element) => optimized.density[element] < 1 - 1e-8,
  )
)
  throw Error(
    "Optimization removed material from a protected mounting or load region",
  );
const history = optimized.history.map((point) => ({ ...point })),
  last = history.at(-1);
const recentCompliance = history.slice(-6).map((point) => point.compliance);
const complianceFlat =
  settings.method === "level_set" &&
  history.length >= 6 &&
  Math.max(...recentCompliance) - Math.min(...recentCompliance) <
    0.1 * settings.tolerance * last.compliance;
if (
  !last ||
  (last.max_change >= settings.tolerance && !complianceFlat) ||
  Math.abs(last.volume - settings.constraints.volumeFraction) >= 0.005
)
  throw Error(`Optimization did not converge: ${JSON.stringify(last)}`);
if (frames.at(-1) !== last.it) throw Error("The last density frame is missing");
if (!optimized.levelSet || optimized.levelSet.length !== nNodes)
  throw Error("Level-set optimization did not return a nodal boundary field");
fields[fields.length - 1] = Float32Array.from(
  optimized.levelSet,
  (phi) => 0.5 * (phi + 1),
);
const topologyData = pack({
  positions: fine.positions,
  tetrahedra: fine.tetrahedra,
  boundary: fine.boundary,
  boundaryNormals: fine.boundaryNormals,
  fields: Float32Array.from(fields.flatMap((field) => Array.from(field))),
});
const topologyMetadata = {
  ...topology,
  generator: "KoFEM optimize_topology / reaction-diffusion level set",
  rendering:
    "Interpolated volume-weighted nodal densities; final surface is the engine level-set phi = 0 boundary",
  nodes: nNodes,
  elements: nElements,
  protectedElements: protectedElements.length,
  optimizationMeshElements: nElements,
  meshSizingMm: fineMeshSizing,
  settings,
  frames,
  history,
  retained,
  stops: frames.map((iteration) => iteration / last.it),
  converged: true,
  finalVolume: last.volume,
  layout: topologyData.layout,
  displayMeshElements: coarse.tetrahedra.length / 4,
  loadCase: {
    forceN: force,
    sourceForceN: sourceForce,
    forceCoordinateSystem:
      "forceN uses the aligned mounting frame; sourceForceN uses the original STEP frame",
    momentNmm: [0, 0, 0],
    support: previous.support,
    fixedNodes: fineLoads.fixed.length,
    loadedNodes: fineLoads.loaded.length,
    verifiedForceN: fineLoads.resultant,
    verifiedMomentNmm: fineLoads.moment,
  },
};
const networkMetadata = {
  ...network,
  seedNode: seed,
  seedPointMm: point(vertices, seed),
  nodeCount: vertices.length / 3,
  boundaryNodes: adjacency.filter((neighbors) => neighbors.length).length,
  edgeCount: edgeLengths.length,
  maxDistance: maxDistance * 1.000001,
};
for (const [stem, metadata, buffer] of [
  ["ge-engine-bracket-solution", solutionMetadata, solutionData.buffer],
  [
    "ge-engine-bracket-network",
    networkMetadata,
    Buffer.concat([
      Buffer.from(arrivals.buffer),
      Buffer.from(edgeLengths.buffer),
    ]),
  ],
  ["ge-engine-bracket-smooth", topologyMetadata, topologyData.buffer],
]) {
  writeFileSync(new URL(`${stem}.json`, directory), JSON.stringify(metadata));
  writeFileSync(new URL(`${stem}.bin`, directory), buffer);
}
console.log(
  JSON.stringify(
    {
      maxDisplacementMm,
      fixedError,
      forceN: loads.resultant,
      momentNmm: loads.moment,
      iterations: last.it,
      finalVolume: last.volume,
      maxChange: last.max_change,
    },
    null,
    2,
  ),
);
