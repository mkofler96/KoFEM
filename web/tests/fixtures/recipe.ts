// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Builds an example from its recipe (examples/validation/lib/recipe.mjs) the way
// a user does (KOF-322): every modelling step — import, splits, element type,
// mesh, material, supports, loads, solve — is a real click or keystroke in the
// app. Faces are picked by clicking the screen projection of the recipe's `at`
// point, from a camera direction that shows it, and every pick is checked
// against the CAD face that point lies on. On a shell, a face through the wall
// is not on the mesh: it collapsed to an edge of the mid-surface, which is
// picked with Edge selection, by clicking the shell next to that edge.
//
// The store is only READ here (to verify picks and to compute the read-out), never
// written. Where the app has no control for a step the recipe asks for, the
// driver throws a MissingUiCapability naming it instead of reaching around the UI.

import { expect, type Page } from "@playwright/test";
import { geometryCounts, importStepText, lookFrom } from "./split";
import { addBoundary, addMaterial, openBody, openTree } from "./tree";
import {
  DEFLECTION_RELATIVE,
  validateRecipe,
} from "../../../examples/validation/lib/recipe.mjs";
import { loadEngine } from "../../../examples/shell-coupling/lib.mjs";
import { shellRimFaces, type ShellRim } from "../../src/lib/shellRim";

// ── The recipe contract, typed (mirrors the JSDoc in lib/recipe.mjs) ──────────

export type Point = [number, number, number];
export type Axis = 0 | 1 | 2;
export interface FaceRef {
  at: Point;
}
export interface Split {
  mode: "faces" | "bodies";
  faces?: FaceRef[];
  origin: Point;
  normal: Point;
}
export interface MeshStep {
  maxElementSize: number;
  // Absent: maxElementSize / 10, the worker's default (recipe.mjs MeshStep).
  minElementSize?: number;
  order: 1 | 2;
  localSizes?: { faces: FaceRef[]; size: number }[];
}
export type Discretization =
  { kind: "solid" } | { kind: "shell"; thickness: number };
export interface Material {
  name: string;
  young: number;
  poisson: number;
  density: number;
}
export interface Support {
  name: string;
  faces: FaceRef[];
  dofs: number[];
  value: number;
}
export interface Load {
  name: string;
  kind: "force" | "pressure" | "moment";
  faces: FaceRef[];
  components?: Point;
  value?: number;
  axis?: Axis;
}
interface ProbeCommon {
  unit: string;
  divideBy?: number;
}
export type Probe =
  | (ProbeCommon & {
      kind: "displacement";
      component: Axis;
      faces?: FaceRef[];
      at?: Point;
    })
  | (ProbeCommon & { kind: "twist"; axis: Axis; faces: FaceRef[] })
  | (ProbeCommon & {
      kind: "stress";
      field: "vonMises";
      stat: "max";
      faces?: FaceRef[];
    });
export interface Readout {
  quantity: string;
  probe: Probe;
  formula: string;
  reference: number;
}
// The Optimize panel's settings (SIMP, minimum compliance).
export interface OptimizeStep {
  objective: "min_compliance";
  volumeFraction: number;
  penalty: number;
  filterRadius: number;
  moveLimit: number;
  maxIterations: number;
  tolerance: number;
}
// An optimum has no closed form: the read-out is the run's final compliance.
export interface ComplianceReadout {
  quantity: string;
  probe: { kind: "compliance"; unit: "N·mm" };
}
interface RecipeSteps {
  step: () => string;
  splits: Split[];
  discretization: Discretization;
  mesh: MeshStep;
  material: Material;
  supports: Support[];
  loads: Load[];
}
export interface StaticRecipe extends RecipeSteps {
  optimize?: undefined;
  readout: Readout;
}
export interface OptimizationRecipe extends RecipeSteps {
  optimize: OptimizeStep;
  readout: ComplianceReadout;
}
export type Recipe = StaticRecipe | OptimizationRecipe;

// A recipe from a case module (plain JS): checked by the contract's own
// validator, which throws a precise error on the first problem.
export function asRecipe(id: string, raw: unknown): Recipe {
  validateRecipe(id, raw);
  return raw as Recipe;
}

// The app cannot do a step the recipe asks for. Thrown, never worked around.
export class MissingUiCapability extends Error {
  constructor(step: string, missing: string) {
    super(`GUI cannot ${step}: ${missing}`);
    this.name = "MissingUiCapability";
  }
}

// ── Reading the app (assertions and the read-out only) ────────────────────────

interface StoreNode {
  id: number;
  x: number;
  y: number;
  z: number;
}
interface StoreFace {
  cadFaceId?: number;
  geometry?: string;
  nodeIds: number[];
}
export interface Snapshot {
  tess: { points: Point[]; triangles: Point[]; faceIds: number[] };
  nodes: StoreNode[];
  elements: { type: string; nodeIds: number[]; propertyId: number }[];
  surfaceTriangles: Point[];
  surfaceFaceIds: number[];
  properties: {
    id: number;
    discretization?: string;
    thickness?: number;
    sourceBodyId?: number;
    materialId: number;
  }[];
  materials: { id: number; young: number; poisson: number }[];
  bcGroups: { dofs: number[]; value: number; faces: StoreFace[] }[];
  loadGroups: {
    kind?: string;
    dof: number;
    totalForce: number;
    components?: Point;
    faces: StoreFace[];
  }[];
  elementOrder: number;
  displacements: number[] | null;
  vonMises: number[] | null;
}

export function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: { getState(): Record<string, unknown> };
      }
    ).__kofemStore.getState();
    const surface = st.stepSurface as {
      points: Point[];
      triangles: Point[];
      faceIds?: number[];
    } | null;
    if (!surface || !surface.faceIds)
      throw new Error("snapshot: no CAD geometry with face ids is loaded");
    const result = st.result as {
      displacements: Float64Array;
      vonMises?: Float64Array;
    } | null;
    return {
      tess: {
        points: surface.points,
        triangles: surface.triangles,
        faceIds: surface.faceIds,
      },
      nodes: st.nodes as StoreNode[],
      elements: st.elements as Snapshot["elements"],
      surfaceTriangles: (st.surfaceTriangles as Point[] | null) ?? [],
      surfaceFaceIds: (st.surfaceFaceIds as number[] | null) ?? [],
      properties: st.properties as Snapshot["properties"],
      materials: st.materials as Snapshot["materials"],
      bcGroups: st.bcGroups as Snapshot["bcGroups"],
      loadGroups: st.loadGroups as Snapshot["loadGroups"],
      elementOrder: st.elementOrder as number,
      displacements: result ? Array.from(result.displacements) : null,
      vonMises: result?.vonMises ? Array.from(result.vonMises) : null,
    };
  });
}

// ── Faces named by a point ────────────────────────────────────────────────────

const sub = (a: Point, b: Point): Point => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Point) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Point, s: number): Point => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Point, b: Point): Point => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
const unit = (a: Point): Point => scale(a, 1 / norm(a));

// Closest point to `p` on triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
function closestOnTriangle(p: Point, a: Point, b: Point, c: Point): Point {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

function modelSize(points: Point[]): number {
  const lo: Point = [Infinity, Infinity, Infinity];
  const hi: Point = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  return norm(sub(hi, lo));
}

export interface ResolvedFace {
  cadFaceId: number;
  // Unit normal of the display triangle the point lies on (winding order, so
  // its sign is not trusted — the picker tries both sides).
  normal: Point;
}

// The CAD face whose display tessellation contains `at`: exactly one face within
// the tessellation's chordal deflection (DEFLECTION_RELATIVE · model size), as
// the contract's resolveFaceAt (and the node-side build) resolve it, so a point
// on the true surface of a curved face resolves where the facets cut inside it.
export function resolveFace(snap: Snapshot, at: Point): ResolvedFace {
  const { points, triangles, faceIds } = snap.tess;
  const tol = DEFLECTION_RELATIVE * modelSize(points);
  const hits = new Map<number, { dist: number; normal: Point }>();
  let nearest = Infinity;
  triangles.forEach((tri, t) => {
    const [a, b, c] = tri.map((i) => points[i]) as [Point, Point, Point];
    const dist = norm(sub(closestOnTriangle(at, a, b, c), at));
    nearest = Math.min(nearest, dist);
    const prev = hits.get(faceIds[t]);
    if (dist <= tol && (prev === undefined || dist < prev.dist))
      hits.set(faceIds[t], { dist, normal: unit(cross(sub(b, a), sub(c, a))) });
  });
  if (hits.size !== 1)
    throw new Error(
      `face at [${at.join(", ")}]: expected exactly one CAD face within ${tol.toExponential(2)} mm, ` +
        (hits.size === 0
          ? `found none (nearest display triangle is ${nearest.toExponential(3)} mm away)`
          : `found faces ${[...hits.keys()].join(", ")} (the point lies on an edge between them)`),
    );
  const [[cadFaceId, { normal }]] = [...hits.entries()];
  return { cadFaceId, normal };
}

// Mesh node indices (into snap.nodes) on the given CAD faces.
function nodesOfFaces(snap: Snapshot, cadFaceIds: number[]): number[] {
  const index = new Map(snap.nodes.map((n, i) => [n.id, i]));
  const wanted = new Set(cadFaceIds);
  const out = new Set<number>();
  snap.surfaceTriangles.forEach((tri, t) => {
    if (!wanted.has(snap.surfaceFaceIds[t])) return;
    for (const id of tri) {
      const i = index.get(id);
      if (i === undefined)
        throw new Error(`surface triangle ${t} names unknown node ${id}`);
      out.add(i);
    }
  });
  if (out.size === 0)
    throw new Error(
      `the mesh has no surface nodes on CAD face(s) ${cadFaceIds.join(", ")}`,
    );
  return [...out].sort((a, b) => a - b);
}

// The CAD faces the shell idealisation collapsed onto the mesh's rim — what the
// app's edge pick selects whole (src/lib/shellRim.ts, the app's own code).
function snapshotRim(snap: Snapshot): ShellRim {
  return shellRimFaces(
    {
      nodes: snap.nodes,
      elements: snap.elements,
      surfaceTriangles: snap.surfaceTriangles,
      surfaceFaceIds: snap.surfaceFaceIds,
    },
    snap.tess,
  );
}

// ── Picking a face by clicking it ─────────────────────────────────────────────

type PickTarget = "split" | "boundary";

function pickedFaceIds(page: Page, target: PickTarget): Promise<number[]> {
  return page.evaluate((tgt) => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            splitFaceIds: number[];
            pendingFaces: { cadFaceId?: number }[];
            selectedFace: { cadFaceId?: number } | null;
          };
        };
      }
    ).__kofemStore.getState();
    if (tgt === "split") return [...st.splitFaceIds];
    const faces = st.selectedFace
      ? [...st.pendingFaces, st.selectedFace]
      : st.pendingFaces;
    // -1 marks a selection with no CAD face behind it (not a whole-face pick).
    return faces.map((f) => (f.cadFaceId === undefined ? -1 : f.cadFaceId));
  }, target);
}

// Let the viewport render the camera change before projecting / clicking.
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

// Where `point` lands on screen, if that pixel shows the viewport canvas (not
// a panel or overlay on top of it).
function canvasPixel(
  page: Page,
  point: Point,
): Promise<{ x: number; y: number } | null> {
  return page.evaluate((p) => {
    const view = (
      window as unknown as {
        __kofemViewport?: {
          project(p: Point): { x: number; y: number } | null;
        };
      }
    ).__kofemViewport;
    if (!view) throw new Error("the viewport test hooks are not mounted");
    const screen = view.project(p);
    if (!screen) return null;
    const hit = document.elementFromPoint(screen.x, screen.y);
    return hit instanceof HTMLCanvasElement ? screen : null;
  }, point);
}

// View directions to try, best first: square onto the face from either side
// (the triangle normal's sign is not trusted), then increasingly oblique ones.
// A small skew keeps the camera off the orbit controls' up axis.
function viewDirections(normal: Point): Point[] {
  const skew: Point = [0.21, 0.17, 0.13];
  const out: Point[] = [];
  for (const side of [1, -1]) {
    const n = scale(normal, side);
    out.push(unit(add(n, skew)));
    for (const tilt of [0.6, 1.2]) {
      // two perpendiculars to n
      const helper: Point = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const e1 = unit(cross(n, helper));
      const e2 = cross(n, e1);
      for (const [u, v] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        out.push(unit(add(add(n, scale(e1, tilt * u)), scale(e2, tilt * v))));
    }
  }
  // Then the whole sphere (a Fibonacci spiral): a face inside a bore or behind
  // a flange shows only through an opening, at an angle far from its normal.
  const count = 64;
  for (let i = 0; i < count; i++) {
    const height = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - height * height);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    out.push(
      unit(
        add([ring * Math.cos(phi), height, ring * Math.sin(phi)], [0, 0, 1e-3]),
      ),
    );
  }
  return out;
}

// Click the face `at` lies on so it joins the current pick (split tool or
// support/load panel). The camera turns to look at it from its normal side; a
// click that lands on another face is clicked again to take that face back out.
async function clickFace(
  page: Page,
  at: Point,
  target: PickTarget,
): Promise<number> {
  const snap = await snapshot(page);
  const face = resolveFace(snap, at);
  // A support or load is picked on the mesh. A shell body's mesh is its
  // mid-surface: a face through the wall thickness (a plate's edge face) is
  // not in it but collapsed to its rim, picked as an Edge (clickRimFace).
  if (target === "boundary" && !snap.surfaceFaceIds.includes(face.cadFaceId))
    throw new MissingUiCapability(
      `pick the face at [${at.join(", ")}] (CAD face ${face.cadFaceId}) for a support or load`,
      `the mesh has no element on that CAD face (mesh faces: ${[...new Set(snap.surfaceFaceIds)].join(", ")})` +
        (snap.elements.some((e) => e.type === "CTRIA3")
          ? ", and it is not on the rim of the shell mid-surface either"
          : ""),
    );
  const before = await pickedFaceIds(page, target);
  if (before.includes(face.cadFaceId))
    throw new Error(
      `face at [${at.join(", ")}] (CAD face ${face.cadFaceId}) is already in the pick — the recipe names it twice`,
    );
  const tried: string[] = [];
  for (const dir of viewDirections(face.normal)) {
    await lookFrom(page, dir);
    await nextFrames(page);
    const screen = await canvasPixel(page, at);
    if (!screen) {
      tried.push(
        `[${dir.map((v) => v.toFixed(2))}]: off-canvas or covered by a panel`,
      );
      continue;
    }
    await page.mouse.click(screen.x, screen.y);
    const after = await pickedFaceIds(page, target);
    if (after.includes(face.cadFaceId)) {
      expect(after.length, "one click adds exactly one face").toBe(
        before.length + 1,
      );
      if (tried.length > 0)
        console.log(
          `[recipe] face at [${at.join(", ")}] picked from view direction #${tried.length + 1} [${dir.map((v) => v.toFixed(2))}]`,
        );
      return face.cadFaceId;
    }
    const got = after.filter((id) => !before.includes(id));
    tried.push(
      `[${dir.map((v) => v.toFixed(2))}]: picked ${got.length ? `face ${got.join(", ")}` : "nothing"}`,
    );
    if (after.join() !== before.join()) {
      // Take the wrong face back out with its × in the pick list (a second
      // click on the same pixel is not reliably a toggle).
      if (target === "split")
        for (const id of got)
          await page
            .getByTestId(`split-face-${id}`)
            .getByTitle("Remove face")
            .click();
      // The new pick is the list's last row; in a new-group pick the list is
      // the only one with remove buttons on screen.
      else await page.getByTitle("Remove face", { exact: true }).last().click();
      expect(await pickedFaceIds(page, target)).toEqual(before);
    }
  }
  throw new MissingUiCapability(
    `click the face at [${at.join(", ")}] (CAD face ${face.cadFaceId})`,
    `no camera direction shows it unobstructed — tried ${tried.length}, e.g. ${tried.slice(0, 6).join("; ")}`,
  );
}

// Click the shell next to the edge a wall face collapsed to, in Edge pick mode,
// so the app selects that face's whole rim. The click lands on the facet that
// owns the rim edge nearest `at`, at its centroid, seen square onto the shell.
async function clickRimFace(page: Page, at: Point): Promise<number> {
  const snap = await snapshot(page);
  const face = resolveFace(snap, at);
  const rim = snapshotRim(snap);
  const rimNodes = rim.nodesByFace.get(face.cadFaceId);
  if (!rimNodes)
    throw new Error(
      `face at [${at.join(", ")}] (CAD face ${face.cadFaceId}) is not on the rim of the shell mid-surface`,
    );
  const index = new Map(snap.nodes.map((n, i) => [n.id, i]));
  const pos = (id: number): Point => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`rim node ${id} is not in the mesh`);
    const n = snap.nodes[i];
    return [n.x, n.y, n.z];
  };
  // The rim edge of this face nearest `at`, and the facet that owns it.
  let best: { facet: number[]; dist: number } | null = null;
  for (const el of snap.elements) {
    if (el.type !== "CTRIA3") continue;
    for (let k = 0; k < 3; k++) {
      const [na, nb] = [el.nodeIds[k], el.nodeIds[(k + 1) % 3]];
      const key = na < nb ? `${na},${nb}` : `${nb},${na}`;
      if (rim.faceOfEdge.get(key) !== face.cadFaceId) continue;
      const mid = scale(add(pos(na), pos(nb)), 0.5);
      const dist = norm(sub(mid, at));
      if (!best || dist < best.dist) best = { facet: el.nodeIds, dist };
    }
  }
  if (!best)
    throw new Error(`CAD face ${face.cadFaceId} has no rim edge on the shell`);
  const [pa, pb, pc] = best.facet.map(pos);
  const centroid = scale(add(add(pa, pb), pc), 1 / 3);
  const normal = unit(cross(sub(pb, pa), sub(pc, pa)));
  const before = await pickedFaceIds(page, "boundary");
  if (before.includes(face.cadFaceId))
    throw new Error(
      `face at [${at.join(", ")}] (CAD face ${face.cadFaceId}) is already in the pick — the recipe names it twice`,
    );
  const tried: string[] = [];
  for (const dir of viewDirections(normal).slice(0, 18)) {
    await lookFrom(page, dir);
    await nextFrames(page);
    const screen = await canvasPixel(page, centroid);
    if (!screen) {
      tried.push(`[${dir.map((v) => v.toFixed(2))}]: off-canvas`);
      continue;
    }
    await page.mouse.click(screen.x, screen.y);
    const after = await pickedFaceIds(page, "boundary");
    if (after.includes(face.cadFaceId)) {
      expect(after.length, "one click adds exactly one edge").toBe(
        before.length + 1,
      );
      return face.cadFaceId;
    }
    tried.push(
      `[${dir.map((v) => v.toFixed(2))}]: picked ${after.filter((id) => !before.includes(id)).join(", ") || "nothing"}`,
    );
    if (after.join() !== before.join()) {
      await page.getByTitle("Remove face", { exact: true }).last().click();
      expect(await pickedFaceIds(page, "boundary")).toEqual(before);
    }
  }
  throw new MissingUiCapability(
    `pick the edge CAD face ${face.cadFaceId} collapsed to`,
    `no click next to it selected it — ${tried.slice(0, 6).join("; ")}`,
  );
}

// Whether a support's or load's faces are picked as Faces (on the mesh
// surface) or as Edges (collapsed to the shell's rim): one or the other, as
// the panel's pick mode is.
async function pickGeometryFor(
  page: Page,
  faces: FaceRef[],
  what: string,
): Promise<"face" | "edge"> {
  const snap = await snapshot(page);
  if (!snap.elements.some((e) => e.type === "CTRIA3")) return "face";
  const rim = snapshotRim(snap);
  const onRim = faces.map((f) =>
    rim.nodesByFace.has(resolveFace(snap, f.at).cadFaceId),
  );
  if (onRim.every((v) => v)) return "edge";
  if (onRim.some((v) => v))
    throw new MissingUiCapability(
      `pick both faces and edges for ${what}`,
      "the panel picks Faces or Edges in one selection, not both",
    );
  return "face";
}

// Pick a support's or load's faces in the open panel.
async function pickBoundary(
  page: Page,
  faces: FaceRef[],
  what: string,
): Promise<void> {
  const geometry = await pickGeometryFor(page, faces, what);
  if (geometry === "edge") {
    await page.getByTestId("pick-geometry-edge").click();
    for (const face of faces) await clickRimFace(page, face.at);
  } else for (const face of faces) await clickFace(page, face.at, "boundary");
}

// ── The steps ─────────────────────────────────────────────────────────────────

const AXIS_NAMES = ["x", "y", "z"] as const;

// The split tool cuts with a plane normal to x, y or z.
function splitAxis(normal: Point): Axis {
  const len = norm(normal);
  const axis = [0, 1, 2].find(
    (k) => Math.abs(Math.abs(normal[k]) - len) <= 1e-12 * len,
  );
  if (axis === undefined)
    throw new MissingUiCapability(
      `split with the plane normal [${normal.join(", ")}]`,
      "the split tool only cuts with planes x = c, y = c or z = c",
    );
  return axis as Axis;
}

export interface Counts {
  faces: number;
  bodies: number;
  edits: number;
}

async function applySplit(page: Page, split: Split): Promise<void> {
  const axis = splitAxis(split.normal);
  const before = await geometryCounts(page);
  if (split.mode === "bodies" && before.bodies !== 1)
    throw new Error(
      `a "bodies" split of a ${before.bodies}-body model needs the body it cuts — the recipe contract does not name one`,
    );
  await openTree(page, "split");
  await page.getByTestId("split-open").click();
  await page.getByTestId(`split-mode-${split.mode}`).click();
  await page.getByTestId("split-axis").selectOption(AXIS_NAMES[axis]);
  await page.getByTestId("split-position").fill(String(split.origin[axis]));
  if (split.mode === "faces") {
    if (!split.faces) throw new Error("a faces split names its faces");
    for (const face of split.faces) await clickFace(page, face.at, "split");
    await expect(page.locator('[data-testid^="split-face-"]')).toHaveCount(
      split.faces.length,
    );
  }
  await page.getByTestId("split-apply").click();
  await expect
    .poll(async () => (await geometryCounts(page)).edits, { timeout: 60_000 })
    .toBe(before.edits + 1);
  const splitError = page.getByTestId("split-error");
  if (await splitError.isVisible())
    throw new Error(`split failed: ${await splitError.textContent()}`);
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

// CAD bodies (not the shell sections a mesh derives).
async function cadBodyIds(page: Page): Promise<number[]> {
  return (await snapshot(page)).properties
    .filter((p) => p.sourceBodyId === undefined)
    .map((p) => p.id);
}

async function chooseElementType(
  page: Page,
  discretization: Discretization,
): Promise<void> {
  for (const id of await cadBodyIds(page)) {
    await openBody(page, id);
    await page.getByTestId(`body-type-${id}`).selectOption(discretization.kind);
  }
}

// The floor Netgen refines curvature to: the recipe's, or max / 10 when it
// sets none (the worker's own default and what the node-side build passes,
// pipeline.mjs minSizeOf).
const minElementSizeOf = (mesh: MeshStep): number =>
  mesh.minElementSize ?? mesh.maxElementSize / 10;

async function meshIt(page: Page, mesh: MeshStep): Promise<void> {
  if (mesh.localSizes && mesh.localSizes.length > 0)
    throw new MissingUiCapability(
      "set a per-face element size",
      "the mesh controls offer one global max/min element size only",
    );
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill(String(mesh.maxElementSize));
  // The import suggests its own minimum, so the recipe's is typed like the max.
  await page
    .getByTestId("min-element-size")
    .fill(String(minElementSizeOf(mesh)));
  await page
    .getByText("Element order", { exact: true })
    .locator("..")
    .locator("select")
    .selectOption(String(mesh.order));
  await page.getByTestId("mesh-generate").click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const st = (
            window as unknown as {
              __kofemStore: {
                getState(): { isMeshing: boolean; nodes: unknown[] };
              };
            }
          ).__kofemStore.getState();
          return !st.isMeshing && st.nodes.length > 0;
        }),
      { timeout: 300_000 },
    )
    .toBe(true);
  const meshError = page.getByTestId("meshing-error");
  if (await meshError.isVisible())
    throw new Error(`meshing failed: ${await meshError.textContent()}`);
}

// The app derives a shell's thickness from the wall it idealises; there is no
// thickness to type. The recipe's thickness is checked against what it measured.
async function checkShellThickness(
  page: Page,
  discretization: Discretization,
): Promise<void> {
  if (discretization.kind !== "shell") return;
  const sections = (await snapshot(page)).properties.filter(
    (p) => p.sourceBodyId !== undefined,
  );
  if (sections.length === 0)
    throw new Error(
      "the body is marked Shell but the mesh made no shell section",
    );
  for (const s of sections)
    if (
      s.thickness === undefined ||
      Math.abs(s.thickness - discretization.thickness) >
        1e-6 * discretization.thickness
    )
      throw new MissingUiCapability(
        `give the shell a thickness of ${discretization.thickness} mm`,
        `the app measures the wall instead (got ${s.thickness} mm) and has no thickness input`,
      );
}

async function setMaterial(page: Page, material: Material): Promise<void> {
  const before = (await snapshot(page)).materials.map((m) => m.id);
  await addMaterial(page);
  const field = (label: string) =>
    page.getByText(label, { exact: true }).locator("..").locator("input");
  await field("Name").fill(material.name);
  await field("E (MPa)").fill(String(material.young));
  await field("ν").fill(String(material.poisson));
  await field("ρ (t/mm³)").fill(String(material.density));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const materials = (await snapshot(page)).materials;
  const created = materials.filter((m) => !before.includes(m.id));
  expect(created, "Save creates one material").toHaveLength(1);
  expect(created[0]).toMatchObject({
    young: material.young,
    poisson: material.poisson,
  });
  for (const id of await cadBodyIds(page)) {
    await openBody(page, id);
    await page
      .getByTestId(`body-material-${id}`)
      .selectOption(String(created[0].id));
  }
}

const DOF_LABELS = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];

async function addSupport(page: Page, support: Support): Promise<void> {
  await addBoundary(page, "bc");
  await pickBoundary(page, support.faces, `"${support.name}"`);
  for (let dof = 0; dof < DOF_LABELS.length; dof++) {
    const box = page.getByLabel(DOF_LABELS[dof], { exact: true });
    const wanted = support.dofs.includes(dof);
    if ((await box.count()) === 0) {
      if (wanted)
        throw new MissingUiCapability(
          `fix ${DOF_LABELS[dof]} on "${support.name}"`,
          "rotations are offered only on shell models and reference points",
        );
      continue;
    }
    if ((await box.isChecked()) !== wanted) await box.click();
  }
  await page
    .getByText("Value", { exact: true })
    .locator("..")
    .locator("input")
    .fill(String(support.value));
  await page.getByRole("button", { name: "Apply BC" }).click();
  await expect(page.getByTestId("panel-title")).toHaveText(/^BC\d+$/);
}

const VECTOR_LABELS = {
  force: ["Fx (N)", "Fy (N)", "Fz (N)"],
  moment: ["Mx (N·mm)", "My (N·mm)", "Mz (N·mm)"],
};

function loadVector(load: Load): Point {
  if (load.kind === "force") {
    if (!load.components) throw new Error(`"${load.name}": no components`);
    return load.components;
  }
  if (load.axis === undefined || load.value === undefined)
    throw new Error(`"${load.name}": a moment needs axis and value`);
  const vec: Point = [0, 0, 0];
  vec[load.axis] = load.value;
  return vec;
}

async function addLoad(page: Page, load: Load): Promise<void> {
  await addBoundary(page, "load");
  await pickBoundary(page, load.faces, `"${load.name}"`);
  await page
    .getByText("Type", { exact: true })
    .locator("..")
    .locator("select")
    .selectOption(load.kind);
  const input = (label: string) =>
    page.getByText(label, { exact: true }).locator("..").locator("input");
  if (load.kind === "pressure") {
    if (load.value === undefined)
      throw new Error(`"${load.name}": a pressure needs a value`);
    await input("Pressure (MPa)").fill(String(load.value));
  } else {
    const vec = loadVector(load);
    for (let k = 0; k < 3; k++)
      await input(VECTOR_LABELS[load.kind][k]).fill(String(vec[k]));
  }
  await page.getByRole("button", { name: "Apply Load" }).click();
  await expect(page.getByTestId("panel-title")).toHaveText(/^Load\d+$/);
}

async function solve(page: Page): Promise<void> {
  await openTree(page, "static");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled({ timeout: 15_000 });
  await run.click();
  const failed = page.getByText(/^Solver error:/);
  await expect
    .poll(
      async () => {
        if (await failed.isVisible())
          throw new Error((await failed.textContent()) as string);
        return page.evaluate(() => {
          const st = (
            window as unknown as {
              __kofemStore: {
                getState(): { isRunning: boolean; result: unknown };
              };
            }
          ).__kofemStore.getState();
          return !st.isRunning && st.result !== null;
        });
      },
      { timeout: 300_000 },
    )
    .toBe(true);
}

// Studies → + Add → Optimization: SIMP, minimum compliance, the recipe's
// settings typed into the Optimize panel, then Run optimization. The store's
// settings must then read exactly as typed.
async function optimize(page: Page, step: OptimizeStep): Promise<void> {
  await openTree(page, "topopt");
  await page.getByRole("button", { name: "SIMP", exact: true }).click();
  await page
    .getByRole("button", { name: "Min compliance", exact: true })
    .click();
  const stress = page.getByTestId("topopt-stress-constraint");
  if (await stress.isChecked()) await stress.click();
  const fields: [string, number][] = [
    ["Volume frac.", step.volumeFraction],
    ["Penalty p", step.penalty],
    ["Filter r_min", step.filterRadius],
  ];
  for (const [label, value] of fields)
    await page.getByLabel(label, { exact: true }).fill(String(value));
  await page.getByRole("button", { name: "Advanced" }).click();
  const advanced: [string, number][] = [
    ["Move limit", step.moveLimit],
    ["Max iters", step.maxIterations],
    ["Tolerance", step.tolerance],
  ];
  for (const [label, value] of advanced)
    await page.getByLabel(label, { exact: true }).fill(String(value));
  const typed = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { topOpt: Record<string, unknown> } };
        }
      ).__kofemStore.getState().topOpt,
  );
  expect(typed).toMatchObject({
    method: "simp",
    objective: step.objective,
    stressConstraint: false,
    volumeFraction: String(step.volumeFraction),
    penalty: String(step.penalty),
    filterRadius: String(step.filterRadius),
    moveLimit: String(step.moveLimit),
    maxIterations: String(step.maxIterations),
    tolerance: String(step.tolerance),
  });
  const run = page.getByRole("button", { name: /Run optimization/ });
  await expect(run).toBeEnabled({ timeout: 15_000 });
  await run.click();
  const failed = page.getByText(/^Optimization error:/);
  await expect
    .poll(
      async () => {
        if (await failed.isVisible())
          throw new Error((await failed.textContent()) as string);
        return page.getByTestId("topopt-final-compliance").count();
      },
      // ~100 iterations at about half a second each in the browser.
      { timeout: 300_000 },
    )
    .toBe(1);
}

// The final compliance the Results panel's run summary shows after an
// optimization (its unrounded data-value), checked against the run's history
// in the store.
export async function readFinalCompliance(page: Page): Promise<number> {
  const shown = page.getByTestId("topopt-final-compliance");
  const value = Number(await shown.getAttribute("data-value"));
  const last = await page.evaluate(() => {
    const result = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            densityResult: {
              history: { compliance: number; max_change: number }[];
            } | null;
          };
        };
      }
    ).__kofemStore.getState().densityResult;
    return result ? result.history[result.history.length - 1] : null;
  });
  if (!last) throw new Error("the Results panel shows no optimization result");
  expect(value, "the panel shows the last iteration's compliance").toBe(
    last.compliance,
  );
  await expect(shown).toHaveText(last.compliance.toExponential(3));
  return value;
}

export interface BuildReport {
  // Geometry after the import and after each split.
  counts: Counts[];
  // Seconds per stage.
  seconds: Record<string, number>;
}

// Perform every step of the recipe through the UI, then run the static solve,
// or the optimization of a recipe with an optimize step.
export async function buildByHand(
  page: Page,
  recipe: Recipe,
): Promise<BuildReport> {
  const seconds: Record<string, number> = {};
  let mark = Date.now();
  const lap = (stage: string) => {
    const now = Date.now();
    seconds[stage] = (now - mark) / 1000;
    mark = now;
  };

  await importStepText(page, recipe.step());
  const counts = [await geometryCounts(page)];
  lap("import");
  for (const split of recipe.splits) {
    await applySplit(page, split);
    counts.push(await geometryCounts(page));
  }
  lap("splits");
  await chooseElementType(page, recipe.discretization);
  await meshIt(page, recipe.mesh);
  await checkShellThickness(page, recipe.discretization);
  lap("mesh");
  await setMaterial(page, recipe.material);
  for (const support of recipe.supports) await addSupport(page, support);
  for (const load of recipe.loads) await addLoad(page, load);
  lap("boundary");
  if (recipe.optimize === undefined) {
    await solve(page);
    lap("solve");
  } else {
    await optimize(page, recipe.optimize);
    lap("optimize");
  }
  return { counts, seconds };
}

// ── What the build made ───────────────────────────────────────────────────────

export interface FaceCheck {
  cadFaceId: number | null;
  // The entry's nodes are exactly the current mesh's nodes of its CAD face —
  // what a fresh pick of that face gives (an Edge entry: the face's rim on
  // the shell).
  onMesh: boolean;
}

export function groupFaces(snap: Snapshot, faces: StoreFace[]): FaceCheck[] {
  const rim = faces.some((f) => f.geometry === "edge")
    ? snapshotRim(snap)
    : null;
  return faces.map((f) => {
    if (f.cadFaceId === undefined) return { cadFaceId: null, onMesh: false };
    const expected = (
      rim && f.geometry === "edge"
        ? (rim.nodesByFace.get(f.cadFaceId) ?? [])
        : nodesOfFaces(snap, [f.cadFaceId]).map((i) => snap.nodes[i].id)
    ).join(",");
    return {
      cadFaceId: f.cadFaceId,
      onMesh: [...f.nodeIds].sort((a, b) => a - b).join(",") === expected,
    };
  });
}

// The CAD faces a recipe's face list names, in the solved model's numbering.
export function recipeFaceIds(snap: Snapshot, faces: FaceRef[]): number[] {
  return faces.map((f) => resolveFace(snap, f.at).cadFaceId);
}

// ── The read-out, exactly as the contract defines the probe ──────────────────

// Nodal von Mises as the app averages it (lib/resultField.ts nodeVonMisesField):
// volume-weighted for tetrahedra, area-weighted for shell facets.
function nodalVonMises(snap: Snapshot): number[] {
  if (!snap.vonMises) throw new Error("the result carries no von Mises field");
  const vm = snap.vonMises;
  if (vm.length !== snap.elements.length)
    throw new Error(
      `von Mises has ${vm.length} values for ${snap.elements.length} elements`,
    );
  const index = new Map(snap.nodes.map((n, i) => [n.id, i]));
  const pos = (id: number): Point => {
    const i = index.get(id);
    if (i === undefined) throw new Error(`element names unknown node ${id}`);
    const n = snap.nodes[i];
    return [n.x, n.y, n.z];
  };
  const sums = new Float64Array(snap.nodes.length);
  const weights = new Float64Array(snap.nodes.length);
  snap.elements.forEach((el, e) => {
    const corner = el.nodeIds.map(pos);
    let weight = 1;
    if (el.nodeIds.length === 3)
      weight =
        norm(cross(sub(corner[1], corner[0]), sub(corner[2], corner[0]))) / 2;
    else if (el.nodeIds.length === 4)
      weight =
        Math.abs(
          dot(
            sub(corner[1], corner[0]),
            cross(sub(corner[2], corner[0]), sub(corner[3], corner[0])),
          ),
        ) / 6;
    for (const id of el.nodeIds) {
      const i = index.get(id) as number;
      sums[i] += weight * vm[e];
      weights[i] += weight;
    }
  });
  return Array.from(sums, (s, i) => (weights[i] > 0 ? s / weights[i] : 0));
}

export function probeValue(snap: Snapshot, probe: Probe): number {
  const disp = snap.displacements;
  if (!disp) throw new Error("the model is not solved");
  if (disp.length !== 3 * snap.nodes.length)
    throw new Error(
      `${disp.length / 3} displacements for ${snap.nodes.length} nodes`,
    );
  const faceNodes = (faces: FaceRef[]) =>
    nodesOfFaces(snap, recipeFaceIds(snap, faces));
  let value: number;
  if (probe.kind === "displacement") {
    if (probe.faces) {
      const nodes = faceNodes(probe.faces);
      value =
        nodes.reduce((s, i) => s + disp[3 * i + probe.component], 0) /
        nodes.length;
    } else {
      if (!probe.at) throw new Error("displacement probe needs faces or at");
      const at = probe.at;
      let best = -1;
      let bestDist = Infinity;
      snap.nodes.forEach((n, i) => {
        const dist = norm(sub([n.x, n.y, n.z], at));
        if (dist < bestDist) [best, bestDist] = [i, dist];
      });
      value = disp[3 * best + probe.component];
    }
  } else if (probe.kind === "twist") {
    const nodes = faceNodes(probe.faces);
    const centroid = scale(
      nodes.reduce<Point>(
        (s, i) => add(s, [snap.nodes[i].x, snap.nodes[i].y, snap.nodes[i].z]),
        [0, 0, 0],
      ),
      1 / nodes.length,
    );
    const axis: Point = [0, 0, 0];
    axis[probe.axis] = 1;
    const size = modelSize(snap.tess.points);
    let sum = 0;
    let count = 0;
    for (const i of nodes) {
      const n = snap.nodes[i];
      const rel = sub([n.x, n.y, n.z], centroid);
      const perp = sub(rel, scale(axis, dot(rel, axis)));
      const r2 = dot(perp, perp);
      if (r2 <= 1e-18 * size * size) continue; // on the axis
      const displacement: Point = [
        disp[3 * i],
        disp[3 * i + 1],
        disp[3 * i + 2],
      ];
      sum += cross(perp, displacement)[probe.axis] / r2;
      count++;
    }
    if (count === 0) throw new Error("twist probe: every node is on the axis");
    value = sum / count;
  } else {
    const vm = nodalVonMises(snap);
    const nodes = probe.faces
      ? faceNodes(probe.faces)
      : snap.nodes.map((_, i) => i);
    value = Math.max(...nodes.map((i) => vm[i]));
  }
  return probe.divideBy === undefined ? value : value / probe.divideBy;
}

// ── Is the hand-built mesh the node-side one? ─────────────────────────────────

export interface MeshComparison {
  identical: boolean;
  gui: { nodes: number; tets: number };
  node: { nodes: number; tets: number };
  maxCoordDiff: number | null;
}

interface EngineMesh {
  vertices: Float64Array;
  tetrahedra: Int32Array;
}
interface Engine {
  tessellate_step(bytes: Uint8Array, opts: string): unknown;
  generate_fem_mesh(opts: string): EngineMesh | { overlaps: unknown[] };
}

// Mesh the geometry the app holds now (after its splits) in Node with a fresh
// engine and the worker's exact options, and compare with the app's mesh.
export async function compareWithNodeMesh(
  page: Page,
  mesh: MeshStep,
): Promise<MeshComparison> {
  const app = await page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            stepBytes: Uint8Array | null;
            nodes: StoreNode[];
            elements: { type: string; nodeIds: number[] }[];
          };
        };
      }
    ).__kofemStore.getState();
    if (!st.stepBytes) throw new Error("the app holds no STEP bytes");
    return {
      bytes: Array.from(st.stepBytes),
      coords: st.nodes.flatMap((n) => [n.x, n.y, n.z]),
      tets: st.elements
        .filter((e) => e.type === "CTETRA")
        .flatMap((e) => e.nodeIds),
    };
  });
  const engine = (await loadEngine()) as Engine;
  engine.tessellate_step(
    Uint8Array.from(app.bytes),
    JSON.stringify({
      deflection_relative: 0.001,
      angular_deflection: 0.5,
      format: "step",
    }),
  );
  const dto = engine.generate_fem_mesh(
    JSON.stringify({
      max_element_size: mesh.maxElementSize,
      min_element_size: minElementSizeOf(mesh),
      grading: 0.3,
      second_order: false,
      elementsperedge: 2.0,
      elementspercurve: 2.0,
      optsteps_2d: 3,
      optsteps_3d: 3,
    }),
  );
  if ("overlaps" in dto)
    throw new Error("node-side mesh: the surface mesh overlaps itself");
  const vertices = Array.from(dto.vertices);
  const tets = Array.from(dto.tetrahedra);
  const sameShape =
    vertices.length === app.coords.length && tets.length === app.tets.length;
  let maxCoordDiff: number | null = null;
  if (sameShape) {
    maxCoordDiff = 0;
    for (let i = 0; i < vertices.length; i++)
      maxCoordDiff = Math.max(
        maxCoordDiff,
        Math.abs(vertices[i] - app.coords[i]),
      );
  }
  return {
    identical:
      sameShape &&
      maxCoordDiff === 0 &&
      tets.every((v, i) => v === app.tets[i]),
    gui: { nodes: app.coords.length / 3, tets: app.tets.length / 4 },
    node: { nodes: vertices.length / 3, tets: tets.length / 4 },
    maxCoordDiff,
  };
}
