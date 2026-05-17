import { test, expect } from '@playwright/test'
import path from 'path'

// Playwright is invoked from web/, so cwd is web/ and the STEP file lives one level up
const STEP_FILE = path.resolve('..', 'test_files', 'new_bracket_2.stp')

test('capture app after loading STEP file with fit view', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  // Upload the example STEP file via the hidden file input
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)

  // Wait for import to finish — button returns to its default label
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 30_000 })

  // Fail fast if the worker reported an error in the UI banner (no alert dialog).
  const errorBanner = page.getByTestId('step-error')
  if (await errorBanner.isVisible()) {
    throw new Error(`STEP import failed: ${await errorBanner.textContent()}`)
  }

  // Fit all loaded geometry into the isometric view
  await page.getByRole('button', { name: 'Fit View' }).click()

  // Allow the camera reposition and a render frame to settle
  await page.waitForTimeout(500)

  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    return canvas ? canvas.toDataURL('image/png') : null
  })
  if (dataUrl) {
    const fs = await import('fs')
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync('screenshots/step-fit-view.png', Buffer.from(base64, 'base64'))
  }
})
