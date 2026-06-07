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

// Returns a promise that rejects the moment any browser console.error or
// uncaught page exception fires. Race this against every critical await so
// the test fails immediately instead of waiting for a timeout.
function watchForErrors(page: import('@playwright/test').Page, tag: string): Promise<never> {
  let _reject: ((err: Error) => void) | null = null
  const p = new Promise<never>((_, rej) => { _reject = rej })
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      console.error(`[${tag}] browser error: ${text}`)
      _reject?.(new Error(`Browser console.error: ${text}`))
    } else {
      console.log(`[${tag}] browser ${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', err => {
    console.error(`[${tag}] page exception: ${err.message}`)
    _reject?.(err)
  })
  return p
}

test('page loads with welcome screen and enters the app', async ({ page }) => {
  const fatal = watchForErrors(page, 'load')

  await page.goto('/')

  // Welcome screen is shown first
  await Promise.race([
    expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible(),
    fatal,
  ])

  // After clicking "Start with example", geometry inputs are shown
  await page.getByRole('button', { name: 'Start with example' }).click()
  await Promise.race([
    expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible(),
    fatal,
  ])
  await Promise.race([
    expect(page.getByRole('button', { name: 'Import INP' })).toBeVisible(),
    fatal,
  ])
})

// ── Solver integration tests ──────────────────────────────────────────────────

test('solve on hex mesh completes and shows results', async ({ page }) => {
  const fatal = watchForErrors(page, 'hex-solve')

  await startExample(page)
  await goToSolvePanel(page)

  // The built-in cantilever uses CHEXA elements — the solver now handles them natively.
  const solveBtn = page.getByRole('button').filter({ hasText: 'Run static solve' })
  await Promise.race([expect(solveBtn).toBeEnabled(), fatal])
  await solveBtn.click()

  // After a successful solve the panel switches to "Results" and shows displacement
  await Promise.race([
    expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 }),
    fatal,
  ])
})

// ── STEP → Volume mesh pipeline ───────────────────────────────────────────────
// Wall Bracket solve regression (WASM trap / SetIntPoint DCE) is covered by
// the Node.js script test_wall_bracket.mjs, which runs synchronously with no
// browser async layer and surfaces raw WASM errors directly.

const STEP_FILE = path.resolve('..', 'test_files', 'tube.stp')

test('vol mesh stores FEM nodes in the store for solving', async ({ page }) => {
  test.setTimeout(180_000)
  test.skip(!fs.existsSync(STEP_FILE), `STEP fixture not found: ${STEP_FILE}`)

  const t0 = Date.now()
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

  const fatal = watchForErrors(page, 'vol-mesh')

  await startExample(page)
  console.log(`[vol-mesh] ${elapsed()} app ready`)

  // ── 1. Tessellate the STEP file ───────────────────────────────────────────
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles(STEP_FILE)
  await Promise.race([
    expect(page.getByRole('button').filter({ hasText: 'Import STEP' })).toBeEnabled({ timeout: 60_000 }),
    fatal,
  ])
  console.log(`[vol-mesh] ${elapsed()} STEP tessellation done`)

  const stepErr = page.getByTestId('step-error')
  if (await stepErr.isVisible()) {
    throw new Error(`step-error banner: ${await stepErr.textContent()}`)
  }

  // ── 2. Navigate to Mesh panel ────────────────────────────────────────────
  await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
  console.log(`[vol-mesh] ${elapsed()} navigated to Mesh panel`)

  // ── 3. Compute volume mesh ────────────────────────────────────────────────
  await page.getByRole('button').filter({ hasText: 'Mesh STEP volume' }).click()
  console.log(`[vol-mesh] ${elapsed()} clicked Mesh STEP volume`)

  await Promise.race([
    expect(page.getByText('Meshing…')).toBeVisible({ timeout: 10_000 }),
    fatal,
  ])
  console.log(`[vol-mesh] ${elapsed()} meshing started (button shows Meshing…)`)

  await Promise.race([
    expect(page.getByText('Meshing…')).not.toBeVisible({ timeout: 150_000 }),
    fatal,
  ])
  console.log(`[vol-mesh] ${elapsed()} meshing finished`)

  const meshErr = page.locator('[class*="errorBanner"]')
  if (await meshErr.isVisible()) {
    throw new Error(`mesh error banner: ${await meshErr.textContent()}`)
  }

  // ── 4. Verify FEM data landed in the store ────────────────────────────────
  await goToSolvePanel(page)
  console.log(`[vol-mesh] ${elapsed()} navigated to Solve panel`)

  await Promise.race([
    expect(page.getByText(/Mesh ready/)).toBeVisible({ timeout: 10_000 }),
    fatal,
  ])
  console.log(`[vol-mesh] ${elapsed()} Mesh ready visible — PASS`)
})
