// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Interactive result viewers in the Theory Guide and on the example pages.
// Each <figure class="result-viewer" data-viewer="…json"> starts with the
// solved model's static figure; once the page has loaded and the figure
// scrolls near, this script loads three.js (self-hosted under /vendor/three/,
// mapped by the page's import map) and the solved surface, and replaces the
// image with a model to rotate and zoom. Without JavaScript or WebGL, the
// static figure simply stays.
//
// Two payloads: a Theory model's, with one field (`values`, `field`, `unit`,
// `min`, `max`, `edges`), and an example page's (examples/validation/lib/
// viewer.mjs), with several `fields` to switch between. A figure with
// data-aspect gets a canvas of those proportions, so the view takes the
// figure's place without moving the page; elements with data-legend="min",
// "max" and "name" in the figure follow the field shown.

import { sectionMesh } from "/theory/section.js";

const figures = [
  ...document.querySelectorAll("figure.result-viewer[data-viewer]"),
];

/** The app's contour colour (blue → red), as in MeshScene. */
function contour(THREE, t, out) {
  return out.setHSL(0.667 * (1 - Math.min(1, Math.max(0, t))), 1, 0.5);
}

/** The boundary's element edges, each once, as vertex pairs. */
function edgesOf(triangles) {
  const edges = new Set();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  return [...edges].flatMap((key) => key.split(",").map(Number));
}

function rangeOf(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * The payload with what the scene reads filled in, and its fields: an
 * example's several, or a Theory model's one.
 */
function normalised(payload) {
  const data = {
    ...payload,
    deformScale: payload.deformScale ?? 0,
    displacements: payload.displacements ?? payload.positions.map(() => 0),
    edges: payload.edges ?? edgesOf(payload.triangles),
  };
  const fields = payload.fields
    ? payload.fields.map((f) => ({ ...f, ...rangeOf(f.values) }))
    : [
        {
          key: payload.field,
          name: payload.field,
          unit: payload.unit,
          values: payload.values,
          min: payload.min,
          max: payload.max,
        },
      ];
  return { data, fields };
}

/** A legend value as the pages print it: three digits, a true minus. */
function legendValue(value, unit) {
  const digits = value.toPrecision(3).replace(/^-/, "\u2212");
  return unit ? `${digits}\u00a0${unit}` : digits;
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
  return { group };
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

/**
 * What the camera frames, and from how far it sees all of it through the
 * vertical half-angle `halfFov` at a given aspect: the box of half-width
 * `half` about the view's `target` (as a focused static figure does), or else
 * every point of the deformed model, looking along `view` at the centre of
 * its extent.
 */
function framing(THREE, data, view, up, halfFov) {
  const MARGIN = 1.04;
  const tan = Math.tan(halfFov);
  if (data.view?.target) {
    const half = data.view.half;
    return {
      center: new THREE.Vector3(...data.view.target),
      distance: (aspect) => half / (tan * aspect),
    };
  }
  const points = deformed(data);
  const right = new THREE.Vector3().crossVectors(view, up).normalize();
  const upward = new THREE.Vector3().crossVectors(right, view).normalize();
  const axes = [right, upward, view];
  const local = new Float64Array(points.length);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const p = new THREE.Vector3();
  for (let i = 0; i < points.length; i += 3) {
    p.set(points[i], points[i + 1], points[i + 2]);
    axes.forEach((axis, k) => {
      const s = p.dot(axis);
      local[i + k] = s;
      lo[k] = Math.min(lo[k], s);
      hi[k] = Math.max(hi[k], s);
    });
  }
  const mid = axes.map((_, k) => (lo[k] + hi[k]) / 2);
  const center = new THREE.Vector3()
    .addScaledVector(right, mid[0])
    .addScaledVector(upward, mid[1])
    .addScaledVector(view, mid[2]);
  // A point (x, y) off the axis and z beyond the centre is in the picture
  // from distance d when |x| ≤ (d + z)·tan·aspect and |y| ≤ (d + z)·tan.
  return {
    center,
    distance: (aspect) => {
      let d = 0;
      for (let i = 0; i < local.length; i += 3) {
        const x = Math.abs(local[i] - mid[0]) * MARGIN;
        const y = Math.abs(local[i + 1] - mid[1]) * MARGIN;
        const z = local[i + 2] - mid[2];
        d = Math.max(d, x / (tan * aspect) - z, y / tan - z);
      }
      return d;
    },
  };
}

async function mount(figure, THREE, OrbitControls) {
  const response = await fetch(figure.dataset.viewer);
  if (!response.ok)
    throw new Error(`${figure.dataset.viewer}: HTTP ${response.status}`);
  const { data, fields } = normalised(await response.json());
  let field = fields[0];
  const shown = () => ({
    ...data,
    values: field.values,
    min: field.min,
    max: field.max,
  });
  const stage = figure.querySelector(".viewer-stage");
  const image = stage.querySelector("img");

  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", image.alt);
  if (figure.dataset.aspect) canvas.style.aspectRatio = figure.dataset.aspect;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
  } catch {
    figure.dataset.ready = "no-webgl";
    return; // No WebGL: keep the static figure.
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  let section = data.section ? { ...data.section } : null;
  let { group } = buildScene(THREE, shown(), section);
  scene.add(group);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  scene.add(key);

  // The canvas's proportions as laid out: the figure's, or 16 : 10.
  const [w, h] = (figure.dataset.aspect ?? "16 / 10").split("/").map(Number);
  const camera = new THREE.PerspectiveCamera(30, w / h, 1, 10);
  // The payload's view (that of its static figure), or the app's opening
  // view: looking along (−0.55, −0.5, −1), y up.
  const view = new THREE.Vector3(
    ...(data.view?.direction ?? [-0.55, -0.5, -1]),
  ).normalize();
  if (data.view?.up) camera.up.set(...data.view.up);
  // The camera frames the whole model, whatever a section shows.
  const halfFov = (camera.fov * Math.PI) / 360;
  const frame = framing(THREE, data, view, camera.up, halfFov);
  const center = frame.center;
  const distance = frame.distance(camera.aspect);
  camera.near = distance * 0.01;
  camera.far = distance * 100;
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
  // On touch screens a vertical swipe scrolls the page; a sideways drag
  // rotates and two fingers zoom.
  canvas.style.touchAction = "pan-y";
  controls.enablePan = false;
  // Wheel zoom only after the reader clicks the model, so scrolling the
  // page past a viewer never zooms it by accident.
  controls.enableZoom = false;
  canvas.addEventListener("pointerdown", () => (controls.enableZoom = true));
  canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") controls.enableZoom = false;
  });

  const render = () => renderer.render(scene, camera);
  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the whole model in view at any proportions.
    camera.zoom = Math.min(1, distance / frame.distance(camera.aspect));
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
    hint.textContent = window.matchMedia("(pointer: coarse)").matches
      ? "Drag sideways to rotate · pinch to zoom"
      : "Drag to rotate · click, then scroll to zoom";
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

  const redraw = () => {
    scene.remove(group);
    ({ group } = buildScene(THREE, shown(), section));
    scene.add(group);
    render();
  };
  // The field control sits on the model, so the page does not move when the
  // view replaces the figure.
  if (fields.length > 1)
    stage.append(
      fieldControl(figure, fields, (next) => {
        field = next;
        relabel(figure, field);
        redraw();
      }),
    );
  if (data.tets) {
    stage.after(
      sectionControls(data, section, (next) => {
        section = next;
        redraw();
      }),
    );
  }
  figure.dataset.ready = "";
}

/** The colour bar and field name of a figure, for the field shown. */
function relabel(figure, field) {
  const set = (name, text) => {
    for (const el of figure.querySelectorAll(`[data-legend="${name}"]`))
      el.textContent = text;
  };
  set("min", legendValue(field.min, field.unit));
  set("max", legendValue(field.max, field.unit));
  set("name", field.name);
}

/** The field control: which of an example's solved fields colours it. */
function fieldControl(figure, fields, onChange) {
  const box = document.createElement("div");
  box.className = "viewer-field";
  const id = `${figure.dataset.viewer.replace(/\W+/g, "-")}-field`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = "Field";
  const select = document.createElement("select");
  select.id = id;
  for (const f of fields) select.add(new Option(f.name, f.key));
  select.addEventListener("change", () =>
    onChange(fields.find((f) => f.key === select.value)),
  );
  box.append(label, select);
  return box;
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
  const observe = () => {
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
  };
  // After the page and its figures have loaded, so the view never holds up
  // the text or the static figure.
  if (document.readyState === "complete") observe();
  else window.addEventListener("load", observe, { once: true });
}
