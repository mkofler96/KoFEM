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
export const SCREW_PROFILE_ENLARGEMENT = niceBelow(6 / deepest);

const PANEL = 150;
const X = scale([-screw.model.halfWidth, screw.model.halfWidth], [50, 630]);
const PX = (X(1) - X(0)) / 1; // pixels per mm, both directions

/** Hatched clamps outside the plate's two edges, over its thickness. */
function edgeClamps(zTop, zBottom) {
  const parts = [];
  for (const [x0, x1] of [
    [X(-screw.model.halfWidth) - 12, X(-screw.model.halfWidth)],
    [X(screw.model.halfWidth), X(screw.model.halfWidth) + 12],
  ])
    parts.push(
      polygon(
        [
          [x0, zTop - 8],
          [x1, zTop - 8],
          [x1, zBottom + 8],
          [x0, zBottom + 8],
        ],
        "hatch-fill",
      ),
    );
  return parts.join("");
}

/**
 * One panel of the section through the screw axis, seen from −y: the cut
 * face with a structured grid, the back half of the bore through the hole,
 * the coupling's legs to the ring (on the cut, and fainter behind it) and the
 * force on the point. `kind` null draws the undeformed model.
 */
function sectionPanel(kind, top, heading) {
  const { thickness: t, holeRadius: a } = screw.model;
  const { xs, zs, phis, ringRadii } = screw.grid;
  const E = kind ? SCREW_PROFILE_ENLARGEMENT : 0;
  const data = kind ? screw.kinds[kind] : null;
  const zBase = top + 115; // pixel row of z = 0
  const P = (x, z, u = [0, 0, 0]) => [
    X(x + E * u[0]),
    zBase - PX * (z + E * u[2]),
  ];
  const u = (table, i, j) => (data ? data[table][i][j] : [0, 0, 0]);
  const rad = (deg) => (deg * Math.PI) / 180;
  const parts = [
    text([50, top + 20], heading, "title", "start"),
    edgeClamps(zBase - PX * t, zBase),
  ];
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
          'style="stroke-width:0.6"',
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
          'style="stroke-width:1" opacity="0.45"',
        ),
      );
    }),
  );
  // The cut face: a structured grid on each side of the hole.
  const half = xs.length / 2;
  for (const side of [0, 1]) {
    const columns = side === 0 ? [0, half] : [half, xs.length];
    for (let i = 0; i + 1 < zs.length; i++)
      for (let j = columns[0]; j + 1 < columns[1]; j++) {
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
            'style="stroke-width:0.7"',
          ),
        );
      }
  }
  // Legs on the cut, to the ring's nodes on the top face.
  const top_ = zs.length - 1;
  xs.forEach((x, j) => {
    if (Math.abs(x) <= screw.model.headRadius + 1e-9)
      parts.push(
        line(
          ref,
          P(x, t, u("section", top_, j)),
          "accent3",
          'style="stroke-width:1.6"',
        ),
      );
  });
  parts.push(
    circle(ref, 4.5, "node-accent"),
    arrow([ref[0], ref[1] + 6], [ref[0], ref[1] + 34], "load"),
    text([ref[0] + 9, ref[1] + 32], "F", "sym load-text", "start"),
  );
  return parts.join("");
}

function screwSections() {
  return [
    sectionPanel(
      null,
      0,
      "Undeformed: the point is coupled to the head’s ring",
    ),
    sectionPanel("kinematic", PANEL, "Kinematic (RBE2): the ring stays flat"),
    sectionPanel(
      "distributing",
      2 * PANEL,
      "Distributing (RBE3): the ring bends with the plate",
    ),
    text(
      [630, 3 * PANEL + 12],
      `section y = 0 · displacements enlarged ${SCREW_PROFILE_ENLARGEMENT}×`,
      "small lbl",
      "end",
    ),
  ].join("");
}

/**
 * How a bolt becomes a coupling: the head, shank and nut on the left; on the
 * right the bolt is gone, its head's ring is coupled to a point on the axis,
 * and the bolt's force acts on the point.
 */
function boltIdealisation() {
  const parts = [];
  const plate = (x0, w, holeHalf, yTop, thickness) => {
    for (const [a, b] of [
      [x0, x0 + w / 2 - holeHalf],
      [x0 + w / 2 + holeHalf, x0 + w],
    ])
      parts.push(
        polygon(
          [
            [a, yTop],
            [b, yTop],
            [b, yTop + thickness],
            [a, yTop + thickness],
          ],
          "body",
        ),
      );
  };
  // Left: the real joint, two plates clamped by a bolt.
  const cx = 160;
  plate(40, 240, 12, 90, 30);
  plate(40, 240, 12, 120, 30);
  parts.push(
    // Head and washer above, nut below, shank through the hole.
    polygon(
      [
        [cx - 30, 72],
        [cx + 30, 72],
        [cx + 30, 90],
        [cx - 30, 90],
      ],
      "side",
    ),
    polygon(
      [
        [cx - 22, 52],
        [cx + 22, 52],
        [cx + 22, 72],
        [cx - 22, 72],
      ],
      "side",
    ),
    polygon(
      [
        [cx - 9, 90],
        [cx + 9, 90],
        [cx + 9, 178],
        [cx - 9, 178],
      ],
      "side",
    ),
    polygon(
      [
        [cx - 30, 150],
        [cx + 30, 150],
        [cx + 30, 168],
        [cx - 30, 168],
      ],
      "side",
    ),
    polygon(
      [
        [cx - 22, 168],
        [cx + 22, 168],
        [cx + 22, 186],
        [cx - 22, 186],
      ],
      "side",
    ),
    text([cx + 34, 64], "head", "small lbl", "start"),
    text([cx + 34, 84], "washer", "small lbl", "start"),
    text([cx + 34, 182], "nut", "small lbl", "start"),
    text([cx, 222], "The bolt as built", "title"),
  );
  // The arrow between.
  parts.push(
    arrow([300, 120], [350, 120], "muted"),
    text([325, 110], "model", "small lbl"),
  );
  // Right: the upper plate with the bolt removed.
  const rx = 490;
  plate(370, 240, 12, 90, 30);
  const ref = [rx, 105];
  for (const dx of [-30, -22, -14, 14, 22, 30])
    parts.push(line(ref, [rx + dx, 90], "accent3", 'style="stroke-width:1.6"'));
  parts.push(
    line(
      [rx - 30, 90],
      [rx - 12, 90],
      "accent3",
      'style="stroke-width:4" opacity="0.5"',
    ),
    line(
      [rx + 12, 90],
      [rx + 30, 90],
      "accent3",
      'style="stroke-width:4" opacity="0.5"',
    ),
    circle(ref, 4.5, "node-accent"),
    arrow([rx, 112], [rx, 160], "load"),
    text([rx + 9, 156], "F", "sym load-text", "start"),
    text(
      [rx + 40, 70],
      "ring under the head",
      "small",
      "start",
      `style="fill:${palette.accent3}"`,
    ),
    line([rx + 38, 74], [rx + 24, 88], "dim"),
    text([rx - 40, 140], "reference point", "small lbl", "end"),
    line([rx - 38, 136], [rx - 6, 108], "dim"),
    text([rx, 222], "The bolt as a coupling", "title"),
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
    alt: "Left: two plates clamped by a bolt, with its head and washer on top, the shank through the hole and a nut below. Right: the upper plate alone with the bolt removed; a reference point on the bolt's axis is joined by legs to the ring of the top face under the head, and the bolt's force acts downward on the point.",
    width: 640,
    height: 240,
    body: boltIdealisation(),
  },
  {
    id: "coupling-screw-sections",
    title:
      "A screw head coupled to its bearing ring: undeformed, kinematic and distributing",
    alt: "Three sections through a plate clamped at its edges, cut through the screw axis, each with a structured grid on the cut face and the back half of the hole visible between the two sides. A point on the axis is joined by legs to the ring of the top face around the hole and carries the screw force. Undeformed, the plate is flat. With a kinematic coupling the ring stays flat and the plate bends away from its outer edge. With a distributing coupling the ring bends with the plate, deepest at the hole edge.",
    width: 680,
    height: 3 * PANEL + 20,
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
