// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The analysis report's document (KOF-391): each body states its element
// family (a shell with its thickness), and a report that would have to make
// up a value refuses instead.

import { describe, expect, test } from "bun:test";
import {
  buildReport,
  type ReportInput,
} from "../../src/lib/report/buildReport";
import { renderReport } from "../../src/lib/report/renderReport";
import type {
  Element,
  Property,
  SolverResult,
  SolveRun,
} from "../../src/store/modelStore";

const steel = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
  color: "#4e79a7",
};

const run = (path: SolveRun["path"]): SolveRun => ({
  path,
  preconditioner: "amg",
  elementOrder: 1,
  warnings: [],
});

const result = (solveRun?: SolveRun): SolverResult => ({
  displacements: new Float64Array(12),
  vonMises: new Float64Array(1),
  run: solveRun,
  reactions: {
    supports: [
      {
        support: 0,
        force: [0, 10, 0],
        moment: [0, 0, 0],
        centroid: [0, 0, 0],
        vertices: 3,
      },
    ],
    nodal: [],
    applied: [0, -10, 0],
    appliedOnSupports: [0, 0, 0],
  },
});

const element = (
  id: number,
  type: Element["type"],
  propertyId: number,
): Element => ({
  id,
  type,
  nodeIds: type === "CTRIA3" ? [1, 2, 3] : [1, 2, 3, 4],
  propertyId,
});

function input(
  properties: Property[],
  elements: Element[],
  solved: SolverResult | null,
): ReportInput {
  return {
    modelName: "Bracket",
    createdAt: "25 November 2026",
    version: "dev",
    nodes: [1, 2, 3, 4].map((id) => ({ id, x: id, y: 0, z: 0 })),
    elements,
    properties,
    materials: [steel],
    bcGroups: [
      {
        id: 1,
        name: "Clamp",
        dofs: [0, 1, 2],
        value: 0,
        faces: [{ id: 1, label: "Face 1", nodeIds: [1] }],
      },
    ],
    loadGroups: [
      {
        id: 1,
        name: "Tip",
        dof: 1,
        totalForce: -10,
        components: [0, -10, 0],
        kind: "force",
        faces: [{ id: 2, label: "Face 2", nodeIds: [4] }],
      },
    ],
    temperature: null,
    meshSizes: { max: 5, min: 0.5, regions: {} },
    result: solved,
    stats: { maxDisplacement: 1.5, maxVonMises: 200, p99VonMises: 150 },
    figures: { current: "data:image/png;base64,AA", isometric: "data:x" },
    legend: {
      title: "|U| [mm]",
      min: 0,
      max: 1.5,
      clampsAbove: false,
      clampsBelow: false,
    },
    figureField: "Displacement (magnitude)",
  };
}

describe("the report's bodies", () => {
  test("a solid body is solid, with its element count", () => {
    const doc = buildReport(
      input(
        [{ id: 1, materialId: 1 }],
        [element(1, "CTETRA", 1), element(2, "CTETRA", 1)],
        result(run("solid")),
      ),
    );
    expect(doc.bodies).toHaveLength(1);
    expect(doc.bodies[0]).toMatchObject({
      name: "Body 1",
      family: "solid",
      thickness: null,
      elementType: "Solid, tetrahedra",
      elementCount: 2,
    });
  });

  test("a shell body states its thickness", () => {
    const doc = buildReport(
      input(
        [{ id: 1, materialId: 1, thickness: 2.5 }],
        [element(1, "CTRIA3", 1)],
        result(run("shell")),
      ),
    );
    expect(doc.bodies[0]).toMatchObject({
      family: "shell",
      thickness: 2.5,
      elementType: "Shell, triangles, thickness 2.5 mm",
    });
  });

  test("a coupled model lists the solid body and the shell idealised from another", () => {
    const doc = buildReport(
      input(
        [
          { id: 1, materialId: 1 },
          { id: 2, materialId: 1, discretization: "shell" },
          { id: 3, materialId: 1, thickness: 2, sourceBodyId: 2 },
        ],
        [element(1, "CTETRA", 1), element(2, "CTRIA3", 3)],
        result(run("coupled")),
      ),
    );
    expect(doc.bodies.map((b) => [b.propertyId, b.name, b.family])).toEqual([
      [1, "Body 1", "solid"],
      [3, "Body 2, shell", "shell"],
    ]);
    expect(doc.bodies[1].thickness).toBe(2);
  });

  test("a body marked Shell on a solid mesh says it is idealised in the solve", () => {
    const doc = buildReport(
      input(
        [{ id: 1, materialId: 1, discretization: "shell" }],
        [element(1, "CTETRA", 1)],
        result(run("auto-shell")),
      ),
    );
    expect(doc.bodies[0].family).toBe("shell");
    expect(doc.bodies[0].thickness).toBeNull();
    expect(doc.bodies[0].elementType).toMatch(/idealised at solve time/);
  });

  test("shell elements without a thickness are refused, not printed blank", () => {
    expect(() =>
      buildReport(
        input(
          [{ id: 1, materialId: 1 }],
          [element(1, "CTRIA3", 1)],
          result(run("shell")),
        ),
      ),
    ).toThrow(/property 1 have no thickness/);
  });
});

describe("what the report refuses or says it lacks", () => {
  test("no result: the report says so", () => {
    expect(() =>
      buildReport(input([{ id: 1, materialId: 1 }], [], null)),
    ).toThrow("There is no result to report. Run the static solve first.");
  });

  test("a body whose material is gone is refused", () => {
    expect(() =>
      buildReport(
        input(
          [{ id: 1, materialId: 9 }],
          [element(1, "CTETRA", 1)],
          result(run("solid")),
        ),
      ),
    ).toThrow(/material 9/);
  });

  test("a result loaded from a file says the solver and reactions are not recorded", () => {
    const solved = { ...result(), reactions: undefined };
    const html = renderReport(
      buildReport(
        input([{ id: 1, materialId: 1 }], [element(1, "CTETRA", 1)], solved),
      ),
    );
    expect(html).toContain(
      "Not recorded: this result was loaded from a file. Solve again to include the solver.",
    );
    expect(html).toContain(
      "Not recorded: this result was loaded from a file. Solve again to include the reactions.",
    );
    expect(html).not.toContain('data-testid="report-reaction-sum"');
  });

  test("a mesh without recorded sizes says so", () => {
    const html = renderReport(
      buildReport({
        ...input(
          [{ id: 1, materialId: 1 }],
          [element(1, "CTETRA", 1)],
          result(run("solid")),
        ),
        meshSizes: null,
      }),
    );
    expect(html).toContain("Not recorded: the mesh was loaded from a file");
  });
});

describe("the HTML file", () => {
  const html = renderReport(
    buildReport(
      input(
        [{ id: 1, materialId: 1 }],
        [element(1, "CTETRA", 1)],
        result({ ...run("solid"), warnings: ["Thin <wall>"] }),
      ),
    ),
  );

  test("is one file with no script and nothing to fetch", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script|<link|@import|url\(/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
  });

  test("states the numbers exactly and the reactions' balance", () => {
    expect(html).toContain(
      'data-testid="report-max-von-mises" data-value="200"',
    );
    expect(html).toContain(
      'data-testid="report-p99-von-mises" data-value="150"',
    );
    expect(html).toContain('data-force="0,10,0"');
    expect(html).toContain('data-balanced="true"');
  });

  test("escapes the text it carries", () => {
    expect(html).toContain("<li>Thin &lt;wall&gt;</li>");
  });
});
