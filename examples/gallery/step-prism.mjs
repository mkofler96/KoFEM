// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal STEP (AP214) writers for the plain stock a user imports into the app:
//
//   prismStep            a simple polygon in the xy plane extruded along +z.
//   extrudedProfileStep  an outer loop with holes, each loop made of straight
//                        lines and circular arcs (full circles allowed),
//                        extruded along +z.
//   annulusStep, plateWithHoleStep, quarterStripWithHoleStep
//                        the curved stock the examples use, built on the above.
//
// Every line or arc of a loop becomes its own side face, so a user can pick one
// straight side, or the whole hole surface, as one CAD face. The end caps are
// one face each (holes are inner bounds of the caps). Gallery support and load
// pads are cut afterwards with the app's split tool (split_geometry), as a user
// cuts them, not baked into the profile. The B-rep uses LINE and CIRCLE edge
// curves on PLANE and CYLINDRICAL_SURFACE faces; OCCT rebuilds the p-curves on
// import. A full circle is one closed edge; its cylindrical face carries the
// usual seam edge (used twice in its loop), at the circle's start point.
//
// Face order — and so the 1-based CAD face id OCCT gives each face on import —
// is: the side faces of the outer loop in segment order, then the side faces of
// each hole in segment order, then the bottom cap (z = 0), then the top cap
// (z = depth). Generators should still pick faces by a point on them, as a user
// clicks them; examples/gallery/step-prism.test.mjs checks this order.

/**
 * The entity table shared by the writers: `add` appends one entity and returns
 * its id; `point` and `dir` write a CARTESIAN_POINT / DIRECTION with `num`.
 *
 * @param {(v: number) => string} num  how a real is written
 */
function stepEntities(num) {
  /** @type {string[]} */
  const lines = [];
  let next = 1;
  /** @param {string} entity */
  const add = (entity) => {
    const id = next++;
    lines.push(`#${id} = ${entity};`);
    return id;
  };
  /** @param {number[]} p */
  const point = (p) => add(`CARTESIAN_POINT('',(${p.map(num).join(",")}))`);
  /** @param {number[]} d */
  const dir = (d) => add(`DIRECTION('',(${d.map(num).join(",")}))`);
  return { lines, add, point, dir };
}

/**
 * `text` as the contents of an ISO 10303-21 string literal. The standard
 * writes an apostrophe in a string twice ("Cook's" → 'Cook''s') and a
 * backslash twice. Characters outside printable ASCII would need its \X2\
 * encoding, which this writer does not emit, so they are rejected.
 *
 * @param {string} text
 * @returns {string}
 */
export function stepString(text) {
  const bad = [...text].find((char) => char < " " || char > "~");
  if (bad !== undefined)
    throw new Error(
      `STEP string ${JSON.stringify(text)}: ${JSON.stringify(bad)} is not printable ASCII, which this writer cannot encode`,
    );
  return text.replaceAll("\\", "\\\\").replaceAll("'", "''");
}

/**
 * The closed shell, solid, units, product and file envelope around the faces.
 *
 * @param {ReturnType<typeof stepEntities>} step
 * @param {number[]} faces        ADVANCED_FACE ids
 * @param {string} productName    product name written into the file (escaped)
 * @returns {string} the STEP file text
 */
function stepFile({ lines, add, point, dir }, faces, productName) {
  const name = stepString(productName);
  const shell = add(
    `CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(",")}))`,
  );
  const solid = add(`MANIFOLD_SOLID_BREP('${name}',#${shell})`);
  const origin = add(
    `AXIS2_PLACEMENT_3D('',#${point([0, 0, 0])},#${dir([0, 0, 1])},#${dir([1, 0, 0])})`,
  );
  const lengthUnit = add(
    `( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`,
  );
  const angleUnit = add(
    `( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`,
  );
  const solidAngleUnit = add(
    `( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`,
  );
  const uncertainty = add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`,
  );
  const context = add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) ` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) ` +
      `REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )`,
  );
  const shapeRep = add(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${origin},#${solid}),#${context})`,
  );
  const appContext = add(
    `APPLICATION_CONTEXT('core data for automotive mechanical design processes')`,
  );
  add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`,
  );
  const productContext = add(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`);
  const product = add(`PRODUCT('${name}','${name}','',(#${productContext}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const defContext = add(
    `PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`,
  );
  const definition = add(
    `PRODUCT_DEFINITION('design','',#${formation},#${defContext})`,
  );
  const defShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${defShape},#${shapeRep})`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${product}))`);

  return [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('${name}'),'2;1');`,
    `FILE_NAME('${name}','2026-01-01T00:00:00',('KoFEM'),('KoFEM'),'KoFEM examples/gallery/step-prism.mjs','KoFEM','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

/** @param {number[]} a @param {number[]} b */
const sub = (a, b) => a.map((v, i) => v - b[i]);
/** @param {number[]} v */
const unit = (v) => {
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
};

/**
 * @param {[number, number][]} polygon  vertices in counter-clockwise order (seen from +z)
 * @param {number} depth                extrusion length along +z (mm)
 * @param {string} name                 product name written into the file
 * @returns {string} the STEP file text
 */
export function prismStep(polygon, depth, name) {
  /** @param {number} v */
  const num = (v) => {
    const s = String(v);
    return s.includes(".") || s.includes("e") ? s : `${s}.`;
  };
  const step = stepEntities(num);
  const { add, point, dir } = step;

  const n = polygon.length;
  const bottom = polygon.map(([x, y]) => [x, y, 0]);
  const top = polygon.map(([x, y]) => [x, y, depth]);
  /** @param {number[]} p */
  const vtx = (p) => add(`VERTEX_POINT('',#${point(p)})`);
  const vb = bottom.map(vtx);
  const vt = top.map(vtx);

  /** @param {number} va @param {number} vb2 @param {number[]} pa @param {number[]} pb */
  const edge = (va, vb2, pa, pb) => {
    const d = sub(pb, pa);
    const vector = add(`VECTOR('',#${dir(unit(d))},${num(Math.hypot(...d))})`);
    const line = add(`LINE('',#${point(pa)},#${vector})`);
    return add(`EDGE_CURVE('',#${va},#${vb2},#${line},.T.)`);
  };
  /** @type {number[]} */
  const eb = [];
  /** @type {number[]} */
  const et = [];
  /** @type {number[]} */
  const ev = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    eb.push(edge(vb[i], vb[j], bottom[i], bottom[j]));
    et.push(edge(vt[i], vt[j], top[i], top[j]));
    ev.push(edge(vb[i], vt[i], bottom[i], top[i]));
  }

  /** @param {number} e @param {boolean} forward */
  const oriented = (e, forward) =>
    add(`ORIENTED_EDGE('',*,*,#${e},${forward ? ".T." : ".F."})`);
  // A planar face whose normal points out of the solid, bounded by a loop that
  // runs counter-clockwise about that normal.
  /** @param {number[]} origin @param {number[]} normal @param {number[]} ref @param {number[]} loopEdges */
  const face = (origin, normal, ref, loopEdges) => {
    const plane = add(
      `PLANE('',#${add(`AXIS2_PLACEMENT_3D('',#${point(origin)},#${dir(normal)},#${dir(ref)})`)})`,
    );
    const loop = add(
      `EDGE_LOOP('',(${loopEdges.map((id) => `#${id}`).join(",")}))`,
    );
    const bound = add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    return add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  };

  /** @type {number[]} */
  const faces = [];
  // Sides: B_i → B_i+1 → T_i+1 → T_i, outward normal (dy, −dx) for a CCW polygon.
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = unit(sub(bottom[j], bottom[i]));
    faces.push(
      face(bottom[i], [d[1], -d[0], 0], d, [
        oriented(eb[i], true),
        oriented(ev[j], true),
        oriented(et[i], false),
        oriented(ev[i], false),
      ]),
    );
  }
  faces.push(
    face(
      bottom[0],
      [0, 0, -1],
      [1, 0, 0],
      [...eb.keys()].reverse().map((i) => oriented(eb[i], false)),
    ),
  );
  faces.push(
    face(
      top[0],
      [0, 0, 1],
      [1, 0, 0],
      et.map((e) => oriented(e, true)),
    ),
  );

  return stepFile(step, faces, name);
}

// ── Extruded profiles: lines and arcs, with holes ─────────────────────────────

/** @typedef {[number, number]} Point2 */
/**
 * A straight segment from the previous segment's end to `to`.
 * @typedef {object} LineSegment
 * @property {"line"} type
 * @property {Point2} to
 */
/**
 * A circular arc about `center` from the previous segment's end to `to`, which
 * must lie at the same radius. When the arc ends where it starts, it is the full
 * circle (a loop of one arc segment).
 * @typedef {object} ArcSegment
 * @property {"arc"} type
 * @property {Point2} to
 * @property {Point2} center
 * @property {boolean} ccw  true: the arc runs counter-clockwise about +z
 */
/** @typedef {LineSegment | ArcSegment} ProfileSegment */
/**
 * A closed loop: each segment starts where the previous one ends, and the first
 * starts where the last one ends (its `to`).
 * @typedef {ProfileSegment[]} ProfileLoop
 */
/**
 * The section to extrude. The outer loop runs counter-clockwise seen from +z,
 * every hole clockwise (material on the left of each loop). Holes must lie
 * inside the outer loop and not touch each other; that is not checked.
 * @typedef {object} Profile
 * @property {ProfileLoop} outer
 * @property {ProfileLoop[]} holes
 */

/**
 * @param {Point2} to
 * @returns {LineSegment}
 */
export const line = (to) => ({ type: "line", to });

/**
 * @param {Point2} to
 * @param {Point2} center
 * @param {boolean} ccw  true: counter-clockwise about +z
 * @returns {ArcSegment}
 */
export const arc = (to, center, ccw) => ({ type: "arc", to, center, ccw });

/**
 * A full circle as a one-segment loop, starting (and seamed) at
 * center + (radius, 0).
 *
 * @param {Point2} center
 * @param {number} radius
 * @param {boolean} ccw  true for an outer loop, false for a hole
 * @returns {ProfileLoop}
 */
export const circleLoop = ([cx, cy], radius, ccw) => [
  arc([cx + radius, cy], [cx, cy], ccw),
];

const TWO_PI = 2 * Math.PI;

/**
 * Start point, end point and signed sweep (rad, + counter-clockwise) of every
 * segment of a loop; throws on an arc whose ends are not on one circle, a
 * zero-length line, or an empty loop.
 *
 * @param {ProfileLoop} loop
 * @param {string} label  for error messages
 */
function loopSegments(loop, label) {
  if (!Array.isArray(loop) || loop.length === 0)
    throw new Error(`${label}: a loop needs at least one segment`);
  const segs = loop.map((seg, i) => {
    const from = loop[(i + loop.length - 1) % loop.length].to;
    const to = seg.to;
    const scale = Math.max(1, Math.hypot(...from), Math.hypot(...to));
    if (seg.type === "line") {
      if (Math.hypot(...sub(to, from)) <= 1e-9 * scale)
        throw new Error(`${label}: line segment ${i} has zero length`);
      return { seg, from, to, sweep: 0, radius: 0 };
    }
    if (seg.type !== "arc")
      throw new Error(`${label}: segment ${i} is neither a line nor an arc`);
    const radius = Math.hypot(...sub(from, seg.center));
    const rTo = Math.hypot(...sub(to, seg.center));
    if (radius <= 1e-9 * scale)
      throw new Error(`${label}: arc segment ${i} has zero radius`);
    if (Math.abs(radius - rTo) > 1e-9 * scale)
      throw new Error(
        `${label}: arc segment ${i} starts at radius ${radius} but ends at radius ${rTo}`,
      );
    const a0 = Math.atan2(from[1] - seg.center[1], from[0] - seg.center[0]);
    const a1 = Math.atan2(to[1] - seg.center[1], to[0] - seg.center[0]);
    const closed = Math.hypot(...sub(to, from)) <= 1e-9 * scale;
    let sweep = closed ? TWO_PI : seg.ccw ? a1 - a0 : a0 - a1;
    if (!closed) sweep = ((sweep % TWO_PI) + TWO_PI) % TWO_PI;
    return { seg, from, to, sweep: seg.ccw ? sweep : -sweep, radius };
  });
  if (segs.length === 1 && segs[0].sweep === 0)
    throw new Error(`${label}: a one-segment loop must be a full circle`);
  return segs;
}

/**
 * Signed area enclosed by a loop (+ counter-clockwise), arcs exact.
 *
 * @param {ReturnType<typeof loopSegments>} segs
 */
function signedArea(segs) {
  let twice = 0;
  for (const { seg, from, to, sweep, radius } of segs) {
    if (seg.type === "line") {
      twice += from[0] * to[1] - to[0] * from[1];
      continue;
    }
    // ∮ (x dy − y dx) along x = c + r·(cos θ, sin θ), θ0 → θ0 + sweep.
    const [cx, cy] = seg.center;
    const a0 = Math.atan2(from[1] - cy, from[0] - cx);
    const a1 = a0 + sweep;
    twice +=
      radius * cx * (Math.sin(a1) - Math.sin(a0)) -
      radius * cy * (Math.cos(a1) - Math.cos(a0)) +
      radius * radius * sweep;
  }
  return twice / 2;
}

/**
 * Checked loops of a profile: the outer loop counter-clockwise, holes clockwise.
 *
 * @param {Profile} profile
 */
function profileLoops(profile) {
  if (!profile || !Array.isArray(profile.holes))
    throw new Error("profile: `holes` must be an array (empty for none)");
  const outer = loopSegments(profile.outer, "outer loop");
  if (signedArea(outer) <= 0)
    throw new Error(
      "outer loop: must run counter-clockwise seen from +z (positive area)",
    );
  const holes = profile.holes.map((loop, h) => {
    const segs = loopSegments(loop, `hole ${h}`);
    if (signedArea(segs) >= 0)
      throw new Error(
        `hole ${h}: must run clockwise seen from +z (negative area)`,
      );
    return segs;
  });
  return [outer, ...holes];
}

/**
 * Net section area of a profile (mm²): the outer area minus the holes, arcs exact.
 *
 * @param {Profile} profile
 * @returns {number}
 */
export function profileArea(profile) {
  return profileLoops(profile).reduce((s, segs) => s + signedArea(segs), 0);
}

/**
 * A real in STEP form ("1.", "0.5", "1.E-07"); round-off below 1e-12 is written
 * as 0 so axis-aligned directions stay exact.
 *
 * @param {number} v
 */
function real(v) {
  if (!Number.isFinite(v))
    throw new Error(`STEP real must be finite, got ${v}`);
  const s = String(Math.abs(v) < 1e-12 ? 0 : v);
  const [mantissa, exponent] = s.split("e");
  const m = mantissa.includes(".") ? mantissa : `${mantissa}.`;
  return exponent === undefined ? m : `${m}E${exponent}`;
}

/**
 * STEP solid of a profile (outer loop of lines and arcs, holes likewise)
 * extruded from z = 0 to z = depth. Each segment becomes one side face — a
 * PLANE for a line, a CYLINDRICAL_SURFACE for an arc or circle — and the holes
 * become inner bounds of the two caps. Face order: outer-loop sides, each
 * hole's sides, bottom cap, top cap.
 *
 * @param {Profile} profile  outer loop counter-clockwise, holes clockwise (seen from +z)
 * @param {number} depth     extrusion length along +z (mm)
 * @param {string} name      product name written into the file
 * @returns {string} the STEP file text
 */
export function extrudedProfileStep(profile, depth, name) {
  if (!(depth > 0)) throw new Error(`depth must be positive, got ${depth}`);
  const loops = profileLoops(profile);
  const step = stepEntities(real);
  const { add, point, dir } = step;
  /** @param {number} e @param {boolean} forward */
  const oriented = (e, forward) =>
    add(`ORIENTED_EDGE('',*,*,#${e},${forward ? ".T." : ".F."})`);
  /** @param {number[]} origin @param {number[]} axis @param {number[]} ref */
  const placement = (origin, axis, ref) =>
    add(`AXIS2_PLACEMENT_3D('',#${point(origin)},#${dir(axis)},#${dir(ref)})`);

  // Edges of one loop: per segment a bottom and a top edge, per vertex (segment
  // start) a vertical edge. A full circle has one vertex, so its vertical edge
  // is the seam of its cylinder.
  const built = loops.map((segs) => {
    const n = segs.length;
    const vb = segs.map(({ from }) =>
      add(`VERTEX_POINT('',#${point([from[0], from[1], 0])})`),
    );
    const vt = segs.map(({ from }) =>
      add(`VERTEX_POINT('',#${point([from[0], from[1], depth])})`),
    );
    /** @param {ReturnType<typeof loopSegments>[number]} s @param {number} z @param {number} va @param {number} vb2 */
    const edge = (s, z, va, vb2) => {
      const pa = [s.from[0], s.from[1], z];
      if (s.seg.type === "line") {
        const d = sub([s.to[0], s.to[1], z], pa);
        const vector = add(
          `VECTOR('',#${dir(unit(d))},${real(Math.hypot(...d))})`,
        );
        const curve = add(`LINE('',#${point(pa)},#${vector})`);
        return add(`EDGE_CURVE('',#${va},#${vb2},#${curve},.T.)`);
      }
      // The circle runs the arc's way (axis ±z), its parameter starting at the
      // arc's start, so the edge is the curve's [0, |sweep|] in its own sense.
      const [cx, cy] = s.seg.center;
      const curve = add(
        `CIRCLE('',#${placement(
          [cx, cy, z],
          [0, 0, s.sweep > 0 ? 1 : -1],
          unit([s.from[0] - cx, s.from[1] - cy, 0]),
        )},${real(s.radius)})`,
      );
      return add(`EDGE_CURVE('',#${va},#${vb2},#${curve},.T.)`);
    };
    /** @type {number[]} */
    const eb = [];
    /** @type {number[]} */
    const et = [];
    /** @type {number[]} */
    const ev = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      eb.push(edge(segs[i], 0, vb[i], vb[j]));
      et.push(edge(segs[i], depth, vt[i], vt[j]));
      const p = segs[i].from;
      const vector = add(`VECTOR('',#${dir([0, 0, 1])},${real(depth)})`);
      const curve = add(`LINE('',#${point([p[0], p[1], 0])},#${vector})`);
      ev.push(add(`EDGE_CURVE('',#${vb[i]},#${vt[i]},#${curve},.T.)`));
    }
    return { segs, eb, et, ev };
  });

  /** @param {number[]} edges */
  const edgeLoop = (edges) =>
    add(`EDGE_LOOP('',(${edges.map((id) => `#${id}`).join(",")}))`);

  /** @type {number[]} */
  const faces = [];
  // Sides: B_i → B_i+1 → T_i+1 → T_i. Material lies left of every loop, so the
  // outward normal is the loop's right: (dy, −dx) for a line; radially out of
  // a counter-clockwise arc and into a clockwise one.
  for (const { segs, eb, et, ev } of built) {
    const n = segs.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const s = segs[i];
      const bound = add(
        `FACE_OUTER_BOUND('',#${edgeLoop([
          oriented(eb[i], true),
          oriented(ev[j], true),
          oriented(et[i], false),
          oriented(ev[i], false),
        ])},.T.)`,
      );
      if (s.seg.type === "line") {
        const d = unit(sub([s.to[0], s.to[1], 0], [s.from[0], s.from[1], 0]));
        const plane = add(
          `PLANE('',#${placement([s.from[0], s.from[1], 0], [d[1], -d[0], 0], d)})`,
        );
        faces.push(add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
      } else {
        // The cylinder's u = 0 seam sits at the arc's counter-clockwise-most
        // end, so the face spans u ∈ [0, |sweep|] without crossing it.
        const [cx, cy] = s.seg.center;
        const start = s.sweep > 0 ? s.from : s.to;
        const cylinder = add(
          `CYLINDRICAL_SURFACE('',#${placement(
            [cx, cy, 0],
            [0, 0, 1],
            unit([start[0] - cx, start[1] - cy, 0]),
          )},${real(s.radius)})`,
        );
        const sense = s.sweep > 0 ? ".T." : ".F.";
        faces.push(add(`ADVANCED_FACE('',(#${bound}),#${cylinder},${sense})`));
      }
    }
  }
  // Caps: the top follows every loop as given (counter-clockwise about +z for
  // the outer loop), the bottom runs each loop backwards (about −z).
  /** @param {number} z @param {boolean} isTop */
  const cap = (z, isTop) => {
    const bounds = built.map(({ eb, et }, k) => {
      const edges = isTop
        ? et.map((e) => oriented(e, true))
        : [...eb.keys()].reverse().map((i) => oriented(eb[i], false));
      const kind = k === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND";
      return add(`${kind}('',#${edgeLoop(edges)},.T.)`);
    });
    const from = loops[0][0].from;
    const plane = add(
      `PLANE('',#${placement([from[0], from[1], z], [0, 0, isTop ? 1 : -1], [1, 0, 0])})`,
    );
    return add(
      `ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(",")}),#${plane},.T.)`,
    );
  };
  faces.push(cap(0, false));
  faces.push(cap(depth, true));

  return stepFile(step, faces, name);
}

// ── The curved stock of the examples ──────────────────────────────────────────

/**
 * A hollow circular shaft (tube) along z: the annulus rInner ≤ r ≤ rOuter about
 * the z axis, from z = 0 to z = length. Four faces: 1 outer cylinder
 * (r = rOuter), 2 bore (r = rInner), 3 end z = 0, 4 end z = length. Each circle
 * is one closed edge, seamed at +x.
 *
 * @param {number} rInner  bore radius (mm)
 * @param {number} rOuter  outer radius (mm)
 * @param {number} length  shaft length along +z (mm)
 * @param {string} name    product name written into the file
 * @returns {string} the STEP file text
 */
export function annulusStep(rInner, rOuter, length, name) {
  if (!(rInner > 0 && rOuter > rInner))
    throw new Error(
      `annulus needs 0 < rInner < rOuter, got rInner=${rInner}, rOuter=${rOuter}`,
    );
  return extrudedProfileStep(
    {
      outer: circleLoop([0, 0], rOuter, true),
      holes: [circleLoop([0, 0], rInner, false)],
    },
    length,
    name,
  );
}

/**
 * A square plate −halfWidth ≤ x, y ≤ halfWidth with a central circular through
 * hole of radius holeRadius, from z = 0 to z = thickness. Seven faces:
 * 1 edge y = −halfWidth, 2 edge x = +halfWidth, 3 edge y = +halfWidth,
 * 4 edge x = −halfWidth, 5 hole (r = holeRadius, seamed at +x), 6 face z = 0,
 * 7 face z = thickness.
 *
 * @param {number} holeRadius  hole radius a (mm)
 * @param {number} halfWidth   plate half-width b (mm), b > a
 * @param {number} thickness   plate thickness t along +z (mm)
 * @param {string} name        product name written into the file
 * @returns {string} the STEP file text
 */
export function plateWithHoleStep(holeRadius, halfWidth, thickness, name) {
  if (!(holeRadius > 0 && halfWidth > holeRadius))
    throw new Error(
      `plate with a hole needs 0 < holeRadius < halfWidth, got ${holeRadius}, ${halfWidth}`,
    );
  const b = halfWidth;
  return extrudedProfileStep(
    {
      outer: [line([b, -b]), line([b, b]), line([-b, b]), line([-b, -b])],
      holes: [circleLoop([0, 0], holeRadius, false)],
    },
    thickness,
    name,
  );
}

/**
 * The quarter x, y ≥ 0 of a strip −halfLength ≤ x ≤ halfLength,
 * −halfWidth ≤ y ≤ halfWidth with a central circular through hole of radius
 * holeRadius, from z = 0 to z = thickness: a model with symmetry supports on
 * x = 0 and y = 0. Seven faces: 1 symmetry edge y = 0, 2 edge x = halfLength,
 * 3 edge y = halfWidth, 4 symmetry edge x = 0, 5 quarter hole
 * (r = holeRadius), 6 face z = 0, 7 face z = thickness.
 *
 * @param {number} holeRadius  hole radius a (mm)
 * @param {number} halfWidth   strip half-width b (mm), b > a
 * @param {number} halfLength  strip half-length L (mm), L > a
 * @param {number} thickness   plate thickness t along +z (mm)
 * @param {string} name        product name written into the file
 * @returns {string} the STEP file text
 */
export function quarterStripWithHoleStep(
  holeRadius,
  halfWidth,
  halfLength,
  thickness,
  name,
) {
  if (!(holeRadius > 0 && halfWidth > holeRadius && halfLength > holeRadius))
    throw new Error(
      `strip with a hole needs 0 < holeRadius < halfWidth, halfLength, got ${holeRadius}, ${halfWidth}, ${halfLength}`,
    );
  const a = holeRadius;
  const b = halfWidth;
  const L = halfLength;
  return extrudedProfileStep(
    {
      outer: [
        line([L, 0]),
        line([L, b]),
        line([0, b]),
        line([0, a]),
        arc([a, 0], [0, 0], false),
      ],
      holes: [],
    },
    thickness,
    name,
  );
}
