// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal STEP (AP214) writer for sectors of solids of revolution, on the
// entity table and file envelope of step-prism.mjs:
//
//   revolvedSectorStep   closed profiles in the (r, z) half-plane, each made
//                        of lines, circular arcs and hyperbolic arcs, revolved
//                        about the z axis from θ = 0 through a sweep < 360°.
//   cylindricalPanelStep, sphericalShellStep, hyperboloidShellStep,
//   cappedCylinderStep
//                        the thick shells of the NAFEMS LE2, LE3, LE4 and LE7
//                        benchmarks, built on the above.
//
// A profile point (r, z) at angle θ is the point (r cos θ, r sin θ, z): θ = 0
// is the xz half-plane x ≥ 0, and the sweep turns counter-clockwise about +z.
// Every segment of a profile becomes its own revolved face, except a segment
// on the axis (r = 0), which sweeps no area: a line parallel to the axis gives
// a CYLINDRICAL_SURFACE, a line perpendicular to it a PLANE (an annular or
// circular sector), any other line a CONICAL_SURFACE, an arc centred on the
// axis a SPHERICAL_SURFACE, an arc off it a TOROIDAL_SURFACE, and a hyperbolic
// arc a SURFACE_OF_REVOLUTION of its HYPERBOLA, trimmed to the arc. Each
// profile vertex off the axis sweeps one circular edge; a vertex on the axis
// is one vertex shared by both ends (a spherical cap's pole). The two planar
// ends, at θ = 0 and at θ = sweep, are bounded by the profile itself.
//
// Face order — and so the 1-based CAD face id OCCT gives each face on import —
// is: the revolved faces in segment order (segments on the axis skipped), then
// the end θ = 0, then the end θ = sweep; several profiles follow each other.
// Generators should still pick faces by a point on them, as a user clicks
// them; web/tests/integration/step-revolve.test.mjs checks this order.

import {
  arc,
  line,
  real,
  stepEntities,
  stepFile,
  sub,
  turn,
  TWO_PI,
  unit,
} from "./step-prism.mjs";

export { arc, line };

const WRITER = "examples/gallery/step-revolve.mjs";

/** @typedef {[number, number]} MeridianPoint  (r, z), r ≥ 0 */
/**
 * An arc of the hyperbola r²/a² − z²/b² = 1 (its branch r > 0, centred on the
 * axis at z = 0) from the previous segment's end to `to`, which must both lie
 * on it.
 * @typedef {object} HyperbolaArcSegment
 * @property {"hyperbolaArc"} type
 * @property {MeridianPoint} to
 * @property {number} a  real semi-axis, along r
 * @property {number} b  imaginary semi-axis, along z
 */
/**
 * A segment of a meridian profile: a line or circular arc of step-prism.mjs
 * with (r, z) for (x, y) — `ccw` turns from +r towards +z — or a hyperbolic arc.
 * @typedef {import("./step-prism.mjs").LineSegment
 *   | import("./step-prism.mjs").ArcSegment
 *   | HyperbolaArcSegment} MeridianSegment
 */
/**
 * A closed meridian profile: each segment starts where the previous one ends,
 * the first where the last one ends. It runs counter-clockwise in the (r, z)
 * plane (material on its left: r to the right, z up) and must not cross itself;
 * that is not checked.
 * @typedef {MeridianSegment[]} MeridianProfile
 */

/**
 * @param {MeridianPoint} to
 * @param {{ a: number, b: number }} axes  r²/a² − z²/b² = 1
 * @returns {HyperbolaArcSegment}
 */
export const hyperbolaArc = (to, { a, b }) => ({
  type: "hyperbolaArc",
  to,
  a,
  b,
});

/**
 * The checked segments of a profile: start, end (r within round-off of the
 * axis written as 0), whether the segment lies on the axis, and for an arc its
 * radius and signed sweep (rad, + counter-clockwise in (r, z)).
 *
 * @param {MeridianProfile} profile
 * @param {string} label  for error messages
 */
function meridianSegments(profile, label) {
  if (!Array.isArray(profile) || profile.length < 2)
    throw new Error(`${label}: a profile needs at least two segments`);
  const scale = Math.max(
    1,
    ...profile.flatMap((seg) => seg.to.map((c) => Math.abs(c))),
  );
  const tol = 1e-9 * scale;
  /** @param {MeridianPoint} p @param {string} what @returns {MeridianPoint} */
  const vertex = ([r, z], what) => {
    if (!Number.isFinite(r) || !Number.isFinite(z))
      throw new Error(`${label}: ${what} (${r}, ${z}) is not finite`);
    if (r < -tol)
      throw new Error(
        `${label}: ${what} (${r}, ${z}) must lie in the half-plane r ≥ 0`,
      );
    return [Math.abs(r) <= tol ? 0 : r, z];
  };
  const points = profile.map((seg, i) => vertex(seg.to, `segment ${i} end`));
  return profile.map((seg, i) => {
    const from = points[(i + profile.length - 1) % profile.length];
    const to = points[i];
    const base = { seg, from, to, onAxis: false, radius: 0, sweep: 0 };
    if (seg.type === "line") {
      if (Math.hypot(...sub(to, from)) <= tol)
        throw new Error(`${label}: line segment ${i} has zero length`);
      return { ...base, onAxis: from[0] === 0 && to[0] === 0 };
    }
    if (seg.type === "arc") {
      const [cr, cz] = seg.center;
      if (!(cr >= -tol))
        throw new Error(
          `${label}: arc segment ${i} has its centre at r = ${cr}; it needs r ≥ 0`,
        );
      const radius = Math.hypot(from[0] - cr, from[1] - cz);
      const rTo = Math.hypot(to[0] - cr, to[1] - cz);
      if (radius <= tol)
        throw new Error(`${label}: arc segment ${i} has zero radius`);
      if (Math.abs(radius - rTo) > tol)
        throw new Error(
          `${label}: arc segment ${i} starts at radius ${radius} but ends at radius ${rTo}`,
        );
      if (Math.hypot(...sub(to, from)) <= tol)
        throw new Error(
          `${label}: arc segment ${i} is a full circle, which revolves to no sector`,
        );
      const a0 = Math.atan2(from[1] - cz, from[0] - cr);
      const a1 = Math.atan2(to[1] - cz, to[0] - cr);
      const sweep = turn(a0, a1, seg.ccw, false);
      // The arc's least r is at its angle nearest π: inside the arc, that is
      // cr − radius, which must stay off the axis.
      const alongPi =
        ((((Math.PI - a0) * (seg.ccw ? 1 : -1)) % TWO_PI) + TWO_PI) % TWO_PI;
      if (alongPi > 0 && alongPi < sweep && cr - radius <= tol)
        throw new Error(
          `${label}: arc segment ${i} reaches r = ${cr - radius}: it crosses or touches the axis between its ends`,
        );
      return {
        ...base,
        center: /** @type {MeridianPoint} */ ([Math.max(cr, 0), cz]),
        radius,
        sweep: seg.ccw ? sweep : -sweep,
        a0,
      };
    }
    if (seg.type === "hyperbolaArc") {
      const { a, b } = seg;
      if (!(a > 0 && b > 0))
        throw new Error(
          `${label}: hyperbolic arc segment ${i} needs positive semi-axes, got a = ${a}, b = ${b}`,
        );
      for (const [p, which] of [
        [from, "starts"],
        [to, "ends"],
      ])
        if (
          !(p[0] > 0) ||
          Math.abs((p[0] / a) ** 2 - (p[1] / b) ** 2 - 1) > 1e-9
        )
          throw new Error(
            `${label}: hyperbolic arc segment ${i} ${which} at (${p.join(", ")}), not on its hyperbola r²/${a}² − z²/${b}² = 1, r > 0`,
          );
      return {
        ...base,
        u0: Math.asinh(from[1] / b),
        u1: Math.asinh(to[1] / b),
      };
    }
    throw new Error(
      `${label}: segment ${i} is neither a line, an arc nor a hyperbolic arc`,
    );
  });
}

/**
 * Signed area of a checked profile in the (r, z) plane (+ counter-clockwise),
 * arcs exact.
 *
 * @param {ReturnType<typeof meridianSegments>} segs
 */
function signedArea(segs) {
  let twice = 0;
  for (const s of segs) {
    const { seg, from, to } = s;
    if (seg.type === "line") twice += from[0] * to[1] - to[0] * from[1];
    else if (seg.type === "arc" && s.center && s.a0 !== undefined) {
      // ∮ (r dz − z dr) along (r, z) = c + R·(cos φ, sin φ), φ0 → φ0 + sweep.
      const [cr, cz] = s.center;
      const a1 = s.a0 + s.sweep;
      twice +=
        s.radius * cr * (Math.sin(a1) - Math.sin(s.a0)) -
        s.radius * cz * (Math.cos(a1) - Math.cos(s.a0)) +
        s.radius * s.radius * s.sweep;
    } else if (
      seg.type === "hyperbolaArc" &&
      s.u0 !== undefined &&
      s.u1 !== undefined
    )
      // Along (a cosh u, b sinh u): r dz − z dr = a·b du.
      twice += seg.a * seg.b * (s.u1 - s.u0);
  }
  return twice / 2;
}

/**
 * STEP file of closed meridian profiles revolved about the z axis from θ = 0
 * to θ = sweepDeg, one solid each: separate bodies in the app (keep a gap
 * between them for bodies that a tie is to join). Face order: per profile, the
 * revolved faces in segment order (none for a segment on the axis), the end
 * θ = 0, the end θ = sweep.
 *
 * @param {MeridianProfile[]} profiles  each counter-clockwise in (r, z), r ≥ 0
 * @param {number} sweepDeg             sweep about +z (degrees), 0 < sweep < 360
 * @param {string} name                 product name written into the file
 * @returns {string} the STEP file text
 */
export function revolvedSectorStep(profiles, sweepDeg, name) {
  if (!(sweepDeg > 0 && sweepDeg < 360))
    throw new Error(
      `sweep must lie strictly between 0° and 360°, got ${sweepDeg}`,
    );
  if (!Array.isArray(profiles) || profiles.length === 0)
    throw new Error("no profile to revolve");
  const checked = profiles.map((profile, k) => {
    const label = `profile ${k}`;
    const segs = meridianSegments(profile, label);
    if (!(signedArea(segs) > 0))
      throw new Error(
        `${label}: must run counter-clockwise in the (r, z) plane (positive area)`,
      );
    return segs;
  });
  const step = stepEntities(real);
  const sweep = (sweepDeg * Math.PI) / 180;
  const shells = checked.map((segs) => revolvedFaces(step, segs, sweep));
  return stepFile(step, shells, name, WRITER);
}

/**
 * The faces of one revolved profile, written into `step`.
 *
 * @param {ReturnType<typeof stepEntities>} step
 * @param {ReturnType<typeof meridianSegments>} segs
 * @param {number} sweep  (rad)
 * @returns {number[]} ADVANCED_FACE ids
 */
function revolvedFaces(step, segs, sweep) {
  const { add, point, dir } = step;
  const n = segs.length;
  /** @param {number} theta */
  const radial = (theta) => [Math.cos(theta), Math.sin(theta), 0];
  /** @param {number} theta */
  const tangential = (theta) => [-Math.sin(theta), Math.cos(theta), 0];
  /** @param {MeridianPoint} p @param {number} theta */
  const at = ([r, z], theta) => [r * Math.cos(theta), r * Math.sin(theta), z];
  /** @param {number[]} origin @param {number[]} axis @param {number[]} ref */
  const placement = (origin, axis, ref) =>
    add(`AXIS2_PLACEMENT_3D('',#${point(origin)},#${dir(axis)},#${dir(ref)})`);
  /** @param {number} e @param {boolean} forward */
  const oriented = (e, forward) =>
    add(`ORIENTED_EDGE('',*,*,#${e},${forward ? ".T." : ".F."})`);
  /** @param {number[]} edges */
  const loop = (edges) =>
    add(`EDGE_LOOP('',(${edges.map((id) => `#${id}`).join(",")}))`);

  // Vertices: segment i starts at vertex i. On the axis the θ = 0 and the
  // θ = sweep vertex are one.
  const v0 = segs.map(({ from }) =>
    add(`VERTEX_POINT('',#${point(at(from, 0))})`),
  );
  const vS = segs.map(({ from }, i) =>
    from[0] === 0 ? v0[i] : add(`VERTEX_POINT('',#${point(at(from, sweep))})`),
  );
  // Circular edges swept by the vertices off the axis, θ = 0 → sweep.
  const circles = segs.map(({ from }, i) => {
    if (from[0] === 0) return null;
    const curve = add(
      `CIRCLE('',#${placement([0, 0, from[1]], [0, 0, 1], [1, 0, 0])},${real(from[0])})`,
    );
    return add(`EDGE_CURVE('',#${v0[i]},#${vS[i]},#${curve},.T.)`);
  });

  /**
   * The meridian curve of a segment in the half-plane θ, as an edge from the
   * segment's start to its end.
   *
   * @param {ReturnType<typeof meridianSegments>[number]} s
   * @param {number} theta
   * @param {number} va @param {number} vb
   */
  const meridian = (s, theta, va, vb) => {
    const pa = at(s.from, theta);
    if (s.seg.type === "line") {
      const d = sub(at(s.to, theta), pa);
      const vector = add(
        `VECTOR('',#${dir(unit(d))},${real(Math.hypot(...d))})`,
      );
      const curve = add(`LINE('',#${point(pa)},#${vector})`);
      return add(`EDGE_CURVE('',#${va},#${vb},#${curve},.T.)`);
    }
    if (s.seg.type === "arc" && s.center) {
      // Counter-clockwise in (r, z) is about radial × z = −tangential, so the
      // circle runs the arc's way and starts at its start.
      const centre = at(s.center, theta);
      const t = tangential(theta);
      const curve = add(
        `CIRCLE('',#${placement(
          centre,
          s.sweep > 0 ? t.map((c) => -c) : t,
          unit(sub(pa, centre)),
        )},${real(s.radius)})`,
      );
      return add(`EDGE_CURVE('',#${va},#${vb},#${curve},.T.)`);
    }
    // The hyperbola (a cosh u, b sinh u) in (r, z) rises with u.
    const curve = hyperbola(s, theta);
    const rising = s.to[1] > s.from[1];
    return add(
      `EDGE_CURVE('',#${va},#${vb},#${curve},${rising ? ".T." : ".F."})`,
    );
  };
  /**
   * HYPERBOLA of a hyperbolic segment in the half-plane θ: centred on the
   * origin, real axis radial, imaginary axis +z (placement axis −tangential).
   *
   * @param {ReturnType<typeof meridianSegments>[number]} s
   * @param {number} theta
   */
  const hyperbola = (s, theta) => {
    if (s.seg.type !== "hyperbolaArc") throw new Error("not a hyperbolic arc");
    return add(
      `HYPERBOLA('',#${placement(
        [0, 0, 0],
        tangential(theta).map((c) => -c),
        radial(theta),
      )},${real(s.seg.a)},${real(s.seg.b)})`,
    );
  };

  // Meridian edges at θ = 0 and θ = sweep; one edge for a segment on the axis.
  const m0 = segs.map((s, i) => meridian(s, 0, v0[i], v0[(i + 1) % n]));
  const mS = segs.map((s, i) =>
    s.onAxis ? m0[i] : meridian(s, sweep, vS[i], vS[(i + 1) % n]),
  );

  /** @type {number[]} */
  const faces = [];
  segs.forEach((s, i) => {
    if (s.onAxis) return;
    const j = (i + 1) % n;
    // Around the outward normal, which is the profile's right (material lies
    // on its left): the start's circle, the far meridian, the end's circle
    // back, the near meridian back. A circle on the axis drops out.
    const edges = [
      ...(circles[i] === null ? [] : [oriented(circles[i], true)]),
      oriented(mS[i], true),
      ...(circles[j] === null ? [] : [oriented(circles[j], false)]),
      oriented(m0[i], false),
    ];
    const bound = add(`FACE_OUTER_BOUND('',#${loop(edges)},.T.)`);
    const [r0, z0] = s.from;
    const [r1, z1] = s.to;
    const rising = z1 > z0;
    /** @type {[number, boolean]} surface and sense */
    let surface;
    if (s.seg.type === "line") {
      const tol = 1e-9 * Math.max(1, Math.hypot(r1 - r0, z1 - z0));
      if (Math.abs(r1 - r0) <= tol) {
        // Its normal points away from the axis: outward when the line rises.
        surface = [
          add(
            `CYLINDRICAL_SURFACE('',#${placement([0, 0, 0], [0, 0, 1], [1, 0, 0])},${real(r0)})`,
          ),
          rising,
        ];
      } else if (Math.abs(z1 - z0) <= tol) {
        // Outward is the profile's right: −z when the line runs outwards.
        surface = [
          add(
            `PLANE('',#${placement([0, 0, z0], [0, 0, r1 > r0 ? -1 : 1], [1, 0, 0])})`,
          ),
          true,
        ];
      } else {
        // The cone widens along its axis, placed at the wider end. Its normal
        // points away from the axis, so it is outward when the line rises. With
        // axis −z the parameter turns clockwise: starting it at θ = sweep keeps
        // the face on u ∈ [0, sweep].
        const widensUp = (r1 - r0) * (z1 - z0) > 0;
        const [rm, zm] = r1 > r0 ? s.to : s.from;
        const semiAngle = Math.atan2(Math.abs(r1 - r0), Math.abs(z1 - z0));
        surface = [
          add(
            `CONICAL_SURFACE('',#${placement(
              [0, 0, zm],
              [0, 0, widensUp ? 1 : -1],
              widensUp ? [1, 0, 0] : radial(sweep),
            )},${real(rm)},${real(semiAngle)})`,
          ),
          rising,
        ];
      }
    } else if (s.seg.type === "arc" && s.center) {
      // Normals point out of the sphere or the torus's tube: outward for an
      // arc that turns counter-clockwise (material towards its centre).
      const [cr, cz] = s.center;
      const position = placement([0, 0, cz], [0, 0, 1], [1, 0, 0]);
      surface = [
        cr === 0
          ? add(`SPHERICAL_SURFACE('',#${position},${real(s.radius)})`)
          : add(
              `TOROIDAL_SURFACE('',#${position},${real(cr)},${real(s.radius)})`,
            ),
        s.sweep > 0,
      ];
    } else {
      // Normal = rotation tangent × curve tangent: the curve's right, away
      // from the axis as the hyperbola rises. The swept curve is trimmed to
      // the arc: OCCT's import raises Standard_NumericError while healing a
      // revolved face of the whole, unbounded hyperbola.
      const axis = add(
        `AXIS1_PLACEMENT('',#${point([0, 0, 0])},#${dir([0, 0, 1])})`,
      );
      surface = [
        add(
          `SURFACE_OF_REVOLUTION('',#${add(
            `TRIMMED_CURVE('',#${hyperbola(s, 0)},(PARAMETER_VALUE(${real(Math.min(s.u0 ?? 0, s.u1 ?? 0))})),(PARAMETER_VALUE(${real(Math.max(s.u0 ?? 0, s.u1 ?? 0))})),.T.,.PARAMETER.)`,
          )},#${axis})`,
        ),
        rising,
      ];
    }
    const [surfaceId, sense] = surface;
    faces.push(
      add(
        `ADVANCED_FACE('',(#${bound}),#${surfaceId},${sense ? ".T." : ".F."})`,
      ),
    );
  });

  // Ends: counter-clockwise in (r, z) is counter-clockwise about −tangential,
  // the outward normal at θ = 0; at θ = sweep the profile runs backwards.
  /** @param {number[]} normal @param {number[]} ref @param {number[]} edges */
  const end = (normal, ref, edges) => {
    const plane = add(`PLANE('',#${placement([0, 0, 0], normal, ref)})`);
    const bound = add(`FACE_OUTER_BOUND('',#${loop(edges)},.T.)`);
    return add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  };
  faces.push(
    end(
      [0, -1, 0],
      [1, 0, 0],
      m0.map((e) => oriented(e, true)),
    ),
  );
  faces.push(
    end(
      tangential(sweep),
      radial(sweep),
      [...mS.keys()].reverse().map((i) => oriented(mS[i], false)),
    ),
  );
  return faces;
}

// ── The thick shells of the NAFEMS benchmarks ─────────────────────────────────

/**
 * Inner and outer radius of a wall of `thickness` about mid-surface radius
 * `radius`; throws unless both are positive.
 *
 * @param {number} radius @param {number} thickness @param {string} what
 */
function wall(radius, thickness, what) {
  if (!(thickness > 0 && radius - thickness / 2 > 0))
    throw new Error(
      `${what} needs 0 < thickness < 2·radius, got radius ${radius}, thickness ${thickness}`,
    );
  return [radius - thickness / 2, radius + thickness / 2];
}

/**
 * A cylindrical panel (NAFEMS LE2: radius 1000, thickness 10, length 500,
 * sweep 30°): the wall about mid-surface radius `radius`, from z = 0 to
 * z = length, θ from 0 to sweepDeg. Six faces: 1 end z = 0, 2 outer cylinder,
 * 3 end z = length, 4 inner cylinder, 5 edge θ = 0, 6 edge θ = sweep.
 *
 * @param {number} radius     mid-surface radius (mm)
 * @param {number} thickness  wall thickness (mm)
 * @param {number} length     axial length along +z (mm)
 * @param {number} sweepDeg   sweep about +z (degrees)
 * @param {string} name       product name written into the file
 * @returns {string} the STEP file text
 */
export function cylindricalPanelStep(
  radius,
  thickness,
  length,
  sweepDeg,
  name,
) {
  const [inner, outer] = wall(radius, thickness, "cylindrical panel");
  if (!(length > 0))
    throw new Error(`cylindrical panel needs a positive length, got ${length}`);
  return revolvedSectorStep(
    [
      [
        line([outer, 0]),
        line([outer, length]),
        line([inner, length]),
        line([inner, 0]),
      ],
    ],
    sweepDeg,
    name,
  );
}

/**
 * A zone of a spherical shell (NAFEMS LE3: radius 10000, thickness 40, from
 * the equator to elevation 72°, the 18° hole about the pole, sweep 90°): the
 * wall about mid-surface radius `radius` centred on the origin, between
 * elevations fromDeg and toDeg above the xy plane (−90 ≤ from < to ≤ 90),
 * θ from 0 to sweepDeg. Faces in order: the lower edge at elevation from (a
 * PLANE at 0°, else a cone through the centre; none at −90°), the outer
 * sphere, the upper edge at elevation to (none at 90°: the shell closes at
 * the pole), the inner sphere, the edge θ = 0, the edge θ = sweep. LE3 has
 * six: 1 equator z = 0, 2 outer sphere, 3 hole edge, 4 inner sphere,
 * 5 edge θ = 0, 6 edge θ = 90°.
 *
 * @param {number} radius     mid-surface radius (mm)
 * @param {number} thickness  wall thickness (mm)
 * @param {number} fromDeg    lower elevation (degrees)
 * @param {number} toDeg      upper elevation (degrees)
 * @param {number} sweepDeg   sweep about +z (degrees)
 * @param {string} name       product name written into the file
 * @returns {string} the STEP file text
 */
export function sphericalShellStep(
  radius,
  thickness,
  fromDeg,
  toDeg,
  sweepDeg,
  name,
) {
  const [inner, outer] = wall(radius, thickness, "spherical shell");
  if (!(fromDeg >= -90 && fromDeg < toDeg && toDeg <= 90))
    throw new Error(
      `spherical shell needs −90 ≤ from < to ≤ 90 (degrees), got ${fromDeg}, ${toDeg}`,
    );
  /** @param {number} rho @param {number} deg @returns {MeridianPoint} */
  const on = (rho, deg) => {
    const angle = (deg * Math.PI) / 180;
    return Math.abs(deg) === 90
      ? [0, Math.sign(deg) * rho]
      : [rho * Math.cos(angle), rho * Math.sin(angle)];
  };
  return revolvedSectorStep(
    [
      [
        line(on(outer, fromDeg)),
        arc(on(outer, toDeg), [0, 0], true),
        line(on(inner, toDeg)),
        arc(on(inner, fromDeg), [0, 0], false),
      ],
    ],
    sweepDeg,
    name,
  );
}

/**
 * A hyperboloid shell (NAFEMS LE4: mid-surface r² − z² = 1000², so a = b =
 * 1000, height 1000, thickness 10, sweep 90°): the wall about the mid-surface
 * r²/a² − z²/b² = 1 from its waist z = 0 to z = height, θ from 0 to sweepDeg.
 * The end at the waist is the plane z = 0; the top end is normal to the
 * mid-surface (a cone). Inner and outer faces are hyperboloids through the
 * mid-surface offset by ∓ thickness/2 along its normal at both ends: their
 * real semi-axes are a ∓ thickness/2, their imaginary semi-axes fitted
 * through the offset top points. Six faces: 1 waist z = 0, 2 outer
 * hyperboloid, 3 top edge, 4 inner hyperboloid, 5 edge θ = 0, 6 edge
 * θ = sweep.
 *
 * @param {number} a          mid-surface real semi-axis: the waist radius (mm)
 * @param {number} b          mid-surface imaginary semi-axis (mm)
 * @param {number} height     height of the top edge's mid-surface point (mm)
 * @param {number} thickness  wall thickness (mm)
 * @param {number} sweepDeg   sweep about +z (degrees)
 * @param {string} name       product name written into the file
 * @returns {string} the STEP file text
 */
export function hyperboloidShellStep(a, b, height, thickness, sweepDeg, name) {
  const [aIn, aOut] = wall(a, thickness, "hyperboloid shell");
  if (!(b > 0 && height > 0))
    throw new Error(
      `hyperboloid shell needs b > 0 and height > 0, got b ${b}, height ${height}`,
    );
  const top = [a * Math.sqrt(1 + (height / b) ** 2), height];
  const normal = unit([top[0] / a ** 2, -top[1] / b ** 2]);
  /** @param {number} sign @param {number} semi */
  const offset = (sign, semi) => {
    /** @type {MeridianPoint} */
    const p = [
      top[0] + (sign * thickness * normal[0]) / 2,
      top[1] + (sign * thickness * normal[1]) / 2,
    ];
    const excess = (p[0] / semi) ** 2 - 1;
    if (!(p[1] > 0 && excess > 0))
      throw new Error(
        `hyperboloid shell: thickness ${thickness} is too large for a = ${a}, b = ${b}, height ${height}`,
      );
    return { p, b: p[1] / Math.sqrt(excess) };
  };
  const outer = offset(1, aOut);
  const inner = offset(-1, aIn);
  return revolvedSectorStep(
    [
      [
        line([aOut, 0]),
        hyperbolaArc(outer.p, { a: aOut, b: outer.b }),
        line(inner.p),
        hyperbolaArc([aIn, 0], { a: aIn, b: inner.b }),
      ],
    ],
    sweepDeg,
    name,
  );
}

/**
 * A cylinder closed by a tangent hemispherical cap (NAFEMS LE7: radius 1000,
 * thickness 25, cylinder length 1500, sweep 90°): the wall about mid-surface
 * radius `radius`, the cylinder from z = 0 to z = length, the hemisphere
 * centred on (0, 0, length) up to the pole at z = length + radius (mid-surface),
 * θ from 0 to sweepDeg. Seven faces: 1 end z = 0, 2 outer cylinder, 3 outer
 * hemisphere, 4 inner hemisphere, 5 inner cylinder, 6 edge θ = 0, 7 edge
 * θ = sweep.
 *
 * @param {number} radius     mid-surface radius (mm)
 * @param {number} thickness  wall thickness (mm)
 * @param {number} length     cylinder length along +z (mm)
 * @param {number} sweepDeg   sweep about +z (degrees)
 * @param {string} name       product name written into the file
 * @returns {string} the STEP file text
 */
export function cappedCylinderStep(radius, thickness, length, sweepDeg, name) {
  const [inner, outer] = wall(radius, thickness, "capped cylinder");
  if (!(length > 0))
    throw new Error(`capped cylinder needs a positive length, got ${length}`);
  return revolvedSectorStep(
    [
      [
        line([outer, 0]),
        line([outer, length]),
        arc([0, length + outer], [0, length], true),
        line([0, length + inner]),
        arc([inner, length], [0, length], false),
        line([inner, 0]),
      ],
    ],
    sweepDeg,
    name,
  );
}
