import { defineConfig, devices } from "@playwright/test";

// Manual V2 staging end-to-end journey (.github/workflows/v2-staging-e2e.yml). It drives a DEPLOYED origin
// named by PW_BASE_URL: there is no local webServer, and no remote default, so a local run without
// PW_BASE_URL fails fast in the spec instead of silently booking on staging. Staging calls take 15-30 s
// each, so the timeouts are generous and the run is serial with a single worker.
//
// Two projects, both Desktop Chromium:
//   v2-customer  the customer journey, with trace + screenshots on (it handles no secret).
//   v2-staff     the optional Booking Command Center check. It signs in with the UAT access code, so its
//                trace and video stay OFF: a trace records network bodies and action parameters, and the
//                uploaded artifact must never contain the code.
const baseURL = process.env.PW_BASE_URL?.trim() || undefined;

export default defineConfig({
  testDir: "e2e",
  testMatch: ["v2-staging-journey.spec.ts"],
  outputDir: "test-results/v2-staging",
  timeout: 25 * 60_000,
  expect: { timeout: 30_000 },
  // Evidence must be a clean first attempt; a retry would create a second staging booking.
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/v2-staging-report" }]],
  use: {
    baseURL,
    actionTimeout: 45_000,
    navigationTimeout: 90_000,
    trace: "on",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    { name: "v2-customer", grep: /@customer/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "v2-staff",
      grep: /@staff/,
      dependencies: ["v2-customer"],
      use: { ...devices["Desktop Chrome"], trace: "off", video: "off" },
    },
  ],
});
