import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

// Helper: dismiss the welcome screen by loading the built-in example
async function startExample(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Start with example' }).click()
  // Wait for the main app layout (geometry inputs visible)
  await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()
}

// Navigate to the "04 Solve" mode tab in the top navigation bar
async function goToSolvePanel(page: import('@playwright/test').Page) {
  await page.locator('nav').getByRole('button').filter({ hasText: 'Solve' }).click()
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

// ── Solver integration tests ──────────────────────────────────────────────────

test('solve on hex mesh completes and shows results', async ({ page }) => {
  await startExample(page)
  await goToSolvePanel(page)

  // The built-in cantilever uses CHEXA elements — the solver now handles them natively.
  const solveBtn = page.getByRole('button').filter({ hasText: 'Run static solve' })
  await expect(solveBtn).toBeEnabled()
  await solveBtn.click()

  // After a successful solve the panel switches to "Results" and shows displacement
  await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 })
})

// ── STEP → Volume mesh pipeline ───────────────────────────────────────────────

const STEP_FILE = path.resolve('..', 'test_files', 'tube.stp')

test('vol mesh stores FEM nodes in the store for solving', async ({ page }) => {
  test.setTimeout(180_000)
  test.skip(!fs.existsSync(STEP_FILE), `STEP fixture not found: ${STEP_FILE}`)

  const t0 = Date.now()
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

  const pageErrors: string[] = []
  page.on('pageerror', e => {
    console.error(`[vol-mesh] page error: ${e.message}`)
    pageErrors.push(e.message)
  })
  page.on('console', msg => {
    if (msg.type() === 'error') console.error(`[vol-mesh] console.error: ${msg.text()}`)
    else console.log(`[vol-mesh] console.${msg.type()}: ${msg.text()}`)
  })

  await startExample(page)
  console.log(`[vol-mesh] ${elapsed()} app ready`)

  // ── 1. Tessellate the STEP file ───────────────────────────────────────────
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)
  await expect(
    page.getByRole('button').filter({ hasText: 'Import STEP' }),
  ).toBeEnabled({ timeout: 60_000 })
  console.log(`[vol-mesh] ${elapsed()} STEP tessellation done`)

  const stepErr = page.getByTestId('step-error')
  if (await stepErr.isVisible()) {
    console.error(`[vol-mesh] step-error banner: ${await stepErr.textContent()}`)
  }
  await expect(stepErr).not.toBeVisible()

  // ── 2. Navigate to Mesh panel ────────────────────────────────────────────
  await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
  console.log(`[vol-mesh] ${elapsed()} navigated to Mesh panel`)

  // ── 3. Compute volume mesh ────────────────────────────────────────────────
  await page.getByRole('button').filter({ hasText: 'Mesh STEP volume' }).click()
  console.log(`[vol-mesh] ${elapsed()} clicked Mesh STEP volume`)

  await expect(page.getByText('Meshing…')).toBeVisible({ timeout: 10_000 })
  console.log(`[vol-mesh] ${elapsed()} meshing started (button shows Meshing…)`)

  await expect(page.getByText('Meshing…')).not.toBeVisible({ timeout: 150_000 })
  console.log(`[vol-mesh] ${elapsed()} meshing finished`)

  // Log any error banner that appeared
  const meshErr = page.locator('[class*="errorBanner"]')
  if (await meshErr.isVisible()) {
    console.error(`[vol-mesh] mesh error banner: ${await meshErr.textContent()}`)
  }

  // ── 4. Verify FEM data landed in the store ────────────────────────────────
  await goToSolvePanel(page)
  console.log(`[vol-mesh] ${elapsed()} navigated to Solve panel`)

  await expect(page.getByText(/Mesh ready/)).toBeVisible({ timeout: 10_000 })
  console.log(`[vol-mesh] ${elapsed()} Mesh ready visible — PASS`)

  expect(pageErrors).toHaveLength(0)
})
