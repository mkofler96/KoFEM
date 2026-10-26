// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later
export function shellJunction(refinement = 1, wallStep = 3) {
  const mesh = { V: [], tet: [], body: [], surfTri: [], surfFace: [] };
  const byPosition = new Map();
  const add = (pos) => {
    const key = pos.map((value) => value.toFixed(9)).join(",");
    if (byPosition.has(key)) return byPosition.get(key);
    const index = mesh.V.length / 3;
    mesh.V.push(...pos);
    byPosition.set(key, index);
    return index;
  };
  const baseY = [0, 5, 10, 15, 19, 21, 25, 30, 35, 40],
    coordsY = [];
  for (let row = 0; row < baseY.length - 1; row++)
    for (let part = 0; part < refinement; part++)
      coordsY.push(
        baseY[row] + ((baseY[row + 1] - baseY[row]) * part) / refinement,
      );
  coordsY.push(40);
  const coordsX = Array.from(
    { length: 12 * refinement + 1 },
    (_, index) => (60 * index) / (12 * refinement),
  );
  const baseZ = Array.from(
    { length: 3 * refinement + 1 },
    (_, index) => (6 * index) / (3 * refinement),
  );
  const wallY = Array.from(
    { length: refinement + 1 },
    (_, index) => 19 + (2 * index) / refinement,
  );
  const wallZ = Array.from(
    { length: Math.ceil(30 / wallStep) * refinement + 1 },
    (_, index) => 6 + (30 * index) / (Math.ceil(30 / wallStep) * refinement),
  );
  const decomposition = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
  ];
  const addBox = (ys, zs, bodyId) => {
    const node = (col, row, layer) => add([coordsX[col], ys[row], zs[layer]]);
    for (let col = 0; col < coordsX.length - 1; col++)
      for (let row = 0; row < ys.length - 1; row++)
        for (let layer = 0; layer < zs.length - 1; layer++) {
          const nodes = [
            node(col, row, layer),
            node(col + 1, row, layer),
            node(col + 1, row + 1, layer),
            node(col, row + 1, layer),
            node(col, row, layer + 1),
            node(col + 1, row, layer + 1),
            node(col + 1, row + 1, layer + 1),
            node(col, row + 1, layer + 1),
          ];
          for (const tet of decomposition) {
            mesh.tet.push(...tet.map((index) => nodes[index]));
            mesh.body.push(bodyId);
          }
        }
  };
  addBox(coordsY, baseZ, 2);
  addBox(wallY, wallZ, 1);
  const boundary = new Map();
  for (let element = 0; element < mesh.body.length; element++)
    for (const face of [
      [0, 1, 2],
      [0, 1, 3],
      [0, 2, 3],
      [1, 2, 3],
    ]) {
      const nodes = face.map((corner) => mesh.tet[4 * element + corner]);
      const key = [
        mesh.body[element],
        ...nodes.toSorted((left, right) => left - right),
      ].join(",");
      const entry = boundary.get(key);
      if (entry) entry.count++;
      else boundary.set(key, { count: 1, nodes, body: mesh.body[element] });
    }
  const point = (index) => mesh.V.slice(3 * index, 3 * index + 3);
  for (const face of boundary.values()) {
    if (face.count !== 1) continue;
    const positions = face.nodes.map(point);
    const center = face.body === 1 ? [30, 20, 21] : [30, 20, 3];
    const axis = [0, 1, 2].find((index) =>
      positions.every(
        (pos) => Math.abs(pos[index] - positions[0][index]) < 1e-8,
      ),
    );
    const side = positions[0][axis] < center[axis] ? 0 : 1;
    const first = positions[1].map(
      (value, index) => value - positions[0][index],
    );
    const second = positions[2].map(
      (value, index) => value - positions[0][index],
    );
    const normal = [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ];
    if (normal[axis] * (side ? 1 : -1) < 0)
      [face.nodes[1], face.nodes[2]] = [face.nodes[2], face.nodes[1]];
    mesh.surfTri.push(...face.nodes);
    mesh.surfFace.push((face.body === 1 ? 1 : 10) + 2 * axis + side);
  }
  return mesh;
}
export function tetVolume(vertices, nodes) {
  const point = (index) => vertices.slice(3 * index, 3 * index + 3);
  const origin = point(nodes[0]);
  const edges = nodes
    .slice(1)
    .map((index) => point(index).map((value, axis) => value - origin[axis]));
  const [first, second, third] = edges;
  return (
    Math.abs(
      first[0] * (second[1] * third[2] - second[2] * third[1]) -
        first[1] * (second[0] * third[2] - second[2] * third[0]) +
        first[2] * (second[0] * third[1] - second[1] * third[0]),
    ) / 6
  );
}
