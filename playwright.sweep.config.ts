import { defineConfig, devices } from "@playwright/test";

// Config for the automated multi-persona human-UAT sweep. Runs against a DEPLOYED origin (staging) —
// no local webServer. baseURL comes from PW_BASE_URL. Serial, single worker (the personas share a
// booking id captured in the customer step).
const baseURL = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";

export default defineConfig({
  testDir: "e2e",
  // The BTM Layout end-to-end proof rides the same workflow (a new workflow file cannot be dispatched
  // until it exists on the default branch); it runs after the sweep, serially, sharing nothing.
  testMatch: ["automated-human-sweep.spec.ts", "uat-btm-e2e.spec.ts"],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-sweep" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "on", video: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
