import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/*
 * Browser E2E against a locally served build (vinext build -> wrangler dev --local, Miniflare D1).
 * The suite is serialized because it mutates shared finance/lifecycle state, but every journey is
 * executed once as Desktop Chrome and once as Pixel 7. The correlated journey uses different future
 * slots per project so provider-capacity state cannot collide across the two passes.
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
    launchOptions: existsSync(LOCAL_CHROMIUM) ? { executablePath: LOCAL_CHROMIUM } : undefined,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
