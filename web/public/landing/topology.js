export async function createTopology(
  THREE,
  body,
  _nodes,
  center,
  baseColor,
  _triangles,
  _restNormals,
  onChange = () => {},
) {
  const [metaResponse, dataResponse] = await Promise.all([
    fetch(new URL("./ge-engine-bracket-smooth.json", import.meta.url)),
    fetch(new URL("./ge-engine-bracket-smooth.bin", import.meta.url)),
  ]);
  if (!metaResponse.ok || !dataResponse.ok)
    throw Error("KoFEM smooth topology sequence could not load");
  const metadata = await metaResponse.json(),
    buffer = await dataResponse.arrayBuffer();
  let geometry = new THREE.BufferGeometry();
  let capacity = 0;
  const material = new THREE.MeshPhongMaterial({
    color: baseColor,
    shininess: 55,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  const object = new THREE.Mesh(geometry, material);
  object.visible = false;
  object.renderOrder = 2;
  object.frustumCulled = false;
  body.add(object);
  const worker = new Worker(new URL("./topology-worker.js", import.meta.url), {
    type: "module",
  });
  let busy = true,
    pending = null,
    last = -1,
    renderedProgress = -1,
    triangles = 0,
    elapsedMs = 0,
    failed = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  function frame(amount) {
    let a = 0;
    while (a < metadata.stops.length - 2 && amount > metadata.stops[a + 1]) a++;
    const b = a + 1,
      blend = Math.max(
        0,
        Math.min(
          1,
          (amount - metadata.stops[a]) /
            (metadata.stops[b] - metadata.stops[a]),
        ),
      );
    return { type: "surface", a, b, blend, amount };
  }
  function send(request) {
    busy = true;
    worker.postMessage(request);
  }
  worker.onerror = (event) => {
    failed = new Error(event.message || "Topology surface worker failed");
    busy = false;
    rejectReady(failed);
    onChange();
  };
  worker.onmessage = (event) => {
    const result = event.data;
    if (result.type === "error") {
      failed = new Error(result.message);
      busy = false;
      rejectReady(failed);
      onChange();
      return;
    }
    if (result.positions.length > capacity) {
      capacity = Math.ceil((result.positions.length * 1.4) / 9) * 9;
      geometry.dispose();
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(capacity), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      geometry.setAttribute(
        "normal",
        new THREE.BufferAttribute(new Float32Array(capacity), 3).setUsage(
          THREE.DynamicDrawUsage,
        ),
      );
      object.geometry = geometry;
    }
    geometry.attributes.position.array.set(result.positions);
    geometry.attributes.normal.array.set(result.normals);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    geometry.setDrawRange(0, result.positions.length / 3);
    renderedProgress = result.amount;
    triangles = result.triangleCount;
    elapsedMs = result.elapsedMs;
    busy = false;
    resolveReady();
    if (pending) {
      const next = pending;
      pending = null;
      send(next);
    }
    onChange();
  };
  worker.postMessage({ type: "init", metadata, buffer, center }, [buffer]);
  await ready;
  return {
    update(amount, visible) {
      if (failed) throw failed;
      object.visible = visible;
      if (!visible) return { iteration: 0, retained: metadata.elements };
      const time = Math.max(0, Math.min(1, amount)),
        request = frame(time),
        { a, b, blend } = request;
      if (time !== last) {
        last = time;
        if (busy) pending = request;
        else if (time !== renderedProgress) send(request);
      }
      return {
        iteration: Math.round(
          metadata.frames[a] * (1 - blend) + metadata.frames[b] * blend,
        ),
        retained: Math.round(
          metadata.retained[a] * (1 - blend) + metadata.retained[b] * blend,
        ),
      };
    },
    get busy() {
      return busy;
    },
    get renderedProgress() {
      return renderedProgress;
    },
    get triangles() {
      return triangles;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    metadata,
    dispose() {
      worker.terminate();
      body.remove(object);
      geometry.dispose();
      material.dispose();
    },
  };
}
