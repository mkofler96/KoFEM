// Drop-in replacement for '@playwright/test' that harvests Istanbul coverage
// counters from the page (and any live dedicated workers) after each test.
//
// Coverage data only exists when the app was built with COVERAGE=1 (see
// vite.config.ts) — otherwise this fixture is a transparent no-op.  Each
// test writes one JSON file into .nyc_output/; `nyc report` merges them.
//
// Run via:  bun run test:coverage
import { test as base, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

type CoverageMap = Record<string, unknown>

// Playwright runs from web/, so .nyc_output lands next to package.json
const NYC_OUTPUT_DIR = path.resolve('.nyc_output')

function writeCoverage(coverage: CoverageMap, label: string): void {
  if (Object.keys(coverage).length === 0) return
  fs.mkdirSync(NYC_OUTPUT_DIR, { recursive: true })
  const file = path.join(
    NYC_OUTPUT_DIR,
    `coverage-${label}-${crypto.randomUUID()}.json`,
  )
  fs.writeFileSync(file, JSON.stringify(coverage))
}

export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page)

    // Dedicated workers (solver.worker) keep their own Istanbul counters in
    // the worker global scope.  Workers terminated mid-test (resetWorker)
    // lose their counters — only live workers can be harvested.
    for (const worker of page.workers()) {
      const cov = await worker
        .evaluate(
          () =>
            (globalThis as { __coverage__?: CoverageMap }).__coverage__ ??
            null,
        )
        .catch(() => null)
      if (cov) writeCoverage(cov, 'worker')
    }

    const pageCov = await page
      .evaluate(
        () =>
          (globalThis as { __coverage__?: CoverageMap }).__coverage__ ?? null,
      )
      .catch(() => null)
    if (pageCov) writeCoverage(pageCov, 'page')
  },
})

export { expect }
