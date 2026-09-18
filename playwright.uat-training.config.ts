import { defineConfig, devices } from "@playwright/test";
const baseURL = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
export default defineConfig({
  testDir:"e2e", testMatch:["uat-training-deployed.spec.ts"], timeout:600_000,
  expect:{timeout:30_000}, retries:0, workers:1, fullyParallel:false,
  reporter:[["list"],["html",{open:"never",outputFolder:"playwright-report-uat-training"}]],
  use:{baseURL,trace:"retain-on-failure",screenshot:"on",video:"retain-on-failure"},
  projects:[{name:"chromium",use:{...devices["Desktop Chrome"]}}],
});
