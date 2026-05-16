import { test, expect } from '@playwright/test'
import path from 'path'

// Playwright is invoked from web/, so cwd is web/ and the STEP file lives one level up
const STEP_FILE = path.resolve('..', 'test_files', 'new_bracket_2.stp')

test('capture app after loading STEP file with fit view', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  // Upload the example STEP file via the hidden file input
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)

  // Wait for geometry to load. The "Wireframe" button only renders when
  // stepSurface is non-null, so its appearance is an unambiguous signal.
  // "toBeEnabled" on the Import button has a race condition: the button is
  // already enabled before the async file.text() read fires setRunning(true).
  await page.getByRole('button', { name: 'Wireframe' }).waitFor({ state: 'visible', timeout: 30_000 })

  // Fit all loaded geometry into the isometric view
  await page.getByRole('button', { name: 'Fit View' }).click()

  // Allow the camera reposition and a render frame to settle
  await page.waitForTimeout(800)

  await page.screenshot({ path: 'screenshots/step-fit-view.png', fullPage: true })
})
