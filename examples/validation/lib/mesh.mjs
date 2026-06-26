// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Structured hex-mesh generators and node selectors for the validation cases.
//
// Every generator returns { vertices: [[x,y,z]...], hexahedra: [[..8]...] } plus
// any helpers a case needs to pick boundary nodes. Hex vertex ordering matches
// MFEM's AddHex: bottom face CCW, then the matching top face.

/** Axis-aligned box [0,L]×[0,W]×[0,H], nx·ny·nz linear hexes. */
export function boxHexMesh(L, W, H, nx, ny, nz) {
  const nid = (i, j, k) => i * (ny + 1) * (nz + 1) + j * (nz + 1) + k;
  const vertices = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++)
      for (let k = 0; k <= nz; k++)
        vertices.push([(i * L) / nx, (j * W) / ny, (k * H) / nz]);
  const hexahedra = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++)
        hexahedra.push([
          nid(i, j, k),
          nid(i + 1, j, k),
          nid(i + 1, j + 1, k),
          nid(i, j + 1, k),
          nid(i, j, k + 1),
          nid(i + 1, j, k + 1),
          nid(i + 1, j + 1, k + 1),
          nid(i, j + 1, k + 1),
        ]);
  return { vertices, hexahedra, nid };
}

/**
 * Square plate of half-width b with a central circular hole of radius a,
 * thickness t. O-grid: rings blend from the hole (s=0) to the square outer
 * boundary (s=1); `grade` clusters rings near the hole where the stress
 * gradient is steep. Single hole-ring of elements is index 0..nth-1, so the
 * peak stress sits in the first nth hexes.
 */
export function plateWithHoleMesh(a, b, t, nr, nth, grade = 2) {
  const idx = new Map();
  const key = (i, j, k) => `${i},${((j % nth) + nth) % nth},${k}`;
  const square = (th) => {
    const c = Math.cos(th),
      s = Math.sin(th);
    const m = Math.max(Math.abs(c), Math.abs(s));
    return [(b * c) / m, (b * s) / m];
  };
  const vertices = [];
  let id = 0;
  for (let i = 0; i <= nr; i++) {
    const s = Math.pow(i / nr, grade);
    for (let j = 0; j < nth; j++) {
      const th = (2 * Math.PI * j) / nth;
      const [cx, cy] = [a * Math.cos(th), a * Math.sin(th)];
      const [sx, sy] = square(th);
      const x = (1 - s) * cx + s * sx;
      const y = (1 - s) * cy + s * sy;
      for (let k = 0; k < 2; k++) {
        idx.set(key(i, j, k), id++);
        vertices.push([x, y, k * t]);
      }
    }
  }
  const n = (i, j, k) => idx.get(key(i, j, k));
  const hexahedra = [];
  for (let i = 0; i < nr; i++)
    for (let j = 0; j < nth; j++)
      hexahedra.push([
        n(i, j, 0),
        n(i + 1, j, 0),
        n(i + 1, j + 1, 0),
        n(i, j + 1, 0),
        n(i, j, 1),
        n(i + 1, j, 1),
        n(i + 1, j + 1, 1),
        n(i, j + 1, 1),
      ]);
  return { vertices, hexahedra, nth, nr };
}

/**
 * Hollow circular shaft (annulus) ri→ro, length Lz along +z.
 * nr radial × nth circumferential × nz axial linear hexes.
 * Returns helpers ring(k) → node indices at axial layer k.
 */
export function annulusHexMesh(ri, ro, Lz, nr, nth, nz) {
  const id = (i, j, k) =>
    i * nth * (nz + 1) + (((j % nth) + nth) % nth) * (nz + 1) + k;
  const vertices = [];
  for (let i = 0; i <= nr; i++) {
    const r = ri + ((ro - ri) * i) / nr;
    for (let j = 0; j < nth; j++) {
      const th = (2 * Math.PI * j) / nth;
      for (let k = 0; k <= nz; k++)
        vertices.push([r * Math.cos(th), r * Math.sin(th), (Lz * k) / nz]);
    }
  }
  const hexahedra = [];
  for (let i = 0; i < nr; i++)
    for (let j = 0; j < nth; j++)
      for (let k = 0; k < nz; k++)
        hexahedra.push([
          id(i, j, k),
          id(i + 1, j, k),
          id(i + 1, j + 1, k),
          id(i, j + 1, k),
          id(i, j, k + 1),
          id(i + 1, j, k + 1),
          id(i + 1, j + 1, k + 1),
          id(i, j + 1, k + 1),
        ]);
  return { vertices, hexahedra, id, nr, nth, nz };
}

/**
 * Cook's membrane: tapered quad (0,0)-(48,44)-(48,60)-(0,44), thickness t,
 * extruded one layer in z. ξ runs left(clamp)→right(load), η runs bottom→top.
 * Returns corner() helper for the loaded top-right node.
 */
export function cookMembraneMesh(nx, ny, t) {
  const P00 = [0, 0],
    P10 = [48, 44],
    P11 = [48, 60],
    P01 = [0, 44];
  const at = (xi, eta) => [
    (1 - xi) * (1 - eta) * P00[0] +
      xi * (1 - eta) * P10[0] +
      xi * eta * P11[0] +
      (1 - xi) * eta * P01[0],
    (1 - xi) * (1 - eta) * P00[1] +
      xi * (1 - eta) * P10[1] +
      xi * eta * P11[1] +
      (1 - xi) * eta * P01[1],
  ];
  const nid = (i, j, k) => i * (ny + 1) * 2 + j * 2 + k;
  const vertices = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) {
      const [x, y] = at(i / nx, j / ny);
      for (let k = 0; k < 2; k++) vertices.push([x, y, k * t]);
    }
  const hexahedra = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      hexahedra.push([
        nid(i, j, 0),
        nid(i + 1, j, 0),
        nid(i + 1, j + 1, 0),
        nid(i, j + 1, 0),
        nid(i, j, 1),
        nid(i + 1, j, 1),
        nid(i + 1, j + 1, 1),
        nid(i, j + 1, 1),
      ]);
  return { vertices, hexahedra, nid, nx, ny };
}

/** Indices of vertices satisfying pred(x,y,z,index). */
export function nodesWhere(vertices, pred) {
  const out = [];
  vertices.forEach((v, i) => {
    if (pred(v[0], v[1], v[2], i)) out.push(i);
  });
  return out;
}

/** Distribute a total force vector evenly over the given nodes. */
export function distributeForce(nodeIds, force) {
  const per = [
    force[0] / nodeIds.length,
    force[1] / nodeIds.length,
    force[2] / nodeIds.length,
  ];
  return nodeIds.map((vertex) => ({ vertex, force: per }));
}
