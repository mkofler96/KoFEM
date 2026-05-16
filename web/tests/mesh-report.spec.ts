import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

// Geometries in ascending complexity order
const GEOMETRIES = [
  { file: 'box.stp',                label: 'Simple Box (80×60×40 mm)' },
  { file: 'cylinder.stp',           label: 'Cylinder (R=25, H=80 mm)' },
  { file: 'cone.stp',               label: 'Truncated Cone (R=10→20, H=30 mm)' },
  { file: 'l_bracket.stp',          label: 'L-Bracket (80×80×20 mm)' },
  { file: 'quarter_cylinder.stp',   label: 'Quarter-Cylinder patch (R=5, H=10 mm)' },
  { file: 'new_bracket_2.stp',      label: 'Complex Bracket (STEP)' },
]

const STEP_FILES_DIR = path.resolve('..', 'test_files')
const OUT_DIR = path.join('screenshots', 'report')

test.describe('Mesh capabilities report', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  for (const geom of GEOMETRIES) {
    const stepFile = path.join(STEP_FILES_DIR, geom.file)
    if (!fs.existsSync(stepFile)) {
      test.skip(`${geom.label} — file not found: ${stepFile}`)
      continue
    }

    test(geom.label, async ({ page }) => {
      // Capture any alert that fires (STEP import error, worker crash, etc.)
      // so the test fails with the real error instead of silently skipping.
      let importError: string | undefined
      page.on('dialog', async d => {
        if (!importError) importError = d.message()
        await d.dismiss().catch(() => {})
      })

      await page.goto('/')
      await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

      // Import STEP file
      await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(stepFile)
      await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 60_000 })

      if (importError) throw new Error(`STEP import failed for ${geom.label}: ${importError}`)

      // Fit and settle
      await page.getByRole('button', { name: 'Fit View' }).click()
      await page.waitForTimeout(600)

      const slug = geom.file.replace('.stp', '')

      // ── Solid (geometry) screenshot ─────────────────────────────────────────
      await page.screenshot({
        path: path.join(OUT_DIR, `${slug}-geometry.png`),
        clip: await getViewportClip(page),
      })

      // ── Wireframe (mesh) screenshot ─────────────────────────────────────────
      await page.getByRole('button', { name: 'Wireframe' }).click()
      await page.waitForTimeout(200)

      await page.screenshot({
        path: path.join(OUT_DIR, `${slug}-mesh.png`),
        clip: await getViewportClip(page),
      })

      await page.getByRole('button', { name: 'Solid' }).click()

      // ── Volume mesh screenshot ───────────────────────────────────────────────
      await page.getByRole('button', { name: 'Vol Mesh' }).click()
      // Volume meshing runs in WASM — wait up to 30 s; skip gracefully if slow
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
    })
  }
})

async function getViewportClip(page: import('@playwright/test').Page) {
  // Clip to the Three.js canvas area (main viewport panel)
  const canvas = page.locator('canvas').first()
  const box = await canvas.boundingBox()
  if (!box) return undefined
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}
