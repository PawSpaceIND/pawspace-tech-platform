import { defineConfig } from '@playwright/test';

// Isolated API/database contract lane. Does not launch a browser or contact hosted Razorpay.
// Keep this separate: the repository's normal config discovers ./e2e, not ./tests/e2e.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '11-beta-golden-path.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  forbidOnly: true,
  reporter: [['list'], ['json']],
  outputDir: process.env.PAWSPACE_BETA_TEST_OUTPUT || 'test-results/beta-contract',
});
