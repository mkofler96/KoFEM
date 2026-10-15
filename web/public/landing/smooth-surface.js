// Continuous density boundary, following KoFEM's Smooth representation.
// Taubin fairing: alternating shrink (λ) and inflate (μ) passes.
const fairingSteps = Array.from({ length: 12 }, (_, i) =>
  i % 2 ? -0.46 : 0.45,
);
const maxFairingShift = 1.2;

function createCut(nodes, center, field, level) {
  const nodeCount = nodes.length / 3;
  const cut = {
    nodes,
    center,
    field,
    level,
    coordinates: [],
    triangles: [],
    crossings: new Map(),
    boundaryNormalsAtCut: new Map(),
    fixedCutVertices: new Set(),
  };
  cut.position = (node) => [
    nodes[node * 3] - center[0],
    nodes[node * 3 + 1] - center[1],
    nodes[node * 3 + 2] - center[2],
  ];
  cut.edge = (nodeA, nodeB) => {
    const key = Math.min(nodeA, nodeB) * nodeCount + Math.max(nodeA, nodeB);
    if (cut.crossings.has(key)) return cut.crossings.get(key);
    const fraction = Math.max(
        0,
        Math.min(1, (level - field[nodeA]) / (field[nodeB] - field[nodeA])),
      ),
      index = cut.coordinates.length / 3;
    for (let j = 0; j < 3; j++)
      cut.coordinates.push(
        nodes[nodeA * 3 + j] +
          fraction * (nodes[nodeB * 3 + j] - nodes[nodeA * 3 + j]) -
          center[j],
      );
    cut.crossings.set(key, index);
    return index;
  };
  return cut;
}

function addTriangle(cut, p0, p1, p2, inside) {
  const coordinates = cut.coordinates;
  const ax = coordinates[p0 * 3],
    ay = coordinates[p0 * 3 + 1],
    az = coordinates[p0 * 3 + 2];
  const ux = coordinates[p1 * 3] - ax,
    uy = coordinates[p1 * 3 + 1] - ay,
    uz = coordinates[p1 * 3 + 2] - az;
  const vx = coordinates[p2 * 3] - ax,
    vy = coordinates[p2 * 3 + 1] - ay,
    vz = coordinates[p2 * 3 + 2] - az;
  const dot =
    (uy * vz - uz * vy) * (ax - inside[0]) +
    (uz * vx - ux * vz) * (ay - inside[1]) +
    (ux * vy - uy * vx) * (az - inside[2]);
  if (dot < 0) cut.triangles.push(p0, p2, p1);
  else cut.triangles.push(p0, p1, p2);
}

function triangulateTetrahedron(cut, inside, outside, material) {
  if (inside.length === 2) {
    const q0 = cut.edge(inside[0], outside[0]),
      q1 = cut.edge(inside[0], outside[1]),
      q2 = cut.edge(inside[1], outside[1]),
      q3 = cut.edge(inside[1], outside[0]);
    addTriangle(cut, q0, q1, q2, material);
    addTriangle(cut, q0, q2, q3, material);
    return;
  }
  const lone = inside.length === 1 ? inside[0] : outside[0],
    others = inside.length === 1 ? outside : inside;
  addTriangle(
    cut,
    cut.edge(lone, others[0]),
    cut.edge(lone, others[1]),
    cut.edge(lone, others[2]),
    material,
  );
}

function marchTetrahedra(cut, tets) {
  const { nodes, center, field, level } = cut;
  const inside = [],
    outside = [],
    material = [0, 0, 0];
  for (let tet = 0; tet < tets.length; tet += 4) {
    inside.length = 0;
    outside.length = 0;
    for (let j = 0; j < 4; j++) {
      const node = tets[tet + j];
      (field[node] >= level ? inside : outside).push(node);
    }
    if (!inside.length || !outside.length) continue;
    material.fill(0);
    for (const node of inside)
      for (let j = 0; j < 3; j++)
        material[j] += (nodes[node * 3 + j] - center[j]) / inside.length;
    triangulateTetrahedron(cut, inside, outside, material);
  }
}

function markBoundaryCut(cut, index, normal) {
  const length = Math.hypot(...normal),
    unit = normal.map((v) => v / length),
    previous = cut.boundaryNormalsAtCut.get(index);
  if (previous && unit.reduce((sum, v, j) => sum + v * previous[j], 0) < 0.7)
    cut.fixedCutVertices.add(index);
  cut.boundaryNormalsAtCut.set(index, unit);
}

function clipBoundaryFace(cut, boundary, boundaryNormals, face) {
  const { field, level } = cut;
  const polygon = [],
    normals = [],
    indices = [];
  for (let corner = 0; corner < 3; corner++) {
    const next = (corner + 1) % 3,
      nodeA = boundary[face + corner],
      nodeB = boundary[face + next],
      inA = field[nodeA] >= level,
      inB = field[nodeB] >= level;
    const normalA = boundaryNormals.subarray(
        (face + corner) * 3,
        (face + corner) * 3 + 3,
      ),
      normalB = boundaryNormals.subarray(
        (face + next) * 3,
        (face + next) * 3 + 3,
      );
    if (inA) {
      polygon.push(cut.position(nodeA));
      normals.push(normalA);
      indices.push(-1);
    }
    if (inA !== inB) {
      const index = cut.edge(nodeA, nodeB),
        fraction = (level - field[nodeA]) / (field[nodeB] - field[nodeA]);
      const interpolated = Array.from(
        normalA,
        (v, j) => v + fraction * (normalB[j] - v),
      );
      markBoundaryCut(cut, index, interpolated);
      polygon.push(cut.coordinates.slice(index * 3, index * 3 + 3));
      normals.push(interpolated);
      indices.push(index);
    }
  }
  return { polygon, normals, indices };
}

// Close the design-domain boundary while retaining CAD creases and hole normals.
function capBoundary(cut, boundary, boundaryNormals) {
  const cap = { positions: [], normals: [], vertexIndices: [] };
  for (let face = 0; face < boundary.length; face += 3) {
    const { polygon, normals, indices } = clipBoundaryFace(
      cut,
      boundary,
      boundaryNormals,
      face,
    );
    for (let i = 1; i + 1 < polygon.length; i++)
      for (const j of [0, i, i + 1]) {
        cap.positions.push(...polygon[j]);
        cap.vertexIndices.push(indices[j]);
        const normal = normals[j],
          length = Math.hypot(...normal);
        cap.normals.push(
          normal[0] / length,
          normal[1] / length,
          normal[2] / length,
        );
      }
  }
  return cap;
}

function neighborSets(cut) {
  const neighbors = Array.from(
    { length: cut.coordinates.length / 3 },
    () => new Set(),
  );
  for (let i = 0; i < cut.triangles.length; i += 3) {
    const [p0, p1, p2] = cut.triangles.slice(i, i + 3);
    neighbors[p0].add(p1).add(p2);
    neighbors[p1].add(p0).add(p2);
    neighbors[p2].add(p0).add(p1);
  }
  return neighbors;
}

function umbrellaStep(points, vertex, adjacent, amount) {
  const delta = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    for (const other of adjacent) delta[j] += points[other * 3 + j];
    delta[j] = amount * (delta[j] / adjacent.size - points[vertex * 3 + j]);
  }
  return delta;
}

function fairingPass(cut, neighbors, points, amount) {
  const { coordinates, boundaryNormalsAtCut, fixedCutVertices } = cut;
  const result = points.slice();
  for (let i = 0; i < neighbors.length; i++) {
    if (fixedCutVertices.has(i) || !neighbors[i].size) continue;
    const delta = umbrellaStep(points, i, neighbors[i], amount);
    const normal = boundaryNormalsAtCut.get(i);
    if (normal) {
      const dot = delta.reduce((sum, v, j) => sum + v * normal[j], 0);
      for (let j = 0; j < 3; j++) delta[j] -= dot * normal[j];
    }
    const moved = delta.map(
        (v, j) => points[i * 3 + j] + v - coordinates[i * 3 + j],
      ),
      scale = Math.min(1, maxFairingShift / (Math.hypot(...moved) || 1));
    for (let j = 0; j < 3; j++)
      result[i * 3 + j] = coordinates[i * 3 + j] + moved[j] * scale;
  }
  return result;
}

// Taubin fairing suppresses contour chatter. Boundary cuts move tangentially; CAD creases stay pinned.
function fair(cut) {
  const neighbors = neighborSets(cut);
  return fairingSteps.reduce(
    (points, amount) => fairingPass(cut, neighbors, points, amount),
    Float64Array.from(cut.coordinates),
  );
}

function snapCapToFairedSurface(cap, points) {
  for (let i = 0; i < cap.vertexIndices.length; i++)
    if (cap.vertexIndices[i] >= 0)
      for (let j = 0; j < 3; j++)
        cap.positions[i * 3 + j] = points[cap.vertexIndices[i] * 3 + j];
}

function vertexNormals(triangles, points) {
  const normals = new Float64Array(points.length);
  for (let i = 0; i < triangles.length; i += 3) {
    const p0 = triangles[i] * 3,
      p1 = triangles[i + 1] * 3,
      p2 = triangles[i + 2] * 3;
    const ux = points[p1] - points[p0],
      uy = points[p1 + 1] - points[p0 + 1],
      uz = points[p1 + 2] - points[p0 + 2],
      vx = points[p2] - points[p0],
      vy = points[p2 + 1] - points[p0 + 1],
      vz = points[p2 + 2] - points[p0 + 2];
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    for (const node of [p0, p1, p2]) {
      normals[node] += nx;
      normals[node + 1] += ny;
      normals[node + 2] += nz;
    }
  }
  return normals;
}

function assemble(triangles, points, smoothNormals, cap) {
  const positions = new Float32Array(
      triangles.length * 3 + cap.positions.length,
    ),
    normals = new Float32Array(positions.length);
  for (let i = 0; i < triangles.length; i++) {
    const node = triangles[i] * 3,
      length =
        Math.hypot(
          smoothNormals[node],
          smoothNormals[node + 1],
          smoothNormals[node + 2],
        ) || 1;
    for (let j = 0; j < 3; j++) {
      positions[i * 3 + j] = points[node + j];
      normals[i * 3 + j] = smoothNormals[node + j] / length;
    }
  }
  positions.set(cap.positions, triangles.length * 3);
  normals.set(cap.normals, triangles.length * 3);
  return { positions, normals, triangleCount: positions.length / 9 };
}

export function createSurfaceExtractor(
  nodes,
  tets,
  boundary,
  boundaryNormals,
  center,
) {
  return function extract(field, level) {
    const cut = createCut(nodes, center, field, level);
    marchTetrahedra(cut, tets);
    const cap = capBoundary(cut, boundary, boundaryNormals);
    const points = fair(cut);
    snapCapToFairedSurface(cap, points);
    return assemble(
      cut.triangles,
      points,
      vertexNormals(cut.triangles, points),
      cap,
    );
  };
}
