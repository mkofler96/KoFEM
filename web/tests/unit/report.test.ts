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
import type { RefinementStudyRun } from "../../src/store/studySlice";
import type { DensityResult } from "../../src/store/topOptSlice";

const steel = {
  id: 1,
  name: "Steel",
  young: 210000,
  poisson: 0.3,
  density: 7.85e-9,
  color: "#4e79a7",
};

const run = (
  path: SolveRun["path"],
  properties: Property[] = [],
): SolveRun => ({
  path,
  preconditioner: "amg",
  elementOrder: 1,
  largeDeformation: null,
  warnings: [],
  materials: [steel],
  properties,
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

// A run solved with the model's own bodies, unless the test gives others.
function input(
  properties: Property[],
  elements: Element[],
  given: SolverResult | null,
): ReportInput {
  const solved =
    given?.run && given.run.properties.length === 0
      ? { ...given, run: { ...given.run, properties } }
      : given;
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
    safety: [],
    figures: {
      current: { src: "data:image/png;base64,AA", width: 400, height: 300 },
      isometric: { src: "data:image/png;base64,BB", width: 400, height: 300 },
    },
    assets: { fontCss: "@font-face{font-family:Test}", logo: "<svg></svg>" },
    refinement: null,
    topology: null,
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

describe("the report states what was solved", () => {
  test("a material edited after the solve is reported as solved", () => {
    const solvedWith: Property[] = [{ id: 1, materialId: 1 }];
    const doc = buildReport({
      ...input(
        [{ id: 1, materialId: 2 }],
        [element(1, "CTETRA", 1)],
        result(run("solid", solvedWith)),
      ),
      materials: [
        { ...steel, young: 70000 },
        { ...steel, id: 2, name: "Aluminium", young: 70000 },
      ],
    });
    expect(doc.bodies[0].material.name).toBe("Steel");
    expect(doc.bodies[0].material.young).toBe(210000);
  });
});

describe("the report states the deformation it solved", () => {
  const html = (solveRun: SolveRun) =>
    renderReport(
      buildReport(
        input(
          [{ id: 1, materialId: 1 }],
          [element(1, "CTETRA", 1)],
          result(solveRun),
        ),
      ),
    );

  test("a linear solve is small deformation", () => {
    expect(html(run("solid"))).toContain(
      "Small deformation (linear elasticity)",
    );
  });

  test("a large-deformation solve names its material model and increments", () => {
    expect(
      html({ ...run("solid"), largeDeformation: { increments: 12 } }),
    ).toContain("Large deformation (Neo-Hookean), 12 load increments");
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
      "Not recorded: this result did not come from a static solve in this session (it was loaded from a file or solved by a study). Solve again to include the solver.",
    );
    expect(html).toContain(
      "Not recorded: this result did not come from a static solve in this session (it was loaded from a file or solved by a study). Solve again to include the reactions.",
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

describe("the printed report", () => {
  const base = () =>
    input(
      [{ id: 1, materialId: 1 }],
      [element(1, "CTETRA", 1)],
      result(run("solid")),
    );

  test("prints on A4 with a footer naming the model on every page", () => {
    const html = renderReport(
      buildReport({ ...base(), modelName: 'Bracket "A"' }),
    );
    expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
    expect(html).toContain('"KoFEM analysis report · Bracket \\"A\\""');
    expect(html).toContain('"Page " counter(page) " of " counter(pages)');
  });

  test("embeds its fonts and logo, and fetches nothing", () => {
    const html = renderReport(buildReport(base()));
    expect(html).toContain("@font-face{font-family:Test}");
    expect(html).toContain("<svg></svg>");
    expect(html).not.toMatch(/<script|<link|@import/i);
  });

  test("every section is a block print keeps whole, and no table sits beside a figure", () => {
    const html = renderReport(buildReport(base()));
    expect((html.match(/<section class="blk"/g) ?? []).length).toBeGreaterThan(
      4,
    );
    for (const row of html.match(
      /<div class="figs">[\s\S]*?<\/div><\/section>/g,
    ) ?? [])
      expect(row).not.toContain("<table");
  });

  test("lists no safety factor without a yield strength", () => {
    const html = renderReport(buildReport(base()));
    expect(html).not.toContain("report-safety");
  });

  test("lists the safety factor on the max and p99 von Mises, per body when given per body", () => {
    const row = {
      materialId: 1,
      yieldStrength: 250,
      maxVonMises: 200,
      p99VonMises: 100,
      maxFactor: 1.25,
      p99Factor: 2.5,
    };
    const model = renderReport(
      buildReport({ ...base(), safety: [{ ...row, propertyId: null }] }),
    );
    expect(model).toContain('data-testid="report-safety-max-model"');
    expect(model).toContain('data-value="1.25"');
    expect(model).toContain('data-testid="report-safety-p99-model"');
    expect(model).toContain('data-value="2.5"');

    const perBody = buildReport({
      ...base(),
      safety: [{ ...row, propertyId: 1 }],
    });
    expect(perBody.safety).toEqual([
      {
        key: "1",
        body: "Body 1 · Steel, 250 MPa",
        maxFactor: 1.25,
        p99Factor: 2.5,
      },
    ]);
    const html = renderReport(perBody);
    expect(html).toContain('data-testid="report-safety-max-1"');
    expect(html).toContain("Body 1 · Steel, 250 MPa");
  });

  test("a refinement study adds its charts, verdict and levels", () => {
    const study: RefinementStudyRun = {
      status: "done",
      settings: { levels: 2, ratio: Math.SQRT2, tolerance: 0.02 },
      step: null,
      phase: null,
      plannedSizes: [11.2, 7.92],
      levels: [
        {
          sizes: { max: 11.2, min: 1.12, regions: {} },
          nodes: 8494,
          elements: 38899,
          maxDisplacement: 1.9113,
          maxVonMises: 59.01,
        },
        {
          sizes: { max: 7.92, min: 0.79, regions: {} },
          nodes: 24923,
          elements: 125483,
          maxDisplacement: 1.9118,
          maxVonMises: 66.3,
        },
      ],
      snapshots: [],
      fingerprint: "",
      error: null,
    } as unknown as RefinementStudyRun;
    const html = renderReport(buildReport({ ...base(), refinement: study }));
    expect(html).toContain('data-testid="report-refinement"');
    expect((html.match(/<svg class="chart/g) ?? []).length).toBe(2);
    expect(html).toContain('data-elements="125483"');
    expect(html).toContain("Converged");
  });

  test("a topology optimization adds its charts, density figure and settings", () => {
    const history = [192.5, 120, 60, 47.4].map((c, k) => ({
      it: k + 1,
      objective: c,
      compliance: c,
      volume: [0.5, 0.46, 0.49, 0.5][k],
      max_change: 0.1,
    }));
    const density: DensityResult = {
      density: new Float64Array(3),
      history,
      converged: true,
      iterations: 4,
      run: {
        method: "simp",
        objective: "min_compliance",
        constraints: { volumeFraction: 0.5 },
        penalty: 3,
        filterRadius: 10,
        moveLimit: 0.2,
        maxIterations: 200,
        tolerance: 0.01,
      },
    };
    const html = renderReport(
      buildReport({
        ...base(),
        topology: {
          result: density,
          threshold: 0.5,
          figure: { src: "data:image/png;base64,CC", width: 300, height: 200 },
        },
      }),
    );
    expect(html).toContain('data-testid="report-topology"');
    expect((html.match(/<svg class="chart/g) ?? []).length).toBe(2);
    expect(html).toContain(
      'data-testid="report-topology-iterations" data-value="4"',
    );
    expect(html).toContain(
      'data-testid="report-density-cutoff" data-value="0.5"',
    );
    expect(html).toContain('data-testid="report-figure-density"');
  });
});
