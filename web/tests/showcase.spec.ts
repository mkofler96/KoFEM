import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const OUT_DIR = path.join('playwright-results', 'screenshots', 'showcase')
const STEP_FILES_DIR = path.resolve('..', 'test_files')
const TUBE_STP = path.join(STEP_FILES_DIR, 'tube.stp')

test.describe('Full workflow showcase', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  test('tube: welcome → geometry → mesh → constraints → results', async ({ page }) => {
    test.setTimeout(120_000)

    if (!fs.existsSync(TUBE_STP)) {
      test.skip()
      return
    }

    const t0 = Date.now()
    const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

    page.on('console', msg => {
      if (msg.type() === 'error') console.error(`[showcase] browser error: ${msg.text()}`)
    })
    page.on('pageerror', err => console.error(`[showcase] page exception: ${err.message}`))

    await page.goto('/')

    // 1. Welcome screen
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '01-select-geometry.png') })
    console.log(`[showcase] ${elapsed()} 01 screenshot done`)

    // Import tube STEP
    console.log(`[showcase] ${elapsed()} importing tube.stp`)
    await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(TUBE_STP)
    await expect(page.getByText('Model geometry')).toBeVisible({ timeout: 60_000 })
    console.log(`[showcase] ${elapsed()} tessellation done`)

    const errorBanner = page.getByTestId('step-error')
    if (await errorBanner.isVisible()) {
      throw new Error(`STEP import failed: ${await errorBanner.textContent()}`)
    }

    await page.waitForTimeout(600)

    // 2. Geometry panel — tube surface
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry-options.png') })
    console.log(`[showcase] ${elapsed()} 02 screenshot done`)

    // 3. Mesh panel — trigger volume meshing and wait for completion
    await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Mesh STEP volume' })).toBeVisible()
    console.log(`[showcase] ${elapsed()} 03 clicking Mesh STEP volume…`)
    await page.getByRole('button').filter({ hasText: 'Mesh STEP volume' }).click()
    await expect(page.getByText('Mesh is solver-ready')).toBeVisible({ timeout: 30_000 })
    console.log(`[showcase] ${elapsed()} 03 volume mesh complete`)
    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh-generation.png') })
    console.log(`[showcase] ${elapsed()} 03 screenshot done`)

    // 4. Apply BCs and load to the meshed tube, then show constraints panel.
    // Find the tube's long axis by bounding-box extents; fix the near face, load the far face.
    await page.evaluate(() => {
      type CoordNode = { id: number; x: number; y: number; z: number }
      const store = (window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: CoordNode[]
            applyBcToFace(ids: number[], dofs: number[], val: number): void
            applyLoadToFace(ids: number[], dof: number, force: number): void
          }
        }
      }).__kofemStore
      const state = store.getState()
      const { nodes } = state

      const axes = ['x', 'y', 'z'] as const
      const ranges = axes.map(ax => {
        const vals = nodes.map(n => n[ax])
        return { ax, min: Math.min(...vals), max: Math.max(...vals) }
      })
      const { ax, min, max } = ranges.reduce((a, b) => (b.max - b.min > a.max - a.min ? b : a))
      const tol = (max - min) * 0.01
      const fixedIds = nodes.filter(n => n[ax] < min + tol).map(n => n.id)
      const loadedIds = nodes.filter(n => n[ax] > max - tol).map(n => n.id)
      state.applyBcToFace(fixedIds, [0, 1, 2], 0)
      state.applyLoadToFace(loadedIds, 1, -2000)
    })

    await page.locator('nav').getByRole('button').filter({ hasText: 'Constraints' }).click()
    await expect(page.getByText('Boundary conditions')).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '04-load-application.png') })
    console.log(`[showcase] ${elapsed()} 04 screenshot done`)

    // 5. Solve and results
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
