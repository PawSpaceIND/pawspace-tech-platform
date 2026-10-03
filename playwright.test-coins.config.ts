import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "test-coins-acceptance.spec.ts", workers: 1, retries: 0,
  timeout: 25000, expect: { timeout: 8000 }, reporter: "line",
  outputDir: "../receipts/test-coins-ui-results",
  use: { baseURL: "http://127.0.0.1:4897", headless: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true } },
  ],
});
