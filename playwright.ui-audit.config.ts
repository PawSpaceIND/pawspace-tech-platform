import { defineConfig } from "@playwright/test";
const port = process.env.PW_PORT || "4197";
const baseURL = process.env.PW_BASE_URL || `http://127.0.0.1:${port}`;
if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("UI repair fixtures must run only in the isolated local sandbox.");
export default defineConfig({
  testDir:"./e2e", testMatch:"ui-audit-closure.spec.ts", timeout:180_000,
  fullyParallel:true, workers:1, retries:0, forbidOnly:!!process.env.CI,
  expect:{timeout:20_000}, outputDir:"test-results/ui-audit",
  reporter:[["list"],["json",{outputFile:"test-results/ui-audit-results.json"}]],
  use:{baseURL,headless:true,trace:"retain-on-failure",screenshot:"only-on-failure",video:"off",
    launchOptions:process.env.PW_CHROME_EXECUTABLE ? {executablePath:process.env.PW_CHROME_EXECUTABLE} : {}},
  webServer:{command:"bash scripts/e2e/serve.sh",url:baseURL,reuseExistingServer:!process.env.CI,timeout:240_000,
    env:{PW_PORT:port,PW_UAT_SERVICE_DATE:"2026-10-05",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",FORBID_PRODUCTION:"true"}},
});
