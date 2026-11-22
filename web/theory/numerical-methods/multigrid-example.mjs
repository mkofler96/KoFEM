// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Educational smoothed-aggregation multigrid for the Theory Guide, not a
// replacement for the solver's regression tests. It follows the steps of
// crates/kofem-fem/src/amg.rs (strong couplings, three-phase aggregation, a
// tentative prolongator by local QR on the rigid-body modes, one damped-Jacobi
// smoothing step, the Galerkin product, forward/backward Gauss–Seidel and a
// dense Cholesky solve on the coarsest level) in plane stress, where a node
// has two unknowns and a body three rigid-body modes.
//
// Running this file checks the worked bar example and the refinement study
// the article quotes. Units: stiffness N/mm, load N, displacement mm.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// ── Sparse matrices: rows of sorted (column, value) pairs ────────────────────

/** CSR from an array of Map rows. */
export function toCsr(rows) {
  const start = [0];
  const columns = [];
  const values = [];
  for (const row of rows) {
    for (const column of [...row.keys()].sort((a, b) => a - b)) {
      columns.push(column);
      values.push(row.get(column));
    }
    start.push(columns.length);
  }
  return {
    size: rows.length,
    start: Int32Array.from(start),
    columns: Int32Array.from(columns),
    values: Float64Array.from(values),
  };
}

export function multiply(matrix, input) {
  const output = new Float64Array(matrix.size);
  for (let row = 0; row < matrix.size; row++) {
    let sum = 0;
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++)
      sum += matrix.values[k] * input[matrix.columns[k]];
    output[row] = sum;
  }
  return output;
}

const dot = (left, right) => {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += left[i] * right[i];
  return sum;
};

function diagonal(matrix) {
  const out = new Float64Array(matrix.size);
  for (let row = 0; row < matrix.size; row++)
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++)
      if (matrix.columns[k] === row) out[row] = matrix.values[k];
  return out;
}

/** One Gauss–Seidel pass over `order`, in place. */
function relax(matrix, inverseDiagonal, rhs, solution, order) {
  for (const row of order) {
    let product = 0;
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++)
      product += matrix.values[k] * solution[matrix.columns[k]];
    solution[row] += (rhs[row] - product) * inverseDiagonal[row];
  }
}

const forward = (size) => Array.from({ length: size }, (_, i) => i);
const backward = (size) => Array.from({ length: size }, (_, i) => size - 1 - i);

/** One symmetric Gauss–Seidel sweep pair from zero: z ≈ A⁻¹ r. */
export function symmetricGaussSeidel(matrix) {
  const inverse = diagonal(matrix).map((value) => 1 / value);
  const down = forward(matrix.size);
  const up = backward(matrix.size);
  return (residual) => {
    const z = new Float64Array(matrix.size);
    relax(matrix, inverse, residual, z, down);
    relax(matrix, inverse, residual, z, up);
    return z;
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

/** Strong neighbours of every node: ‖A_ij‖ > θ·√(‖A_ii‖·‖A_jj‖), Frobenius norms. */
export function strongCouplings(matrix, block, threshold) {
  const nodes = matrix.size / block;
  const norms = Array.from({ length: nodes }, () => new Map());
  for (let row = 0; row < matrix.size; row++) {
    const node = Math.floor(row / block);
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++) {
      const other = Math.floor(matrix.columns[k] / block);
      const value = matrix.values[k];
      norms[node].set(other, (norms[node].get(other) ?? 0) + value * value);
    }
  }
  const own = norms.map((map, node) => map.get(node) ?? 0);
  return norms.map((map, node) =>
    [...map]
      .filter(
        ([other, strength]) =>
          other !== node &&
          strength > 0 &&
          strength > threshold ** 2 * Math.sqrt(own[node] * own[other]),
      )
      .sort((a, b) => a[0] - b[0]),
  );
}

/** Three-phase aggregation (Vaněk, Mandel and Brezina). */
export function aggregate(couplings, excluded) {
  const owner = new Array(couplings.length).fill(null);
  let count = 0;
  couplings.forEach((list, node) => {
    if (excluded[node] || owner[node] !== null || list.length === 0) return;
    if (list.some(([other]) => owner[other] !== null)) return;
    owner[node] = count;
    for (const [other] of list) owner[other] = count;
    count++;
  });
  const snapshot = [...owner];
  couplings.forEach((list, node) => {
    if (excluded[node] || owner[node] !== null) return;
    let best = null;
    for (const [other, strength] of list)
      if (snapshot[other] !== null && (best === null || strength > best[1]))
        best = [snapshot[other], strength];
    if (best) owner[node] = best[0];
  });
  couplings.forEach((list, node) => {
    if (excluded[node] || owner[node] !== null || list.length === 0) return;
    owner[node] = count;
    for (const [other] of list)
      if (!excluded[other] && owner[other] === null) owner[other] = count;
    count++;
  });
  return { owner, count };
}

/** Plane rigid-body modes: x, y and a rotation, centred and scaled. */
export function rigidBodyModes2d(coordinates, constrained) {
  const count = coordinates.length;
  const centre = [0, 1].map(
    (axis) => coordinates.reduce((sum, point) => sum + point[axis], 0) / count,
  );
  const radius = Math.sqrt(
    coordinates.reduce(
      (sum, [x, y]) => sum + (x - centre[0]) ** 2 + (y - centre[1]) ** 2,
      0,
    ) / count,
  );
  const scale = radius > 0 ? 1 / radius : 1;
  const modes = [];
  for (const [x, y] of coordinates) {
    const [px, py] = [(x - centre[0]) * scale, (y - centre[1]) * scale];
    modes.push([1, 0, -py], [0, 1, px]);
  }
  return modes.map((row, dof) => (constrained[dof] ? row.map(() => 0) : row));
}

/** P₀ on every aggregate: an orthonormal basis of the modes (local MGS-QR). */
function tentativeProlongator(owner, aggregates, block, modes) {
  const width = modes[0].length;
  const members = Array.from({ length: aggregates }, () => []);
  owner.forEach((id, node) => {
    if (id !== null) members[id].push(node);
  });
  const basis = modes.map((row) => row.map(() => 0));
  const coarseModes = [];
  const coarseDead = [];
  members.forEach((nodes) => {
    const rows = nodes.flatMap((node) =>
      Array.from({ length: block }, (_, c) => block * node + c),
    );
    const norm = (matrix, mode) =>
      Math.sqrt(rows.reduce((sum, row) => sum + matrix[row][mode] ** 2, 0));
    const scale = Math.max(
      ...Array.from({ length: width }, (_, mode) => norm(modes, mode)),
    );
    const upper = Array.from({ length: width }, () => new Array(width).fill(0));
    const dead = new Array(width).fill(false);
    for (let mode = 0; mode < width; mode++) {
      for (const row of rows) basis[row][mode] = modes[row][mode];
      for (let earlier = 0; earlier < mode; earlier++) {
        const projection = rows.reduce(
          (sum, row) => sum + basis[row][earlier] * basis[row][mode],
          0,
        );
        upper[earlier][mode] = projection;
        for (const row of rows)
          basis[row][mode] -= projection * basis[row][earlier];
      }
      const length = norm(basis, mode);
      if (length > 1e-8 * scale && length > 0) {
        upper[mode][mode] = length;
        for (const row of rows) basis[row][mode] /= length;
      } else {
        dead[mode] = true;
        for (const row of rows) basis[row][mode] = 0;
      }
    }
    coarseModes.push(...upper);
    coarseDead.push(...dead);
  });
  const rows = basis.map((values, row) => {
    const map = new Map();
    const id = owner[Math.floor(row / block)];
    if (id !== null)
      values.forEach((value, mode) => {
        if (value !== 0) map.set(id * width + mode, value);
      });
    return map;
  });
  return { rows, columns: aggregates * width, coarseModes, coarseDead };
}

/** ρ(D⁻¹A) by 15 power steps from a fixed start, padded by 5 %. */
export function spectralRadius(matrix, inverseDiagonal) {
  let state = 0x9e3779b9;
  let vector = Float64Array.from({ length: matrix.size }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  });
  let estimate = 0;
  for (let step = 0; step < 15; step++) {
    const length = Math.sqrt(dot(vector, vector));
    if (length === 0) break;
    vector = vector.map((value) => value / length);
    const product = multiply(matrix, vector).map(
      (value, i) => value * inverseDiagonal[i],
    );
    estimate = Math.max(estimate, Math.sqrt(dot(product, product)));
    vector = product;
  }
  return 1.05 * estimate;
}

/** P = (I − ω·D⁻¹·A)·P₀, with ω from `weight(matrix, D⁻¹)`. */
export function smoothProlongator(matrix, inverseDiagonal, tentative, omega) {
  return Array.from({ length: matrix.size }, (_, row) => {
    const out = new Map(tentative[row]);
    const weight = -omega * inverseDiagonal[row];
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++)
      for (const [column, value] of tentative[matrix.columns[k]])
        out.set(
          column,
          (out.get(column) ?? 0) + weight * matrix.values[k] * value,
        );
    return out;
  });
}

/** A_c = Pᵀ·A·P; a coarse unknown without fine content gets a unit diagonal. */
export function galerkin(matrix, prolongator, columns, dead = []) {
  const ap = prolongator.map(() => new Map());
  for (let row = 0; row < matrix.size; row++)
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++)
      for (const [column, value] of prolongator[matrix.columns[k]])
        ap[row].set(
          column,
          (ap[row].get(column) ?? 0) + matrix.values[k] * value,
        );
  const coarse = Array.from({ length: columns }, () => new Map());
  prolongator.forEach((row, fine) => {
    for (const [i, weight] of row)
      for (const [j, value] of ap[fine])
        coarse[i].set(j, (coarse[i].get(j) ?? 0) + weight * value);
  });
  dead.forEach((flag, i) => {
    if (flag) coarse[i] = new Map([[i, 1]]);
  });
  return coarse;
}

function cholesky(matrix) {
  const n = matrix.size;
  const lower = Array.from({ length: n }, () => new Float64Array(n));
  for (let row = 0; row < n; row++)
    for (let k = matrix.start[row]; k < matrix.start[row + 1]; k++)
      if (matrix.columns[k] <= row)
        lower[row][matrix.columns[k]] = matrix.values[k];
  for (let j = 0; j < n; j++) {
    let pivot = lower[j][j];
    const original = pivot;
    for (let k = 0; k < j; k++) pivot -= lower[j][k] ** 2;
    if (!(pivot > 1e-14 * Math.abs(original)))
      throw new Error(
        `coarsest matrix (${n} unknowns) is not positive definite`,
      );
    lower[j][j] = Math.sqrt(pivot);
    for (let i = j + 1; i < n; i++) {
      let value = lower[i][j];
      for (let k = 0; k < j; k++) value -= lower[i][k] * lower[j][k];
      lower[i][j] = value / lower[j][j];
    }
  }
  return (rhs) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let value = rhs[i];
      for (let k = 0; k < i; k++) value -= lower[i][k] * out[k];
      out[i] = value / lower[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let value = out[i];
      for (let k = i + 1; k < n; k++) value -= lower[k][i] * out[k];
      out[i] = value / lower[i][i];
    }
    return out;
  };
}

/**
 * The smoothed-aggregation hierarchy and its V-cycle. `modes[dof]` holds the
 * near-null space (zero rows on constrained unknowns), `block` unknowns per node.
 */
export function smoothedAggregation(
  matrix,
  {
    block,
    modes,
    constrained,
    threshold = 0.02,
    coarseSize = 600,
    maxLevels = 10,
  },
) {
  const levels = [matrix];
  const prolongators = [];
  const inverseDiagonals = [];
  const aggregations = [];
  let current = matrix;
  let currentModes = modes;
  let dead = [...constrained];
  let currentBlock = block;
  while (levels.length < maxLevels && current.size > coarseSize) {
    const couplings = strongCouplings(current, currentBlock, threshold);
    const excluded = couplings.map((_, node) =>
      dead.slice(currentBlock * node, currentBlock * (node + 1)).every(Boolean),
    );
    const { owner, count } = aggregate(couplings, excluded);
    const width = currentModes[0].length;
    if (count === 0 || count * width >= current.size) break;
    const tentative = tentativeProlongator(
      owner,
      count,
      currentBlock,
      currentModes,
    );
    const inverseDiagonal = diagonal(current).map((v) => (v === 0 ? 1 : 1 / v));
    const omega = 4 / (3 * spectralRadius(current, inverseDiagonal));
    const prolongator = smoothProlongator(
      current,
      inverseDiagonal,
      tentative.rows,
      omega,
    );
    const next = toCsr(
      galerkin(current, prolongator, tentative.columns, tentative.coarseDead),
    );
    aggregations.push(owner);
    inverseDiagonals.push(inverseDiagonal);
    prolongators.push(prolongator);
    levels.push(next);
    current = next;
    currentModes = tentative.coarseModes;
    dead = tentative.coarseDead;
    currentBlock = width;
  }
  const coarseSolve = cholesky(current);
  const apply = (residual) => {
    const rhs = [Float64Array.from(residual)];
    const solution = [];
    for (let level = 0; level < prolongators.length; level++) {
      const A = levels[level];
      const x = new Float64Array(A.size);
      relax(A, inverseDiagonals[level], rhs[level], x, forward(A.size));
      const r = multiply(A, x).map((value, i) => rhs[level][i] - value);
      const below = new Float64Array(levels[level + 1].size);
      prolongators[level].forEach((row, fine) => {
        for (const [column, value] of row) below[column] += value * r[fine];
      });
      solution.push(x);
      rhs.push(below);
    }
    let correction = coarseSolve(rhs.at(-1));
    for (let level = prolongators.length - 1; level >= 0; level--) {
      const A = levels[level];
      const x = solution[level];
      prolongators[level].forEach((row, fine) => {
        for (const [column, value] of row)
          x[fine] += value * correction[column];
      });
      relax(A, inverseDiagonals[level], rhs[level], x, backward(A.size));
      correction = x;
    }
    return correction;
  };
  const nonzeros = levels.reduce((sum, level) => sum + level.values.length, 0);
  return {
    apply,
    aggregations,
    unknowns: levels.map((level) => level.size),
    operatorComplexity: nonzeros / matrix.values.length,
  };
}

/** Preconditioned CG, stopping as KoFEM does at ‖r‖ ≤ τ·‖b‖. */
export function pcg(
  matrix,
  load,
  precondition,
  { relative = 1e-6, limit = 20000 } = {},
) {
  const x = new Float64Array(matrix.size);
  const r = Float64Array.from(load);
  let z = precondition(r);
  const p = Float64Array.from(z);
  let rz = dot(r, z);
  const threshold = relative ** 2 * dot(load, load);
  const history = [1];
  const loadNorm = Math.sqrt(dot(load, load));
  for (let iteration = 0; iteration < limit; iteration++) {
    if (dot(r, r) <= threshold) return { x, iterations: iteration, history };
    const ap = multiply(matrix, p);
    const alpha = rz / dot(p, ap);
    for (let i = 0; i < matrix.size; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    history.push(Math.sqrt(dot(r, r)) / loadNorm);
    z = precondition(r);
    const next = dot(r, z);
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < matrix.size; i++) p[i] = z[i] + beta * p[i];
  }
  throw new Error(`CG did not converge in ${limit} iterations`);
}

// ── Plane-stress models ──────────────────────────────────────────────────────

/** Linear-triangle plane-stress stiffness (E = 1, ν = 0.3, unit thickness). */
export function planeStress(points, triangles) {
  const nu = 0.3;
  const c = 1 / (1 - nu * nu);
  const D = [
    [c, c * nu, 0],
    [c * nu, c, 0],
    [0, 0, (c * (1 - nu)) / 2],
  ];
  const rows = Array.from({ length: 2 * points.length }, () => new Map());
  for (const triangle of triangles) {
    const [p1, p2, p3] = triangle.map((i) => points[i]);
    const area2 =
      (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1]);
    const b = [p2[1] - p3[1], p3[1] - p1[1], p1[1] - p2[1]].map(
      (v) => v / area2,
    );
    const g = [p3[0] - p2[0], p1[0] - p3[0], p2[0] - p1[0]].map(
      (v) => v / area2,
    );
    const B = [[], [], []];
    for (let a = 0; a < 3; a++) {
      B[0].push(b[a], 0);
      B[1].push(0, g[a]);
      B[2].push(g[a], b[a]);
    }
    const dofs = triangle.flatMap((i) => [2 * i, 2 * i + 1]);
    for (let r = 0; r < 6; r++)
      for (let s = 0; s < 6; s++) {
        let value = 0;
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) value += B[i][r] * D[i][j] * B[j][s];
        const row = rows[dofs[r]];
        row.set(
          dofs[s],
          (row.get(dofs[s]) ?? 0) + (value * Math.abs(area2)) / 2,
        );
      }
  }
  return rows;
}

/** Keep each constrained unknown as an identity row, as KoFEM does. */
export function eliminate(rows, constrained) {
  return rows.map((row, i) => {
    if (constrained[i]) return new Map([[i, 1]]);
    return new Map([...row].filter(([j]) => !constrained[j]));
  });
}

/**
 * A 4:1 cantilever plate of `nx × ny` squares, each cut into two linear
 * triangles, clamped on the left edge and pulled down at the right edge.
 */
export function cantilever(nx) {
  const ny = nx / 4;
  const h = 4 / nx;
  const points = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) points.push([i * h, j * h]);
  const id = (i, j) => j * (nx + 1) + i;
  const triangles = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      triangles.push(
        [id(i, j), id(i + 1, j), id(i + 1, j + 1)],
        [id(i, j), id(i + 1, j + 1), id(i, j + 1)],
      );
  const constrained = points.flatMap(([x]) => [x === 0, x === 0]);
  const load = new Float64Array(2 * points.length);
  for (let j = 0; j <= ny; j++) load[2 * id(nx, j) + 1] = -1 / (ny + 1);
  const matrix = toCsr(eliminate(planeStress(points, triangles), constrained));
  return { points, triangles, constrained, load, matrix };
}

// ── The article's numbers ────────────────────────────────────────────────────

/**
 * Worked example: a bar of six free unit springs' nodes (k = 1 N/mm), fixed
 * at both ends, two aggregates of three nodes. The near-null space is the
 * axial translation. ω·D⁻¹ = 1/3 uses the Gershgorin bound ρ(D⁻¹A) ≤ 2.
 */
export function barExample() {
  const size = 6;
  const rows = Array.from({ length: size }, (_, i) => {
    const row = new Map([[i, 2]]);
    if (i > 0) row.set(i - 1, -1);
    if (i < size - 1) row.set(i + 1, -1);
    return row;
  });
  const matrix = toCsr(rows);
  const tentative = Array.from(
    { length: size },
    (_, i) => new Map([[i < 3 ? 0 : 1, 1]]),
  );
  const inverseDiagonal = new Float64Array(size).fill(0.5);
  const prolongator = smoothProlongator(
    matrix,
    inverseDiagonal,
    tentative,
    2 / 3,
  );
  const columns = [0, 1].map((c) => prolongator.map((row) => row.get(c) ?? 0));
  const coarseTentative = galerkin(matrix, tentative, 2);
  const coarse = galerkin(matrix, prolongator, 2);
  const asDense = (map) =>
    [0, 1].map((i) => [0, 1].map((j) => map[i].get(j) ?? 0));
  // One application of each preconditioner to a unit load at every node.
  const load = new Float64Array(size).fill(1);
  const exact = Float64Array.from(
    { length: size },
    (_, i) => ((i + 1) * (6 - i)) / 2,
  );
  const energy = (x) => {
    const e = exact.map((value, i) => value - x[i]);
    return Math.sqrt(dot(e, multiply(matrix, e)));
  };
  const twoLevel = (residual) => {
    const down = forward(size);
    const up = backward(size);
    const x = new Float64Array(size);
    relax(matrix, inverseDiagonal, residual, x, down);
    const r = multiply(matrix, x).map((value, i) => residual[i] - value);
    const rc = columns.map((column) => dot(column, r));
    const [[a, b], [, d]] = asDense(coarse);
    const det = a * d - b * b;
    const xc = [(d * rc[0] - b * rc[1]) / det, (a * rc[1] - b * rc[0]) / det];
    for (let i = 0; i < size; i++)
      x[i] += columns[0][i] * xc[0] + columns[1][i] * xc[1];
    relax(matrix, inverseDiagonal, residual, x, up);
    return x;
  };
  return {
    columns,
    coarseTentative: asDense(coarseTentative),
    coarse: asDense(coarse),
    exact: [...exact],
    initialError: energy(new Float64Array(size)),
    gaussSeidelError: energy(symmetricGaussSeidel(matrix)(load)),
    twoLevelError: energy(twoLevel(load)),
  };
}

/** CG iterations to 10⁻⁶ under refinement, with each preconditioner. */
export function refinementStudy(sizes = [16, 32, 64, 128]) {
  return sizes.map((nx) => {
    const { matrix, load, points, constrained } = cantilever(nx);
    const hierarchy = smoothedAggregation(matrix, {
      block: 2,
      modes: rigidBodyModes2d(points, constrained),
      constrained,
      coarseSize: 60,
    });
    return {
      nx,
      unknowns: matrix.size,
      levels: hierarchy.unknowns,
      operatorComplexity: hierarchy.operatorComplexity,
      multigrid: pcg(matrix, load, hierarchy.apply).iterations,
      gaussSeidel: pcg(matrix, load, symmetricGaussSeidel(matrix)).iterations,
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const close = (actual, expected, tolerance = 1e-12) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `Expected ${expected}, got ${actual}`,
    );
  // Hand-derived: (I − A/3)·P₀ turns the two blocks of ones into overlapping hats.
  const bar = barExample();
  [2 / 3, 1, 2 / 3, 1 / 3, 0, 0].forEach((v, i) => close(bar.columns[0][i], v));
  [0, 0, 1 / 3, 2 / 3, 1, 2 / 3].forEach((v, i) => close(bar.columns[1][i], v));
  [
    [2, -1],
    [-1, 2],
  ].forEach((row, i) =>
    row.forEach((v, j) => close(bar.coarseTentative[i][j], v)),
  );
  [
    [8 / 9, -1 / 3],
    [-1 / 3, 8 / 9],
  ].forEach((row, i) => row.forEach((v, j) => close(bar.coarse[i][j], v)));
  [3, 5, 6, 6, 5, 3].forEach((v, i) => close(bar.exact[i], v));
  console.table({
    initial: bar.initialError,
    gaussSeidel: bar.gaussSeidelError,
    twoLevel: bar.twoLevelError,
  });
  close(bar.initialError, Math.sqrt(28), 1e-12);
  // The article quotes these energy-norm errors to three digits.
  close(bar.gaussSeidelError / bar.initialError, 0.696, 5e-4);
  close(bar.twoLevelError / bar.initialError, 0.159, 5e-4);

  // The V-cycle is a symmetric positive-definite operator, as CG requires.
  const model = cantilever(32);
  const hierarchy = smoothedAggregation(model.matrix, {
    block: 2,
    modes: rigidBodyModes2d(model.points, model.constrained),
    constrained: model.constrained,
    coarseSize: 60,
  });
  let seed = 7;
  const random = () =>
    Float64Array.from({ length: model.matrix.size }, (_, i) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return model.constrained[i] ? 0 : seed / 2 ** 32 - 0.5;
    });
  const u = random();
  const v = random();
  const uMv = dot(u, hierarchy.apply(v));
  const vMu = dot(v, hierarchy.apply(u));
  close(uMv, vMu, 1e-10 * Math.abs(uMv));
  assert.ok(dot(u, hierarchy.apply(u)) > 0);

  const study = refinementStudy();
  console.table(study);
  const multigrid = study.map((row) => row.multigrid);
  const gaussSeidel = study.map((row) => row.gaussSeidel);
  // Gauss–Seidel iterations roughly double with each halving of h; the
  // multigrid count stays nearly flat, and far below.
  assert.ok(gaussSeidel.at(-1) > 6 * gaussSeidel[0], `${gaussSeidel}`);
  assert.ok(multigrid.at(-1) < 2 * multigrid[0], `${multigrid}`);
  assert.ok(
    multigrid.every((count, i) => count < gaussSeidel[i] / 3),
    `${multigrid}`,
  );
  for (const row of study)
    assert.ok(row.operatorComplexity < 2, `${row.operatorComplexity}`);
  console.log(
    "PASS: bar prolongator and coarse matrix, symmetric V-cycle, flat multigrid iterations under refinement.",
  );
}
