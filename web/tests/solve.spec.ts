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


