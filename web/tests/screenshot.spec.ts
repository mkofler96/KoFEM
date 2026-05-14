import { test, expect } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const STEP_FILE_PATH = path.resolve(__dirname, '../../test_files/new_bracket_2.stp')
const SCREENSHOT_DIR = path.resolve(__dirname, '../screenshots')

test.describe('Screenshot Tests', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    }
  })

  test('capture app with STEP file loaded', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))

    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

    // Upload the STEP file
    const fileInput = page.locator('input[type="file"][accept=".stp,.step"]')
    await fileInput.setInputFiles(STEP_FILE_PATH)

    // Wait for import to complete (button text returns to "Import STEP")
    await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 60_000 })

    // Wait a moment for the 3D scene to render
    await page.waitForTimeout(1000)

    // Take screenshot of the full page
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const screenshotPath = path.join(SCREENSHOT_DIR, `step-import-${timestamp}.png`)

    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    })

    console.log(`Screenshot saved to: ${screenshotPath}`)

    // Also save a viewport-only screenshot
    const viewportScreenshotPath = path.join(SCREENSHOT_DIR, `step-import-viewport-${timestamp}.png`)
    await page.screenshot({
      path: viewportScreenshotPath,
      fullPage: false
    })

    console.log(`Viewport screenshot saved to: ${viewportScreenshotPath}`)

    expect(errors).toHaveLength(0)

    // Output the paths for the upload script to consume
    const manifestPath = path.join(SCREENSHOT_DIR, 'latest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({
      fullPage: screenshotPath,
      viewport: viewportScreenshotPath,
      timestamp: new Date().toISOString()
    }, null, 2))
  })

  test('capture app after solving', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))

    await page.goto('/')

    // Solve the default model
    const solveBtn = page.getByRole('button', { name: /Solve|Solving/ })
    await expect(solveBtn).toBeEnabled()
    await solveBtn.click()

    // Wait for solve to complete
    await expect(page.getByRole('button', { name: 'Solve' })).toBeEnabled({ timeout: 60_000 })

    // Wait for results to render
    await page.waitForTimeout(500)

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const screenshotPath = path.join(SCREENSHOT_DIR, `solve-result-${timestamp}.png`)

    await page.screenshot({
      path: screenshotPath,
      fullPage: true
    })

    console.log(`Solve result screenshot saved to: ${screenshotPath}`)

    expect(errors).toHaveLength(0)
  })
})
