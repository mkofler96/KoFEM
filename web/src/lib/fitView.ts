// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The box Fit view frames: what the viewport draws (KOF-385). With a deformed
// result shown, that is the deformed shape at the scale the scene draws it
// with, plus the undeformed overlay when it is visible. Otherwise, and at
// scale 0, it is the undeformed mesh and the CAD tessellation.

type Vec3 = [number, number, number];

export interface FitViewInput {
  nodes: readonly { x: number; y: number; z: number }[];
  stepSurface: { points: readonly Vec3[] } | null;
  // The shown result: null without one, or when the viewport does not draw it.
  deformed: {
    // Three components per node, in the order of `nodes`.
    displacements: ArrayLike<number>;
    // The factor the scene multiplies the displacements by.
    scale: number;
    // Whether the undeformed overlay is drawn over the result.
    showUndeformed: boolean;
  } | null;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export function fitViewBox({
  nodes,
  stepSurface,
  deformed,
}: FitViewInput): Box | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let empty = true;
  const add = (x: number, y: number, z: number) => {
    empty = false;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  };

  if (deformed !== null && deformed.scale !== 0) {
    const { displacements: u, scale, showUndeformed } = deformed;
    if (u.length !== 3 * nodes.length)
      throw new Error(
        `Fit view: the result has ${u.length / 3} displacements for ${nodes.length} nodes`,
      );
    nodes.forEach((n, i) => {
      add(
        n.x + u[3 * i] * scale,
        n.y + u[3 * i + 1] * scale,
        n.z + u[3 * i + 2] * scale,
      );
      if (showUndeformed) add(n.x, n.y, n.z);
    });
  } else {
    for (const n of nodes) add(n.x, n.y, n.z);
    if (stepSurface) for (const [x, y, z] of stepSurface.points) add(x, y, z);
  }

  return empty ? null : { min, max };
}

/**
 * The sphere around `box`: its centre and half its diagonal. A box without
 * extent (every point in one place) has nothing to frame.
 */
export function boundingSphere(box: Box): { center: Vec3; radius: number } {
  const { min, max } = box;
  const radius =
    Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  if (!(radius > 0))
    throw new Error(
      `The view has nothing to frame: the model has no extent at (${min.join(", ")})`,
    );
  return {
    center: [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ],
    radius,
  };
}

// Results → Show (KOF-495) frames a sphere of this share of the model's
// bounding sphere around the node: close enough to see the elements at the
// node, wide enough to see where on the part it lies.
export const NODE_FRAME_SHARE = 0.3;

/**
 * The sphere Results → Show frames around node `index`: centred where the
 * viewport draws the node (on the deformed shape at the drawn scale), with
 * NODE_FRAME_SHARE of the radius of what Fit view frames.
 */
export function nodeFrame(
  input: FitViewInput,
  index: number,
): { center: Vec3; radius: number } {
  const node = input.nodes[index];
  if (!Number.isInteger(index) || node === undefined)
    throw new Error(
      `Show: node ${index} is not one of the model's ${input.nodes.length} nodes`,
    );
  const box = fitViewBox(input);
  if (box === null) throw new Error("Show: the model draws nothing");
  const { deformed } = input;
  const center: Vec3 =
    deformed === null || deformed.scale === 0
      ? [node.x, node.y, node.z]
      : [
          node.x + deformed.displacements[3 * index] * deformed.scale,
          node.y + deformed.displacements[3 * index + 1] * deformed.scale,
          node.z + deformed.displacements[3 * index + 2] * deformed.scale,
        ];
  return { center, radius: NODE_FRAME_SHARE * boundingSphere(box).radius };
}
