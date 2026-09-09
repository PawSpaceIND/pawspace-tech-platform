import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PW_PORT || 4173);
const baseURL = process.env.PW_BASE_URL || `http://localhost:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "tests/e2e/**/*.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.PW_BASE_URL ? undefined : {
    command: "bash scripts/e2e/serve.sh",
    url: `${baseURL}/mobile-app`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { ...process.env, PW_PORT: String(port), PAWSPACE_PAYMENT_ENV: "sandbox" },
  },
  projects: [
    { name: "backend-concurrency", testMatch: "tests/e2e/**/*.spec.ts", use: {} },
    { name: "chromium", testIgnore: "tests/e2e/**/*.spec.ts", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", testIgnore: "tests/e2e/**/*.spec.ts", use: { ...devices["Pixel 7"] } },
  ],
});
