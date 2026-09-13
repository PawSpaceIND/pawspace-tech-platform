import { defineConfig, devices } from "@playwright/test";

// Config for the automated multi-persona human-UAT sweep. Runs against a DEPLOYED origin (staging) —
// no local webServer. baseURL comes from PW_BASE_URL. Serial, single worker (the personas share a
// booking id captured in the customer step).
const baseURL = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";

export default defineConfig({
  testDir: "e2e",
  // The BTM Layout end-to-end proof rides this workflow for now (a new workflow file cannot be dispatched
  // until it exists on the default branch). It runs ALONE so the sweep's own bookings cannot consume the
  // slots the proof needs; restore "automated-human-sweep.spec.ts" here once uat-btm-e2e.yml is on main.
  testMatch: ["uat-btm-e2e.spec.ts"],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-sweep" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "on", video: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
