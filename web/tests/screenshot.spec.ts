import { test, expect } from '@playwright/test'

test('capture app after solving', async ({ page }) => {
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

  // Take screenshot - Playwright handles the path
  await page.screenshot({ path: 'screenshots/solve-result.png', fullPage: true })
})
