import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

// ── Geometry groups ───────────────────────────────────────────────────────────

const BASE_DIR   = path.resolve('..', 'test_files')
const NIST_DIR   = path.join(BASE_DIR, 'NIST')

interface GeomEntry {
  file: string
  label: string
  dir?: string   // defaults to BASE_DIR
}

const ORIGINAL_GEOMETRIES: GeomEntry[] = [
  { file: 'box.stp',              label: 'Simple Box (80×60×40 mm)' },
  { file: 'cylinder.stp',         label: 'Cylinder (R=25, H=80 mm)' },
  { file: 'cone.stp',             label: 'Truncated Cone (R=10→20, H=30 mm)' },
  { file: 'l_bracket.stp',        label: 'L-Bracket (80×80×20 mm)' },
  { file: 'quarter_cylinder.stp', label: 'Quarter-Cylinder patch (R=5, H=10 mm)' },
  { file: 'new_bracket_2.stp',    label: 'Complex Bracket (STEP)' },
]

const NEW_GEOMETRIES: GeomEntry[] = [
  { file: 'tube.stp',          label: 'Hollow Tube (R₀=20, Rᵢ=14, H=60 mm)' },
  { file: 'elbow.stp',         label: '90° Pipe Elbow (Rₘ=40, r=10 mm)' },
  { file: 'torus_ring.stp',    label: 'Half-Torus U-Bend (Rₘ=30, r=10 mm)' },
  { file: 'stepped_shaft.stp', label: 'Stepped Shaft (R20→12, H30+40 mm)' },
  { file: 'hex_prism.stp',     label: 'Hex Prism (R=25, H=50 mm)' },
  { file: 'pyramid.stp',       label: 'Square Pyramid (50×50, H=60 mm)' },
  { file: 'wedge.stp',         label: 'Triangular Wedge (80×50×30 mm)' },
  { file: 'i_beam.stp',        label: 'I-Beam (W=60, H=80, L=80 mm)' },
  { file: 't_profile.stp',     label: 'T-Profile (W=80, H=68, L=20 mm)' },
  { file: 'u_channel.stp',     label: 'U-Channel (W=60, H=40, L=80 mm)' },
]

const NIST_GEOMETRIES: GeomEntry[] = [
  { file: 'nist_ctc_01_asme1_ap242-e1.stp',    label: 'NIST CTC-01', dir: NIST_DIR },
  { file: 'nist_ctc_02_asme1_ap242-e2.stp',    label: 'NIST CTC-02', dir: NIST_DIR },
  { file: 'nist_ctc_03_asme1_ap242-e2.stp',    label: 'NIST CTC-03', dir: NIST_DIR },
  { file: 'nist_ctc_04_asme1_ap242-e1.stp',    label: 'NIST CTC-04', dir: NIST_DIR },
  { file: 'nist_ctc_05_asme1_ap242-e1.stp',    label: 'NIST CTC-05', dir: NIST_DIR },
  { file: 'nist_ftc_06_asme1_ap242-e2.stp',    label: 'NIST FTC-06', dir: NIST_DIR },
  { file: 'nist_ftc_07_asme1_ap242-e2.stp',    label: 'NIST FTC-07', dir: NIST_DIR },
  { file: 'nist_ftc_08_asme1_ap242-e1-tg.stp', label: 'NIST FTC-08 (tg)', dir: NIST_DIR },
  { file: 'nist_ftc_08_asme1_ap242-e2.stp',    label: 'NIST FTC-08', dir: NIST_DIR },
  { file: 'nist_ftc_09_asme1_ap242-e1.stp',    label: 'NIST FTC-09', dir: NIST_DIR },
  { file: 'nist_ftc_10_asme1_ap242-e2.stp',    label: 'NIST FTC-10', dir: NIST_DIR },
  { file: 'nist_ftc_11_asme1_ap242-e2.stp',    label: 'NIST FTC-11', dir: NIST_DIR },
  { file: 'nist_stc_06_asme1_ap242-e3.stp',    label: 'NIST STC-06', dir: NIST_DIR },
  { file: 'nist_stc_07_asme1_ap242-e3.stp',    label: 'NIST STC-07', dir: NIST_DIR },
  { file: 'nist_stc_08_asme1_ap242-e3.stp',    label: 'NIST STC-08', dir: NIST_DIR },
  { file: 'nist_stc_09_asme1_ap242-e3.stp',    label: 'NIST STC-09', dir: NIST_DIR },
  { file: 'nist_stc_10_asme1_ap242-e2.stp',    label: 'NIST STC-10', dir: NIST_DIR },
]

const OUT_DIR = path.join('screenshots', 'report')

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getViewportClip(page: import('@playwright/test').Page) {
  const canvas = page.locator('canvas').first()
  const box = await canvas.boundingBox()
  if (!box) return undefined
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

async function captureGeom(
  page: import('@playwright/test').Page,
  stepFile: string,
  slug: string,
) {
  page.on('dialog', d => d.dismiss().catch(() => {}))

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(stepFile)
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 60_000 })

  await page.getByRole('button', { name: 'Fit View' }).click()
  await page.waitForTimeout(600)

  await page.screenshot({
    path: path.join(OUT_DIR, `${slug}-geometry.png`),
    clip: await getViewportClip(page),
  })

  await page.getByRole('button', { name: 'Wireframe' }).click()
  await page.waitForTimeout(200)
  await page.screenshot({
    path: path.join(OUT_DIR, `${slug}-mesh.png`),
    clip: await getViewportClip(page),
  })
  await page.getByRole('button', { name: 'Solid' }).click()

  await page.getByRole('button', { name: 'Vol Mesh' }).click()
  const volSolidBtn = page.getByRole('button', { name: 'Vol Solid' })
  const volReady = await volSolidBtn.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false)
  if (volReady) {
    await page.waitForTimeout(300)
    await page.screenshot({
      path: path.join(OUT_DIR, `${slug}-volume.png`),
      clip: await getViewportClip(page),
    })
    await volSolidBtn.click()
  }
}

// ── Test suites ───────────────────────────────────────────────────────────────

function registerSuite(suiteName: string, geometries: GeomEntry[]) {
  test.describe(suiteName, () => {
    test.beforeAll(() => { fs.mkdirSync(OUT_DIR, { recursive: true }) })

    for (const geom of geometries) {
      const dir = geom.dir ?? BASE_DIR
      const stepFile = path.join(dir, geom.file)

      if (!fs.existsSync(stepFile)) {
        test.skip(`${geom.label} — file not found: ${stepFile}`)
        continue
      }

      const slug = geom.file.replace(/\.stp$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')

      test(geom.label, async ({ page }) => {
        await captureGeom(page, stepFile, slug)
      })
    }
  })
}

registerSuite('Mesh capabilities report — original geometries', ORIGINAL_GEOMETRIES)
registerSuite('Mesh capabilities report — new test shapes',      NEW_GEOMETRIES)
registerSuite('Mesh capabilities report — NIST AP242 cases',     NIST_GEOMETRIES)
