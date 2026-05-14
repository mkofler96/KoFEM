import { test, expect } from '@playwright/test'
import path from 'path'

const STEP_FILE = path.join(__dirname, '../../test_files/new_bracket_2.stp')

test('capture app after loading STEP file with fit view', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  // Upload the example STEP file via the hidden file input
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)

  // Wait for import to finish — button returns to its default label
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 30_000 })

  // Fit all loaded geometry into the isometric view
  await page.getByRole('button', { name: 'Fit View' }).click()

  // Allow the camera reposition and a render frame to settle
  await page.waitForTimeout(500)

  await page.screenshot({ path: 'screenshots/step-fit-view.png', fullPage: true })
})
