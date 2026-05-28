import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

interface Geom {
  file: string
  label: string
  subdir?: string
}

// Geometries in ascending complexity order
const GEOMETRIES: Geom[] = [
  { file: 'box.stp',                label: 'Simple Box (80×60×40 mm)' },
  { file: 'cylinder.stp',           label: 'Cylinder (R=25, H=80 mm)' },
  { file: 'cone.stp',               label: 'Truncated Cone (R=10→20, H=30 mm)' },
  { file: 'l_bracket.stp',          label: 'L-Bracket (80×80×20 mm)' },
  { file: 'new_bracket_2.stp',      label: 'Complex Bracket (STEP)' },
  // New shapes added in last two commits
  { file: 'elbow.stp',              label: 'Pipe Elbow' },
  { file: 'hex_prism.stp',          label: 'Hexagonal Prism' },
  { file: 'i_beam.stp',             label: 'I-Beam Profile' },
  { file: 'pyramid.stp',            label: 'Square Pyramid' },
  { file: 'stepped_shaft.stp',      label: 'Stepped Shaft' },
  { file: 't_profile.stp',          label: 'T-Profile' },
  { file: 'torus_ring.stp',         label: 'Torus Ring' },
  { file: 'tube.stp',               label: 'Tube (hollow cylinder)' },
  { file: 'u_channel.stp',          label: 'U-Channel' },
  { file: 'wedge.stp',              label: 'Wedge' },
]

const NIST_GEOMETRIES: Geom[] = [
  { file: 'nist_ctc_01_asme1_ap242-e1.stp',    label: 'NIST CTC-01 (AP242 e1)',    subdir: 'NIST' },
  { file: 'nist_ctc_02_asme1_ap242-e2.stp',    label: 'NIST CTC-02 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_ctc_03_asme1_ap242-e2.stp',    label: 'NIST CTC-03 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_ctc_04_asme1_ap242-e1.stp',    label: 'NIST CTC-04 (AP242 e1)',    subdir: 'NIST' },
  { file: 'nist_ctc_05_asme1_ap242-e1.stp',    label: 'NIST CTC-05 (AP242 e1)',    subdir: 'NIST' },
  { file: 'nist_ftc_06_asme1_ap242-e2.stp',    label: 'NIST FTC-06 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_ftc_07_asme1_ap242-e2.stp',    label: 'NIST FTC-07 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_ftc_08_asme1_ap242-e2.stp',    label: 'NIST FTC-08 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_ftc_09_asme1_ap242-e1.stp',    label: 'NIST FTC-09 (AP242 e1)',    subdir: 'NIST' },
  { file: 'nist_ftc_10_asme1_ap242-e2.stp',    label: 'NIST FTC-10 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_ftc_11_asme1_ap242-e2.stp',    label: 'NIST FTC-11 (AP242 e2)',    subdir: 'NIST' },
  { file: 'nist_stc_06_asme1_ap242-e3.stp',    label: 'NIST STC-06 (AP242 e3)',    subdir: 'NIST' },
  { file: 'nist_stc_07_asme1_ap242-e3.stp',    label: 'NIST STC-07 (AP242 e3)',    subdir: 'NIST' },
  { file: 'nist_stc_08_asme1_ap242-e3.stp',    label: 'NIST STC-08 (AP242 e3)',    subdir: 'NIST' },
  { file: 'nist_stc_09_asme1_ap242-e3.stp',    label: 'NIST STC-09 (AP242 e3)',    subdir: 'NIST' },
]

const ALL_GEOMETRIES: Geom[] = [...GEOMETRIES, ...NIST_GEOMETRIES]

const STEP_FILES_DIR = path.resolve('..', 'test_files')
const OUT_DIR = path.join('playwright-results', 'screenshots', 'report')

test.describe('Mesh capabilities report', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  for (const geom of ALL_GEOMETRIES) {
    const stepFile = path.join(STEP_FILES_DIR, geom.subdir ?? '', geom.file)
    if (!fs.existsSync(stepFile)) {
      test.skip(`${geom.label} — file not found: ${stepFile}`)
      continue
    }

    test(geom.label, async ({ page }) => {
      const t0 = Date.now()
      const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

      page.on('console', msg => {
        if (msg.type() === 'error') console.error(`[${geom.label}] browser error: ${msg.text()}`)
      })
      page.on('pageerror', err => console.error(`[${geom.label}] page exception: ${err.message}`))

      console.log(`[${geom.label}] navigating to app`)
      await page.goto('/')
      // Dismiss welcome screen
      await page.getByRole('button', { name: 'Start with example' }).click()
      await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()
      console.log(`[${geom.label}] ${elapsed()} app ready, importing ${stepFile}`)

      // Import STEP file
      await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(stepFile)
      await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 10_000 })
      console.log(`[${geom.label}] ${elapsed()} import done`)

      // Fail fast if the worker surfaced an error in the UI banner.
      const errorBanner = page.getByTestId('step-error')
      if (await errorBanner.isVisible()) {
        throw new Error(`STEP import failed for ${geom.label}: ${await errorBanner.textContent()}`)
      }

      // Fit and settle
      await page.getByRole('button', { name: 'Fit View' }).click()
      await page.waitForTimeout(600)

      const slug = geom.file.replace('.stp', '')

      // ── Solid (geometry) screenshot ─────────────────────────────────────────
      await page.screenshot({
        path: path.join(OUT_DIR, `${slug}-geometry.png`),
        clip: await getViewportClip(page),
      })
      console.log(`[${geom.label}] ${elapsed()} geometry screenshot done`)

      // ── Wireframe (mesh) screenshot ─────────────────────────────────────────
      await page.getByRole('button', { name: 'Wireframe' }).click()
      await page.waitForTimeout(200)

      await page.screenshot({
        path: path.join(OUT_DIR, `${slug}-mesh.png`),
        clip: await getViewportClip(page),
      })
      console.log(`[${geom.label}] ${elapsed()} mesh screenshot done`)

      console.log(`[${geom.label}] ${elapsed()} DONE`)
    })
  }
})

async function getViewportClip(page: import('@playwright/test').Page) {
  // Clip to the Three.js canvas area (main viewport panel).
  // Use a short explicit timeout so a missing canvas returns null quickly
  // rather than blocking until the whole test budget is exhausted.
  const canvas = page.locator('canvas').first()
  const box = await canvas.boundingBox({ timeout: 5_000 }).catch(() => null)
  if (!box) return undefined
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}
