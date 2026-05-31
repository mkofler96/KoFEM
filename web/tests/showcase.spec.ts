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

  test('wall bracket: welcome → geometry → mesh panel → constraints → results', async ({ page }) => {
    test.setTimeout(120_000)

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

    // ── Phase 1: Wall Bracket — screenshots 1–4 ──────────────────────────────
    console.log(`[showcase] ${elapsed()} navigating to app`)
    await page.goto('/')

    // 1. Welcome screen — geometry selection / import window
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '01-select-geometry.png') })
    console.log(`[showcase] ${elapsed()} 01 screenshot done`)

    // Import wall bracket STEP from the welcome screen.
    // setStepSurface auto-transitions to geometry mode (hasStarted = true).
    console.log(`[showcase] ${elapsed()} importing Wall Bracket.stp`)
    await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(WALL_BRACKET)
    await expect(page.getByText('Model geometry')).toBeVisible({ timeout: 60_000 })
    console.log(`[showcase] ${elapsed()} wall bracket tessellation done`)

    const errorBanner = page.getByTestId('step-error')
    if (await errorBanner.isVisible()) {
      throw new Error(`STEP import failed: ${await errorBanner.textContent()}`)
    }

    await page.waitForTimeout(600)

    // 2. Geometry panel — wall bracket surface loaded with options panel visible
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry-options.png') })
    console.log(`[showcase] ${elapsed()} 02 screenshot done`)

    // Navigate to Mesh panel via TopBar and show the mesh-generation interface
    await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Mesh STEP volume' })).toBeVisible()

    // 3. Mesh panel — wall bracket surface stats and volume-mesh controls
    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh-generation.png') })
    console.log(`[showcase] ${elapsed()} 03 screenshot done`)

    // Navigate to Constraints panel
    await page.locator('nav').getByRole('button').filter({ hasText: 'Constraints' }).click()
    await expect(page.getByText('Boundary conditions')).toBeVisible()

    // 4. Constraints panel — boundary condition and load interface
    await page.screenshot({ path: path.join(OUT_DIR, '04-load-application.png') })
    console.log(`[showcase] ${elapsed()} 04 screenshot done`)

    // ── Phase 2: Cantilever example — screenshot 5 (actual results) ──────────
    // Reload and use the pre-configured cantilever beam (BCs + loads already set)
    // to demonstrate the solver and results panel with real displacement data.
    await page.goto('/')
    await page.getByRole('button', { name: 'Start with example' }).click()
    await expect(page.getByText('Model geometry')).toBeVisible()

    await page.locator('nav').getByRole('button').filter({ hasText: 'Solve' }).click()
    await expect(page.getByRole('button').filter({ hasText: 'Run static solve' })).toBeEnabled()
    await page.getByRole('button').filter({ hasText: 'Run static solve' }).click()
    console.log(`[showcase] ${elapsed()} solver started…`)

    // Solver auto-navigates to Results on completion
    await expect(page.getByText('Result summary')).toBeVisible({ timeout: 30_000 })

    // 5. Results panel — displacement and stress post-processing
    await page.screenshot({ path: path.join(OUT_DIR, '05-results.png') })
    console.log(`[showcase] ${elapsed()} 05 screenshot done`)

    console.log(`[showcase] ${elapsed()} DONE`)
  })
})
