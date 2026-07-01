/// <reference lib="webworker" />
// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

// import init, {
//   tessellate_step,
//   generate_volume_mesh,
//   solve_linear_elastic,
// } from '/wasm/pkg/kofem_wasm.js'
import createModule from "../wasm/pkg/kofem_wasm.js";
import type { KofemModule } from "../wasm/pkg/kofem_wasm.js";

let Module: KofemModule | null = null;

// True once tessellate_step has loaded the OCCT STEP shape into THIS worker's
// WASM module. The worker is torn down after every mesh (resetWorker in
// LeftPanel) to keep Netgen's global state out of the MFEM solve, so a re-mesh
// starts in a fresh module where this is false and the geometry must be
// reloaded from the original STEP bytes before meshing.
let geometryLoaded = false;

// Emscripten (-fexceptions) surfaces an uncaught C++ exception to JS as the raw
// heap pointer of the exception object — a bare number such as 12190840. Decode
// it to the real what() text via getExceptionMessage, exported by the build flag
// EXPORT_EXCEPTION_HANDLING_HELPERS. Degrades gracefully (labelled pointer) when
// the helper is absent, e.g. an older wasm binary built before the flag was added.
function describeError(err: unknown): string {
  if (err instanceof Error)
    return `${err.name}: ${err.message}\n${err.stack ?? ""}`;
  if (typeof err === "number") {
    const getMsg = (
      Module as unknown as {
        getExceptionMessage?: (ptr: number) => [string, string];
      } | null
    )?.getExceptionMessage;
    if (getMsg) {
      try {
        const [type, message] = getMsg(err);
        return message ? `${type}: ${message}` : type;
      } catch {
        // decoding failed — fall through to the labelled raw pointer
      }
    }
    return `C++ exception (undecoded, ptr ${err})`;
  }
  return String(err);
}

async function ensureInit() {
  if (!Module) {
    Module = await createModule({
      print: (text: string) =>
        self.postMessage({ id: 0, log: `[wasm] ${text}` }),
      printErr: (text: string) =>
        self.postMessage({ id: 0, log: `[wasm:err] ${text}` }),
    });
  }
}
function m(): KofemModule {
  if (!Module)
    throw new Error("WASM module not initialised — await ensureInit() first");
  return Module;
}

// Group a flat typed array (xyz / abc interleaved) into [a, b, c] tuples.
// tessellate_step now returns binary typed arrays instead of a JSON string;
// the store's StepSurfaceMesh holds nested tuples, so unpack at this boundary —
// far cheaper than the previous JSON.parse of a multi-MB text payload.
function chunk3(flat: Float32Array | Uint32Array): [number, number, number][] {
  const n = (flat.length / 3) | 0;
  const out = new Array<[number, number, number]>(n);
  for (let i = 0; i < n; i++) {
    const j = 3 * i;
    out[i] = [flat[j], flat[j + 1], flat[j + 2]];
  }
  return out;
}

// ── Payload types ─────────────────────────────────────────────────────────────

interface Node {
  id: number;
  x: number;
  y: number;
  z: number;
}
interface Element {
  id: number;
  type: string;
  nodeIds: number[];
  propertyId: number;
}
interface Material {
  id: number;
  name: string;
  young: number;
  poisson: number;
  density: number;
}
interface Constraint {
  nodeId: number;
  dof: number;
  prescribedValue?: number;
}
interface Load {
  nodeId: number;
  dof: number;
  value: number;
}
// A work-equivalent surface load applied by the engine's boundary integrator
// over the boundary elements covering `faces` (node-index lists — triangles for
// tets, quads for hexes).
//   force    — total force vector spread as a uniform traction over the face
//   pressure — scalar magnitude applied as -p·n̂ (outward normal; + pushes in)
//   traction — traction vector applied directly
interface SurfaceLoad {
  type: "force" | "pressure" | "traction";
  faces: number[][];
  force?: [number, number, number];
  pressure?: number;
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;

  try {
    await ensureInit();

    if (type === "parse_step") {
      // payload.bytes: Uint8Array, payload.format: "step" | "iges"
      // deflection_relative: chord tolerance as a fraction of the model's
      // bounding-box diagonal, so a large part isn't tessellated into millions of
      // needless triangles. ~0.1% matches the fast browser STEP viewers.
      const opts = JSON.stringify({
        deflection_relative: 0.001,
        angular_deflection: 0.5,
        format: (payload.format as string) ?? "step",
      });
      const { vertices, triangles } = m().tessellate_step(
        payload.bytes as Uint8Array,
        opts,
      );
      // tessellate_step stores the OCCT shape in the module — record that so a
      // subsequent volume_mesh in this same worker can skip the reload.
      geometryLoaded = true;
      // Return as {points, triangles} to match the StepSurfaceMesh type used by
      // the store; tessellate_step returns flat Float32/Uint32 typed arrays.
      self.postMessage({
        id,
        ok: true,
        points: chunk3(vertices),
        triangles: chunk3(triangles),
      });
    } else if (type === "volume_mesh") {
      const {
        bytes,
        format = "step",
        maxElementSize = 20.0,
        minElementSize,
      } = payload as {
        bytes?: Uint8Array;
        format?: string;
        maxElementSize?: number;
        minElementSize?: number;
      };

      // A re-mesh runs in a fresh worker (the previous mesh tore this worker's
      // predecessor down), so the OCCT shape generate_fem_mesh needs is gone.
      // Reload it from the original STEP bytes first. This makes every mesh
      // reproduce the known-good import→mesh sequence — tessellate_step (loads
      // the shape) then generate_fem_mesh — rather than meshing twice inside one
      // Netgen-contaminated module.
      if (!geometryLoaded) {
        if (!bytes)
          throw new Error(
            "volume_mesh: no STEP geometry is loaded and no STEP bytes were provided to reload it — re-import the STEP file before meshing",
          );
        self.postMessage({
          id,
          log: "Reloading STEP geometry into the mesher…",
        });
        m().tessellate_step(
          bytes,
          JSON.stringify({
            deflection_relative: 0.001,
            angular_deflection: 0.5,
            format,
          }),
        );
        geometryLoaded = true;
      }

      // Floor the curvature-driven local element size at maxElementSize/10 by
      // default.  Without a floor, Netgen refines every fillet to ~radius/2
      // (elementspercurve) — on fillet-heavy CAD this produces >10x more
      // elements than the max size suggests and meshing takes minutes.
      const minSize = minElementSize ?? maxElementSize / 10;

      const opts = JSON.stringify({
        max_element_size: maxElementSize,
        min_element_size: minSize,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 3,
        optsteps_3d: 3,
      });

      // Use Netgen's native OCC mesher: reads the stored STEP geometry directly,
      // generates a proper FEM surface mesh respecting CAD topology (edges, faces,
      // feature lines), then fills the volume — all in one pass.
      self.postMessage({
        id,
        log: `Generating FEM mesh via Netgen OCC (element size: ${minSize}–${maxElementSize} mm)…`,
      });
      const json = m().generate_fem_mesh(opts);
      const dto = JSON.parse(json) as {
        vertices: [number, number, number][];
        tetrahedra: [number, number, number, number][];
        // Surface element data from Netgen — present when Netgen was built with
        // USE_OCC and exposes Ng_GetSurfaceElement / Ng_GetSurfaceElementIndex.
        // surfaceTriangles: vertex indices (0-based, same node IDs as volume mesh)
        // surfaceFaceIds:   OCC face index (1-based) per surface triangle
        // Both arrays are in Netgen surface-element order, NOT tet boundary order.
        surfaceTriangles?: [number, number, number][];
        surfaceFaceIds?: number[];
      };

      self.postMessage({
        id,
        log: `Volume mesh complete: ${dto.vertices.length} nodes, ${dto.tetrahedra.length} tetrahedra`,
      });

      // Release OCCT shape + STEP bytes from WASM heap — they are no longer
      // needed once meshing is done, and freeing them before the solve gives
      // MFEM more headroom for stiffness-matrix assembly.
      m().free_geometry_cache();
      geometryLoaded = false;

      const nodes: Node[] = dto.vertices.map(([x, y, z], i) => ({
        id: i,
        x,
        y,
        z,
      }));
      const elements: Element[] = dto.tetrahedra.map((v, i) => ({
        id: i,
        type: "CTETRA",
        nodeIds: v,
        propertyId: 1,
      }));

      // Derive unique edges from tetrahedra for wireframe display.
      // Numeric keys (lo * nVerts + hi): string keys cost seconds of hashing
      // and GC at >100k-node mesh sizes.  Max key is nVerts² < 2^53 for any
      // mesh that fits in WASM memory.
      const nVerts = dto.vertices.length;
      const edgeSet = new Set<number>();
      const edges: [number, number][] = [];
      for (const [a, b, c, d] of dto.tetrahedra) {
        for (const [u, v] of [
          [a, b],
          [a, c],
          [a, d],
          [b, c],
          [b, d],
          [c, d],
        ] as [number, number][]) {
          const key = u < v ? u * nVerts + v : v * nVerts + u;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push([u, v]);
          }
        }
      }

      self.postMessage({ id, log: `Wireframe: ${edges.length} edges built` });

      self.postMessage({
        id,
        ok: true,
        points: dto.vertices,
        edges,
        nodes,
        elements,
        surfaceTriangles: dto.surfaceTriangles ?? null,
        surfaceFaceIds: dto.surfaceFaceIds ?? null,
      });
    } else if (type === "solve") {
      const {
        nodes,
        elements,
        materials,
        constraints,
        loads,
        surfaceLoads,
        elementOrder,
      } = payload as {
        nodes: Node[];
        elements: Element[];
        materials: Material[];
        properties: unknown[];
        constraints: Constraint[];
        loads: Load[];
        surfaceLoads?: SurfaceLoad[];
        elementOrder?: number;
      };

      // The engine indexes vertices 0-based in the order they are added (mesh
      // vertices below are emitted in node-array order). Stored node .id values
      // are NOT those indices — saved analyses number nodes 1-based and .inp
      // imports use arbitrary ids — so every node reference (element
      // connectivity, constraints, loads, surface-load faces) must be remapped
      // to its vertex index before reaching the engine. Passing a raw node id
      // where the engine expects a vertex index reads past the vertex array and
      // traps with "memory access out of bounds" (issue #288).
      const vertexIndexById = new Map(nodes.map((n, i) => [n.id, i]));
      const vid = (nodeId: number, context: string): number => {
        const i = vertexIndexById.get(nodeId);
        if (i === undefined)
          throw new Error(
            `${context} references unknown node id ${nodeId} — the model is inconsistent`,
          );
        return i;
      };

      const tetrahedra = elements
        .filter((e) => e.type === "CTETRA")
        .map((e) => e.nodeIds.map((id) => vid(id, "CTETRA element")));
      const hexahedra = elements
        .filter((e) => e.type === "CHEXA")
        .map((e) => e.nodeIds.map((id) => vid(id, "CHEXA element")));
      if (tetrahedra.length === 0 && hexahedra.length === 0) {
        throw new Error(
          "No supported elements found. MFEM requires CTETRA or CHEXA elements — " +
            'import a STEP file and click "Mesh STEP volume" first.',
        );
      }
      const mesh = {
        vertices: nodes.map((n) => [n.x, n.y, n.z]),
        tetrahedra,
        hexahedra,
      };

      const mat = materials[0];
      if (!mat) {
        throw new Error(
          "solve: no material assigned — assign a material before running the solver",
        );
      }
      if (materials.length > 1) {
        throw new Error(
          `Multi-material models are not yet supported: ${materials.length} materials defined. ` +
            "Only a single material can be assigned. Remove all but one material before solving.",
        );
      }
      const material = {
        young_modulus: mat.young,
        poisson_ratio: mat.poisson,
        density: mat.density,
      };

      // Group translational constraints (DOFs 0–2) per node. A node constrained
      // in all three components is a full fix (fixed_vertices); a node constrained
      // in only some becomes a per-DOF constraint (fixed_dofs) so the unconstrained
      // directions stay free — e.g. a symmetry-plane roller. Rotational DOFs (3–5)
      // carry no stiffness for solid (H1 displacement) elements and are ignored.
      //
      // A non-zero prescribed displacement is also a Dirichlet condition, but it
      // must reach the solver as an inhomogeneous essential BC (prescribed_dofs):
      // folding it into fixed_vertices/fixed_dofs would silently pin the DOF to
      // zero and discard the requested value (issue #216).
      // Keyed by vertex index (vid), so the essential-DOF sets the engine
      // receives line up with the remapped mesh connectivity above.
      const dofsByNode = new Map<number, Set<number>>();
      const prescribed_dofs: { vertex: number; dof: number; value: number }[] =
        [];
      for (const c of constraints) {
        if (c.dof > 2) continue;
        const v = vid(c.nodeId, "constraint");
        const value = c.prescribedValue ?? 0;
        if (value === 0) {
          if (!dofsByNode.has(v)) dofsByNode.set(v, new Set());
          dofsByNode.get(v)!.add(c.dof);
        } else {
          prescribed_dofs.push({ vertex: v, dof: c.dof, value });
        }
      }
      const fixed_vertices: number[] = [];
      const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
      for (const [vertex, dofSet] of dofsByNode) {
        if (dofSet.size === 3) fixed_vertices.push(vertex);
        else fixed_dofs.push({ vertex, dofs: [...dofSet].sort() });
      }

      // Group translational force loads by vertex index, accumulating [fx,fy,fz]
      const loadMap = new Map<number, [number, number, number]>();
      for (const load of loads) {
        if (load.dof > 2) continue;
        const v = vid(load.nodeId, "load");
        if (!loadMap.has(v)) loadMap.set(v, [0, 0, 0]);
        loadMap.get(v)![load.dof] += load.value;
      }
      const point_loads = [...loadMap.entries()].map(([vertex, force]) => ({
        vertex,
        force,
      }));

      // Surface-load faces are node-id lists from the store; remap each to the
      // engine's vertex indices so the boundary-element matcher finds them.
      const surface_loads = (surfaceLoads ?? []).map((sl) => ({
        ...sl,
        faces: sl.faces.map((face) =>
          face.map((id) => vid(id, "surface load face")),
        ),
      }));
      const bcs = {
        fixed_vertices,
        point_loads,
        fixed_dofs,
        prescribed_dofs,
        surface_loads,
      };
      // FE polynomial order, chosen in the frontend (Solver settings). Order 2
      // (quadratic / second-order) adds edge-midpoint DOFs that resolve bending
      // and stress gradients far better than linear tets, which lock in bending
      // and smear stress concentrations to a single constant value per element
      // (issue #215), at the cost of a slower solve. The engine extends the
      // vertex Dirichlet BCs to the new edge DOFs so clamped/prescribed faces
      // stay fully constrained. Defaults to 1 (linear) when the payload omits it.
      const order = elementOrder ?? 1;
      const json = m().solve_linear_elastic(
        JSON.stringify(mesh),
        JSON.stringify(material),
        JSON.stringify(bcs),
        order,
      );
      const result = JSON.parse(json) as {
        displacements: number[];
        von_mises: number[];
      };
      self.postMessage({
        id,
        ok: true,
        displacements: result.displacements,
        vonMises: result.von_mises,
      });
    } else if (type === "test_generate_fem_mesh") {
      // Smoke test for the production OCC meshing path. Requires tessellate_step
      // to have been called first so the STEP geometry is loaded in WASM memory.
      const t0 = Date.now();
      const opts = JSON.stringify({
        max_element_size: 20.0,
        min_element_size: 2.0,
        grading: 0.3,
        second_order: false,
        elementsperedge: 2.0,
        elementspercurve: 2.0,
        optsteps_2d: 0,
        optsteps_3d: 0,
      });
      const json = m().generate_fem_mesh(opts);
      const dto = JSON.parse(json) as {
        vertices: unknown[];
        tetrahedra: unknown[];
      };
      self.postMessage({
        id,
        ok: true,
        nodes: dto.vertices.length,
        elements: dto.tetrahedra.length,
        durationMs: Date.now() - t0,
      });
    } else if (type === "mesh") {
      throw new Error(
        "Parametric mesh generation is not available in the new pipeline. Import a STEP file instead.",
      );
    } else {
      throw new Error(`Unknown worker message type: ${type}`);
    }
  } catch (err) {
    const isRuntimeError = err instanceof Error && err.name === "RuntimeError";
    const isWasmTrap =
      isRuntimeError &&
      (err.message.includes("memory access out of bounds") ||
        err.message.includes("integer overflow") ||
        err.message.includes("integer divide by zero") ||
        err.message.includes("unreachable") ||
        err.message.includes("null function or function signature mismatch") ||
        err.message.includes("table index is out of bounds"));
    const detail = describeError(err);
    const errorMessage = isWasmTrap
      ? `WASM trap (code bug, not OOM): ${detail}`
      : detail;
    if (isWasmTrap) {
      console.error(`[solver.worker] WASM trap in ${type}:`, detail);
    } else {
      console.error(`[solver.worker] ${type} failed:`, detail);
    }
    self.postMessage({ id, ok: false, error: errorMessage });
  }
};
