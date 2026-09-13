import { defineConfig, devices } from "@playwright/test";

// Config for the BTM Layout (560068) end-to-end staging proof: customer online checkout through the
// Razorpay sandbox, partner job lifecycle with proof-photo upload, founder approval, completion.
// Runs against a DEPLOYED origin (no local webServer). Serial, single worker: the personas share the
// booking created in the customer step.
const baseURL = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";

export default defineConfig({
  testDir: "e2e",
  testMatch: ["uat-btm-e2e.spec.ts"],
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-uat-btm" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "on", video: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
