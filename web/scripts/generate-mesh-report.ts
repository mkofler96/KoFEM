#!/usr/bin/env -S bun run
/**
 * Generate a multi-page PDF mesh capabilities report from Playwright screenshots.
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

// ── Geometry groups ────────────────────────────────────────────────────────────

const ORIGINAL_GEOMETRIES: GeomEntry[] = [
  { file: 'box',              label: 'Simple Box',             desc: '80 × 60 × 40 mm — 6 planar faces' },
  { file: 'cylinder',         label: 'Cylinder',               desc: 'R = 25 mm, H = 80 mm — cylindrical surface + 2 disc caps' },
  { file: 'cone',             label: 'Truncated Cone',         desc: 'R_bot = 10, R_top = 20, H = 30 mm — conical surface + 2 disc caps' },
  { file: 'l_bracket',        label: 'L-Bracket',              desc: '80 × 80 × 20 mm — 8 planar faces, re-entrant corner' },
  { file: 'quarter_cylinder', label: 'Quarter-Cyl. Patch',    desc: 'r = 5, H = 10 mm, u ∈ [0, π/2] — partial cylindrical surface' },
  { file: 'new_bracket_2',    label: 'Complex Bracket',        desc: 'Imported STEP — curved faces, blends, multiple features' },
]

const NEW_GEOMETRIES: GeomEntry[] = [
  { file: 'tube',          label: 'Hollow Tube',          desc: 'R₀=20, Rᵢ=14, H=60 mm — annular caps with FACE_BOUND holes' },
  { file: 'elbow',         label: '90° Pipe Elbow',       desc: 'Rₘ=40, r=10 mm — quarter TOROIDAL_SURFACE + 2 disc caps' },
  { file: 'torus_ring',    label: 'Half-Torus U-Bend',    desc: 'Rₘ=30, r=10 mm — π-sweep TOROIDAL_SURFACE' },
  { file: 'stepped_shaft', label: 'Stepped Shaft',        desc: 'R20→12, H30+40 mm — two cylinders + annular step ring' },
  { file: 'hex_prism',     label: 'Hex Prism',            desc: 'circumR=25, H=50 mm — regular hexagonal cross-section' },
  { file: 'pyramid',       label: 'Square Pyramid',       desc: 'base 50×50 mm, H=60 mm — 4 triangular faces + square base' },
  { file: 'wedge',         label: 'Triangular Wedge',     desc: '80×50×30 mm — right-angle triangular prism' },
  { file: 'i_beam',        label: 'I-Beam',               desc: 'W=60, H=80, tf=8, tw=6, L=80 mm — structural steel section' },
  { file: 't_profile',     label: 'T-Profile',            desc: 'W=80, H=68, tf=8, tw=10, L=20 mm — T cross-section extrusion' },
  { file: 'u_channel',     label: 'U-Channel',            desc: 'W=60, H=40, t=5, L=80 mm — C/U section extrusion' },
]

const NIST_GEOMETRIES: GeomEntry[] = [
  { file: 'nist_ctc_01_asme1_ap242-e1',    label: 'NIST CTC-01', desc: 'AP242 e1 — Core Technical Case 1' },
  { file: 'nist_ctc_02_asme1_ap242-e2',    label: 'NIST CTC-02', desc: 'AP242 e2 — Core Technical Case 2' },
  { file: 'nist_ctc_03_asme1_ap242-e2',    label: 'NIST CTC-03', desc: 'AP242 e2 — Core Technical Case 3' },
  { file: 'nist_ctc_04_asme1_ap242-e1',    label: 'NIST CTC-04', desc: 'AP242 e1 — Core Technical Case 4' },
  { file: 'nist_ctc_05_asme1_ap242-e1',    label: 'NIST CTC-05', desc: 'AP242 e1 — Core Technical Case 5' },
  { file: 'nist_ftc_06_asme1_ap242-e2',    label: 'NIST FTC-06', desc: 'AP242 e2 — Feature Technical Case 6' },
  { file: 'nist_ftc_07_asme1_ap242-e2',    label: 'NIST FTC-07', desc: 'AP242 e2 — Feature Technical Case 7' },
  { file: 'nist_ftc_08_asme1_ap242-e1-tg', label: 'NIST FTC-08 (tg)', desc: 'AP242 e1 — FTC-08 tolerance geometry' },
  { file: 'nist_ftc_08_asme1_ap242-e2',    label: 'NIST FTC-08', desc: 'AP242 e2 — Feature Technical Case 8' },
  { file: 'nist_ftc_09_asme1_ap242-e1',    label: 'NIST FTC-09', desc: 'AP242 e1 — Feature Technical Case 9' },
  { file: 'nist_ftc_10_asme1_ap242-e2',    label: 'NIST FTC-10', desc: 'AP242 e2 — Feature Technical Case 10' },
  { file: 'nist_ftc_11_asme1_ap242-e2',    label: 'NIST FTC-11', desc: 'AP242 e2 — Feature Technical Case 11' },
  { file: 'nist_stc_06_asme1_ap242-e3',    label: 'NIST STC-06', desc: 'AP242 e3 — Sheet Technical Case 6' },
  { file: 'nist_stc_07_asme1_ap242-e3',    label: 'NIST STC-07', desc: 'AP242 e3 — Sheet Technical Case 7' },
  { file: 'nist_stc_08_asme1_ap242-e3',    label: 'NIST STC-08', desc: 'AP242 e3 — Sheet Technical Case 8' },
  { file: 'nist_stc_09_asme1_ap242-e3',    label: 'NIST STC-09', desc: 'AP242 e3 — Sheet Technical Case 9' },
  { file: 'nist_stc_10_asme1_ap242-e2',    label: 'NIST STC-10', desc: 'AP242 e2 — Sheet Technical Case 10' },
]

// ── Layout constants ───────────────────────────────────────────────────────────

const PW = 297, PH = 210        // A4 landscape mm
const M  = 12                   // page margin
const COL_LABEL = 38            // label column width
const GAP = 3                   // gap between image columns
const NUM_COLS = 3
const IMG_W = (PW - 2*M - COL_LABEL - (NUM_COLS - 1)*GAP) / NUM_COLS  // ~75 mm each
const HEADER_H = 22             // space used by page title + column headers

// Rows per page: choose so each row is at least 12 mm (reasonable thumbnail)
const MAX_ROWS_PER_PAGE = 8
const MIN_ROW_H = 12

// ── Helpers ────────────────────────────────────────────────────────────────────

function pngToDataUrl(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const buf = fs.readFileSync(filePath)
  return `data:image/png;base64,${buf.toString('base64')}`
}

function slugFor(file: string) {
  return file.replace(/\.stp$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')
}

function drawPageBackground(doc: jsPDF) {
  doc.setFillColor(18, 18, 38)
  doc.rect(0, 0, PW, PH, 'F')
  doc.setFillColor(59, 91, 219)
  doc.rect(0, 0, PW, 2, 'F')
}

function drawSectionHeader(doc: jsPDF, title: string, subtitle: string) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16)
  doc.setTextColor(224, 224, 240)
  doc.text(title, M, M + 6)

  doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
  doc.setTextColor(136, 136, 170)
  doc.text(subtitle, M, M + 12)
}

function drawColumnHeaders(doc: jsPDF, tableTop: number) {
  const imgCol1 = M + COL_LABEL
  const imgCol2 = imgCol1 + IMG_W + GAP
  const imgCol3 = imgCol2 + IMG_W + GAP

  doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5)
  doc.setTextColor(100, 120, 200)
  doc.text('Geometry', M + 2, tableTop - 2)
  doc.text('Rendered surface',           imgCol1 + IMG_W/2, tableTop - 2, { align: 'center' })
  doc.text('Surface mesh (wireframe)',   imgCol2 + IMG_W/2, tableTop - 2, { align: 'center' })
  doc.text('Volume mesh (tets)',         imgCol3 + IMG_W/2, tableTop - 2, { align: 'center' })

  doc.setDrawColor(50, 50, 90); doc.setLineWidth(0.3)
  doc.line(M, tableTop, PW - M, tableTop)
}

function drawRow(
  doc: jsPDF,
  g: GeomEntry,
  rowY: number,
  rowH: number,
  idx: number,
  shotDir: string,
) {
  const imgY  = rowY + 1.5
  const imgH  = rowH - 3
  const imgCol1 = M + COL_LABEL
  const imgCol2 = imgCol1 + IMG_W + GAP
  const imgCol3 = imgCol2 + IMG_W + GAP

  if (idx % 2 === 0) {
    doc.setFillColor(22, 22, 44)
    doc.rect(M, rowY, PW - 2*M, rowH, 'F')
  }

  // Label
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5)
  doc.setTextColor(200, 210, 240)
  doc.text(g.label, M + 2, rowY + 5.5)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(110, 120, 160)
  const descLines = doc.splitTextToSize(g.desc, COL_LABEL - 4)
  doc.text(descLines, M + 2, rowY + 10)

  const slug = slugFor(g.file)

  // Three screenshot columns
  for (const [col, suffix] of [[imgCol1, 'geometry'], [imgCol2, 'mesh'], [imgCol3, 'volume']] as [number, string][]) {
    const imgPath = path.join(shotDir, `${slug}-${suffix}.png`)
    const dataUrl = pngToDataUrl(imgPath)
    if (dataUrl) {
      doc.addImage(dataUrl, 'PNG', col, imgY, IMG_W, imgH)
    } else {
      doc.setFillColor(28, 28, 50); doc.rect(col, imgY, IMG_W, imgH, 'F')
      doc.setFontSize(6); doc.setTextColor(70, 70, 100)
      doc.text('screenshot missing', col + IMG_W/2, imgY + imgH/2, { align: 'center' })
    }
  }

  doc.setDrawColor(35, 35, 65); doc.setLineWidth(0.2)
  doc.line(M, rowY + rowH, PW - M, rowY + rowH)
}

function drawFooter(doc: jsPDF) {
  doc.setFontSize(6.5); doc.setTextColor(60, 60, 90)
  const ts = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  doc.text(
    `Generated by KoFEM — browser-first finite element analysis — ${ts}`,
    PW/2, PH - 4, { align: 'center' },
  )
}

/** Render a named group of geometries, splitting across pages as needed. */
function renderGroup(
  doc: jsPDF,
  groupTitle: string,
  groupSubtitle: string,
  geometries: GeomEntry[],
  shotDir: string,
  isFirstPage: boolean,
) {
  if (geometries.length === 0) return

  // Chunk into pages
  const chunks: GeomEntry[][] = []
  for (let i = 0; i < geometries.length; i += MAX_ROWS_PER_PAGE) {
    chunks.push(geometries.slice(i, i + MAX_ROWS_PER_PAGE))
  }

  chunks.forEach((chunk, chunkIdx) => {
    if (!isFirstPage || chunkIdx > 0) doc.addPage()
    isFirstPage = false

    drawPageBackground(doc)

    const subtitle = chunkIdx === 0
      ? groupSubtitle
      : `${groupSubtitle} (continued ${chunkIdx + 1}/${chunks.length})`
    drawSectionHeader(doc, groupTitle, subtitle)

    const tableTop = M + HEADER_H
    drawColumnHeaders(doc, tableTop)

    const available = PH - tableTop - M - 6  // 6mm footer clearance
    const rowH = Math.max(MIN_ROW_H, Math.floor(available / chunk.length))

    chunk.forEach((g, i) => {
      drawRow(doc, g, tableTop + i * rowH, rowH, i, shotDir)
    })

    drawFooter(doc)
  })
}

// ── Main ───────────────────────────────────────────────────────────────────────

function run() {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  let firstPage = true

  renderGroup(
    doc,
    'KoFEM — Meshing Capabilities',
    `Surface tessellation test suite — original geometries — ${dateStr}`,
    ORIGINAL_GEOMETRIES,
    SHOT_DIR,
    firstPage,
  )
  firstPage = false

  renderGroup(
    doc,
    'KoFEM — New Test Shapes',
    'Tubes, bends, toroidal surfaces, prismatic profiles — ' + dateStr,
    NEW_GEOMETRIES,
    SHOT_DIR,
    firstPage,
  )

  renderGroup(
    doc,
    'KoFEM — NIST AP242 Standard Cases',
    'NIST MBE PMI Validation & Conformance Testing — ' + dateStr,
    NIST_GEOMETRIES,
    SHOT_DIR,
    firstPage,
  )

  const arrayBuf = doc.output('arraybuffer')
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, Buffer.from(arrayBuf))
  console.log(`Report written to ${OUT_FILE}`)
}

run()
