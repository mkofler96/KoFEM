// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Interactive result viewers in the Theory Guide. Each
// <figure class="result-viewer" data-viewer="…json"> starts with the solved
// example's static figure; when it scrolls near, this script loads three.js
// (self-hosted under /vendor/three/, mapped by the page's import map) and the
// extracted surface, and replaces the image with a model to rotate.
// Without JavaScript or WebGL, the static figure simply stays.

import { sectionMesh } from "/theory/section.js";

const figures = [
  ...document.querySelectorAll("figure.result-viewer[data-viewer]"),
];

/** The app's contour colour (blue → red), as in MeshScene. */
function contour(THREE, t, out) {
  return out.setHSL(0.667 * (1 - Math.min(1, Math.max(0, t))), 1, 0.5);
}

/** Deformed vertex positions: undeformed plus enlarged displacement. */
function deformed(data) {
  return data.positions.map(
    (value, i) => value + data.deformScale * data.displacements[i],
  );
}

/**
 * The drawn surface: the whole boundary, or — with a section — the part
 * below the cut plane closed by its cap (section.js), in deformed space.
 */
function surfaceMesh(data, points, section) {
  if (!section) {
    return {
      positions: points,
      values: data.values,
      triangles: data.triangles,
    };
  }
  return sectionMesh(
    {
      positions: points,
      values: data.values,
      triangles: data.triangles,
      tets: data.tets,
    },
    section.axis,
    section.level,
  );
}

function buildScene(THREE, data, section) {
  const points = deformed(data);
  const mesh = surfaceMesh(data, points, section);
  const n = mesh.values.length;
  const colour = new Float32Array(3 * n);
  const range = data.max - data.min || 1;
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    contour(THREE, (mesh.values[i] - data.min) / range, c);
    colour[3 * i] = c.r;
    colour[3 * i + 1] = c.g;
    colour[3 * i + 2] = c.b;
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3),
  );
  surface.setAttribute("color", new THREE.BufferAttribute(colour, 3));
  surface.setIndex(mesh.triangles);
  surface.computeVertexNormals();
  surface.computeBoundingSphere();

  // Element edges of the boundary; with a section, those below the plane.
  const below = (v) =>
    !section || points[3 * v + section.axis] <= section.level;
  const edgeIndex = [];
  for (let k = 0; k < data.edges.length; k += 2)
    if (below(data.edges[k]) && below(data.edges[k + 1]))
      edgeIndex.push(data.edges[k], data.edges[k + 1]);
  const edges = new THREE.BufferGeometry();
  edges.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(points), 3),
  );
  edges.setIndex(edgeIndex);

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
  if (data.spider) group.add(spider(THREE, data, points, below));
  return { group, sphere: surface.boundingSphere };
}

/**
 * A coupling's legs: its reference point joined to the nodes it couples, on
 * the side a section keeps. A view framed about a target draws the point at
 * a size for that frame; otherwise it is 1 model unit across.
 */
function spider(THREE, data, points, kept) {
  const { origin, originDisplacement, targets } = data.spider;
  const from = origin.map(
    (v, k) => v + data.deformScale * originDisplacement[k],
  );
  const legs = targets
    .filter(kept)
    .flatMap((t) => [
      ...from,
      points[3 * t],
      points[3 * t + 1],
      points[3 * t + 2],
    ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(legs), 3),
  );
  const group = new THREE.Group();
  group.add(
    new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x16a34a }),
    ),
  );
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x15803d }),
  );
  marker.position.set(...from);
  if (data.view?.target) marker.scale.setScalar(0.025 * data.view.half);
  group.add(marker);
  return group;
}

/** The extent of the deformed model along each axis. */
function bounds(data) {
  const points = deformed(data);
  return [0, 1, 2].map((axis) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = axis; i < points.length; i += 3) {
      lo = Math.min(lo, points[i]);
      hi = Math.max(hi, points[i]);
    }
    return [lo, hi];
  });
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
  let section = data.section ? { ...data.section } : null;
  let { group, sphere } = buildScene(THREE, data, section);
  // The camera frames the whole model, whatever the section shows.
  if (section) sphere = buildScene(THREE, data, null).sphere;
  scene.add(group);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(30, 1.6, 1, 10);
  const radius = sphere.radius || 1;
  camera.near = radius * 0.01;
  camera.far = radius * 100;
  // The payload's view (that of its static figure), or the app's opening
  // view: looking along (−0.55, −0.5, −1), y up.
  const view = new THREE.Vector3(
    ...(data.view?.direction ?? [-0.55, -0.5, -1]),
  ).normalize();
  if (data.view?.up) camera.up.set(...data.view.up);
  // A Theory model's own view says what to frame: a box of half-width `half`
  // about `target` (as its static figure does), or the whole model, `fit`
  // times as tight.
  const center = data.view?.target
    ? new THREE.Vector3(...data.view.target)
    : sphere.center;
  const halfFov = (camera.fov * Math.PI) / 360;
  const distance = data.view?.target
    ? data.view.half / (Math.tan(halfFov) * camera.aspect)
    : ((data.view?.fit ?? 0.85) * radius) / Math.sin(halfFov);
  const home = center.clone().addScaledVector(view, -distance);
  camera.position.copy(home);
  camera.lookAt(center);
  // Light from over the viewer's shoulder.
  camera.add(key);
  key.position.set(1, 1.2, 0.5);
  scene.add(camera);

  // The constructor aims the camera at the origin; re-aim it at the model.
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
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
    controls.target.copy(center);
    controls.update();
    render();
  });
  stage.append(reset);

  if (data.tets) {
    figure.querySelector(".viewer-stage").after(
      sectionControls(data, section, (next) => {
        section = next;
        scene.remove(group);
        ({ group } = buildScene(THREE, data, section));
        scene.add(group);
        render();
      }),
    );
  }
}

const AXES = ["x", "y", "z"];

/**
 * The section control: an axis (or off) and the plane's position along it,
 * over the deformed model's extent.
 */
function sectionControls(data, initial, onChange) {
  const extent = bounds(data);
  const box = document.createElement("div");
  box.className = "viewer-section";
  const id = `${data.id}-section`;
  box.innerHTML = `<label for="${id}">Section</label>
    <select id="${id}"><option value="off">Off</option>${AXES.map(
      (name, axis) => `<option value="${axis}">Cut along ${name}</option>`,
    ).join("")}</select>
    <input type="range" aria-label="Section position" min="0" max="1000" step="1" />`;
  const select = box.querySelector("select");
  const slider = box.querySelector("input");
  const levelOf = (axis) => {
    const [lo, hi] = extent[axis];
    return lo + (Number(slider.value) / 1000) * (hi - lo);
  };
  const sliderOf = (axis, level) => {
    const [lo, hi] = extent[axis];
    return String(Math.round((1000 * (level - lo)) / (hi - lo)));
  };
  select.value = initial ? String(initial.axis) : "off";
  slider.value = initial ? sliderOf(initial.axis, initial.level) : "500";
  slider.disabled = !initial;
  const update = () => {
    if (select.value === "off") {
      slider.disabled = true;
      onChange(null);
      return;
    }
    slider.disabled = false;
    const axis = Number(select.value);
    onChange({ axis, level: levelOf(axis) });
  };
  select.addEventListener("change", update);
  slider.addEventListener("input", update);
  return box;
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
