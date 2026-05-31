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

  test('wall bracket: welcome → geometry → mesh → constraints → solve → results', async ({ page }) => {
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

    console.log(`[showcase] ${elapsed()} navigating to app`)
    await page.goto('/')

    // 1. Welcome screen — geometry selection / import window
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '01-select-geometry.png') })
    console.log(`[showcase] ${elapsed()} 01 screenshot done`)

    // Import wall bracket STEP from the welcome screen.
    // setStepSurface clears nodes/constraints/loads but keeps the default Steel
    // material, then auto-transitions to geometry mode (hasStarted = true).
    console.log(`[showcase] ${elapsed()} importing Wall Bracket.stp`)
    await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(WALL_BRACKET)
    await expect(page.getByText('Model geometry')).toBeVisible({ timeout: 60_000 })
    console.log(`[showcase] ${elapsed()} wall bracket tessellation done`)

    const errorBanner = page.getByTestId('step-error')
    if (await errorBanner.isVisible()) {
      throw new Error(`STEP import failed: ${await errorBanner.textContent()}`)
    }

    await page.waitForTimeout(600)

    // 2. Geometry panel — wall bracket surface with options panel visible
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry-options.png') })
    console.log(`[showcase] ${elapsed()} 02 screenshot done`)

    // Navigate to Mesh mode via TopBar, then generate volume mesh
    await page.locator('header').getByRole('button', { name: /Mesh/ }).click()
    await expect(page.getByRole('button', { name: /Mesh STEP volume/ })).toBeVisible()
    await page.getByRole('button', { name: /Mesh STEP volume/ }).click()
    console.log(`[showcase] ${elapsed()} volume meshing started…`)
    await expect(page.getByText('Mesh is solver-ready')).toBeVisible({ timeout: 120_000 })
    console.log(`[showcase] ${elapsed()} wall bracket volume mesh done`)

    // 3. Mesh panel — volume mesh statistics
    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh-generation.png') })
    console.log(`[showcase] ${elapsed()} 03 screenshot done`)

    // Navigate to Constraints mode
    await page.locator('header').getByRole('button', { name: /Constraints/ }).click()
    await expect(page.getByText('Boundary conditions')).toBeVisible()

    // Apply BCs and loads programmatically — face picking is not automatable in
    // Playwright, so we inject through the store exposed on window in DEV mode.
    await page.evaluate(() => {
      type KStore = {
        getState: () => {
          nodes: { id: number; x: number; y: number; z: number }[]
          applyBcToFace: (nodeIds: number[], dofs: number[], value: number) => void
          applyLoadToFace: (nodeIds: number[], dof: number, totalForce: number) => void
        }
      }
      const store = (window as Window & { __kofemStore?: KStore }).__kofemStore
      if (!store) return
      const { nodes, applyBcToFace, applyLoadToFace } = store.getState()
      const zVals = nodes.map(n => n.z)
      const zMin = Math.min(...zVals), zMax = Math.max(...zVals)
      const range = zMax - zMin
      // Fix nodes at the bottom (mounting face), load nodes at the top
      const fixedIds = nodes.filter(n => n.z <= zMin + 0.05 * range).map(n => n.id)
      const loadedIds = nodes.filter(n => n.z >= zMax - 0.05 * range).map(n => n.id)
      if (fixedIds.length > 0) applyBcToFace(fixedIds, [0, 1, 2], 0)
      if (loadedIds.length > 0) applyLoadToFace(loadedIds, 1, -10_000)
    })
    console.log(`[showcase] ${elapsed()} BCs and loads applied`)

    // 4. Constraints panel — applied boundary conditions and loads
    await page.screenshot({ path: path.join(OUT_DIR, '04-load-application.png') })
    console.log(`[showcase] ${elapsed()} 04 screenshot done`)

    // Navigate to Solve mode, run the solver
    await page.locator('header').getByRole('button', { name: /Solve/ }).click()
    await expect(page.getByRole('button', { name: /Run static solve/ })).toBeEnabled()
    await page.getByRole('button', { name: /Run static solve/ }).click()
    console.log(`[showcase] ${elapsed()} solver started…`)

    // Wait for results — the solver auto-navigates to the Results panel on completion
    await expect(page.getByText('Result summary')).toBeVisible({ timeout: 60_000 })

    // 5. Results panel — displacement and stress post-processing
    await page.screenshot({ path: path.join(OUT_DIR, '05-results.png') })
    console.log(`[showcase] ${elapsed()} 05 screenshot done`)

    console.log(`[showcase] ${elapsed()} DONE`)
  })
})
