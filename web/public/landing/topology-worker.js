import { createSurfaceExtractor } from "./smooth-surface.js";
let extract, fields, nodeCount, threshold;
self.onmessage = (event) => {
  const data = event.data;
  try {
    if (data.type === "init") {
      const { metadata, buffer, center } = data;
      const read = (name) => {
        const info = metadata.layout[name];
        return info.type === "Uint32Array"
          ? new Uint32Array(buffer, info.offset, info.length)
          : new Float32Array(buffer, info.offset, info.length);
      };
      const positions = read("positions");
      nodeCount = positions.length / 3;
      fields = read("fields");
      threshold = metadata.threshold;
      extract = createSurfaceExtractor(
        positions,
        read("tetrahedra"),
        read("boundary"),
        read("boundaryNormals"),
        center,
      );
    }
    const started = performance.now(),
      field = new Float32Array(nodeCount);
    const a = data.a ?? 0,
      b = data.b ?? 0,
      blend = data.blend ?? 0;
    for (let i = 0; i < nodeCount; i++)
      field[i] =
        fields[a * nodeCount + i] * (1 - blend) +
        fields[b * nodeCount + i] * blend;
    const result = extract(field, threshold);
    self.postMessage(
      {
        type: "surface",
        amount: data.amount ?? 0,
        ...result,
        elapsedMs: performance.now() - started,
      },
      [result.positions.buffer, result.normals.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};
