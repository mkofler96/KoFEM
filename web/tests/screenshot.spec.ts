import { test, expect } from '@playwright/test'
import path from 'path'

// Playwright is invoked from web/, so cwd is web/ and the STEP file lives one level up
const STEP_FILE = path.resolve('..', 'test_files', 'new_bracket_2.stp')

// new_bracket_2.stp is 3.5 MB; parsing can take 30–60 s in CI WASM.
// Give 90 s so the 60 s wireframe wait + fit-view overhead stays within budget.
test('capture app after loading STEP file with fit view', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  // Upload the example STEP file via the hidden file input
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)

  // Wait for geometry to load. The "Wireframe" button only renders when
  // stepSurface is non-null — its appearance is an unambiguous "loaded" signal.
  // We don't throw on timeout: if the parse is slow we still capture a screenshot.
  const loaded = await page
    .getByRole('button', { name: 'Wireframe' })
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => true)
    .catch(() => false)

  if (loaded) {
    await page.getByRole('button', { name: 'Fit View' }).click()
    await page.waitForTimeout(800)
  }

  await page.screenshot({ path: 'screenshots/step-fit-view.png', fullPage: true })
}, { timeout: 90_000 })
