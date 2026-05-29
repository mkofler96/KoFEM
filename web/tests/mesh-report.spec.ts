import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

interface Geom {
  file: string
  label: string
  subdir?: string
}

const GEOMETRIES: Geom[] = [
  { file: 'tube.stp',               label: 'Tube (hollow cylinder)' },
  { file: 'new_bracket_2.stp',      label: 'Complex Bracket (STEP)' },
  { file: 'Wall Bracket.stp',       label: 'Wall Bracket' },
]

const NIST_GEOMETRIES: Geom[] = [
  { file: 'nist_ctc_03_asme1_ap242-e2.stp',    label: 'NIST CTC-03 (AP242 e2)' },
  { file: 'nist_ctc_05_asme1_ap242-e1.stp',    label: 'NIST CTC-05 (AP242 e1)' },
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

      // Import STEP file — complex geometries can take >10 s in CI
      await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(stepFile)
      await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 60_000 })
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
