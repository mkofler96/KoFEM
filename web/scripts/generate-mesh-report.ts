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

const GEOMETRIES: GeomEntry[] = [
  { file: 'box',              label: 'Simple Box',            desc: '80 × 60 × 40 mm — 6 planar faces' },
  { file: 'cylinder',         label: 'Cylinder',              desc: 'R = 25 mm, H = 80 mm — cylindrical surface + 2 disc caps' },
  { file: 'cone',             label: 'Truncated Cone',        desc: 'R_bot = 10, R_top = 20, H = 30 mm — conical surface + 2 disc caps' },
  { file: 'l_bracket',        label: 'L-Bracket',             desc: '80 × 80 × 20 mm — 8 planar faces, re-entrant corner' },
  { file: 'quarter_cylinder', label: 'Quarter-Cyl. Patch',   desc: 'r = 5, H = 10 mm, u ∈ [0, π/2] — partial cylindrical surface' },
  { file: 'new_bracket_2',    label: 'Complex Bracket',       desc: 'Imported STEP — curved faces, blends, multiple features' },
]

function pngToDataUrl(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const buf = fs.readFileSync(filePath)
  return `data:image/png;base64,${buf.toString('base64')}`
}

function run() {
  // A4 landscape: 297 × 210 mm
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const PW = 297, PH = 210
  const M = 12                 // page margin
  const COL_LABEL = 36         // width of label column
  const GAP = 4                // gap between image columns
  const NUM_COLS = 3
  const IMG_W = (PW - 2*M - COL_LABEL - (NUM_COLS - 1) * GAP) / NUM_COLS  // ~75 mm each
  const ROW_H = (PH - 2*M - 24) / GEOMETRIES.length // ~40 mm each row

  // ── Cover / header ──────────────────────────────────────────────────────────
  doc.setFillColor(18, 18, 38); doc.rect(0, 0, PW, PH, 'F')
  doc.setFillColor(59, 91, 219); doc.rect(0, 0, PW, 2, 'F')

  doc.setFont('helvetica', 'bold'); doc.setFontSize(20)
  doc.setTextColor(224, 224, 240)
  doc.text('KoFEM — Meshing Capabilities', M, M + 8)

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.setTextColor(136, 136, 170)
  doc.text(
    `Surface tessellation test suite — ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`,
    M, M + 14,
  )

  // Column headers
  const tableTop = M + 22
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

  // ── Rows ─────────────────────────────────────────────────────────────────────
  for (let i = 0; i < GEOMETRIES.length; i++) {
    const g = GEOMETRIES[i]
    const rowY = tableTop + i * ROW_H
    const imgY = rowY + 2
    const imgH = ROW_H - 4

    // Row stripe
    if (i % 2 === 0) {
      doc.setFillColor(22, 22, 44)
      doc.rect(M, rowY, PW - 2*M, ROW_H, 'F')
    }

    // Label column
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5)
    doc.setTextColor(200, 210, 240)
    doc.text(g.label, M + 2, rowY + 7)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(110, 120, 160)
    const descLines = doc.splitTextToSize(g.desc, COL_LABEL - 4)
    doc.text(descLines, M + 2, rowY + 13)

    // Geometry (solid) image
    const geoPath = path.join(SHOT_DIR, `${g.file}-geometry.png`)
    const geoUrl = pngToDataUrl(geoPath)
    if (geoUrl) {
      doc.addImage(geoUrl, 'PNG', imgCol1, imgY, IMG_W, imgH)
    } else {
      doc.setFillColor(30, 30, 55); doc.rect(imgCol1, imgY, IMG_W, imgH, 'F')
      doc.setFontSize(7); doc.setTextColor(80, 80, 110)
      doc.text('screenshot missing', imgCol1 + IMG_W/2, imgY + imgH/2, { align: 'center' })
    }

    // Mesh (wireframe) image
    const meshPath = path.join(SHOT_DIR, `${g.file}-mesh.png`)
    const meshUrl = pngToDataUrl(meshPath)
    if (meshUrl) {
      doc.addImage(meshUrl, 'PNG', imgCol2, imgY, IMG_W, imgH)
    } else {
      doc.setFillColor(30, 30, 55); doc.rect(imgCol2, imgY, IMG_W, imgH, 'F')
      doc.setFontSize(7); doc.setTextColor(80, 80, 110)
      doc.text('screenshot missing', imgCol2 + IMG_W/2, imgY + imgH/2, { align: 'center' })
    }

    // Volume mesh (tet wireframe) image
    const volPath = path.join(SHOT_DIR, `${g.file}-volume.png`)
    const volUrl = pngToDataUrl(volPath)
    if (volUrl) {
      doc.addImage(volUrl, 'PNG', imgCol3, imgY, IMG_W, imgH)
    } else {
      doc.setFillColor(30, 30, 55); doc.rect(imgCol3, imgY, IMG_W, imgH, 'F')
      doc.setFontSize(7); doc.setTextColor(80, 80, 110)
      doc.text('screenshot missing', imgCol3 + IMG_W/2, imgY + imgH/2, { align: 'center' })
    }

    // Row separator
    doc.setDrawColor(35, 35, 65); doc.setLineWidth(0.2)
    doc.line(M, rowY + ROW_H, PW - M, rowY + ROW_H)
  }

  // Footer
  doc.setFontSize(7); doc.setTextColor(60, 60, 90)
  doc.text('Generated by KoFEM — browser-first finite element analysis', PW/2, PH - 5, { align: 'center' })

  // Write file
  const arrayBuf = doc.output('arraybuffer')
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, Buffer.from(arrayBuf))
  console.log(`Report written to ${OUT_FILE}`)
}

run()
