import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

// Playwright is invoked from web/, so cwd is web/ and the STEP file lives one level up
const STEP_FILE = path.resolve('..', 'test_files', 'new_bracket_2.stp')

// new_bracket_2.stp is 3.5 MB; parsing can take 30–60 s in CI WASM.
// Give 90 s so the 60 s wireframe wait + fit-view overhead stays within budget.
test('capture app after loading STEP file with fit view', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)

  // Wait for geometry to load — "Wireframe" only renders when stepSurface is set.
  const loaded = await page
    .getByRole('button', { name: 'Wireframe' })
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => true)
    .catch(() => false)

  if (loaded) {
    await page.getByRole('button', { name: 'Fit View' }).click()
    await page.waitForTimeout(1_000)
  }

  // Read the WebGL canvas pixel buffer directly — more reliable than
  // page.screenshot() which may not flush the WebGL compositor in headless mode.
  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    return canvas ? canvas.toDataURL('image/png') : null
  })

  if (dataUrl) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync('screenshots/step-fit-view.png', Buffer.from(base64, 'base64'))
  }
}, { timeout: 90_000 })
