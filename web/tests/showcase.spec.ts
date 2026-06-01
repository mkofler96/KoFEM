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

    // ── 1. Welcome screen ────────────────────────────────────────────────────
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '01-select-geometry.png') })
    console.log(`[showcase] ${elapsed()} 01 screenshot done`)

    // ── 2. Geometry panel — Wall Bracket surface ─────────────────────────────
    console.log(`[showcase] ${elapsed()} importing Wall Bracket.stp`)
    await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(WALL_BRACKET)
    await expect(page.getByText('Model geometry')).toBeVisible({ timeout: 60_000 })
    console.log(`[showcase] ${elapsed()} wall bracket tessellation done`)

    const errorBanner = page.getByTestId('step-error')
    if (await errorBanner.isVisible()) {
      throw new Error(`STEP import failed: ${await errorBanner.textContent()}`)
    }

    await page.waitForTimeout(600)
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry-options.png') })
    console.log(`[showcase] ${elapsed()} 02 screenshot done`)

    // ── 3. Mesh panel — generate volume mesh and show statistics ─────────────
    await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Mesh STEP volume' })).toBeVisible()

    await page.getByRole('button').filter({ hasText: 'Mesh STEP volume' }).click()
    await expect(page.getByText('Meshing…')).toBeVisible({ timeout: 10_000 })
    console.log(`[showcase] ${elapsed()} meshing started…`)
    await expect(page.getByText('Meshing…')).not.toBeVisible({ timeout: 200_000 })
    console.log(`[showcase] ${elapsed()} meshing complete`)

    const meshErr = page.locator('[class*="errorBanner"]')
    if (await meshErr.isVisible()) {
      throw new Error(`Meshing failed: ${await meshErr.textContent()}`)
    }

    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh-generation.png') })
    console.log(`[showcase] ${elapsed()} 03 screenshot done`)

    // ── Inject BCs and loads via the exposed Zustand store ───────────────────
    // Fix the face at the minimum extent of the longest bounding-box axis (wall
    // mount). Apply a force perpendicular to that axis at the opposite face (arm tip).
    await page.evaluate(() => {
      const store = (window as unknown as Record<string, unknown>).__kofemStore as {
        getState(): {
          nodes: { id: number; x: number; y: number; z: number }[]
          applyBcToFace(nodeIds: number[], dofs: number[], value: number): void
          applyLoadToFace(nodeIds: number[], dof: number, totalForce: number): void
        }
      }
      const state = store.getState()
      const nodes = state.nodes

      if (nodes.length === 0) throw new Error('No FEM nodes in store after meshing')

      const axes = ['x', 'y', 'z'] as const
      const extents = axes.map(ax => {
        const vals = nodes.map(n => n[ax])
        const min = Math.min(...vals)
        const max = Math.max(...vals)
        return { ax, min, max, span: max - min }
      })
      extents.sort((a, b) => b.span - a.span)

      const { ax, min, max } = extents[0]
      const tol = (max - min) * 0.05

      const fixedIds = nodes.filter(n => Math.abs(n[ax] - min) < tol).map(n => n.id)
      const loadedIds = nodes.filter(n => Math.abs(n[ax] - max) < tol).map(n => n.id)

      const loadDof = ax === 'x' ? 1 : ax === 'y' ? 2 : 1

      state.applyBcToFace(fixedIds, [0, 1, 2], 0)
      state.applyLoadToFace(loadedIds, loadDof, -500)
    })
    console.log(`[showcase] ${elapsed()} BCs and loads applied`)

    // ── 4. Constraints panel — applied BCs and loads ─────────────────────────
    await page.locator('nav').getByRole('button').filter({ hasText: 'Constraints' }).click()
    await expect(page.getByText('Boundary conditions')).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '04-load-application.png') })
    console.log(`[showcase] ${elapsed()} 04 screenshot done`)

    // ── 5. Solve and results — Wall Bracket displacement ─────────────────────
    await page.locator('nav').getByRole('button').filter({ hasText: 'Solve' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Run static solve' })).toBeEnabled()
    await page.getByRole('button').filter({ hasText: 'Run static solve' }).click()
    console.log(`[showcase] ${elapsed()} solver started…`)

    await expect(page.getByText('Result summary')).toBeVisible({ timeout: 60_000 })

    await page.screenshot({ path: path.join(OUT_DIR, '05-results.png') })
    console.log(`[showcase] ${elapsed()} 05 screenshot done`)

    console.log(`[showcase] ${elapsed()} DONE`)
  })
})
