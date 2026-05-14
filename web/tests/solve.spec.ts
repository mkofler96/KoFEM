import { test, expect } from '@playwright/test'

test('page loads with toolbar and viewport', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))

  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Solve' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import INP' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()
  expect(errors).toHaveLength(0)
})

test('solve default model completes and button re-enables', async ({ page }) => {
  await page.goto('/')

  const solveBtn = page.getByRole('button', { name: /Solve|Solving/ })
  await expect(solveBtn).toBeEnabled()

  await solveBtn.click()
  // Button becomes disabled while solving
  await expect(solveBtn).toBeDisabled()
  // Wait for solve to finish — button text returns to "Solve" and re-enables
  await expect(page.getByRole('button', { name: 'Solve' })).toBeEnabled({ timeout: 30_000 })
})

test('results panel shows displacement after solve', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: 'Solve' }).click()
  // Wait for solve to finish
  await expect(page.getByRole('button', { name: 'Solve' })).toBeEnabled({ timeout: 30_000 })

  // Results panel should show a numeric displacement value
  await expect(page.getByText(/Max \|displacement\|/i)).toBeVisible()
})
