import { test, expect } from '@playwright/test'
import path from 'path'

// Playwright is invoked from web/, so cwd is web/ and the STEP file lives one level up
const STEP_FILE = path.resolve('..', 'test_files', 'new_bracket_2.stp')

test('capture app after loading STEP file with fit view', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()

  // Capture any alert that fires during import so we can fail with the real
  // error message instead of silently passing with an empty canvas.
  let importError: string | undefined
  page.on('dialog', async d => {
    importError = d.message()
    await d.dismiss()
  })

  // Upload the example STEP file via the hidden file input
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)

  // Wait for import to finish — button returns to its default label
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeEnabled({ timeout: 30_000 })

  if (importError) throw new Error(`STEP import failed: ${importError}`)

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
