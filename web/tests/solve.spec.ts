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
  test.skip(!fs.existsSync(STEP_FILE), `STEP fixture not found: ${STEP_FILE}`)

  const pageErrors: string[] = []
  page.on('pageerror', e => pageErrors.push(e.message))

  await startExample(page)

  // ── 1. Tessellate the STEP file ───────────────────────────────────────────
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)
  // Wait for WASM tessellation to complete (button re-enables when done)
  await expect(
    page.getByRole('button').filter({ hasText: 'Import STEP' }),
  ).toBeEnabled({ timeout: 60_000 })
  await expect(page.getByTestId('step-error')).not.toBeVisible()

  // ── 2. Navigate to Mesh panel where the volume mesh button lives ─────────
  await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()

  // ── 3. Compute volume mesh ────────────────────────────────────────────────
  await page.getByRole('button').filter({ hasText: 'Mesh STEP volume' }).click()
  // Button changes to "Meshing…" while running, then back when done
  await expect(page.getByText('Meshing…')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Meshing…')).not.toBeVisible({ timeout: 60_000 })

  // ── 4. Verify FEM data landed in the store ────────────────────────────────
  // Navigate to the Solve panel — pre-flight shows mesh-ready with node count
  await goToSolvePanel(page)
  // "Mesh ready · X nodes · Y elements" is shown only when nodes.length > 0
  await expect(page.getByText(/Mesh ready/)).toBeVisible()

  expect(pageErrors).toHaveLength(0)
}, 90_000)   // extended timeout: WASM init + tessellation + Netgen vol mesh
