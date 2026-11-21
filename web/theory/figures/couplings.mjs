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

/**
 * Drawn displacement = this × computed displacement (mm per mm). The drawing
 * is a schematic, so it enlarges more than the result viewers do: the
 * deepest point of the section sinks at most 3 mm, half the plate's
 * thickness, so no cell of the grid folds over.
 */
export const SCREW_PROFILE_ENLARGEMENT = niceBelow(
  3 /
    Math.max(
      ...Object.values(screw.kinds).flatMap((kind) =>
        [...kind.section, ...kind.boreBack].flat().map(([, , uz]) => -uz),
      ),
    ),
);

// A second hatch direction, for the second part of a section drawing.
const HATCH_BACK = `<defs><pattern id="hatch-back" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><line x1="0" y1="0" x2="0" y2="7" stroke="${palette.muted}" stroke-width="1.2"/></pattern></defs>`;

const hatched = (points, back = false) =>
  polygon(points, "body") +
  polygon(points, "", `style="fill:url(#${back ? "hatch-back" : "hatch"})"`);

const REACH = Math.max(...screw.grid.xs);
const PANEL = 250;
const X = scale([-REACH, REACH], [70, 610]);
const PX = X(1) - X(0); // pixels per mm, both directions

/**
 * One panel of the section through the screw axis, around the hole, seen
 * from −y: the cut face with a structured grid, the back half of the bore
 * through the hole, the fixed base under the plate, the coupled ring with
 * the coupling's legs to its nodes on the cut, and the force on the point,
 * which sits on the axis at the height of the top face.
 * `kind` null draws the undeformed model.
 */
function sectionPanel(kind, top, heading) {
  const { thickness: t, holeRadius: a, headRadius: r } = screw.model;
  const { xs, zs, phis } = screw.grid;
  const E = kind ? SCREW_PROFILE_ENLARGEMENT : 0;
  const data = kind ? screw.kinds[kind] : null;
  const zBase = top + 72 + PX * t; // pixel row of z = 0
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
  // Where the drawing is cut off, away from the hole: a plain edge that
  // follows the deformed grid.
  for (const j of [0, xs.length - 1])
    parts.push(
      polyline(
        zs.map((z, i) => P(xs[j], z, u("section", i, j))),
        "ink",
        'style="stroke-width:1.1"',
      ),
    );
  // The coupled ring on the cut, its nodes, and the legs from the point.
  const ref = P(0, t, data ? [0, 0, -data.pointDeflection] : undefined);
  const ringTop = (side) =>
    xs
      .map((x, j) => [x, j])
      .filter(([x]) => Math.sign(x) === side && Math.abs(x) <= r + 1e-9)
      .map(([x, j]) => P(x, t, u("section", zs.length - 1, j)));
  for (const side of [-1, 1]) {
    const nodes = ringTop(side);
    parts.push(
      polyline(
        nodes,
        "accent3",
        'style="stroke-width:6" opacity="0.35" stroke-linecap="round"',
      ),
    );
    for (const node of nodes)
      parts.push(
        line(ref, node, "accent3", 'style="stroke-width:1.1"'),
        `<circle cx="${node[0]}" cy="${node[1]}" r="2.3" style="fill:${palette.accent3}"/>`,
      );
  }
  parts.push(
    circle(ref, 4.5, "node-accent"),
    arrow([ref[0], ref[1] - 40], [ref[0], ref[1] - 7], "load"),
    text([ref[0] + 8, ref[1] - 26], "F", "sym load-text", "start"),
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

/** A leader line from `from` to `to`, with its words just past `to`. */
const label = (from, to, words, anchor = "start") =>
  line(from, to, "dim") +
  text(
    [to[0] + (anchor === "start" ? 4 : -4), to[1] + 4],
    words,
    "small lbl",
    anchor,
  );

/** A rectangle from its corners. */
const box = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * How a bolt becomes a coupling: on the left a section through a bolted
 * joint (head and washer, threaded shank, washer and nut, two plates); on the
 * right the model at the same scale — the upper plate on a fixed base, the
 * bolt gone, the ring its washer bears on coupled to a point on the bolt's
 * axis at the height of the top face, and the bolt's force on the point.
 */
function boltIdealisation() {
  const parts = [HATCH_BACK];
  const hole = 18; // clearance hole radius (px)
  const shank = 15; // bolt radius
  const washer = 40; // washer radius: the ring the joint bears on
  const top = 120; // top face of the upper plate
  const plate = 40; // plate thickness

  // Left: the bolted joint.
  const cx = 165;
  for (const [y0, back] of [
    [top, false],
    [top + plate, true],
  ])
    for (const [x0, x1] of [
      [25, cx - hole],
      [cx + hole, 305],
    ])
      parts.push(hatched(box(x0, y0, x1, y0 + plate), back));
  const bottom = top + 2 * plate;
  const end = bottom + 52; // the shank's end, past the nut
  const threadFrom = top + plate + 12;
  parts.push(
    polygon(
      [
        [cx - shank, top - 20],
        [cx + shank, top - 20],
        [cx + shank, end - 3],
        [cx + shank - 3, end],
        [cx - shank + 3, end],
        [cx - shank, end - 3],
      ],
      "body-alt",
    ),
    line([cx - shank + 3, threadFrom], [cx - shank + 3, end], "thin"),
    line([cx + shank - 3, threadFrom], [cx + shank - 3, end], "thin"),
    line([cx - shank, threadFrom], [cx + shank, threadFrom], "ink"),
    polygon(box(cx - washer, top - 7, cx + washer, top), "body-alt"),
    polygon(box(cx - washer, bottom, cx + washer, bottom + 7), "body-alt"),
    hexSide(cx, top - 33, top - 7, 36, { chamferBottom: false }),
    hexSide(cx, bottom + 7, bottom + 37, 36),
    line(
      [cx, top - 45],
      [cx, end + 10],
      "dash",
      'style="stroke-dasharray:10 3 2 3"',
    ),
    label([cx - 30, top - 24], [cx - 72, top - 40], "hex head", "end"),
    label([cx - 38, top - 3], [cx - 72, top - 14], "washer", "end"),
    label([cx + 34, bottom + 22], [cx + 70, bottom + 22], "nut"),
    label([cx + shank - 3, end - 8], [cx + 70, end - 2], "thread"),
    label([60, bottom - 4], [30, bottom + 30], "clamped plates"),
    text([cx, 292], "The bolted joint", "title"),
  );

  parts.push(
    arrow([322, top + plate], [366, top + plate], "muted"),
    text([344, top + plate - 10], "model", "small lbl"),
  );

  // Right: the upper plate on a fixed base; the bolt replaced by a coupling.
  const rx = 525;
  for (const [x0, x1] of [
    [385, rx - hole],
    [rx + hole, 665],
  ])
    parts.push(hatched(box(x0, top, x1, top + plate)));
  parts.push(
    polygon(box(380, top + plate, 670, top + plate + 12), "hatch-fill"),
    line([380, top + plate], [670, top + plate], "ground"),
    line(
      [rx, top + 6],
      [rx, top + plate + 22],
      "dash",
      'style="stroke-dasharray:10 3 2 3"',
    ),
  );
  const ref = [rx, top];
  const ringNodes = [0, 1, 2, 3].map((k) => hole + (k * (washer - hole)) / 3);
  for (const side of [-1, 1]) {
    parts.push(
      line(
        [rx + side * hole, top],
        [rx + side * washer, top],
        "accent3",
        'style="stroke-width:6" opacity="0.35"',
      ),
      line(
        ref,
        [rx + side * washer, top],
        "accent3",
        'style="stroke-width:1.5"',
      ),
    );
    for (const dx of ringNodes)
      parts.push(
        `<circle cx="${rx + side * dx}" cy="${top}" r="2.6" style="fill:${palette.accent3}"/>`,
      );
  }
  parts.push(
    circle(ref, 4.5, "node-accent"),
    arrow([rx, top - 64], [rx, top - 7], "load"),
    text([rx + 8, top - 50], "F", "sym load-text", "start"),
    label([rx - 6, top - 4], [rx - 50, top - 28], "reference point", "end"),
    label([rx + 32, top - 3], [rx + 66, top - 28], "coupled ring"),
    label([420, top + plate + 10], [432, top + plate + 36], "lower face fixed"),
    text([rx, 292], "The bolt as a coupling", "title"),
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
    alt: "Left: a section through a bolted joint: two hatched plates of equal thickness clamped by a bolt with a hex head and washer on top, a shank through the clearance hole, threaded below the joint, and a washer and nut below. Right: the model: the upper plate alone on a fixed base, the bolt removed, and a reference point on the bolt's axis, at the height of the top face, joined by legs to the ring of the top face under the washer, with the bolt's force on the point.",
    width: 680,
    height: 310,
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
    alt: "The largest element von Mises stress in each five-millimetre slice of a square bar in torsion, plotted against the distance from the clamped root. The kinematic and distributing curves lie on top of each other along the bar and part only in the last ten millimetres before the coupled tip, where the distributing coupling's stress rises above the value along the bar and the kinematic coupling's falls below it.",
    width: 640,
    height: 325,
    body: torsionDecay(),
  },
];
