// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Minimal STEP (AP214) writer for a straight prism: a simple polygon in the xy
// plane extruded along +z. Every polygon edge becomes its own planar side face,
// so extra polygon vertices on a straight edge split that side into separate CAD
// faces — which is how the gallery examples get pickable support and load pads
// on an otherwise plain block. The B-rep uses plain LINE edge curves and PLANE
// surfaces; OCCT rebuilds the p-curves on import.

/**
 * @param {[number, number][]} polygon  vertices in counter-clockwise order (seen from +z)
 * @param {number} depth                extrusion length along +z (mm)
 * @param {string} name                 product name written into the file
 * @returns {string} the STEP file text
 */
export function prismStep(polygon, depth, name) {
  const lines = [];
  let next = 1;
  const add = (entity) => {
    const id = next++;
    lines.push(`#${id} = ${entity};`);
    return id;
  };
  const num = (v) => {
    const s = String(v);
    return s.includes(".") || s.includes("e") ? s : `${s}.`;
  };
  const point = (p) => add(`CARTESIAN_POINT('',(${p.map(num).join(",")}))`);
  const dir = (d) => add(`DIRECTION('',(${d.map(num).join(",")}))`);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const unit = (v) => {
    const len = Math.hypot(...v);
    return v.map((c) => c / len);
  };

  const n = polygon.length;
  const bottom = polygon.map(([x, y]) => [x, y, 0]);
  const top = polygon.map(([x, y]) => [x, y, depth]);
  const vtx = (p) => add(`VERTEX_POINT('',#${point(p)})`);
  const vb = bottom.map(vtx);
  const vt = top.map(vtx);

  const edge = (va, vb2, pa, pb) => {
    const d = sub(pb, pa);
    const vector = add(`VECTOR('',#${dir(unit(d))},${num(Math.hypot(...d))})`);
    const line = add(`LINE('',#${point(pa)},#${vector})`);
    return add(`EDGE_CURVE('',#${va},#${vb2},#${line},.T.)`);
  };
  const eb = [];
  const et = [];
  const ev = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    eb.push(edge(vb[i], vb[j], bottom[i], bottom[j]));
    et.push(edge(vt[i], vt[j], top[i], top[j]));
    ev.push(edge(vb[i], vt[i], bottom[i], top[i]));
  }

  const oriented = (e, forward) =>
    add(`ORIENTED_EDGE('',*,*,#${e},${forward ? ".T." : ".F."})`);
  // A planar face whose normal points out of the solid, bounded by a loop that
  // runs counter-clockwise about that normal.
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
    `FILE_NAME('${name}','2026-01-01T00:00:00',('KoFEM'),('KoFEM'),'KoFEM examples/web-examples/step-prism.mjs','KoFEM','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    ...lines,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
