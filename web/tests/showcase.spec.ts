import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const OUT_DIR = path.join('playwright-results', 'screenshots', 'showcase')
const STEP_FILES_DIR = path.resolve('..', 'test_files')
const WALL_BRACKET = path.join(STEP_FILES_DIR, 'Wall Bracket.stp')

test.describe('Full workflow showcase', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  test('wall bracket: welcome → geometry → mesh → constraints → results', async ({ page }) => {
    test.setTimeout(360_000)

    if (!fs.existsSync(WALL_BRACKET)) {
      test.skip()
      return
    }

    const t0 = Date.now()
    const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`[showcase] browser error: ${msg.text()}`)
    })
    page.on('pageerror', err => console.error(`[showcase] page exception: ${err.message}`))

    // ── Phase 1: Wall Bracket STEP — screenshots 1–4 ─────────────────────────
    // Screenshots 1–4 use the real wall bracket geometry. Screenshot 03 now
    // triggers volume meshing so the showcase shows the completed tet mesh.
    // The test file guard above skips this test in CI where the STEP file is absent.

    await page.goto('/')

    // 1. Welcome screen
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '01-select-geometry.png') })
    console.log(`[showcase] ${elapsed()} 01 screenshot done`)

    // Import wall bracket — OCCT tessellation only, no volume mesh
    console.log(`[showcase] ${elapsed()} importing Wall Bracket.stp`)
    await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(WALL_BRACKET)
    await expect(page.getByText('Model geometry')).toBeVisible({ timeout: 60_000 })
    console.log(`[showcase] ${elapsed()} tessellation done`)

    const errorBanner = page.getByTestId('step-error')
    if (await errorBanner.isVisible()) {
      throw new Error(`STEP import failed: ${await errorBanner.textContent()}`)
    }

    await page.waitForTimeout(600)

    // 2. Geometry panel — wall bracket surface
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry-options.png') })
    console.log(`[showcase] ${elapsed()} 02 screenshot done`)

    // 3. Mesh panel — trigger volume meshing and wait for completion
    await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Mesh STEP volume' })).toBeVisible()
    console.log(`[showcase] ${elapsed()} 03 clicking Mesh STEP volume…`)
    await page.getByRole('button').filter({ hasText: 'Mesh STEP volume' }).click()
    await expect(page.getByText('Mesh is solver-ready')).toBeVisible({ timeout: 240_000 })
    console.log(`[showcase] ${elapsed()} 03 volume mesh complete`)
    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh-generation.png') })
    console.log(`[showcase] ${elapsed()} 03 screenshot done`)

    // 4. Constraints panel
    await page.locator('nav').getByRole('button').filter({ hasText: 'Constraints' }).click()
    await expect(page.getByText('Boundary conditions')).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '04-load-application.png') })
    console.log(`[showcase] ${elapsed()} 04 screenshot done`)

    // ── Phase 2: Wall Bracket simplified FEM — screenshot 5 ──────────────────
    // Reload and inject a structured hex mesh with wall-bracket proportions
    // (150 × 60 × 40 mm). BCs and loads are applied programmatically:
    // min-X face fixed (wall mount), max-X face loaded in -Y (tip force).
    // This avoids Netgen WASM while still demonstrating the full solve pipeline.

    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()

    await page.evaluate(() => {
      const store = (window as unknown as Record<string, unknown>).__kofemStore as {
        getState(): {
          nodes: { id: number; x: number; y: number; z: number }[]
          startCustom(params: {
            name: string; lx: number; ly: number; lz: number
            nx: number; ny: number; nz: number
          }): void
          applyBcToFace(nodeIds: number[], dofs: number[], value: number): void
          applyLoadToFace(nodeIds: number[], dof: number, totalForce: number): void
        }
      }
      const state = store.getState()

      // Build a wall-bracket proportioned hex mesh
      state.startCustom({ name: 'Wall Bracket', lx: 0.15, ly: 0.06, lz: 0.04, nx: 6, ny: 3, nz: 2 })

      const { nodes } = store.getState()
      const xs = nodes.map(n => n.x)
      const minX = Math.min(...xs), maxX = Math.max(...xs)
      const tol = (maxX - minX) * 0.01

      const fixedIds = nodes.filter(n => n.x < minX + tol).map(n => n.id)
      const loadedIds = nodes.filter(n => n.x > maxX - tol).map(n => n.id)

      state.applyBcToFace(fixedIds, [0, 1, 2], 0)
      state.applyLoadToFace(loadedIds, 1, -2000)
    })

    await expect(page.getByText('Model geometry')).toBeVisible()

    // 5. Solve and results
    await page.locator('nav').getByRole('button').filter({ hasText: 'Solve' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Run static solve' })).toBeEnabled()
    await page.getByRole('button').filter({ hasText: 'Run static solve' }).click()
    console.log(`[showcase] ${elapsed()} solver started…`)

    await expect(page.getByText('Result summary')).toBeVisible({ timeout: 30_000 })

    await page.screenshot({ path: path.join(OUT_DIR, '05-results.png') })
    console.log(`[showcase] ${elapsed()} 05 screenshot done`)

    console.log(`[showcase] ${elapsed()} DONE`)
  })
})
