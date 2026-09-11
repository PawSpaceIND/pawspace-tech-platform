import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PW_PORT || 4185);
const baseURL = process.env.PW_BASE_URL || `http://localhost:${port}`;
const uatServiceDate = process.env.PW_UAT_SERVICE_DATE || new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
process.env.PW_UAT_SERVICE_DATE ??= uatServiceDate;
process.env.PAWSPACE_UAT_SERVICE_CLOCK ??= "on";
process.env.PAWSPACE_UAT_EXECUTION_NOW_MS ??= String(Date.parse(`${uatServiceDate}T08:30:00.000Z`));
process.env.PW_STAFF_UAT_ACCESS_CODE ??= "pawspace-e2e-access-only";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "e2e/staff-login.spec.ts",
    "e2e/boarding-persistent-closure.spec.ts",
    "e2e/customer-booking.spec.ts",
    "e2e/customer-notifications.spec.ts",
    "e2e/frontend-resilience.spec.ts",
    "e2e/mission-01.spec.ts",
    "e2e/partner-journey.spec.ts",
  ],
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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
