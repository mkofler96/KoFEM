// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ShellizeMesh } from "./shellize/geometry.js";
import type { ShellExtraction } from "./shellize/midSurface.js";

type Point = [number, number, number];
export interface TransitionPlane {
  origin: Point;
  normal: Point;
}
const tetFaces = [
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

function triangulate(polygon: number[]): number[][] {
  if (polygon.length < 3) return [];
  const minimum = polygon.indexOf(Math.min(...polygon));
  const ordered = [...polygon.slice(minimum), ...polygon.slice(0, minimum)];
  return ordered
    .slice(1, -1)
    .map((_, index) => [ordered[0], ordered[index + 1], ordered[index + 2]]);
}

interface VolumePiece {
  faces: number[][];
  retained: boolean;
}
interface SurfacePiece {
  polygon: number[];
  retained: boolean;
}

// One cache per node pool makes intersections shared across materials and
// neighbouring elements. Canonical face fans then preserve solid conformity.
class PlaneClipper {
  private readonly intersections = new Map<string, number>();
  constructor(
    readonly vertices: number[],
    readonly planes: TransitionPlane[],
    readonly tolerance: number,
  ) {}
  point(index: number): Point {
    return [
      this.vertices[3 * index],
      this.vertices[3 * index + 1],
      this.vertices[3 * index + 2],
    ];
  }
  addPoint(point: Point): number {
    const index = this.vertices.length / 3;
    this.vertices.push(...point);
    return index;
  }
  center(nodes: number[]): Point {
    const center: Point = [0, 0, 0];
    for (const index of nodes)
      this.point(index).forEach(
        (value, axis) => (center[axis] += value / nodes.length),
      );
    return center;
  }
  distance(index: number, planeIndex: number): number {
    const plane = this.planes[planeIndex];
    return dot(minus(this.point(index), plane.origin), plane.normal);
  }
  side(nodes: number[], planeIndex: number): -1 | 0 | 1 {
    const distances = nodes.map((index) => this.distance(index, planeIndex));
    if (Math.max(...distances) <= this.tolerance) return -1;
    if (Math.min(...distances) >= -this.tolerance) return 1;
    return 0;
  }
  intersection(first: number, second: number, planeIndex: number): number {
    const startDistance = this.distance(first, planeIndex),
      endDistance = this.distance(second, planeIndex);
    if (Math.abs(startDistance) <= this.tolerance) return first;
    if (Math.abs(endDistance) <= this.tolerance) return second;
    const key = `${Math.min(first, second)},${Math.max(first, second)},${planeIndex}`;
    const existing = this.intersections.get(key);
    if (existing !== undefined) return existing;
    const ratio = startDistance / (startDistance - endDistance),
      start = this.point(first),
      end = this.point(second);
    const index = this.addPoint(
      start.map((value, axis) => value + ratio * (end[axis] - value)) as Point,
    );
    this.intersections.set(key, index);
    return index;
  }
  clipPolygon(
    polygon: number[],
    planeIndex: number,
    positive: boolean,
  ): number[] {
    const output: number[] = [],
      sign = positive ? 1 : -1;
    for (let corner = 0; corner < polygon.length; corner++) {
      const start = polygon[corner],
        end = polygon[(corner + 1) % polygon.length];
      const inside = sign * this.distance(start, planeIndex) >= -this.tolerance;
      const nextInside =
        sign * this.distance(end, planeIndex) >= -this.tolerance;
      if (inside) output.push(start);
      if (inside !== nextInside)
        output.push(this.intersection(start, end, planeIndex));
    }
    return [...new Set(output)];
  }
  private orderedCap(nodes: number[], planeIndex: number): number[] {
    const cap = nodes.filter(
      (index) => Math.abs(this.distance(index, planeIndex)) <= this.tolerance,
    );
    const center = this.center(cap),
      normal = this.planes[planeIndex].normal;
    const seed: Point = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    const first = cross(normal, seed),
      second = cross(normal, first);
    const angle = (index: number) => {
      const offset = minus(this.point(index), center);
      return Math.atan2(dot(offset, second), dot(offset, first));
    };
    return cap.sort((left, right) => angle(left) - angle(right));
  }
  private volumeSide(
    faces: number[][],
    planeIndex: number,
    positive: boolean,
  ): number[][] {
    const clipped = faces
      .map((face) => this.clipPolygon(face, planeIndex, positive))
      .filter((face) => face.length >= 3);
    const cap = this.orderedCap([...new Set(clipped.flat())], planeIndex);
    const existing = clipped.some(
      (face) =>
        face.length === cap.length &&
        face.every((index) => cap.includes(index)),
    );
    if (cap.length >= 3 && !existing) clipped.push(cap);
    return clipped;
  }
  splitVolume(piece: VolumePiece, planeIndex: number): VolumePiece[] {
    const side = this.side([...new Set(piece.faces.flat())], planeIndex);
    if (side < 0) return [{ faces: piece.faces, retained: true }];
    if (side > 0) return [piece];
    return [
      {
        faces: this.volumeSide(piece.faces, planeIndex, false),
        retained: true,
      },
      {
        faces: this.volumeSide(piece.faces, planeIndex, true),
        retained: piece.retained,
      },
    ];
  }
  splitSurface(piece: SurfacePiece, planeIndex: number): SurfacePiece[] {
    const side = this.side(piece.polygon, planeIndex);
    if (side < 0) return [{ polygon: piece.polygon, retained: true }];
    if (side > 0) return [piece];
    return [
      {
        polygon: this.clipPolygon(piece.polygon, planeIndex, false),
        retained: true,
      },
      {
        polygon: this.clipPolygon(piece.polygon, planeIndex, true),
        retained: piece.retained,
      },
    ].filter((part) => part.polygon.length >= 3);
  }
}

class SolidOutput {
  readonly tet: number[] = [];
  readonly body: number[] = [];
  constructor(private readonly clipper: PlaneClipper) {}
  addTet(nodes: number[], bodyId: number): void {
    const corners = nodes.map((index) => this.clipper.point(index));
    const determinant = dot(
      minus(corners[1], corners[0]),
      cross(minus(corners[2], corners[0]), minus(corners[3], corners[0])),
    );
    if (Math.abs(determinant) <= this.clipper.tolerance ** 3) return;
    if (determinant < 0) [nodes[1], nodes[2]] = [nodes[2], nodes[1]];
    this.tet.push(...nodes);
    this.body.push(bodyId);
  }
  addVolume(piece: VolumePiece, originalNodes: number[], bodyId: number): void {
    if (!piece.retained) return;
    const nodes = [...new Set(piece.faces.flat())];
    if (nodes.length < 4) return;
    if (
      nodes.length === 4 &&
      nodes.every((index) => originalNodes.includes(index))
    ) {
      this.addTet(originalNodes, bodyId);
      return;
    }
    const center = this.clipper.addPoint(this.clipper.center(nodes));
    for (const face of piece.faces)
      for (const triangle of triangulate(face))
        this.addTet([...triangle, center], bodyId);
  }
}

function clipSolidTets(
  mesh: ShellizeMesh,
  replaced: Set<number>,
  clipper: PlaneClipper,
): SolidOutput {
  const output = new SolidOutput(clipper);
  for (let element = 0; element < mesh.body.length; element++) {
    const nodes = mesh.tet.slice(4 * element, 4 * element + 4);
    let pieces: VolumePiece[] = [
      {
        faces: tetFaces.map((face) => face.map((corner) => nodes[corner])),
        retained: !replaced.has(element),
      },
    ];
    // Retained solids must receive every cut too: otherwise a plane from a
    // perpendicular joint leaves hanging nodes on their shared solid interface.
    for (let planeIndex = 0; planeIndex < clipper.planes.length; planeIndex++)
      pieces = pieces.flatMap((piece) =>
        clipper.splitVolume(piece, planeIndex),
      );
    for (const piece of pieces)
      output.addVolume(piece, nodes, mesh.body[element]);
  }
  return output;
}

function clipSolidSurface(
  mesh: ShellizeMesh,
  shellFaceIds: Set<number>,
  clipper: PlaneClipper,
): { surfTri: number[]; surfFace: number[] } {
  const surfTri: number[] = [],
    surfFace: number[] = [];
  for (let triangle = 0; triangle < mesh.surfFace.length; triangle++) {
    const faceId = mesh.surfFace[triangle];
    let pieces: SurfacePiece[] = [
      {
        polygon: mesh.surfTri.slice(3 * triangle, 3 * triangle + 3),
        retained: !shellFaceIds.has(faceId),
      },
    ];
    for (let planeIndex = 0; planeIndex < clipper.planes.length; planeIndex++)
      pieces = pieces.flatMap((piece) =>
        clipper.splitSurface(piece, planeIndex),
      );
    for (const piece of pieces) {
      if (!piece.retained) continue;
      for (const face of triangulate(piece.polygon)) {
        surfTri.push(...face);
        surfFace.push(faceId);
      }
    }
  }
  return { surfTri, surfFace };
}

function compactShellNodes(
  shells: ShellExtraction,
  triangles: number[],
  nodeSources: number[],
  clipper: PlaneClipper,
): void {
  if (triangles.length === 0)
    throw new Error(
      "Shell body is too short to retain its solid joint sections. Keep this body Solid.",
    );
  const used = [...new Set(triangles)],
    remap = new Map(used.map((index, position) => [index, position]));
  shells.shellVerts = used.flatMap((index) => clipper.point(index));
  shells.shellSrc = used.map((index) => nodeSources[index]);
  shells.shellTris = triangles.map((index) => {
    const mapped = remap.get(index);
    if (mapped === undefined) throw new Error("Missing clipped shell vertex");
    return mapped;
  });
}

function clipShellFacets(
  shells: ShellExtraction,
  planes: TransitionPlane[],
  tolerance: number,
): void {
  const clipper = new PlaneClipper([...shells.shellVerts], planes, tolerance);
  const triangles: number[] = [],
    thicknesses: number[] = [],
    sources: number[] = [],
    nodeSources = [...shells.shellSrc];
  for (let triangle = 0; triangle < shells.shellThk.length; triangle++) {
    let polygon = shells.shellTris.slice(3 * triangle, 3 * triangle + 3);
    for (
      let planeIndex = 0;
      planeIndex < planes.length && polygon.length >= 3;
      planeIndex++
    )
      polygon = clipper.clipPolygon(polygon, planeIndex, true);
    while (nodeSources.length < clipper.vertices.length / 3)
      nodeSources.push(shells.shellTriSrc[triangle]);
    for (const face of triangulate(polygon)) {
      const [first, second, third] = face.map((index) => clipper.point(index));
      const normal = cross(minus(second, first), minus(third, first));
      if (Math.sqrt(dot(normal, normal)) <= tolerance ** 2) continue;
      triangles.push(...face);
      thicknesses.push(shells.shellThk[triangle]);
      sources.push(shells.shellTriSrc[triangle]);
    }
  }
  compactShellNodes(shells, triangles, nodeSources, clipper);
  shells.shellThk = thicknesses;
  shells.shellTriSrc = sources;
}

export function clipShellTransition(
  mesh: ShellizeMesh,
  shells: ShellExtraction,
  replaced: Set<number>,
  planes: TransitionPlane[],
  shellFaceIds: Set<number>,
  tolerance: number,
): ShellizeMesh {
  const clipper = new PlaneClipper([...mesh.V], planes, tolerance);
  const solids = clipSolidTets(mesh, replaced, clipper);
  const surface = clipSolidSurface(mesh, shellFaceIds, clipper);
  clipShellFacets(shells, planes, tolerance);
  return {
    V: clipper.vertices,
    tet: solids.tet,
    body: solids.body,
    ...surface,
  };
}
