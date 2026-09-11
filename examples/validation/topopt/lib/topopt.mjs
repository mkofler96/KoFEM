// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Structured hex meshes, boundary-condition builders and topology-field metrics
// for the TO benchmark cases (KOF-234).
//
// The benchmarks deliberately use programmatically generated STRUCTURED hex
// meshes rather than STEP imports: Netgen's CAD meshing is not bit-reproducible,
// and a regression lock needs a fixed design domain so the compliance/volume
// trajectory is the same on every run. A structured grid also gives a trivial
// element↔(i,j,k) map, which the mesh-independence projection and the symmetry
// check below rely on.

/**
 * Axis-aligned box [0,L]×[0,W]×[0,H] as nx·ny·nz linear hexes. Vertex ordering
 * matches MFEM's AddHex (bottom face CCW, then the matching top face), identical
 * to ../../lib/mesh.mjs's boxHexMesh.
 *
 * `eidx(i,j,k)` is the element's position in the returned `hexahedra` array. For
 * a hex-only mesh that is also the engine's element/solve order, so the density
 * the optimizer returns indexes as `density[eidx(i,j,k)]`.
 */
export function boxHexMesh(L, W, H, nx, ny, nz) {
  const nid = (i, j, k) => i * (ny + 1) * (nz + 1) + j * (nz + 1) + k;
  const eidx = (i, j, k) => (i * ny + j) * nz + k;
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
  return { vertices, hexahedra, nid, eidx, dims: { L, W, H, nx, ny, nz } };
}

/**
 * Accumulates per-vertex essential DOFs and emits them in the engine's BC shape:
 * a vertex fixed in all three translations becomes a `fixed_vertices` entry,
 * anything partial (a symmetry plane, a roller) a `fixed_dofs` entry — exactly
 * how the worker's groupDirichlet splits them, so a node is never listed twice.
 * DOF components are 0,1,2 = (u_x, u_y, u_z).
 */
export function dirichletBuilder() {
  const perVertex = new Map();
  return {
    fix(vertex, dof) {
      if (!perVertex.has(vertex)) perVertex.set(vertex, new Set());
      perVertex.get(vertex).add(dof);
    },
    build() {
      const fixed_vertices = [];
      const fixed_dofs = [];
      for (const [vertex, dofs] of perVertex) {
        if (dofs.size === 3) fixed_vertices.push(vertex);
        else fixed_dofs.push({ vertex, dofs: [...dofs].sort() });
      }
      return { fixed_vertices, fixed_dofs };
    },
  };
}

/** Distribute a total force vector evenly as point loads over the given nodes. */
export function distributeForce(nodeIds, force) {
  const per = [
    force[0] / nodeIds.length,
    force[1] / nodeIds.length,
    force[2] / nodeIds.length,
  ];
  return nodeIds.map((vertex) => ({ vertex, force: per }));
}

/**
 * Population statistics of a density field: how many elements resolved to solid
 * (ρ > 0.9) or void (ρ < 0.1), the mean, and the standard deviation. A stalled
 * "uniform gray" run has std ≈ 0; a real topology spreads toward both extremes.
 */
export function densityStats(density) {
  const n = density.length;
  let solid = 0;
  let empty = 0;
  let mean = 0;
  for (const r of density) {
    mean += r;
    if (r > 0.9) solid++;
    if (r < 0.1) empty++;
  }
  mean /= n;
  let variance = 0;
  for (const r of density) variance += (r - mean) ** 2;
  return { solid, void: empty, mean, std: Math.sqrt(variance / n) };
}

/**
 * Average a fine-grid density field onto a coarse grid. The fine grid must be an
 * integer refinement of the coarse one (same physical box), so each coarse
 * element maps exactly onto fx·fy·fz fine elements — the standard way to compare
 * two resolutions of the same design for mesh-independence.
 */
export function projectToCoarse(fine, fineDims, coarse, coarseDims) {
  const fx = fineDims.nx / coarseDims.nx;
  const fy = fineDims.ny / coarseDims.ny;
  const fz = fineDims.nz / coarseDims.nz;
  if (!Number.isInteger(fx) || !Number.isInteger(fy) || !Number.isInteger(fz))
    throw new Error(
      `fine grid ${fineDims.nx}×${fineDims.ny}×${fineDims.nz} is not an integer ` +
        `refinement of coarse ${coarseDims.nx}×${coarseDims.ny}×${coarseDims.nz}`,
    );
  const ce = (i, j, k) => (i * coarseDims.ny + j) * coarseDims.nz + k;
  const fe = (i, j, k) => (i * fineDims.ny + j) * fineDims.nz + k;
  const out = new Array(coarseDims.nx * coarseDims.ny * coarseDims.nz).fill(0);
  for (let i = 0; i < coarseDims.nx; i++)
    for (let j = 0; j < coarseDims.ny; j++)
      for (let k = 0; k < coarseDims.nz; k++) {
        let sum = 0;
        for (let a = 0; a < fx; a++)
          for (let b = 0; b < fy; b++)
            for (let c = 0; c < fz; c++)
              sum += fine[fe(i * fx + a, j * fy + b, k * fz + c)];
        out[ce(i, j, k)] = sum / (fx * fy * fz);
      }
  return out;
}

/** Pearson correlation coefficient between two equal-length fields. */
export function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

/** Intersection-over-union of the thresholded (ρ > th) solid regions. */
export function solidIoU(a, b, th = 0.5) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i] > th;
    const sb = b[i] > th;
    if (sa && sb) inter++;
    if (sa || sb) union++;
  }
  return union ? inter / union : 1;
}

/**
 * Largest density difference between an element and its mirror across the
 * z-midplane, over a structured grid. A z-symmetric problem (geometry, supports
 * and load all symmetric about z = H/2) must produce a z-symmetric design, so
 * this is ~0 for a correct solve.
 */
export function zSymmetryMaxDiff(density, dims) {
  const e = (i, j, k) => (i * dims.ny + j) * dims.nz + k;
  let worst = 0;
  for (let i = 0; i < dims.nx; i++)
    for (let j = 0; j < dims.ny; j++)
      for (let k = 0; k < dims.nz; k++) {
        const diff = Math.abs(
          density[e(i, j, k)] - density[e(i, j, dims.nz - 1 - k)],
        );
        if (diff > worst) worst = diff;
      }
  return worst;
}

/** Indices of vertices of a boxHexMesh satisfying pred(x, y, z, index). */
export function verticesWhere(mesh, pred) {
  const out = [];
  mesh.vertices.forEach((v, i) => {
    if (pred(v[0], v[1], v[2], i)) out.push(i);
  });
  return out;
}
