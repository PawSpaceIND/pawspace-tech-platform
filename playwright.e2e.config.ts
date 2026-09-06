import { defineConfig } from "@playwright/test";

/*
 * Browser E2E against a locally served build (vinext build -> wrangler dev --local, Miniflare D1).
 * Separate from playwright.config.ts, which targets the vite dev server on :5173.
 */
export default defineConfig({
  testDir: "./e2e/journeys",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:8788",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" },
  },
});
