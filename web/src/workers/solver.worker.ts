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

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;

  try {
    await ensureInit();

    if (type === "parse_step") {
      // payload.bytes: Uint8Array, payload.format: "step" | "iges"
      const opts = JSON.stringify({
        linear_deflection: 0.1,
        angular_deflection: 0.5,
        format: (payload.format as string) ?? "step",
      });
      const json = m().tessellate_step(payload.bytes as Uint8Array, opts);
      // tessellate_step stores the OCCT shape in the module — record that so a
      // subsequent volume_mesh in this same worker can skip the reload.
      geometryLoaded = true;
      const dto = JSON.parse(json) as {
        vertices: [number, number, number][];
        triangles: [number, number, number][];
      };
      // Return as {points, triangles} to match the StepSurfaceMesh type used by the store
      self.postMessage({
        id,
        ok: true,
        points: dto.vertices,
        triangles: dto.triangles,
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
            linear_deflection: 0.1,
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
      const { nodes, elements, materials, constraints, loads } = payload as {
        nodes: Node[];
        elements: Element[];
        materials: Material[];
        properties: unknown[];
        constraints: Constraint[];
        loads: Load[];
      };

      const tetrahedra = elements
        .filter((e) => e.type === "CTETRA")
        .map((e) => e.nodeIds);
      const hexahedra = elements
        .filter((e) => e.type === "CHEXA")
        .map((e) => e.nodeIds);
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
      const dofsByNode = new Map<number, Set<number>>();
      const prescribed_dofs: { vertex: number; dof: number; value: number }[] =
        [];
      for (const c of constraints) {
        if (c.dof > 2) continue;
        const value = c.prescribedValue ?? 0;
        if (value === 0) {
          if (!dofsByNode.has(c.nodeId)) dofsByNode.set(c.nodeId, new Set());
          dofsByNode.get(c.nodeId)!.add(c.dof);
        } else {
          prescribed_dofs.push({ vertex: c.nodeId, dof: c.dof, value });
        }
      }
      const fixed_vertices: number[] = [];
      const fixed_dofs: { vertex: number; dofs: number[] }[] = [];
      for (const [nodeId, dofSet] of dofsByNode) {
        if (dofSet.size === 3) fixed_vertices.push(nodeId);
        else fixed_dofs.push({ vertex: nodeId, dofs: [...dofSet].sort() });
      }

      // Group translational force loads by node, accumulating into [fx, fy, fz]
      const loadMap = new Map<number, [number, number, number]>();
      for (const load of loads) {
        if (load.dof > 2) continue;
        if (!loadMap.has(load.nodeId)) loadMap.set(load.nodeId, [0, 0, 0]);
        loadMap.get(load.nodeId)![load.dof] += load.value;
      }
      const point_loads = [...loadMap.entries()].map(([vertex, force]) => ({
        vertex,
        force,
      }));

      const bcs = { fixed_vertices, point_loads, fixed_dofs, prescribed_dofs };
      const json = m().solve_linear_elastic(
        JSON.stringify(mesh),
        JSON.stringify(material),
        JSON.stringify(bcs),
        1,
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
