import { fetchBinary, fetchJson, typedArray } from "./assets.js";
import { createTopology, loadTopology } from "./topology.js";
const status = document.querySelector("#load-status");
const track = document.querySelector(".scroll-story");
const scrollViewport = document.querySelector("#scroll-viewport");
const intro = document.querySelector(".intro");
const bottomLine = document.querySelector(".bottom-line");
const meshCopy = document.querySelector(".mesh-copy");
const analysisCopy = document.querySelector(".analysis-copy");
const analysisStages = {
  solve: {
    title: "Local Solve",
    subtitle: "No cloud, full control over your data.",
  },
  results: {
    title: "Post Processing",
    subtitle: "Integrated web-based visualization",
  },
  optimization: {
    title: "Optimization",
    subtitle: "Put material where it is needed",
  },
};
const analysisPanels = Object.values(analysisStages).map((stage, index) => {
  const panel = document.createElement("div");
  panel.className = "analysis-stage";
  panel.setAttribute("aria-hidden", String(index !== 0));
  const title = document.createElement("h2");
  title.textContent = stage.title;
  const subtitle = document.createElement("p");
  subtitle.className = "stage-subtitle";
  subtitle.textContent = stage.subtitle;
  if (index === 0) {
    title.id = "analysis-title";
    subtitle.id = "analysis-detail";
  }
  panel.append(title, subtitle);
  return { panel, title, subtitle };
});
analysisCopy.replaceChildren(...analysisPanels.map(({ panel }) => panel));
const progressBar = document.querySelector(".progress i");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
// Phones and portrait tablets stack the copy above the bracket; the same query
// switches the layout in landing.css.
const stacked = matchMedia(
  "(max-width: 700px) and (orientation: portrait), (max-aspect-ratio: 4/5)",
);
const clamp = (value) => Math.max(0, Math.min(1, value));
const smooth = (value) => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const curve = (value) => {
  const x = clamp(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
};
function transitionAnalysis(results, optimization, still) {
  const weights = [1 - results, results * (1 - optimization), optimization];
  const offsets = [-results, 1 - results - optimization, 1 - optimization];
  const active = weights.indexOf(Math.max(...weights));
  analysisPanels.forEach(({ panel, title, subtitle }, index) => {
    const weight = weights[index];
    panel.style.opacity = String(weight);
    panel.style.translate = `0 ${still ? 0 : offsets[index] * 28}px`;
    panel.style.filter = still ? "none" : `blur(${(1 - weight) * 4}px)`;
    panel.setAttribute("aria-hidden", String(index !== active));
    title.id = index === active ? "analysis-title" : "";
    subtitle.id = index === active ? "analysis-detail" : "";
    subtitle.style.opacity = String(
      still ? weight : smooth((weight - 0.12) / 0.88),
    );
    subtitle.style.translate = `0 ${still ? 0 : (1 - weight) * 8}px`;
  });
}
const asset = (name) => new URL(`./${name}`, import.meta.url);
// Every request starts at once; awaiting them in turn chained a round trip each.
const libraries = Promise.all([
  import("./vendor/manim-web.browser.js"),
  import("./vendor/three.module.js"),
]);
const bracketAssets = Promise.all([
  fetchJson(asset("ge-engine-bracket-solution.json")),
  fetchJson(asset("ge-engine-bracket.json")),
  fetchBinary(asset("ge-engine-bracket-solution.bin")),
  fetchJson(asset("ge-engine-bracket-network.json")),
  fetchBinary(asset("ge-engine-bracket-network.bin")),
]);
async function start() {
  const [
    [solution, metadata, binary, network, travelBuffer],
    [{ ThreeDScene, ModelMobject, Arrow3D }, THREE],
  ] = await Promise.all([bracketAssets, libraries]);
  const center = metadata.min.map((v, j) => (v + metadata.max[j]) / 2);
  // The optimization download is the largest. It starts once everything the
  // bracket needs is in, so it does not compete with it.
  const topologySource = loadTopology(center);
  const loadAxis = ["X", "Y", "Z"][
    solution.sourceForceN.findIndex((value) => value !== 0)
  ];
  const arrival = new Float32Array(travelBuffer, 0, network.nodeCount);
  const edgeLengths = new Float32Array(
    travelBuffer,
    network.nodeCount * 4,
    network.edgeCount,
  );
  const array = (name) => typedArray(binary, solution.layout[name]);
  const nodes = array("positions"),
    magnitudes = array("magnitudes");
  const triangles = array("triangles"),
    edgeIndices = array("edges");
  const positions = new Float32Array(nodes.length);
  const colors = new Float32Array(nodes.length);
  const surfaceGeometry = new THREE.BufferGeometry();
  const renderPositions = new Float32Array(triangles.length * 3),
    renderColors = new Float32Array(triangles.length * 3),
    renderNormals = new Float32Array(triangles.length * 3);
  const surfacePosition = new THREE.BufferAttribute(
    renderPositions,
    3,
  ).setUsage(THREE.DynamicDrawUsage);
  const surfaceColor = new THREE.BufferAttribute(renderColors, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const surfaceNormal = new THREE.BufferAttribute(renderNormals, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  surfaceGeometry.setAttribute("position", surfacePosition);
  surfaceGeometry.setAttribute("color", surfaceColor);
  surfaceGeometry.setAttribute("normal", surfaceNormal);
  for (let i = 0; i < nodes.length; i++)
    positions[i] = nodes[i] - center[i % 3];
  const faceCount = triangles.length / 3,
    faceNormals = new Float32Array(faceCount * 3);
  const attachedFaces = Array.from({ length: nodes.length / 3 }, () => []);
  for (let face = 0; face < faceCount; face++)
    for (let corner = 0; corner < 3; corner++)
      attachedFaces[triangles[face * 3 + corner]].push(face);
  function faceDirections() {
    for (let face = 0; face < faceCount; face++) {
      const p0 = triangles[face * 3] * 3,
        p1 = triangles[face * 3 + 1] * 3,
        p2 = triangles[face * 3 + 2] * 3;
      const ux = positions[p1] - positions[p0],
        uy = positions[p1 + 1] - positions[p0 + 1],
        uz = positions[p1 + 2] - positions[p0 + 2];
      const vx = positions[p2] - positions[p0],
        vy = positions[p2 + 1] - positions[p0 + 1],
        vz = positions[p2 + 2] - positions[p0 + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx,
        length = Math.hypot(nx, ny, nz);
      faceNormals.set([nx / length, ny / length, nz / length], face * 3);
    }
  }
  faceDirections();
  const creaseDot = Math.cos(Math.PI / 4),
    normalGroups = [];
  let sharpCorners = 0;
  for (let corner = 0; corner < triangles.length; corner++) {
    const face = Math.floor(corner / 3),
      node = triangles[corner];
    const similar = attachedFaces[node].filter(
      (other) =>
        faceNormals[face * 3] * faceNormals[other * 3] +
          faceNormals[face * 3 + 1] * faceNormals[other * 3 + 1] +
          faceNormals[face * 3 + 2] * faceNormals[other * 3 + 2] >
        creaseDot,
    );
    normalGroups.push(similar);
    if (similar.length < attachedFaces[node].length) sharpCorners++;
  }
  function updateSurfaceGeometry() {
    faceDirections();
    for (let corner = 0; corner < triangles.length; corner++) {
      const node = triangles[corner];
      renderPositions.set(
        positions.subarray(node * 3, node * 3 + 3),
        corner * 3,
      );
      let nx = 0,
        ny = 0,
        nz = 0;
      for (const face of normalGroups[corner]) {
        nx += faceNormals[face * 3];
        ny += faceNormals[face * 3 + 1];
        nz += faceNormals[face * 3 + 2];
      }
      const length = Math.hypot(nx, ny, nz);
      renderNormals.set([nx / length, ny / length, nz / length], corner * 3);
    }
    surfacePosition.needsUpdate = true;
    surfaceNormal.needsUpdate = true;
  }
  updateSurfaceGeometry();
  const frontMaterial = new THREE.MeshPhongMaterial({
    color: "#ffffff",
    vertexColors: true,
    transparent: false,
    opacity: 1,
    side: THREE.FrontSide,
    depthWrite: true,
    shininess: 45,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const frontSurface = new THREE.Mesh(surfaceGeometry, frontMaterial);
  frontSurface.renderOrder = 2;
  const body = new THREE.Group();
  body.add(frontSurface);
  const linePositions = new Float32Array(edgeIndices.length * 6);
  const lineGeometry = new THREE.BufferGeometry();
  const linePosition = new THREE.BufferAttribute(linePositions, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  lineGeometry.setAttribute("position", linePosition);
  lineGeometry.setDrawRange(0, 0);
  const lineMaterial = new THREE.LineBasicMaterial({
    color: "#8abdeb",
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    depthTest: true,
  });
  const lineObject = new THREE.LineSegments(lineGeometry, lineMaterial);
  lineObject.frustumCulled = false;
  lineObject.renderOrder = 3;
  body.add(lineObject);
  const pulsePositions = new Float32Array(linePositions.length);
  const pulseGeometry = new THREE.BufferGeometry();
  const pulsePosition = new THREE.BufferAttribute(pulsePositions, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  pulseGeometry.setAttribute("position", pulsePosition);
  pulseGeometry.setDrawRange(0, 0);
  const pulseMaterial = new THREE.LineBasicMaterial({
    color: "#d6f6ff",
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pulseObject = new THREE.LineSegments(pulseGeometry, pulseMaterial);
  pulseObject.frustumCulled = false;
  body.add(pulseObject);
  const nodePositions = new Float32Array(nodes.length),
    nodeColors = new Float32Array(nodes.length);
  const nodeGeometry = new THREE.BufferGeometry();
  const nodePosition = new THREE.BufferAttribute(nodePositions, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const nodeColor = new THREE.BufferAttribute(nodeColors, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  nodeGeometry.setAttribute("position", nodePosition);
  nodeGeometry.setAttribute("color", nodeColor);
  nodeGeometry.setDrawRange(0, 0);
  const sprite = document.createElement("canvas");
  sprite.width = 32;
  sprite.height = 32;
  const context = sprite.getContext("2d");
  const radial = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  radial.addColorStop(0, "rgba(255,255,255,1)");
  radial.addColorStop(0.3, "rgba(255,255,255,.75)");
  radial.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = radial;
  context.fillRect(0, 0, 32, 32);
  const nodeTexture = new THREE.CanvasTexture(sprite);
  const nodeMaterial = new THREE.PointsMaterial({
    size: 0.06,
    map: nodeTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const nodeObject = new THREE.Points(nodeGeometry, nodeMaterial);
  nodeObject.frustumCulled = false;
  body.add(nodeObject);
  const originalOrientation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 1, 0),
  );
  const ceilingOrientation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
  );
  body.quaternion.copy(originalOrientation);
  const model = new ModelMobject(body, { scale: metadata.scale });
  const scene = new ThreeDScene(document.querySelector("#scene"), {
    backgroundColor: "#0c1015",
    backgroundOpacity: 0,
    distance: 9.4,
    phi: 1.05,
    theta: -0.65,
    enableOrbitControls: false,
    targetFps: 30,
  });
  scene.add(model);
  const originalCameraUp = scene.camera3D.getCamera().up.clone();
  const ceilingCameraUp = new THREE.Vector3(0, 1, 0);
  frontSurface.renderOrder = 2;
  lineObject.renderOrder = 3;
  pulseObject.renderOrder = 4;
  nodeObject.renderOrder = 5;
  scene.lighting.addDirectional({
    color: "#c9dfff",
    intensity: 1,
    position: [-5, 5, 7],
  });
  scene.lighting.addDirectional({
    color: "#bcd7ff",
    intensity: 0.7,
    position: [5, -3, -7],
  });
  const normalized = (point) => [
    (point[0] - center[0]) * metadata.scale,
    (point[2] - center[2]) * metadata.scale,
    -(point[1] - center[1]) * metadata.scale,
  ];
  const anchor = normalized(solution.loadCentroidMm);
  const forceVector = new THREE.Vector3(
    solution.forceN[0],
    solution.forceN[2],
    -solution.forceN[1],
  ).normalize();
  const forceArrow = new Arrow3D({
    start: anchor,
    end: anchor.map((v, i) => v + forceVector.getComponent(i) * 1.5),
    color: "#ffbb6a",
    tipLength: 0.22,
    tipRadius: 0.1,
    shaftRadius: 0.025,
  });
  scene.add(forceArrow);
  const arrowObject = forceArrow.getThreeObject();
  const arrowMaterials = [];
  arrowObject.traverse((object) => {
    if (object.material) {
      const list = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of list) {
        material.transparent = true;
        material.depthWrite = false;
        material.depthTest = true;
        arrowMaterials.push(material);
      }
    }
  });
  arrowObject.traverse((object) => {
    object.renderOrder = 6;
  });
  const boltArrows = solution.mountingHoleCentersMm.map((hole) => {
    const point = normalized(hole);
    const arrow = new Arrow3D({
      start: [point[0] + 0.48, point[1], point[2]],
      end: [point[0] - 0.65, point[1], point[2]],
      color: "#b4d8f0",
      tipLength: 0.14,
      tipRadius: 0.07,
      shaftRadius: 0.018,
    });
    scene.add(arrow);
    const object = arrow.getThreeObject(),
      materials = [];
    object.traverse((child) => {
      child.renderOrder = 4;
      if (child.material) {
        for (const material of Array.isArray(child.material)
          ? child.material
          : [child.material]) {
          material.transparent = true;
          material.depthWrite = false;
          materials.push(material);
        }
      }
    });
    return { object, materials };
  });
  const palette = [
    "#2856c7",
    "#179ee2",
    "#2dc5b2",
    "#e4dc55",
    "#f59b42",
    "#eb4f4d",
  ].map((color) => new THREE.Color(color));
  const baseColor = new THREE.Color("#b6d0e6");
  const fieldColors = new Float32Array(nodes.length);
  for (let node = 0; node < magnitudes.length; node++) {
    const scaled =
      clamp(magnitudes[node] / solution.maxDisplacementMm) *
      (palette.length - 1);
    const index = Math.min(palette.length - 2, Math.floor(scaled));
    const color = palette[index]
      .clone()
      .lerp(palette[index + 1], scaled - index);
    fieldColors.set([color.r, color.g, color.b], node * 3);
  }
  const count = edgeIndices.length / 2;
  const sceneHost = document.querySelector("#scene");
  let lastContour = -1,
    raf = 0,
    topology = null;
  let topologyReady = false;
  function surface(contour) {
    if (contour !== lastContour) {
      for (let i = 0; i < nodes.length; i += 3) {
        colors[i] = baseColor.r;
        colors[i + 1] = baseColor.g;
        colors[i + 2] = baseColor.b;
      }
      for (let i = 0; i < colors.length; i++)
        colors[i] = colors[i] * (1 - contour) + fieldColors[i] * contour;
      for (let corner = 0; corner < triangles.length; corner++)
        renderColors.set(
          colors.subarray(triangles[corner] * 3, triangles[corner] * 3 + 3),
          corner * 3,
        );
      surfaceColor.needsUpdate = true;
      lastContour = contour;
    }
  }
  function drawEdges(amount) {
    const wave = amount * network.maxDistance;
    let visible = 0,
      completed = 0,
      growing = 0,
      pulses = 0;
    function segment(output, index, fromNode, toNode, head, tail) {
      for (let axis = 0; axis < 3; axis++) {
        const origin = positions[fromNode * 3 + axis],
          delta = positions[toNode * 3 + axis] - origin;
        output[index * 6 + axis] = origin + delta * head;
        output[index * 6 + 3 + axis] = origin + delta * tail;
      }
    }
    for (let edge = 0; edge < count; edge++) {
      const nodeA = edgeIndices[edge * 2],
        nodeB = edgeIndices[edge * 2 + 1],
        length = edgeLengths[edge];
      const fromA = clamp((wave - arrival[nodeA]) / length),
        fromB = clamp((wave - arrival[nodeB]) / length);
      if (fromA + fromB <= 0) continue;
      if (fromA + fromB >= 1 - 1e-5) {
        segment(linePositions, visible++, nodeA, nodeB, 0, 1);
        completed++;
      } else {
        growing++;
        if (fromA > 0) {
          segment(linePositions, visible++, nodeA, nodeB, 0, fromA);
          segment(
            pulsePositions,
            pulses++,
            nodeA,
            nodeB,
            Math.max(0, fromA - 0.22),
            fromA,
          );
        }
        if (fromB > 0) {
          segment(linePositions, visible++, nodeB, nodeA, 0, fromB);
          segment(
            pulsePositions,
            pulses++,
            nodeB,
            nodeA,
            Math.max(0, fromB - 0.22),
            fromB,
          );
        }
      }
    }
    let glowing = 0;
    if (amount > 0 && amount < 1 && !reduced.matches) {
      for (let node = 0; node < arrival.length; node++) {
        const age = wave - arrival[node];
        if (arrival[node] < 0 || age < 0 || age > 3) continue;
        const strength = 1 - age / 3;
        nodePositions.set(
          positions.subarray(node * 3, node * 3 + 3),
          glowing * 3,
        );
        nodeColors.set([0.6 * strength, 0.9 * strength, strength], glowing * 3);
        glowing++;
      }
    }
    linePosition.needsUpdate = true;
    lineGeometry.setDrawRange(0, visible * 2);
    lineObject.visible = visible > 0;
    pulsePosition.needsUpdate = true;
    pulseGeometry.setDrawRange(0, pulses * 2);
    pulseObject.visible = pulses > 0 && !reduced.matches;
    nodePosition.needsUpdate = true;
    nodeColor.needsUpdate = true;
    nodeGeometry.setDrawRange(0, glowing);
    nodeObject.visible = glowing > 0;
    sceneHost.dataset.drawnEdges = String(completed);
    sceneHost.dataset.growingEdges = String(growing);
    sceneHost.dataset.networkSeed = String(network.seedNode);
  }
  function copy(element, opacity) {
    element.style.opacity = String(opacity);
    element.setAttribute("aria-hidden", String(opacity < 0.05));
    // The hero holds links: once faded out they must leave the tab order.
    element.inert = opacity < 0.05;
  }
  const yaw = -0.65,
    phi = 1.05;
  const originalFrame = new THREE.PerspectiveCamera();
  originalFrame.position.set(
    Math.sin(phi) * Math.cos(yaw),
    Math.sin(phi) * Math.sin(yaw),
    Math.cos(phi),
  );
  originalFrame.up.copy(originalCameraUp);
  originalFrame.lookAt(0, 0, 0);
  const viewRotation = originalFrame.quaternion;
  const finalFrame = new THREE.PerspectiveCamera();
  const finalYaw = -2.48,
    elevation = 0.255;
  finalFrame.position.set(
    Math.cos(elevation) * Math.sin(finalYaw),
    -Math.sin(elevation),
    Math.cos(elevation) * Math.cos(finalYaw),
  );
  finalFrame.up.copy(ceilingCameraUp);
  finalFrame.lookAt(0, 0, 0);
  const startView = finalFrame.quaternion
    .clone()
    .invert()
    .multiply(ceilingOrientation);
  startView.premultiply(
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI,
    ),
  );
  const quarterTurn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -Math.PI / 2,
  );
  const verticalAxis = new THREE.Vector3(0, 1, 0);
  const topologyPlaceholder = {
    busy: false,
    renderedProgress: -1,
    triangles: 0,
    elapsedMs: 0,
    metadata: { elements: 0 },
  };
  function updateCopy(progress, still) {
    const introFade = smooth((progress - 0.06) / 0.09),
      next = smooth((progress - 0.53) / 0.08),
      meshExit = curve((progress - 0.38) / 0.1);
    copy(intro, 1 - introFade);
    copy(meshCopy, introFade * (1 - meshExit));
    copy(analysisCopy, next);
    intro.style.translate = `0 ${still ? 0 : -introFade * 28}px`;
    meshCopy.style.translate = `0 ${still ? 0 : (1 - introFade - meshExit) * 28}px`;
    analysisCopy.style.translate = `0 ${still ? 0 : (1 - next) * 28}px`;
    return introFade;
  }
  function poseBody(rotationDegrees) {
    const verticalRotation = new THREE.Quaternion().setFromAxisAngle(
      verticalAxis,
      (rotationDegrees * Math.PI) / 180,
    );
    body.quaternion
      .copy(viewRotation)
      .multiply(verticalRotation)
      .multiply(startView)
      .multiply(quarterTurn);
    body.position.set(0, 0, 0);
    const bodyShift = body.position.clone().multiplyScalar(metadata.scale);
    const sceneAlignment = body.quaternion
      .clone()
      .multiply(originalOrientation.clone().invert());
    for (const bolt of boltArrows) {
      bolt.object.quaternion.copy(sceneAlignment);
      bolt.object.position.copy(bodyShift);
    }
    arrowObject.quaternion.copy(sceneAlignment);
    arrowObject.position.copy(bodyShift);
  }
  // In the stacked layout the hero fills the top of the screen, so the bracket
  // first waits between it and the scroll cue, then rises to its own place as
  // the hero fades out.
  function stackedVertical(canvasHeight, heroShown) {
    const rest = 0.68;
    const heroBottom = intro.offsetTop + intro.offsetHeight;
    const waiting = Math.min(
      0.95,
      Math.max(rest, (heroBottom + bottomLine.offsetTop) / 2 / canvasHeight),
    );
    return rest + (waiting - rest) * heroShown;
  }
  function frameCamera(orientation, heroShown) {
    const canvasDistance = 9.4 / (stacked.matches ? 0.54 : 0.81);
    const cameraPosition = new THREE.Vector3(
      0,
      0,
      canvasDistance,
    ).applyQuaternion(viewRotation);
    scene.camera3D.moveTo([
      cameraPosition.x,
      cameraPosition.y,
      cameraPosition.z,
    ]);
    scene.camera3D.getCamera().quaternion.copy(viewRotation);
    const canvasWidth = sceneHost.clientWidth,
      canvasHeight = sceneHost.clientHeight;
    const horizontal = stacked.matches ? 0.5 : 0.7 - orientation * 0.4;
    const vertical = stacked.matches
      ? stackedVertical(canvasHeight, heroShown)
      : 0.505;
    scene.camera3D
      .getCamera()
      .setViewOffset(
        canvasWidth,
        canvasHeight,
        (0.5 - horizontal) * canvasWidth,
        (0.5 - vertical) * canvasHeight,
        canvasWidth,
        canvasHeight,
      );
    return { cameraPosition, vertical };
  }
  function fadeAnnotations(mounted, load, overallProgress) {
    const annotationFade = 1 - curve((overallProgress - 0.76) / 0.08);
    for (const bolt of boltArrows) {
      bolt.object.visible = mounted * annotationFade > 0;
      for (const material of bolt.materials)
        material.opacity = mounted * 0.9 * annotationFade;
    }
    arrowObject.visible = load * annotationFade > 0;
    for (const material of arrowMaterials)
      material.opacity = load * annotationFade;
  }
  function publishState(state) {
    const shownTopology = topology ?? topologyPlaceholder;
    const data = sceneHost.dataset;
    data.progress = state.overallProgress.toFixed(3);
    data.optimization = state.topologyProgress.toFixed(3);
    data.optimizationPlayback = state.optimizationPlayback.toFixed(3);
    data.topologyReady = String(topologyReady);
    data.iteration = String(state.topologyState.iteration);
    data.retainedElements = String(state.topologyState.retained);
    data.edgeDrawProgress = state.edges.toFixed(3);
    data.deformation = "0.000";
    data.contour = state.shownContour.toFixed(3);
    data.mounting = "horizontal";
    data.rotationAxis = "vertical";
    data.rotationDegrees = String(state.rotationDegrees);
    data.optimizationRotationDegrees = String(360 * state.optimizationTurn);
    data.frontLiftDegrees = "0";
    data.poseQuaternion = body.quaternion.toArray().join(",");
    data.ceilingTurn = state.turn.toFixed(3);
    data.boltDirection = "up";
    data.boltArrows = String(boltArrows.length);
    data.mounted = state.mounted.toFixed(3);
    data.loadDirection = `source-positive-${loadAxis.toLowerCase()}`;
    data.support = "hole-bores-only";
    data.torsionNm = String(solution.momentNmm[0] / 1000);
    data.initialScreenRotation = "180";
    data.cameraRadius = state.cameraPosition.length().toFixed(4);
    data.bracketVertical = state.vertical.toFixed(3);
    data.networkPropagation = "connected";
    data.transparency = "0";
    data.sharpCorners = String(sharpCorners);
    data.ceilingPlane = "removed";
    data.surfaceBusy = String(shownTopology.busy);
    data.surfaceProgress = String(shownTopology.renderedProgress);
    data.surfaceTriangles = String(shownTopology.triangles);
    data.surfaceComputeMs = String(shownTopology.elapsedMs);
    data.topologyRendering = "smooth-isosurface";
    data.optimizationElements = String(shownTopology.metadata.elements);
    data.bodyOpacity = frontMaterial.opacity.toFixed(2);
    data.turn = state.turn.toFixed(3);
    data.force = state.load.toFixed(3);
  }
  function update() {
    raf = 0;
    const distance = scrollViewport.scrollHeight - scrollViewport.clientHeight;
    const overallProgress = clamp(
      scrollViewport.scrollTop / Math.max(1, distance),
    );
    const progress = clamp(overallProgress / 0.7),
      relax = curve((overallProgress - 0.7) / 0.06),
      topologyProgress = clamp((overallProgress - 0.76) / 0.24);
    const optimizationPlayback = clamp(curve(topologyProgress) / 0.8);
    const edges = clamp((progress - 0.12) / 0.24),
      turn = curve((progress - 0.38) / 0.24);
    const mounted = smooth((progress - 0.62) / 0.06),
      load = smooth((progress - 0.62) / 0.08),
      contour = smooth((progress - 0.72) / 0.08);
    const still = reduced.matches;
    const introFade = updateCopy(progress, still);
    const shownContour = contour * (1 - relax);
    surface(shownContour);
    drawEdges(edges);
    const optimizing = overallProgress >= 0.76;
    frontSurface.visible = !optimizing || !topologyReady;
    const topologyState = topology
      ? topology.update(optimizationPlayback, optimizing)
      : { iteration: 0, retained: solution.tetrahedra };
    frontMaterial.opacity = 1;
    frontMaterial.transparent = false;
    frontMaterial.depthWrite = true;
    lineMaterial.opacity = (0.6 - 0.35 * shownContour) * (1 - relax);
    lineMaterial.depthWrite = false;
    const orientation = still ? Number(progress >= 0.62) : turn;
    const optimizationTurn = still ? 0 : curve(topologyProgress);
    const rotationDegrees = 90 * orientation + 360 * optimizationTurn;
    poseBody(rotationDegrees);
    const { cameraPosition, vertical } = frameCamera(
      orientation,
      still ? Number(introFade < 0.5) : 1 - introFade,
    );
    fadeAnnotations(mounted, load, overallProgress);
    transitionAnalysis(
      still ? Number(progress >= 0.81) : smooth((progress - 0.81) / 0.06),
      still ? Number(optimizing) : smooth((overallProgress - 0.76) / 0.035),
      still,
    );
    progressBar.style.transform = `scaleX(${overallProgress})`;
    publishState({
      overallProgress,
      topologyProgress,
      optimizationPlayback,
      topologyState,
      edges,
      shownContour,
      rotationDegrees,
      optimizationTurn,
      turn,
      mounted,
      load,
      cameraPosition,
      vertical,
    });
    scene.render();
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(update);
  }
  scrollViewport.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  document.querySelectorAll('a[href^="#"]').forEach((link) =>
    link.addEventListener("click", (event) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (!target || (!track.contains(target) && target !== track)) return;
      event.preventDefault();
      scrollViewport.scrollTo({
        top: target === track ? 0 : target.offsetTop,
        behavior: reduced.matches ? "instant" : "smooth",
      });
    }),
  );
  document.addEventListener(
    "wheel",
    (event) => {
      if (
        event.ctrlKey ||
        event.deltaY === 0 ||
        scrollViewport.contains(event.target)
      )
        return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? scrollViewport.clientHeight
            : 1;
      scrollViewport.scrollBy({
        top: event.deltaY * unit,
        behavior: "instant",
      });
    },
    { passive: false },
  );
  // A swipe that starts on a hero link or the navigation is outside the scroll
  // viewport too; pan it by hand, as the wheel handler does.
  let touchY = null;
  document.addEventListener(
    "touchstart",
    (event) => {
      touchY =
        event.touches.length === 1 && !scrollViewport.contains(event.target)
          ? event.touches[0].clientY
          : null;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (touchY === null || event.touches.length !== 1) return;
      const y = event.touches[0].clientY;
      scrollViewport.scrollBy({ top: touchY - y, behavior: "instant" });
      touchY = y;
    },
    { passive: true },
  );
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.target.closest("input,textarea,select,button,[contenteditable]")
    )
      return;
    const page = scrollViewport.clientHeight * 0.85;
    const steps = {
      ArrowDown: 60,
      ArrowUp: -60,
      PageDown: page,
      PageUp: -page,
    };
    if (event.key === " " && event.target.closest("a")) return;
    if (event.key in steps || event.key === " ") {
      event.preventDefault();
      scrollViewport.scrollBy({
        top:
          event.key === " "
            ? event.shiftKey
              ? -page
              : page
            : steps[event.key],
        behavior: reduced.matches ? "instant" : "smooth",
      });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      scrollViewport.scrollTo({
        top: event.key === "Home" ? 0 : scrollViewport.scrollHeight,
        behavior: reduced.matches ? "instant" : "smooth",
      });
    }
  });
  reduced.addEventListener("change", schedule);
  stacked.addEventListener("change", schedule);
  const observer = new ResizeObserver(schedule);
  observer.observe(sceneHost);
  status.hidden = true;
  sceneHost.dataset.loaded = "true";
  sceneHost.dataset.meshSource = solution.generator;
  sceneHost.dataset.solver = solution.solver;
  update();
  topologySource
    .then((source) => createTopology(THREE, body, baseColor, schedule, source))
    .then((sequence) => {
      topology = sequence;
      topologyReady = true;
      schedule();
    })
    .catch((error) => {
      status.hidden = false;
      status.textContent = `Optimization could not load: ${error.message}`;
      console.error(error);
    });
  window.addEventListener("pagehide", (event) => {
    // A persisted page is frozen in the back-forward cache and restored as-is,
    // without start() running again, so it must keep its scene.
    if (event.persisted) return;
    cancelAnimationFrame(raf);
    observer.disconnect();
    if (topology) topology.dispose();
    scene.dispose();
    surfaceGeometry.dispose();
    lineGeometry.dispose();
    frontMaterial.dispose();
    lineMaterial.dispose();
    pulseGeometry.dispose();
    pulseMaterial.dispose();
    nodeGeometry.dispose();
    nodeMaterial.dispose();
    nodeTexture.dispose();
  });
}
start().catch((error) => {
  status.hidden = false;
  status.textContent = `Could not load the bracket: ${error.message}`;
  console.error(error);
});
