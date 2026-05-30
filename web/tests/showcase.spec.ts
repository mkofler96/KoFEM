import { test, expect } from '@playwright/test'
import path from 'path'
import fs from 'fs'

const OUT_DIR = path.join('playwright-results', 'screenshots', 'showcase')

test.describe('KoFEM workflow showcase', () => {
  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true })
  })

  test('full workflow', async ({ page }) => {
    test.setTimeout(60_000)

    // ── 1. Welcome screen ─────────────────────────────────────────────────────
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Start with example' })).toBeVisible()
    await page.screenshot({ path: path.join(OUT_DIR, '01-welcome.png'), fullPage: true })

    // ── 2. Geometry panel ─────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Start with example' }).click()
    await expect(page.getByRole('button', { name: 'Import STEP' })).toBeVisible()
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT_DIR, '02-geometry.png'), fullPage: true })

    // ── 3. Mesh panel ─────────────────────────────────────────────────────────
    await page.locator('nav').getByRole('button').filter({ hasText: 'Mesh' }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT_DIR, '03-mesh.png'), fullPage: true })

    // ── 4. Constraints / loads panel ─────────────────────────────────────────
    await page.locator('nav').getByRole('button').filter({ hasText: 'Constraints' }).click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(OUT_DIR, '04-loads.png'), fullPage: true })

    // ── 5. Results (run solve first) ─────────────────────────────────────────
    await page.locator('nav').getByRole('button').filter({ hasText: 'Solve' }).click()
    const solveBtn = page.getByRole('button').filter({ hasText: 'Run static solve' })
    await expect(solveBtn).toBeEnabled()
    await solveBtn.click()
    await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(OUT_DIR, '05-results.png'), fullPage: true })
  })
})
