import { defineConfig, devices } from "@playwright/test";

// Read-only Dog Training trainer-availability check against a deployed origin (staging by default).
// It reserves nothing: one new sandbox-OTP customer, one on-screen check and availability previews.
const baseURL = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
export default defineConfig({
  testDir: "e2e",
  testMatch: ["training-trainer-check-staging.spec.ts"],
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL, actionTimeout: 20_000, navigationTimeout: 60_000, trace: "off", screenshot: "off", video: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
