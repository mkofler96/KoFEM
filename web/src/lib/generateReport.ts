import jsPDF from 'jspdf'
import type { Node, Element, Material, Property, Constraint, Load } from '../store/modelStore'

export type ReportStep =
  | 'collecting'
  | 'statistics'
  | 'elements'
  | 'materials'
  | 'building'
  | 'done'

export type StepCallback = (step: ReportStep, progress: number) => void

export interface ReportModel {
  modelName: string
  nodes: Node[]
  elements: Element[]
  materials: Material[]
  properties: Property[]
  constraints: Constraint[]
  loads: Load[]
}

type RGB = readonly [number, number, number]

const BG: RGB       = [18, 18, 38]
const SURFACE: RGB  = [28, 28, 56]
const SURFACE2: RGB = [36, 36, 72]
const HDR_BG: RGB   = [24, 24, 52]
const ACCENT: RGB   = [59, 91, 219]
const ACCENT2: RGB  = [76, 110, 245]
const TEXT: RGB     = [224, 224, 240]
const TEXT_DIM: RGB = [136, 136, 170]
const TEXT_MID: RGB = [160, 160, 200]
const BORDER: RGB   = [50, 50, 90]
const GREEN: RGB    = [100, 200, 100]
const YELLOW: RGB   = [200, 180, 60]
const GRAY_DIM: RGB = [80, 80, 120]

const ELEMENT_LIBRARY = [
  { type: 'CBAR / CBEAM',   property: 'PBAR / PBEAM', dof: 6, formulation: 'Euler-Bernoulli beam',          status: 'Local K done' },
  { type: 'CTRIA3',         property: 'PLPLANE',       dof: 2, formulation: 'CST plane stress/strain',       status: 'Full' },
  { type: 'CQUAD4',         property: 'PLPLANE',       dof: 2, formulation: 'Bilinear quad, 2×2 Gauss',      status: 'Full' },
  { type: 'CTETRA (4-node)',property: 'PSOLID',        dof: 3, formulation: 'Linear tet, exact integration', status: 'Full' },
  { type: 'CHEXA (8-node)', property: 'PSOLID',        dof: 3, formulation: 'Trilinear hex, 2×2×2 Gauss',   status: 'Full' },
  { type: 'CTRIA3',         property: 'PSHELL',        dof: 6, formulation: 'DKT shell',                     status: 'Stub' },
  { type: 'CQUAD4',         property: 'PSHELL',        dof: 6, formulation: 'MITC4 shell (Bathe & Dvorkin)', status: 'Stub' },
  { type: 'CPENTA (6-node)',property: 'PSOLID',        dof: 3, formulation: 'Wedge element',                 status: 'Stub' },
  { type: 'CPYRAM (5-node)',property: 'PSOLID',        dof: 3, formulation: 'Pyramid element',               status: 'Stub' },
]

const DOF_MAP: Record<string, number> = {
  CTRIA3: 3, CQUAD4: 3, CTETRA: 3, CHEXA: 3, CPENTA: 3, CPYRAM: 3, CBAR: 6, CBEAM: 6,
}
const FORM_MAP: Record<string, string> = {
  CTRIA3: 'CST / DKT', CQUAD4: 'Bilinear / MITC4', CTETRA: 'Linear tet',
  CHEXA: 'Trilinear hex', CPENTA: 'Wedge', CPYRAM: 'Pyramid',
  CBAR: 'Euler-Bernoulli', CBEAM: 'Euler-Bernoulli',
}

// Color helpers use tuple indexing to satisfy TypeScript strict mode
const fill = (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2])
const draw = (doc: jsPDF, c: RGB) => doc.setDrawColor(c[0], c[1], c[2])
const ink  = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2])

function pageBackground(doc: jsPDF, w: number, h: number) {
  fill(doc, BG);    doc.rect(0, 0, w, h, 'F')
  fill(doc, ACCENT); doc.rect(0, 0, w, 2, 'F')
}

function sectionHeading(doc: jsPDF, text: string, x: number, y: number): number {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); ink(doc, TEXT_MID)
  doc.text(text, x, y)
  y += 3
  draw(doc, ACCENT); doc.setLineWidth(0.4)
  doc.line(x, y, x + text.length * 2.2 + 4, y)
  return y + 8
}

function tableHeader(
  doc: jsPDF, headers: string[], colX: number[],
  margin: number, cw: number, y: number,
): number {
  fill(doc, HDR_BG); doc.rect(margin, y - 5, cw, 7, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); ink(doc, TEXT_MID)
  headers.forEach((h, i) => doc.text(h, colX[i] + 2, y))
  y += 3
  draw(doc, BORDER); doc.setLineWidth(0.3)
  doc.line(margin, y, margin + cw, y)
  return y + 5
}

function tableRow(
  doc: jsPDF, cells: string[], colX: number[],
  margin: number, cw: number, y: number, rowIdx: number,
) {
  if (rowIdx % 2 === 0) { fill(doc, SURFACE); doc.rect(margin, y - 4, cw, 6.5, 'F') }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); ink(doc, TEXT)
  cells.forEach((c, i) => doc.text(c, colX[i] + 2, y))
}

function pageFooter(doc: jsPDF, label: string, page: number, w: number, h: number, m: number) {
  doc.setFontSize(7.5); ink(doc, GRAY_DIM)
  doc.text(label, w / 2, h - 8, { align: 'center' })
  doc.text(String(page), w - m, h - 8, { align: 'right' })
}

function buildColX(start: number, widths: number[]): number[] {
  const xs = [start]
  for (let i = 0; i < widths.length - 1; i++) xs.push(xs[xs.length - 1] + widths[i])
  return xs
}

function tick() { return new Promise<void>(r => setTimeout(r, 180)) }

function drawElementSketch(doc: jsPDF, type: string, cx: number, cy: number, size: number) {
  draw(doc, ACCENT2); doc.setLineWidth(0.6)

  const dot = (x: number, y: number) => {
    fill(doc, [220, 80, 80] as unknown as RGB); doc.circle(x, y, 1.5, 'F')
  }

  if (type === 'CTRIA3') {
    const h = size * 0.87
    doc.triangle(cx, cy - h / 2, cx - size / 2, cy + h / 2, cx + size / 2, cy + h / 2, 'S')
    dot(cx, cy - h / 2); dot(cx - size / 2, cy + h / 2); dot(cx + size / 2, cy + h / 2)
  } else if (type === 'CQUAD4') {
    doc.rect(cx - size / 2, cy - size / 2, size, size, 'S')
    dot(cx - size / 2, cy - size / 2); dot(cx + size / 2, cy - size / 2)
    dot(cx - size / 2, cy + size / 2); dot(cx + size / 2, cy + size / 2)
  } else if (type === 'CTETRA') {
    const pts: [number, number][] = [
      [cx, cy - size * 0.52],
      [cx - size * 0.48, cy + size * 0.32],
      [cx + size * 0.48, cy + size * 0.32],
      [cx + size * 0.08, cy + size * 0.08],
    ]
    draw(doc, [60, 80, 160] as unknown as RGB); doc.setLineWidth(0.3)
    doc.line(pts[1][0], pts[1][1], pts[3][0], pts[3][1])
    doc.line(pts[2][0], pts[2][1], pts[3][0], pts[3][1])
    draw(doc, ACCENT2); doc.setLineWidth(0.6)
    doc.line(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
    doc.line(pts[0][0], pts[0][1], pts[2][0], pts[2][1])
    doc.line(pts[0][0], pts[0][1], pts[3][0], pts[3][1])
    doc.line(pts[1][0], pts[1][1], pts[2][0], pts[2][1])
    pts.forEach(p => dot(p[0], p[1]))
  } else if (type === 'CHEXA') {
    const s = size * 0.38, off = size * 0.22
    draw(doc, [60, 80, 160] as unknown as RGB); doc.setLineWidth(0.3)
    doc.rect(cx - s + off, cy - s - off, s * 2, s * 2, 'S')
    draw(doc, ACCENT2); doc.setLineWidth(0.6)
    doc.line(cx - s, cy - s, cx - s + off, cy - s - off)
    doc.line(cx + s, cy - s, cx + s + off, cy - s - off)
    doc.line(cx + s, cy + s, cx + s + off, cy + s - off)
    doc.line(cx - s, cy + s, cx - s + off, cy + s - off)
    doc.rect(cx - s, cy - s, s * 2, s * 2, 'S')
    const pts: [number, number][] = [
      [cx - s, cy - s], [cx + s, cy - s], [cx + s, cy + s], [cx - s, cy + s],
      [cx - s + off, cy - s - off], [cx + s + off, cy - s - off],
      [cx + s + off, cy + s - off], [cx - s + off, cy + s - off],
    ]
    pts.forEach(p => dot(p[0], p[1]))
  } else if (type === 'CBAR') {
    doc.setLineWidth(2)
    doc.line(cx - size / 2, cy, cx + size / 2, cy)
    dot(cx - size / 2, cy); dot(cx + size / 2, cy)
    draw(doc, ACCENT2); doc.setLineWidth(0.4)
    const bw = 3
    doc.rect(cx - bw / 2, cy - bw, bw, bw * 2, 'S')
  }
  doc.setLineWidth(0.3)
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateMeshReport(
  state: ReportModel,
  onProgress: StepCallback,
): Promise<Blob> {
  onProgress('collecting', 5)
  await tick()

  const elementCounts: Record<string, number> = {}
  for (const el of state.elements) {
    elementCounts[el.type] = (elementCounts[el.type] ?? 0) + 1
  }

  onProgress('statistics', 20)
  await tick()

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const W = 210, H = 297, M = 18, CW = W - 2 * M

  // ── Page 1: Cover ──────────────────────────────────────────────────────────
  pageBackground(doc, W, H)

  doc.setFont('helvetica', 'bold'); doc.setFontSize(48); ink(doc, TEXT)
  doc.text('KoFEM', W / 2, 78, { align: 'center' })

  doc.setFont('helvetica', 'normal'); doc.setFontSize(15); ink(doc, TEXT_DIM)
  doc.text('Finite Element Analysis — Mesh Capabilities Report', W / 2, 90, { align: 'center' })

  draw(doc, BORDER); doc.setLineWidth(0.4)
  doc.line(M, 98, W - M, 98)

  let y = 111
  const infoRows: [string, string][] = [
    ['Model', state.modelName],
    ['Date', new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })],
  ]
  for (const [label, value] of infoRows) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); ink(doc, TEXT_MID)
    doc.text(label, M, y)
    doc.setFont('helvetica', 'normal'); ink(doc, TEXT)
    doc.text(value, M + 24, y)
    y += 10
  }

  const stats = [
    { label: 'Nodes',     value: state.nodes.length.toLocaleString() },
    { label: 'Elements',  value: state.elements.length.toLocaleString() },
    { label: 'Materials', value: state.materials.length.toLocaleString() },
    { label: 'Sections',  value: state.properties.length.toLocaleString() },
  ]
  const cardW = (CW - 12) / 4, cardH = 26, cardGap = 4, cardY = 143
  for (let i = 0; i < stats.length; i++) {
    const cx = M + i * (cardW + cardGap)
    fill(doc, SURFACE2); doc.roundedRect(cx, cardY, cardW, cardH, 2, 2, 'F')
    fill(doc, ACCENT);   doc.roundedRect(cx, cardY, cardW, 2, 1, 1, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); ink(doc, TEXT)
    doc.text(stats[i].value, cx + cardW / 2, cardY + 16, { align: 'center' })
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); ink(doc, TEXT_DIM)
    doc.text(stats[i].label, cx + cardW / 2, cardY + 23, { align: 'center' })
  }

  doc.setFontSize(8); ink(doc, GRAY_DIM)
  doc.text('Generated by KoFEM — browser-first finite element analysis', W / 2, H - 8, { align: 'center' })

  onProgress('elements', 40)
  await tick()

  // ── Page 2: Mesh Summary ───────────────────────────────────────────────────
  doc.addPage()
  pageBackground(doc, W, H)
  y = 28

  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); ink(doc, TEXT)
  doc.text('Mesh Summary', M, y)
  y += 12

  if (Object.keys(elementCounts).length > 0) {
    y = sectionHeading(doc, 'Element Distribution', M, y)
    const distCols = [50, 28, 28, 60]
    const distColX = buildColX(M, distCols)
    y = tableHeader(doc, ['Element Type', 'Count', 'DOF/Node', 'Formulation'], distColX, M, CW, y)
    let ri = 0
    for (const [type, count] of Object.entries(elementCounts)) {
      tableRow(
        doc,
        [type, count.toLocaleString(), String(DOF_MAP[type] ?? '—'), FORM_MAP[type] ?? '—'],
        distColX, M, CW, y, ri,
      )
      y += 7; ri++
    }
    y += 10
  }

  y = sectionHeading(doc, 'Boundary Conditions & Loads', M, y)
  const uniqueBcNodes  = new Set(state.constraints.map((c: Constraint) => c.nodeId)).size
  const uniqueLoadNodes = new Set(state.loads.map((l: Load) => l.nodeId)).size
  const totalLoad = state.loads.reduce((s: number, l: Load) => s + Math.abs(l.value), 0)
  const bcRows: [string, string][] = [
    ['Constrained nodes',              uniqueBcNodes.toString()],
    ['Constraint DOF entries',         state.constraints.length.toString()],
    ['Loaded nodes',                   uniqueLoadNodes.toString()],
    ['Total applied force magnitude (N)', totalLoad.toFixed(2)],
  ]
  const bcColX = buildColX(M, [120, 40])
  y = tableHeader(doc, ['Description', 'Value'], bcColX, M, CW, y)
  bcRows.forEach(([label, val]: [string, string], i: number) => {
    tableRow(doc, [label, val], bcColX, M, CW, y, i); y += 7
  })

  pageFooter(doc, 'KoFEM Report — Mesh Summary', 2, W, H, M)

  onProgress('materials', 60)
  await tick()

  // ── Page 3: Element Library ────────────────────────────────────────────────
  doc.addPage()
  pageBackground(doc, W, H)
  y = 28

  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); ink(doc, TEXT)
  doc.text('Element Library', M, y)
  y += 8

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); ink(doc, TEXT_DIM)
  doc.text(
    'Supported element types follow Nastran naming conventions. ' +
    'The property card determines DOF count and formulation.',
    M, y,
  )
  y += 10

  const libColX = buildColX(M, [44, 34, 12, 60, 22])
  y = tableHeader(doc, ['Element', 'Property', 'DOF', 'Formulation', 'Status'], libColX, M, CW, y)
  for (let i = 0; i < ELEMENT_LIBRARY.length; i++) {
    const el = ELEMENT_LIBRARY[i]
    if (i % 2 === 0) { fill(doc, SURFACE); doc.rect(M, y - 4, CW, 6.5, 'F') }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); ink(doc, TEXT)
    doc.text(el.type,        libColX[0] + 2, y)
    doc.text(el.property,    libColX[1] + 2, y)
    doc.text(String(el.dof), libColX[2] + 2, y)
    doc.text(el.formulation, libColX[3] + 2, y)
    const sc = el.status === 'Full' ? GREEN : el.status.includes('done') ? YELLOW : GRAY_DIM
    ink(doc, sc); doc.text(el.status, libColX[4] + 2, y)
    y += 7
  }

  y += 10
  y = sectionHeading(doc, 'Element Topology Sketches', M, y)

  const sketches = [
    { type: 'CTRIA3', label: 'CTRIA3 (CST)' },
    { type: 'CQUAD4', label: 'CQUAD4' },
    { type: 'CTETRA', label: 'CTETRA (4-node)' },
    { type: 'CHEXA',  label: 'CHEXA (8-node)' },
    { type: 'CBAR',   label: 'CBAR / CBEAM' },
  ]
  const skSize = 22
  const skSpan = CW / sketches.length
  for (let i = 0; i < sketches.length; i++) {
    const cx = M + i * skSpan + skSpan / 2
    drawElementSketch(doc, sketches[i].type, cx, y + skSize * 0.6, skSize)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); ink(doc, TEXT_DIM)
    doc.text(sketches[i].label, cx, y + skSize * 1.6, { align: 'center' })
  }

  pageFooter(doc, 'KoFEM Report — Element Library', 3, W, H, M)

  onProgress('building', 80)
  await tick()

  // ── Page 4: Materials & Sections ──────────────────────────────────────────
  doc.addPage()
  pageBackground(doc, W, H)
  y = 28

  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); ink(doc, TEXT)
  doc.text('Materials & Sections', M, y)
  y += 10

  y = sectionHeading(doc, 'Material Properties', M, y)
  const matColX = buildColX(M, [12, 48, 38, 18, 44])
  y = tableHeader(doc, ['ID', 'Name', 'E (GPa)', 'ν', 'ρ (kg/m³)'], matColX, M, CW, y)
  state.materials.forEach((mat: Material, i: number) => {
    tableRow(doc, [
      String(mat.id), mat.name,
      (mat.young / 1e9).toFixed(3),
      mat.poisson.toFixed(3),
      mat.density.toFixed(0),
    ], matColX, M, CW, y, i)
    y += 7
  })

  y += 12
  y = sectionHeading(doc, 'Section Properties', M, y)
  const secColX = buildColX(M, [12, 32, 38, 28, CW - 12 - 32 - 38 - 28])
  y = tableHeader(doc, ['ID', 'Type', 'Material', 'Formulation', 'Parameters'], secColX, M, CW, y)
  state.properties.forEach((prop: Property, i: number) => {
    const mat = state.materials.find((m: Material) => m.id === prop.materialId)
    const formulation = prop.planeFormulation
      ?? (prop.type === 'PSOLID' ? '3D Solid' : prop.type === 'PBAR' ? 'Euler-Bernoulli' : '—')
    let params = '—'
    if (prop.thickness != null) params = `t = ${prop.thickness.toFixed(4)} m`
    else if (prop.area != null) params = `A = ${prop.area.toExponential(3)} m²`
    tableRow(doc, [
      String(prop.id), prop.type,
      mat?.name ?? `Mat ${prop.materialId}`,
      formulation, params,
    ], secColX, M, CW, y, i)
    y += 7
  })

  pageFooter(doc, 'KoFEM Report — Materials & Sections', 4, W, H, M)

  onProgress('done', 100)

  return doc.output('blob') as Blob
}
