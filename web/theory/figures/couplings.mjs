// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Figures for the coupling article, drawn from its recorded solves
// (public/theory/couplings.json, written by
// numerical-methods/coupling-evidence.mjs): the deformed top face of the
// screw-head plate through the screw axis, with the coupling's legs, and the
// largest stress along the bar in torsion.

import { readFileSync } from "node:fs";
import {
  arrow,
  circle,
  line,
  palette,
  polygon,
  polyline,
  scale,
  text,
} from "./svg.mjs";

const record = JSON.parse(
  readFileSync(
    new URL("../../public/theory/couplings.json", import.meta.url),
    "utf8",
  ),
);
const { screw, bar } = record;

const niceBelow = (value) => {
  const power = 10 ** Math.floor(Math.log10(value));
  return [5, 2, 1].map((m) => m * power).find((v) => v <= value);
};

const deepest = Math.max(
  ...Object.values(screw.kinds).flatMap((kind) =>
    kind.section.flat().map(([, , uz]) => -uz),
  ),
);
/** Drawn displacement = this × computed displacement (mm per mm). */
export const SCREW_PROFILE_ENLARGEMENT = niceBelow(1.2 / deepest);

// A second hatch direction, for the second part of a section drawing.
const HATCH_BACK = `<defs><pattern id="hatch-back" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${palette.muted}" stroke-width="1.2"/></pattern></defs>`;

const hatched = (points, back = false) =>
  polygon(points, "body") +
  polygon(points, "", `style="fill:url(#${back ? "hatch-back" : "hatch"})"`);

const REACH = Math.max(...screw.grid.xs);
const PANEL = 205;
const X = scale([-REACH, REACH], [70, 610]);
const PX = X(1) - X(0); // pixels per mm, both directions

/** A zigzag break line from `from` to `to`: where the drawing is cut off. */
function breakLine(from, to) {
  const steps = 6;
  const points = Array.from({ length: steps + 1 }, (_, k) => {
    const t = k / steps;
    const offset = k === 0 || k === steps ? 0 : k % 2 ? 4 : -4;
    return [
      from[0] + t * (to[0] - from[0]) + offset,
      from[1] + t * (to[1] - from[1]),
    ];
  });
  return polyline(points, "ink", 'style="stroke-width:1.1"');
}

/**
 * One panel of the section through the screw axis, around the hole, seen
 * from −y: the cut face with a structured grid, the back half of the bore
 * through the hole, the fixed base under the plate, the coupling's legs to
 * the ring (on the cut, and fainter behind it) and the force on the point.
 * `kind` null draws the undeformed model.
 */
function sectionPanel(kind, top, heading) {
  const { thickness: t, holeRadius: a, headRadius: r } = screw.model;
  const { xs, zs, phis, ringRadii } = screw.grid;
  const E = kind ? SCREW_PROFILE_ENLARGEMENT : 0;
  const data = kind ? screw.kinds[kind] : null;
  const zBase = top + 48 + PX * t; // pixel row of z = 0
  const P = (x, z, u = [0, 0, 0]) => [
    X(x + E * u[0]),
    zBase - PX * (z + E * u[2]),
  ];
  const u = (table, i, j) => (data ? data[table][i][j] : [0, 0, 0]);
  const rad = (deg) => (deg * Math.PI) / 180;
  const parts = [text([70, top + 20], heading, "title", "start")];
  // The rigid base the plate's lower face is fixed to.
  parts.push(
    polygon(
      [
        [X(-REACH) - 6, zBase],
        [X(REACH) + 6, zBase],
        [X(REACH) + 6, zBase + 12],
        [X(-REACH) - 6, zBase + 12],
      ],
      "hatch-fill",
    ),
    line([X(-REACH) - 6, zBase], [X(REACH) + 6, zBase], "ground"),
  );
  // The back of the bore, seen through the hole: facet strips at 15° steps.
  for (let j = 0; j + 1 < phis.length; j++)
    for (let i = 0; i + 1 < zs.length; i++) {
      const corner = (jj, ii) =>
        P(a * Math.cos(rad(phis[jj])), zs[ii], u("boreBack", ii, jj));
      parts.push(
        polygon(
          [
            corner(j, i),
            corner(j + 1, i),
            corner(j + 1, i + 1),
            corner(j, i + 1),
          ],
          "side",
          'style="stroke-width:0.5"',
        ),
      );
    }
  // Legs behind the cut, to the ring on the top face beyond the hole.
  const ref = P(0, t / 2, data ? [0, 0, -data.pointDeflection] : undefined);
  ringRadii.forEach((radius, ri) =>
    phis.forEach((phi, j) => {
      if (phi === 0 || phi === 180 || j % 2 === 1) return;
      parts.push(
        line(
          ref,
          P(radius * Math.cos(rad(phi)), t, u("ringBack", ri, j)),
          "accent3",
          'style="stroke-width:0.9" opacity="0.4"',
        ),
      );
    }),
  );
  // The cut face: a structured grid on each side of the hole.
  const half = xs.length / 2;
  for (const [first, last] of [
    [0, half],
    [half, xs.length],
  ])
    for (let i = 0; i + 1 < zs.length; i++)
      for (let j = first; j + 1 < last; j++) {
        const corner = (jj, ii) => P(xs[jj], zs[ii], u("section", ii, jj));
        parts.push(
          polygon(
            [
              corner(j, i),
              corner(j + 1, i),
              corner(j + 1, i + 1),
              corner(j, i + 1),
            ],
            "body",
            'style="stroke-width:0.45"',
          ),
        );
      }
  // Where the drawing is cut off, away from the hole.
  for (const j of [0, xs.length - 1])
    parts.push(
      breakLine(
        P(xs[j], t, u("section", zs.length - 1, j)),
        P(xs[j], 0, u("section", 0, j)),
      ),
    );
  // Legs on the cut, to the ring's nodes on the top face.
  xs.forEach((x, j) => {
    if (Math.abs(x) <= r + 1e-9)
      parts.push(
        line(
          ref,
          P(x, t, u("section", zs.length - 1, j)),
          "accent3",
          'style="stroke-width:1.5"',
        ),
      );
  });
  parts.push(
    circle(ref, 4.5, "node-accent"),
    arrow([ref[0], ref[1] + 6], [ref[0], ref[1] + 40], "load"),
    text([ref[0] - 9, ref[1] + 38], "F", "sym load-text", "end"),
  );
  return parts.join("");
}

function screwSections() {
  return [
    HATCH_BACK,
    sectionPanel(
      null,
      0,
      "Undeformed: the point is coupled to the head’s ring",
    ),
    sectionPanel(
      "kinematic",
      PANEL,
      "Kinematic (RBE2): the ring is pressed in flat",
    ),
    sectionPanel(
      "distributing",
      2 * PANEL,
      "Distributing (RBE3): the ring dishes, deepest at the hole",
    ),
    text(
      [610, 3 * PANEL + 14],
      `section y = 0 · lower face fixed · displacements enlarged ${SCREW_PROFILE_ENLARGEMENT}×`,
      "small lbl",
      "end",
    ),
  ].join("");
}

/** A hexagon seen across its flats' side: three faces, chamfered top and bottom. */
function hexSide(
  cx,
  y0,
  y1,
  half,
  { chamferTop = true, chamferBottom = true } = {},
) {
  const c = 4;
  const outline = [
    [cx - half, chamferBottom ? y1 - c : y1],
    [cx - half, chamferTop ? y0 + c : y0],
    [cx - half + (chamferTop ? c : 0), y0],
    [cx + half - (chamferTop ? c : 0), y0],
    [cx + half, chamferTop ? y0 + c : y0],
    [cx + half, chamferBottom ? y1 - c : y1],
    [cx + half - (chamferBottom ? c : 0), y1],
    [cx - half + (chamferBottom ? c : 0), y1],
  ];
  const parts = [polygon(outline, "body-alt")];
  // The two edges between the faces, and the chamfer arcs on each face.
  for (const x of [cx - half / 2, cx + half / 2])
    parts.push(
      line(
        [x, y0 + (chamferTop ? 2 : 0)],
        [x, y1 - (chamferBottom ? 2 : 0)],
        "thin",
      ),
    );
  const arcs = (y, dir) =>
    [
      [cx - half, cx - half / 2],
      [cx - half / 2, cx + half / 2],
      [cx + half / 2, cx + half],
    ]
      .map(
        ([xa, xb]) =>
          `<path d="M${xa} ${y + dir * c} Q${(xa + xb) / 2} ${y - dir * 1} ${xb} ${y + dir * c}" class="thin"/>`,
      )
      .join("");
  if (chamferTop) parts.push(arcs(y0, 1));
  if (chamferBottom) parts.push(arcs(y1, -1));
  return parts.join("");
}

/**
 * How a bolt becomes a coupling: on the left a section through a bolted
 * joint (head, washer, threaded shank, nut, two plates); on the right the
 * model — the upper part on a fixed base, the bolt gone, the ring its head
 * bears on coupled to a point on its axis, and the bolt's force on the point.
 */
function boltIdealisation() {
  const parts = [HATCH_BACK];
  const cx = 175;
  const hole = 12; // clearance hole radius (px)
  const shank = 10; // bolt radius
  const plates = [
    [104, 140, false],
    [140, 188, true],
  ];
  for (const [y0, y1, back] of plates)
    for (const [x0, x1] of [
      [40, cx - hole],
      [cx + hole, 310],
    ])
      parts.push(
        hatched(
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
          back,
        ),
      );
  // Shank through both plates, thread from below the joint line to the end.
  const end = 236;
  parts.push(
    polygon(
      [
        [cx - shank, 96],
        [cx + shank, 96],
        [cx + shank, end - 3],
        [cx + shank - 3, end],
        [cx - shank + 3, end],
        [cx - shank, end - 3],
      ],
      "body-alt",
    ),
    line([cx - shank + 2.5, 160], [cx - shank + 2.5, end], "thin"),
    line([cx + shank - 2.5, 160], [cx + shank - 2.5, end], "thin"),
    line([cx - shank, 160], [cx + shank, 160], "ink"),
    // Washers and nut, head on top.
    polygon(
      [
        [cx - 27, 97],
        [cx + 27, 97],
        [cx + 27, 104],
        [cx - 27, 104],
      ],
      "body-alt",
    ),
    polygon(
      [
        [cx - 27, 188],
        [cx + 27, 188],
        [cx + 27, 195],
        [cx - 27, 195],
      ],
      "body-alt",
    ),
    hexSide(cx, 74, 97, 24, { chamferBottom: false }),
    hexSide(cx, 195, 222, 24),
    line([cx, 64], [cx, 246], "dash", 'style="stroke-dasharray:10 3 2 3"'),
  );
  const label = (from, to, words, anchor = "start") =>
    line(from, to, "dim") +
    text(
      [to[0] + (anchor === "start" ? 4 : -4), to[1] + 4],
      words,
      "small lbl",
      anchor,
    );
  parts.push(
    label([cx + 20, 80], [cx + 60, 64], "hex head"),
    label([cx + 26, 100], [cx + 70, 92], "washer"),
    label([cx + shank, 205 - 20], [cx + 70, 176 - 12], "thread"),
    label([cx + 22, 214], [cx + 70, 230], "nut"),
    label([90, 126], [60, 72], "plates", "start"),
    text([cx, 274], "The bolted joint", "title"),
  );

  parts.push(
    arrow([328, 150], [368, 150], "muted"),
    text([348, 140], "model", "small lbl"),
  );

  // Right: the upper part on a fixed base; the bolt replaced by a coupling.
  const rx = 520;
  for (const [x0, x1] of [
    [395, rx - hole],
    [rx + hole, 650],
  ])
    parts.push(
      hatched([
        [x0, 104],
        [x1, 104],
        [x1, 140],
        [x0, 140],
      ]),
    );
  parts.push(
    polygon(
      [
        [390, 140],
        [655, 140],
        [655, 152],
        [390, 152],
      ],
      "hatch-fill",
    ),
    line([390, 140], [655, 140], "ground"),
    line([rx, 64], [rx, 160], "dash", 'style="stroke-dasharray:10 3 2 3"'),
  );
  const ref = [rx, 122];
  for (const dx of [hole, 18, 24])
    for (const side of [-1, 1])
      parts.push(
        line(ref, [rx + side * dx, 104], "accent3", 'style="stroke-width:1.5"'),
      );
  for (const side of [-1, 1])
    parts.push(
      line(
        [rx + side * hole, 104],
        [rx + side * 24, 104],
        "accent3",
        'style="stroke-width:4" opacity="0.55"',
      ),
    );
  parts.push(
    circle(ref, 4.5, "node-accent"),
    arrow([rx, 52], [rx, 114], "load"),
    text([rx + 8, 62], "F", "sym load-text", "start"),
    label([rx + 21, 103], [rx + 46, 82], "coupled ring", "start"),
    label([rx - 5, 124], [rx - 70, 176], "reference point", "end"),
    label([440, 150], [450, 196], "lower face fixed"),
    text([rx, 274], "The bolt as a coupling", "title"),
  );
  return parts.join("");
}

function torsionDecay() {
  const { length } = bar.model;
  const sv = bar.theory.saintVenantVonMises;
  const peaks = Object.values(bar.torsion).flatMap((kind) =>
    kind.bandPeaks.map(([, v]) => v),
  );
  const top = Math.ceil(Math.max(...peaks, sv) / 20) * 20;
  const X = scale([0, length], [80, 620]);
  const Y = scale([0, top], [270, 30]);
  const parts = [];
  for (let v = 0; v <= top; v += 20)
    parts.push(
      line([80, Y(v)], [620, Y(v)], "grid"),
      text([72, Y(v) + 4], String(v), "small lbl", "end"),
    );
  for (let z = 0; z <= length; z += 50)
    parts.push(
      line([X(z), 270], [X(z), 275], "thin"),
      text([X(z), 290], String(z), "small lbl"),
    );
  parts.push(
    line([80, 270], [620, 270], "axis"),
    line([80, 30], [80, 270], "axis"),
    text([350, 316], "distance from the clamped root z (mm)", "lbl"),
    text(
      [26, 150],
      "largest von Mises (MPa)",
      "lbl",
      "middle",
      'transform="rotate(-90 26 150)"',
    ),
    line([80, Y(sv)], [620, Y(sv)], "dash", `style="stroke:${palette.load}"`),
    text(
      [84, Y(sv) - 6],
      "Saint-Venant, surface value",
      "small load-text",
      "start",
    ),
  );
  const curve = (kind, cls, extra = "") =>
    polyline(
      bar.torsion[kind].bandPeaks.map(([z, v]) => [X(z), Y(v)]),
      cls,
      extra,
    );
  // Kinematic dashed on top: the two lie on one curve along most of the bar.
  parts.push(
    curve("distributing", "accent2"),
    curve("kinematic", "accent", 'stroke-dasharray="6 4"'),
    line([330, 48], [360, 48], "accent2"),
    text([366, 52], "distributing (RBE3)", "small accent2-text", "start"),
    line([330, 66], [360, 66], "accent", 'stroke-dasharray="6 4"'),
    text([366, 70], "kinematic (RBE2)", "small accent-text", "start"),
    text([604, 262], "coupled tip", "small lbl", "end"),
  );
  return parts.join("");
}

export default [
  {
    id: "coupling-bolt-idealisation",
    title: "A bolt replaced by a coupling",
    alt: "Left: a section through a bolted joint: two hatched plates clamped by a bolt with a hex head and washer on top, a threaded shank through the clearance hole, and a washer and nut below. Right: the model: the upper plate alone on a fixed base, the bolt removed, and a reference point on the bolt's axis joined by legs to the ring of the top face under the head, with the bolt's force on the point.",
    width: 680,
    height: 290,
    body: boltIdealisation(),
  },
  {
    id: "coupling-screw-sections",
    title:
      "A screw head coupled to its bearing ring: undeformed, kinematic and distributing",
    alt: "Three sections around the hole of a plate whose lower face is fixed, cut through the screw axis, each with a fine structured grid on the cut face and the back half of the hole visible between the two sides. A point on the axis is joined by legs to the ring of the top face around the hole and carries the screw force. Undeformed, the plate is flat. With a kinematic coupling the ring is pressed in flat. With a distributing coupling the ring dishes, deepest at the hole edge.",
    width: 680,
    height: 3 * PANEL + 24,
    body: screwSections(),
  },
  {
    id: "coupling-torsion-decay",
    title: "Largest stress along a bar twisted through a coupled end face",
    alt: "The largest element von Mises stress in each five-millimetre slice of a square bar in torsion, plotted against the distance from the clamped root. The kinematic and distributing curves lie on top of each other along the bar and part only in the last ten millimetres before the coupled tip, where the distributing coupling's stress rises well above the Saint-Venant value and the kinematic coupling's falls below it.",
    width: 640,
    height: 325,
    body: torsionDecay(),
  },
];
