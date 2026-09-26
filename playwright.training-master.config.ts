import { defineConfig, devices } from "@playwright/test";

// Dog Training master E2E against a deployed origin (staging by default). Serial, single worker: the
// journey shares one customer, one trainer and one staff session across personas.
const baseURL = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
export default defineConfig({
  testDir: "e2e",
  testMatch: ["training-master-staging.spec.ts"],
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL, actionTimeout: 20_000, navigationTimeout: 60_000, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
