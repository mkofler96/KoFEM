// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Interactive result viewers in the Theory Guide. Each
// <figure class="result-viewer" data-viewer="…json"> starts with the solved
// example's static figure; when it scrolls near, this script loads three.js
// (self-hosted under /vendor/three/, mapped by the page's import map) and the
// extracted surface, and replaces the image with a model to rotate.
// Without JavaScript or WebGL, the static figure simply stays.

const figures = [
  ...document.querySelectorAll("figure.result-viewer[data-viewer]"),
];

/** The app's contour colour (blue → red), as in MeshScene. */
function contour(THREE, t, out) {
  return out.setHSL(0.667 * (1 - Math.min(1, Math.max(0, t))), 1, 0.5);
}

function buildScene(THREE, data) {
  const n = data.values.length;
  const position = new Float32Array(3 * n);
  const colour = new Float32Array(3 * n);
  const range = data.max - data.min || 1;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++)
      position[3 * i + k] =
        data.positions[3 * i + k] +
        data.deformScale * data.displacements[3 * i + k];
    contour(THREE, (data.values[i] - data.min) / range, c);
    colour[3 * i] = c.r;
    colour[3 * i + 1] = c.g;
    colour[3 * i + 2] = c.b;
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.BufferAttribute(position, 3));
  surface.setAttribute("color", new THREE.BufferAttribute(colour, 3));
  surface.setIndex(data.triangles);
  surface.computeVertexNormals();
  surface.computeBoundingSphere();

  const edges = new THREE.BufferGeometry();
  edges.setAttribute("position", new THREE.BufferAttribute(position, 3));
  edges.setIndex(data.edges);

  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      surface,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    ),
    new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0x16263d,
        transparent: true,
        opacity: 0.35,
      }),
    ),
  );
  return { group, sphere: surface.boundingSphere };
}

async function mount(figure, THREE, OrbitControls) {
  const response = await fetch(figure.dataset.viewer);
  if (!response.ok)
    throw new Error(`${figure.dataset.viewer}: HTTP ${response.status}`);
  const data = await response.json();
  const stage = figure.querySelector(".viewer-stage");
  const image = stage.querySelector("img");

  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", image.alt);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
  } catch {
    return; // No WebGL: keep the static figure.
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const { group, sphere } = buildScene(THREE, data);
  scene.add(group);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(30, 1.6, 1, 10);
  const radius = sphere.radius || 1;
  camera.near = radius * 0.01;
  camera.far = radius * 100;
  // The app's opening view: looking along (−0.55, −0.5, −1), y up.
  const view = new THREE.Vector3(-0.55, -0.5, -1).normalize();
  const home = sphere.center
    .clone()
    .addScaledVector(
      view,
      (-0.85 * radius) / Math.sin((camera.fov * Math.PI) / 360),
    );
  camera.position.copy(home);
  camera.lookAt(sphere.center);
  // Light from over the viewer's shoulder.
  camera.add(key);
  key.position.set(1, 1.2, 0.5);
  scene.add(camera);

  // The constructor aims the camera at the origin; re-aim it at the model.
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(sphere.center);
  controls.update();
  // On touch screens a vertical swipe scrolls the page; a sideways drag rotates.
  canvas.style.touchAction = "pan-y";
  controls.enablePan = false;
  // Wheel zoom only after the reader clicks the model, so scrolling the
  // page past a viewer never zooms it by accident.
  controls.enableZoom = false;
  canvas.addEventListener("pointerdown", () => (controls.enableZoom = true));
  canvas.addEventListener("pointerleave", () => (controls.enableZoom = false));

  const render = () => renderer.render(scene, camera);
  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the whole model in view at narrow widths.
    const fit = Math.max(1, 1.6 / camera.aspect);
    camera.zoom = 1 / fit;
    camera.updateProjectionMatrix();
    render();
  };
  controls.addEventListener("change", render);

  image.hidden = true;
  stage.prepend(canvas);
  new ResizeObserver(resize).observe(canvas);
  resize();

  const hint = stage.querySelector(".viewer-hint");
  if (hint) {
    hint.hidden = false;
    hint.textContent = "Drag to rotate · click, then scroll to zoom";
  }
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "viewer-reset";
  reset.textContent = "Reset view";
  reset.addEventListener("click", () => {
    camera.position.copy(home);
    controls.target.copy(sphere.center);
    controls.update();
    render();
  });
  stage.append(reset);
}

if (figures.length) {
  let library;
  const load = () =>
    (library ??= Promise.all([
      import("three"),
      import("three/addons/controls/OrbitControls.js"),
    ]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        load()
          .then(([THREE, { OrbitControls }]) =>
            mount(entry.target, THREE, OrbitControls),
          )
          .catch((error) => {
            // The static figure remains; report for developers only.
            console.error("Theory viewer unavailable:", error);
          });
      }
    },
    { rootMargin: "300px 0px" },
  );
  for (const figure of figures) observer.observe(figure);
}
