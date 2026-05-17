#!/usr/bin/env -S bun run
/**
 * Generate a PDF mesh capabilities report from Playwright screenshots.
 * Run after: bun run test:mesh-report
 * Usage:  bun scripts/generate-mesh-report.ts
 */
import { jsPDF } from 'jspdf'
import fs from 'fs'
import path from 'path'

const SHOT_DIR = path.join(import.meta.dir, '..', 'screenshots', 'report')
const OUT_FILE = path.join(import.meta.dir, '..', 'screenshots', 'mesh-report.pdf')

interface GeomEntry {
  file: string
  label: string
  desc: string
}

const ORIGINAL_GEOMETRIES: GeomEntry[] = [
  { file: 'box',              label: 'Simple Box',            desc: '80 × 60 × 40 mm — 6 planar faces' },
  { file: 'cylinder',         label: 'Cylinder',              desc: 'R = 25 mm, H = 80 mm — cylindrical surface + 2 disc caps' },
  { file: 'cone',             label: 'Truncated Cone',        desc: 'R_bot = 10, R_top = 20, H = 30 mm — conical surface + 2 disc caps' },
  { file: 'l_bracket',        label: 'L-Bracket',             desc: '80 × 80 × 20 mm — 8 planar faces, re-entrant corner' },
  { file: 'quarter_cylinder', label: 'Quarter-Cyl. Patch',   desc: 'r = 5, H = 10 mm, u ∈ [0, π/2] — partial cylindrical surface' },
  { file: 'new_bracket_2',    label: 'Complex Bracket',       desc: 'Imported STEP — curved faces, blends, multiple features' },
]

const NEW_GEOMETRIES: GeomEntry[] = [
  { file: 'elbow',         label: 'Pipe Elbow',       desc: '90° elbow sweep with circular cross-section' },
  { file: 'hex_prism',     label: 'Hex Prism',        desc: 'Regular hexagonal prism' },
  { file: 'i_beam',        label: 'I-Beam',           desc: 'Standard I-section structural profile' },
  { file: 'pyramid',       label: 'Pyramid',          desc: 'Square-base solid pyramid' },
  { file: 'stepped_shaft', label: 'Stepped Shaft',    desc: 'Multi-diameter shaft with machined shoulders' },
  { file: 't_profile',     label: 'T-Profile',        desc: 'T-section structural profile' },
  { file: 'torus_ring',    label: 'Torus Ring',       desc: 'Toroidal ring — genus-1 surface' },
  { file: 'tube',          label: 'Tube',             desc: 'Hollow cylinder — annular end caps + inner bore' },
  { file: 'u_channel',     label: 'U-Channel',        desc: 'U-section structural channel' },
  { file: 'wedge',         label: 'Wedge',            desc: 'Prismatic wedge — triangular cross-section' },
]

// 17 NIST AP242 PMI validation models split across two pages
const NIST_GEOMETRIES_1: GeomEntry[] = [
  { file: 'nist_ctc_01_asme1_ap242-e1',    label: 'NIST CTC-01',        desc: 'AP242 e1 — Conformance Test Case' },
  { file: 'nist_ctc_02_asme1_ap242-e2',    label: 'NIST CTC-02',        desc: 'AP242 e2 — Conformance Test Case' },
  { file: 'nist_ctc_03_asme1_ap242-e2',    label: 'NIST CTC-03',        desc: 'AP242 e2 — Conformance Test Case' },
  { file: 'nist_ctc_04_asme1_ap242-e1',    label: 'NIST CTC-04',        desc: 'AP242 e1 — Conformance Test Case' },
  { file: 'nist_ctc_05_asme1_ap242-e1',    label: 'NIST CTC-05',        desc: 'AP242 e1 — Conformance Test Case' },
  { file: 'nist_ftc_06_asme1_ap242-e2',    label: 'NIST FTC-06',        desc: 'AP242 e2 — Functional Test Case' },
  { file: 'nist_ftc_07_asme1_ap242-e2',    label: 'NIST FTC-07',        desc: 'AP242 e2 — Functional Test Case' },
  { file: 'nist_ftc_08_asme1_ap242-e1-tg', label: 'NIST FTC-08 (e1-tg)', desc: 'AP242 e1-tg — Functional Test Case' },
  { file: 'nist_ftc_08_asme1_ap242-e2',    label: 'NIST FTC-08 (e2)',   desc: 'AP242 e2 — Functional Test Case' },
]

const NIST_GEOMETRIES_2: GeomEntry[] = [
  { file: 'nist_ftc_09_asme1_ap242-e1',    label: 'NIST FTC-09',        desc: 'AP242 e1 — Functional Test Case' },
  { file: 'nist_ftc_10_asme1_ap242-e2',    label: 'NIST FTC-10',        desc: 'AP242 e2 — Functional Test Case' },
  { file: 'nist_ftc_11_asme1_ap242-e2',    label: 'NIST FTC-11',        desc: 'AP242 e2 — Functional Test Case' },
  { file: 'nist_stc_06_asme1_ap242-e3',    label: 'NIST STC-06',        desc: 'AP242 e3 — Semantic Test Case' },
  { file: 'nist_stc_07_asme1_ap242-e3',    label: 'NIST STC-07',        desc: 'AP242 e3 — Semantic Test Case' },
  { file: 'nist_stc_08_asme1_ap242-e3',    label: 'NIST STC-08',        desc: 'AP242 e3 — Semantic Test Case' },
  { file: 'nist_stc_09_asme1_ap242-e3',    label: 'NIST STC-09',        desc: 'AP242 e3 — Semantic Test Case' },
  { file: 'nist_stc_10_asme1_ap242-e2',    label: 'NIST STC-10',        desc: 'AP242 e2 — Semantic Test Case' },
]

function pngToDataUrl(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const buf = fs.readFileSync(filePath)
  return `data:image/png;base64,${buf.toString('base64')}`
}

function renderPage(
  doc: jsPDF,
  title: string,
  subtitle: string,
  geoms: GeomEntry[],
  pageNum: number,
  totalPages: number,
): void {
  const PW = 297, PH = 210
  const M = 12
  const COL_LABEL = 44
  const GAP = 4
  const NUM_COLS = 3
  const IMG_W = (PW - 2 * M - COL_LABEL - (NUM_COLS - 1) * GAP) / NUM_COLS
  const tableTop = M + 22
  const ROW_H = (PH - 2 * M - 24) / geoms.length

  // Background + accent bar
  doc.setFillColor(18, 18, 38); doc.rect(0, 0, PW, PH, 'F')
  doc.setFillColor(59, 91, 219); doc.rect(0, 0, PW, 2, 'F')

  // Title
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18)
  doc.setTextColor(224, 224, 240)
  doc.text(title, M, M + 7)

  // Subtitle (left) + page indicator (right)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.setTextColor(136, 136, 170)
  doc.text(subtitle, M, M + 14)
  doc.text(`${pageNum} / ${totalPages}`, PW - M, M + 7, { align: 'right' })
  doc.text(
    new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    PW - M, M + 14, { align: 'right' },
  )

  // Column headers
  const imgCol1 = M + COL_LABEL
  const imgCol2 = imgCol1 + IMG_W + GAP
  const imgCol3 = imgCol2 + IMG_W + GAP

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8)
  doc.setTextColor(100, 120, 200)
  doc.text('Geometry', M + 2, tableTop - 2)
  doc.text('Rendered surface', imgCol1 + IMG_W / 2, tableTop - 2, { align: 'center' })
  doc.text('Surface mesh (wireframe)', imgCol2 + IMG_W / 2, tableTop - 2, { align: 'center' })
  doc.text('Volume mesh (tets)', imgCol3 + IMG_W / 2, tableTop - 2, { align: 'center' })

  doc.setDrawColor(50, 50, 90); doc.setLineWidth(0.3)
  doc.line(M, tableTop, PW - M, tableTop)

  // Rows
  for (let i = 0; i < geoms.length; i++) {
    const g = geoms[i]
    const rowY = tableTop + i * ROW_H
    const imgY = rowY + 2
    const imgH = ROW_H - 4

    if (i % 2 === 0) {
      doc.setFillColor(22, 22, 44)
      doc.rect(M, rowY, PW - 2 * M, ROW_H, 'F')
    }

    // Label column
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5)
    doc.setTextColor(200, 210, 240)
    doc.text(g.label, M + 2, rowY + 7)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(110, 120, 160)
    const descLines = doc.splitTextToSize(g.desc, COL_LABEL - 4)
    doc.text(descLines, M + 2, rowY + 13)

    // Images
    const columns: Array<[number, string]> = [
      [imgCol1, 'geometry'],
      [imgCol2, 'mesh'],
      [imgCol3, 'volume'],
    ]
    for (const [col, suffix] of columns) {
      const dataUrl = pngToDataUrl(path.join(SHOT_DIR, `${g.file}-${suffix}.png`))
      if (dataUrl) {
        doc.addImage(dataUrl, 'PNG', col, imgY, IMG_W, imgH)
      } else {
        doc.setFillColor(30, 30, 55); doc.rect(col, imgY, IMG_W, imgH, 'F')
        doc.setFontSize(7); doc.setTextColor(80, 80, 110)
        doc.text('screenshot missing', col + IMG_W / 2, imgY + imgH / 2, { align: 'center' })
      }
    }

    // Row separator
    doc.setDrawColor(35, 35, 65); doc.setLineWidth(0.2)
    doc.line(M, rowY + ROW_H, PW - M, rowY + ROW_H)
  }

  // Footer
  doc.setFontSize(7); doc.setTextColor(60, 60, 90)
  doc.text('Generated by KoFEM — browser-first finite element analysis', PW / 2, PH - 5, { align: 'center' })
}

function run() {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  const pages = [
    {
      title: 'KoFEM — Meshing Capabilities',
      subtitle: `Basic geometry suite — ${dateStr}`,
      geoms: ORIGINAL_GEOMETRIES,
    },
    {
      title: 'KoFEM — Extended Shape Suite',
      subtitle: `New test geometries — profiles, sweeps, intersections — ${dateStr}`,
      geoms: NEW_GEOMETRIES,
    },
    {
      title: 'KoFEM — NIST Conformance Models  (1 / 2)',
      subtitle: `NIST AP242 STEP PMI validation — CTC & FTC series — ${dateStr}`,
      geoms: NIST_GEOMETRIES_1,
    },
    {
      title: 'KoFEM — NIST Conformance Models  (2 / 2)',
      subtitle: `NIST AP242 STEP PMI validation — FTC & STC series — ${dateStr}`,
      geoms: NIST_GEOMETRIES_2,
    },
  ]

  for (let p = 0; p < pages.length; p++) {
    if (p > 0) doc.addPage()
    const { title, subtitle, geoms } = pages[p]
    renderPage(doc, title, subtitle, geoms, p + 1, pages.length)
  }

  const arrayBuf = doc.output('arraybuffer')
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, Buffer.from(arrayBuf))
  console.log(`Report written to ${OUT_FILE}`)
}

run()
