import { test, expect } from '@playwright/test'

// Helper: dismiss the welcome screen by loading the built-in example
async function startExample(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start with example' }).click()
  // Wait for the main app layout (geometry inputs visible)
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()
}

// Navigate to the Solve mode tab in the top bar
async function goToSolveMode(page: import('@playwright/test').Page) {
  await page.locator('button').filter({ hasText: 'Solve' }).first().click()
}

test('page loads with welcome screen and enters the app', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))

  await page.goto('/')

  // Welcome screen is shown first
  await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()

  // After clicking "Start with example", geometry inputs are shown
  await page.getByRole('button', { name: 'Start with example' }).click()
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import INP' })).toBeVisible()

  expect(errors).toHaveLength(0)
})

test('solve default model completes and navigates to results', async ({ page }) => {
  await startExample(page)
  await goToSolveMode(page)

  const solveBtn = page.getByRole('button', { name: /Run static solve|Solving/ })
  await expect(solveBtn).toBeEnabled()

  await solveBtn.click()
  // Button becomes disabled while solving
  await expect(solveBtn).toBeDisabled()
  // After solve, app auto-navigates to Results mode showing displacement
  await expect(page.getByText(/Max \|U\|/i)).toBeVisible({ timeout: 30_000 })
})

test('results panel shows displacement after solve', async ({ page }) => {
  await startExample(page)
  await goToSolveMode(page)

  await page.getByRole('button', { name: 'Run static solve' }).click()
  // App auto-navigates to Results mode after solve completes
  await expect(page.getByText(/Max \|U\|/i)).toBeVisible({ timeout: 30_000 })
})
