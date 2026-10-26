// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ShellExtraction, ShellizeMesh } from "./shellize";

type Point = [number, number, number];
export interface TransitionPlane {
  origin: Point;
  normal: Point;
}
const faces = [
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
];
const dot = (left: Point, right: Point) =>
  left.reduce((sum, value, axis) => sum + value * right[axis], 0);
const minus = (left: Point, right: Point): Point => [
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
];
const cross = (left: Point, right: Point): Point => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

// Clip at physical transition planes. Intersections are shared by edge+plane;
// canonical face fans give neighbouring cut tets the same face triangulation.
export function clipShellTransition(
  mesh: ShellizeMesh,
  shells: ShellExtraction,
  replaced: Set<number>,
  planes: TransitionPlane[],
  shellFaceIds: Set<number>,
  tolerance: number,
): ShellizeMesh {
  const vertices = [...mesh.V];
  const intersections = new Map<string, number>();
  const point = (index: number): Point => [
    vertices[3 * index],
    vertices[3 * index + 1],
    vertices[3 * index + 2],
  ];
  const distance = (index: number, plane: TransitionPlane) =>
    dot(minus(point(index), plane.origin), plane.normal);
  const intersection = (first: number, second: number, planeIndex: number) => {
    const plane = planes[planeIndex];
    const firstDistance = distance(first, plane),
      secondDistance = distance(second, plane);
    if (Math.abs(firstDistance) <= tolerance) return first;
    if (Math.abs(secondDistance) <= tolerance) return second;
    const key = `${Math.min(first, second)},${Math.max(first, second)},${planeIndex}`;
    const existing = intersections.get(key);
    if (existing !== undefined) return existing;
    const ratio = firstDistance / (firstDistance - secondDistance);
    const start = point(first),
      end = point(second);
    const result = vertices.length / 3;
    vertices.push(
      ...start.map((value, axis) => value + ratio * (end[axis] - value)),
    );
    intersections.set(key, result);
    return result;
  };
  const clipPolygon = (
    polygon: number[],
    planeIndex: number,
    positive: boolean,
  ): number[] => {
    const output: number[] = [];
    const sign = positive ? 1 : -1;
    for (let corner = 0; corner < polygon.length; corner++) {
      const start = polygon[corner],
        end = polygon[(corner + 1) % polygon.length];
      const inside = sign * distance(start, planes[planeIndex]) >= -tolerance;
      const nextInside = sign * distance(end, planes[planeIndex]) >= -tolerance;
      if (inside) output.push(start);
      if (inside !== nextInside)
        output.push(intersection(start, end, planeIndex));
    }
    return [...new Set(output)];
  };
  const split = (
    polyhedron: number[][],
    planeIndex: number,
    positive: boolean,
  ): number[][] => {
    const output = polyhedron
      .map((face) => clipPolygon(face, planeIndex, positive))
      .filter((face) => face.length >= 3);
    const cap = [...new Set(output.flat())].filter(
      (index) => Math.abs(distance(index, planes[planeIndex])) <= tolerance,
    );
    if (cap.length >= 3) {
      const center: Point = [0, 0, 0];
      for (const index of cap)
        point(index).forEach(
          (value, axis) => (center[axis] += value / cap.length),
        );
      const normal = planes[planeIndex].normal;
      const seed: Point = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
      const firstAxis = cross(normal, seed),
        secondAxis = cross(normal, firstAxis);
      cap.sort((left, right) => {
        const leftOffset = minus(point(left), center),
          rightOffset = minus(point(right), center);
        return (
          Math.atan2(dot(leftOffset, secondAxis), dot(leftOffset, firstAxis)) -
          Math.atan2(dot(rightOffset, secondAxis), dot(rightOffset, firstAxis))
        );
      });
      // An original face on the plane is already present.
      if (
        !output.some(
          (face) =>
            face.length === cap.length &&
            face.every((index) => cap.includes(index)),
        )
      )
        output.push(cap);
    }
    return output;
  };
  const fan = (polygon: number[]) => {
    const minimum = polygon.indexOf(Math.min(...polygon));
    const ordered = [...polygon.slice(minimum), ...polygon.slice(0, minimum)];
    return ordered
      .slice(1, -1)
      .map((_, index) => [ordered[0], ordered[index + 1], ordered[index + 2]]);
  };
  const tets: number[] = [],
    body: number[] = [];
  const addTet = (nodes: number[], bodyId: number) => {
    const corners = nodes.map(point);
    const determinant = dot(
      minus(corners[1], corners[0]),
      cross(minus(corners[2], corners[0]), minus(corners[3], corners[0])),
    );
    if (Math.abs(determinant) <= tolerance ** 3) return;
    if (determinant < 0) [nodes[1], nodes[2]] = [nodes[2], nodes[1]];
    tets.push(...nodes);
    body.push(bodyId);
  };
  const addPolyhedron = (polyhedron: number[][], bodyId: number) => {
    const nodes = [...new Set(polyhedron.flat())];
    if (nodes.length < 4) return;
    const center: Point = [0, 0, 0];
    for (const index of nodes)
      point(index).forEach(
        (value, axis) => (center[axis] += value / nodes.length),
      );
    const centerIndex = vertices.length / 3;
    vertices.push(...center);
    for (const face of polyhedron)
      for (const triangle of fan(face))
        addTet([...triangle, centerIndex], bodyId);
  };
  for (let element = 0; element < mesh.tet.length / 4; element++) {
    const nodes = mesh.tet.slice(4 * element, 4 * element + 4);
    if (!replaced.has(element)) {
      addTet(nodes, mesh.body[element]);
      continue;
    }
    let remainder = faces.map((face) => face.map((corner) => nodes[corner]));
    for (
      let planeIndex = 0;
      planeIndex < planes.length && remainder.length;
      planeIndex++
    ) {
      const distances = [...new Set(remainder.flat())].map((index) =>
        distance(index, planes[planeIndex]),
      );
      if (Math.max(...distances) <= tolerance) {
        // Preserve untouched tets rather than subdividing them.
        if (
          remainder.length === 4 &&
          remainder.every((face) =>
            face.every((index) => nodes.includes(index)),
          )
        )
          addTet(nodes, mesh.body[element]);
        else addPolyhedron(remainder, mesh.body[element]);
        remainder = [];
        break;
      }
      if (Math.min(...distances) >= -tolerance) continue;
      addPolyhedron(split(remainder, planeIndex, false), mesh.body[element]);
      remainder = split(remainder, planeIndex, true);
    }
  }
  const surfTri: number[] = [],
    surfFace: number[] = [];
  for (let triangle = 0; triangle < mesh.surfFace.length; triangle++) {
    let polygon = mesh.surfTri.slice(3 * triangle, 3 * triangle + 3);
    if (!shellFaceIds.has(mesh.surfFace[triangle])) {
      surfTri.push(...polygon);
      surfFace.push(mesh.surfFace[triangle]);
      continue;
    }
    for (
      let planeIndex = 0;
      planeIndex < planes.length && polygon.length >= 3;
      planeIndex++
    ) {
      const retained = clipPolygon(polygon, planeIndex, false);
      for (const face of fan(retained)) {
        surfTri.push(...face);
        surfFace.push(mesh.surfFace[triangle]);
      }
      polygon = clipPolygon(polygon, planeIndex, true);
    }
  }
  // Shell facets occupy only the complement of the retained solid sections.
  const shellVertices = [...shells.shellVerts];
  const shellMesh: ShellizeMesh = {
    V: shellVertices,
    tet: [],
    body: [],
    surfTri: [],
    surfFace: [],
  };
  // Reuse polygon clipping with its own edge cache and node numbering.
  const shellCache = new Map<string, number>();
  const shellPoint = (index: number): Point => [
    shellMesh.V[3 * index],
    shellMesh.V[3 * index + 1],
    shellMesh.V[3 * index + 2],
  ];
  const shellTriangles: number[] = [],
    thicknesses: number[] = [],
    sources: number[] = [],
    nodeSources = [...shells.shellSrc];
  for (let triangle = 0; triangle < shells.shellThk.length; triangle++) {
    let polygon = shells.shellTris.slice(3 * triangle, 3 * triangle + 3);
    for (
      let planeIndex = 0;
      planeIndex < planes.length && polygon.length >= 3;
      planeIndex++
    ) {
      const plane = planes[planeIndex],
        output: number[] = [];
      for (let corner = 0; corner < polygon.length; corner++) {
        const start = polygon[corner],
          end = polygon[(corner + 1) % polygon.length];
        const startDistance = dot(
            minus(shellPoint(start), plane.origin),
            plane.normal,
          ),
          endDistance = dot(minus(shellPoint(end), plane.origin), plane.normal);
        const inside = startDistance >= -tolerance,
          nextInside = endDistance >= -tolerance;
        if (inside) output.push(start);
        if (inside === nextInside) continue;
        if (Math.abs(startDistance) <= tolerance) {
          output.push(start);
          continue;
        }
        if (Math.abs(endDistance) <= tolerance) {
          output.push(end);
          continue;
        }
        const key = `${Math.min(start, end)},${Math.max(start, end)},${planeIndex}`;
        let index = shellCache.get(key);
        if (index === undefined) {
          const ratio = startDistance / (startDistance - endDistance),
            first = shellPoint(start),
            second = shellPoint(end);
          index = shellMesh.V.length / 3;
          shellMesh.V.push(
            ...first.map(
              (value, axis) => value + ratio * (second[axis] - value),
            ),
          );
          nodeSources.push(shells.shellTriSrc[triangle]);
          shellCache.set(key, index);
        }
        output.push(index);
      }
      polygon = [...new Set(output)];
    }
    for (const face of fan(polygon)) {
      const [first, second, third] = face.map(shellPoint);
      if (
        normCross(minus(second, first), minus(third, first)) <=
        tolerance ** 2
      )
        continue;
      shellTriangles.push(...face);
      thicknesses.push(shells.shellThk[triangle]);
      sources.push(shells.shellTriSrc[triangle]);
    }
  }
  if (shellTriangles.length === 0)
    throw new Error(
      "Shell body is too short to retain its solid joint sections. Keep this body Solid.",
    );
  // Remove unused shell nodes so BC mapping cannot select a node without stiffness.
  const used = [...new Set(shellTriangles)],
    remap = new Map(used.map((index, position) => [index, position]));
  shells.shellVerts = used.flatMap(shellPoint);
  shells.shellSrc = used.map((index) => nodeSources[index]);
  shells.shellTris = shellTriangles.map((index) => {
    const mapped = remap.get(index);
    if (mapped === undefined) throw new Error("Missing clipped shell vertex");
    return mapped;
  });
  shells.shellThk = thicknesses;
  shells.shellTriSrc = sources;
  return { V: vertices, tet: tets, body, surfTri, surfFace };
}
function normCross(left: Point, right: Point) {
  return Math.sqrt(dot(cross(left, right), cross(left, right)));
}
