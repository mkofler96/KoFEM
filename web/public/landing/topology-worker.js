import { createSurfaceExtractor } from "./smooth-surface.js";
let sequence = null;
function load({ metadata, buffer, center }) {
  const read = (name) => {
    const info = metadata.layout[name];
    return info.type === "Uint32Array"
      ? new Uint32Array(buffer, info.offset, info.length)
      : new Float32Array(buffer, info.offset, info.length);
  };
  const positions = read("positions");
  return {
    nodeCount: positions.length / 3,
    fields: read("fields"),
    threshold: metadata.threshold,
    extract: createSurfaceExtractor(
      positions,
      read("tetrahedra"),
      read("boundary"),
      read("boundaryNormals"),
      center,
    ),
  };
}
function surface(request) {
  if (!sequence)
    throw Error(
      `Topology worker received a "${request.type}" request before "init"`,
    );
  const { extract, fields, nodeCount, threshold } = sequence;
  const started = performance.now(),
    field = new Float32Array(nodeCount);
  const lower = request.lower ?? 0,
    upper = request.upper ?? 0,
    blend = request.blend ?? 0;
  for (let i = 0; i < nodeCount; i++)
    field[i] =
      fields[lower * nodeCount + i] * (1 - blend) +
      fields[upper * nodeCount + i] * blend;
  return {
    ...extract(field, threshold),
    elapsedMs: performance.now() - started,
  };
}
self.onmessage = (event) => {
  const data = event.data;
  try {
    if (data.type === "init") sequence = load(data);
    const result = surface(data);
    self.postMessage({ type: "surface", amount: data.amount ?? 0, ...result }, [
      result.positions.buffer,
      result.normals.buffer,
    ]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};
