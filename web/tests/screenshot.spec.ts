import { test, expect } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const SCREENSHOT_DIR = path.resolve(__dirname, '../screenshots')

test.describe('Screenshot Tests', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    }
  })

  test('capture app after solving', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))

    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Solve' })).toBeVisible()

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

    console.log(`Screenshot saved to: ${screenshotPath}`)

    // Save manifest for upload script
    const manifestPath = path.join(SCREENSHOT_DIR, 'latest.json')
    fs.writeFileSync(manifestPath, JSON.stringify({
      viewport: screenshotPath,
      fullPage: screenshotPath,
      timestamp: new Date().toISOString()
    }, null, 2))

    expect(errors).toHaveLength(0)
  })
})
