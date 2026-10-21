// The worker fetches and decodes the sequence itself and answers with the
// metadata and the first surface, so none of it runs on the scroll thread.
export function loadTopology(center) {
  const worker = new Worker(new URL("./topology-worker.js", import.meta.url), {
    type: "module",
  });
  const first = new Promise((resolve, reject) => {
    worker.onmessage = (event) =>
      event.data.type === "error"
        ? reject(Error(event.data.message))
        : resolve(event.data);
    worker.onerror = (event) =>
      reject(Error(event.message || "Topology surface worker failed"));
  });
  worker.postMessage({
    type: "init",
    center,
    metadataUrl: new URL("./ge-engine-bracket-smooth.json", import.meta.url)
      .href,
    dataUrl: new URL("./ge-engine-bracket-smooth.bin", import.meta.url).href,
  });
  return first.then((result) => ({ worker, first: result }));
}

export function createTopology(
  THREE,
  body,
  baseColor,
  onChange,
  { worker, first },
) {
  const metadata = first.metadata;
  const playbackEndIteration = 36;
  const playbackFrames = metadata.frames.filter(
    (iteration) => iteration <= playbackEndIteration,
  );
  const stops = playbackFrames.map(
    (iteration) => iteration / playbackFrames.at(-1),
  );
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
  let busy = false,
    pending = null,
    last = -1,
    renderedProgress = -1,
    triangles = 0,
    elapsedMs = 0,
    failed = null;
  function frame(amount) {
    let lower = 0;
    while (lower < stops.length - 2 && amount > stops[lower + 1]) lower++;
    const upper = lower + 1,
      blend = Math.max(
        0,
        Math.min(1, (amount - stops[lower]) / (stops[upper] - stops[lower])),
      );
    return { type: "surface", lower, upper, blend, amount };
  }
  function send(request) {
    busy = true;
    worker.postMessage(request);
  }
  worker.onerror = (event) => {
    failed = new Error(event.message || "Topology surface worker failed");
    busy = false;
    onChange();
  };
  function show(result) {
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
  }
  worker.onmessage = (event) => {
    const result = event.data;
    busy = false;
    if (result.type === "error") failed = new Error(result.message);
    else show(result);
    if (pending && !failed) {
      const next = pending;
      pending = null;
      send(next);
    }
    onChange();
  };
  show(first);
  return {
    update(amount, visible) {
      if (failed) throw failed;
      object.visible = visible;
      if (!visible) return { iteration: 0, retained: metadata.elements };
      const time = Math.max(0, Math.min(1, amount)),
        request = frame(time),
        { lower, upper, blend } = request;
      if (time !== last) {
        last = time;
        if (busy) pending = request;
        else if (time !== renderedProgress) send(request);
      }
      return {
        iteration: Math.round(
          metadata.frames[lower] * (1 - blend) + metadata.frames[upper] * blend,
        ),
        retained: Math.round(
          metadata.retained[lower] * (1 - blend) +
            metadata.retained[upper] * blend,
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
