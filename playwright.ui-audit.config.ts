import { defineConfig } from "@playwright/test";
import {resolveUiAuditServer} from "./scripts/ui-audit-server.mjs";
const {port,baseURL}=resolveUiAuditServer({PW_PORT:process.env.PW_PORT,PW_BASE_URL:process.env.PW_BASE_URL});
export default defineConfig({
  testDir:"./e2e", testMatch:["ui-audit-closure.spec.ts","ui-audit-finance-feedback.spec.ts"], timeout:180_000,
  fullyParallel:true, workers:1, retries:0, forbidOnly:!!process.env.CI,
  expect:{timeout:20_000}, outputDir:"test-results/ui-audit",
  reporter:[["list"],["json",{outputFile:"test-results/ui-audit-results.json"}]],
  use:{baseURL,headless:true,trace:"retain-on-failure",screenshot:"only-on-failure",video:"off",
    launchOptions:process.env.PW_CHROME_EXECUTABLE ? {executablePath:process.env.PW_CHROME_EXECUTABLE} : {}},
  webServer:{command:"bash scripts/e2e/serve.sh",url:baseURL,reuseExistingServer:false,timeout:240_000,
    env:{PW_PORT:port,PW_UAT_SERVICE_DATE:"2026-10-05",PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",FORBID_PRODUCTION:"true"}},
});
