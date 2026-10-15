// Continuous density boundary, following KoFEM's Smooth representation.
export function createSurfaceExtractor(
  nodes,
  tets,
  boundary,
  boundaryNormals,
  center,
) {
  const nodeCount = nodes.length / 3;
  return function extract(field, level) {
    const coordinates = [],
      triangles = [],
      capPositions = [],
      capNormals = [],
      crossings = new Map(),
      boundaryNormalsAtCut = new Map(),
      fixedCutVertices = new Set(),
      capVertexIndices = [];
    const position = (i) => [
      nodes[i * 3] - center[0],
      nodes[i * 3 + 1] - center[1],
      nodes[i * 3 + 2] - center[2],
    ];
    function edge(a, b) {
      const key = Math.min(a, b) * nodeCount + Math.max(a, b);
      if (crossings.has(key)) return crossings.get(key);
      const fraction = Math.max(
          0,
          Math.min(1, (level - field[a]) / (field[b] - field[a])),
        ),
        index = coordinates.length / 3;
      for (let j = 0; j < 3; j++)
        coordinates.push(
          nodes[a * 3 + j] +
            fraction * (nodes[b * 3 + j] - nodes[a * 3 + j]) -
            center[j],
        );
      crossings.set(key, index);
      return index;
    }
    function triangle(a, b, c, inside) {
      const ax = coordinates[a * 3],
        ay = coordinates[a * 3 + 1],
        az = coordinates[a * 3 + 2];
      const ux = coordinates[b * 3] - ax,
        uy = coordinates[b * 3 + 1] - ay,
        uz = coordinates[b * 3 + 2] - az;
      const vx = coordinates[c * 3] - ax,
        vy = coordinates[c * 3 + 1] - ay,
        vz = coordinates[c * 3 + 2] - az;
      const dot =
        (uy * vz - uz * vy) * (ax - inside[0]) +
        (uz * vx - ux * vz) * (ay - inside[1]) +
        (ux * vy - uy * vx) * (az - inside[2]);
      if (dot < 0) triangles.push(a, c, b);
      else triangles.push(a, b, c);
    }
    const inside = [],
      outside = [],
      material = [0, 0, 0];
    for (let e = 0; e < tets.length; e += 4) {
      inside.length = 0;
      outside.length = 0;
      for (let j = 0; j < 4; j++) {
        const node = tets[e + j];
        (field[node] >= level ? inside : outside).push(node);
      }
      if (!inside.length || !outside.length) continue;
      material.fill(0);
      for (const node of inside)
        for (let j = 0; j < 3; j++)
          material[j] += (nodes[node * 3 + j] - center[j]) / inside.length;
      if (inside.length === 2) {
        const a = edge(inside[0], outside[0]),
          b = edge(inside[0], outside[1]),
          c = edge(inside[1], outside[1]),
          d = edge(inside[1], outside[0]);
        triangle(a, b, c, material);
        triangle(a, c, d, material);
      } else {
        const lone = inside.length === 1 ? inside[0] : outside[0],
          others = inside.length === 1 ? outside : inside;
        triangle(
          edge(lone, others[0]),
          edge(lone, others[1]),
          edge(lone, others[2]),
          material,
        );
      }
    }
    // Close the design-domain boundary while retaining CAD creases and hole normals.
    for (let face = 0; face < boundary.length; face += 3) {
      const polygon = [],
        normals = [],
        indices = [];
      for (let corner = 0; corner < 3; corner++) {
        const next = (corner + 1) % 3,
          a = boundary[face + corner],
          b = boundary[face + next],
          inA = field[a] >= level,
          inB = field[b] >= level;
        const normalA = boundaryNormals.subarray(
            (face + corner) * 3,
            (face + corner) * 3 + 3,
          ),
          normalB = boundaryNormals.subarray(
            (face + next) * 3,
            (face + next) * 3 + 3,
          );
        if (inA) {
          polygon.push(position(a));
          normals.push(normalA);
          indices.push(-1);
        }
        if (inA !== inB) {
          const index = edge(a, b),
            fraction = (level - field[a]) / (field[b] - field[a]);
          const interpolated = Array.from(
            normalA,
            (v, j) => v + fraction * (normalB[j] - v),
          );
          const length = Math.hypot(...interpolated),
            unit = interpolated.map((v) => v / length),
            previous = boundaryNormalsAtCut.get(index);
          if (
            previous &&
            unit.reduce((sum, v, j) => sum + v * previous[j], 0) < 0.7
          )
            fixedCutVertices.add(index);
          boundaryNormalsAtCut.set(index, unit);
          polygon.push(coordinates.slice(index * 3, index * 3 + 3));
          normals.push(interpolated);
          indices.push(index);
        }
      }
      for (let i = 1; i + 1 < polygon.length; i++)
        for (const j of [0, i, i + 1]) {
          capPositions.push(...polygon[j]);
          capVertexIndices.push(indices[j]);
          const n = normals[j],
            length = Math.hypot(...n);
          capNormals.push(n[0] / length, n[1] / length, n[2] / length);
        }
    }
    // Taubin fairing suppresses contour chatter. Boundary cuts move tangentially; CAD creases stay pinned.
    const neighbors = Array.from(
      { length: coordinates.length / 3 },
      () => new Set(),
    );
    for (let i = 0; i < triangles.length; i += 3) {
      const [a, b, c] = triangles.slice(i, i + 3);
      neighbors[a].add(b).add(c);
      neighbors[b].add(a).add(c);
      neighbors[c].add(a).add(b);
    }
    let points = Float64Array.from(coordinates);
    for (const amount of Array.from({ length: 12 }, (_, i) =>
      i % 2 ? -0.46 : 0.45,
    )) {
      const result = points.slice();
      for (let i = 0; i < neighbors.length; i++)
        if (!fixedCutVertices.has(i) && neighbors[i].size) {
          const delta = [0, 0, 0];
          for (let j = 0; j < 3; j++) {
            for (const other of neighbors[i]) delta[j] += points[other * 3 + j];
            delta[j] =
              amount * (delta[j] / neighbors[i].size - points[i * 3 + j]);
          }
          const n = boundaryNormalsAtCut.get(i);
          if (n) {
            const dot = delta.reduce((sum, v, j) => sum + v * n[j], 0);
            for (let j = 0; j < 3; j++) delta[j] -= dot * n[j];
          }
          const moved = delta.map(
              (v, j) => points[i * 3 + j] + v - coordinates[i * 3 + j],
            ),
            distance = Math.hypot(...moved),
            limit = 1.2;
          for (let j = 0; j < 3; j++)
            result[i * 3 + j] =
              coordinates[i * 3 + j] +
              moved[j] * Math.min(1, limit / (distance || 1));
        }
      points = result;
    }
    for (let i = 0; i < capVertexIndices.length; i++)
      if (capVertexIndices[i] >= 0)
        for (let j = 0; j < 3; j++)
          capPositions[i * 3 + j] = points[capVertexIndices[i] * 3 + j];
    const vertexNormals = new Float64Array(points.length);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i] * 3,
        b = triangles[i + 1] * 3,
        c = triangles[i + 2] * 3;
      const ux = points[b] - points[a],
        uy = points[b + 1] - points[a + 1],
        uz = points[b + 2] - points[a + 2],
        vx = points[c] - points[a],
        vy = points[c + 1] - points[a + 1],
        vz = points[c + 2] - points[a + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      for (const node of [a, b, c]) {
        vertexNormals[node] += nx;
        vertexNormals[node + 1] += ny;
        vertexNormals[node + 2] += nz;
      }
    }
    const positions = new Float32Array(
        triangles.length * 3 + capPositions.length,
      ),
      normals = new Float32Array(positions.length);
    for (let i = 0; i < triangles.length; i++) {
      const node = triangles[i] * 3,
        length =
          Math.hypot(
            vertexNormals[node],
            vertexNormals[node + 1],
            vertexNormals[node + 2],
          ) || 1;
      for (let j = 0; j < 3; j++) {
        positions[i * 3 + j] = points[node + j];
        normals[i * 3 + j] = vertexNormals[node + j] / length;
      }
    }
    positions.set(capPositions, triangles.length * 3);
    normals.set(capNormals, triangles.length * 3);
    return { positions, normals, triangleCount: positions.length / 9 };
  };
}
