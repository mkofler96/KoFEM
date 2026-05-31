import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const OUT_DIR = path.join('playwright-results', 'screenshots', 'showcase')

test.describe('Full workflow showcase', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  test('cantilever beam: welcome → geometry → mesh → constraints → solve → results', async ({ page }) => {
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

    // Load the built-in cantilever beam (75 nodes, 40 CHEXA8 elements, BCs + loads pre-set)
    await page.getByRole('button', { name: 'Start with example' }).click()
    await expect(page.getByText('Model geometry')).toBeVisible()
    await page.waitForTimeout(800)

    // 2. Geometry panel — model loaded with left panel and 3D viewport visible
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry-options.png') })
    console.log(`[showcase] ${elapsed()} 02 screenshot done`)

    // Navigate to Mesh mode via TopBar
    await page.locator('header').getByRole('button', { name: /Mesh/ }).click()
    await expect(page.getByText('Mesh is solver-ready')).toBeVisible()

    // 3. Mesh panel — mesh statistics (75 nodes, 40 CHEXA8 elements)
    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh-generation.png') })
    console.log(`[showcase] ${elapsed()} 03 screenshot done`)

    // Navigate to Constraints mode via TopBar
    await page.locator('header').getByRole('button', { name: /Constraints/ }).click()
    await expect(page.getByText('Boundary conditions')).toBeVisible()

    // 4. Constraints panel — applied BCs and loads
    await page.screenshot({ path: path.join(OUT_DIR, '04-load-application.png') })
    console.log(`[showcase] ${elapsed()} 04 screenshot done`)

    // Navigate to Solve mode, run the solver
    await page.locator('header').getByRole('button', { name: /Solve/ }).click()
    await expect(page.getByRole('button', { name: /Run static solve/ })).toBeEnabled()
    await page.getByRole('button', { name: /Run static solve/ }).click()

    // Wait for results panel — solver navigates automatically on completion
    await expect(page.getByText('Result summary')).toBeVisible({ timeout: 30_000 })

    // 5. Results panel — displacement and stress post-processing
    await page.screenshot({ path: path.join(OUT_DIR, '05-results.png') })
    console.log(`[showcase] ${elapsed()} 05 screenshot done`)

    console.log(`[showcase] ${elapsed()} DONE`)
  })
})
