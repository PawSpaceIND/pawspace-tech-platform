import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  // Per-test sharding avoids placing the entire route matrix on one runner; workers stays 1.
  fullyParallel: true,
  testDir: "./e2e", testMatch: ["v2-grooming.spec.ts", "v2-customer-shell.spec.ts", "v2-ui-theme-closure.spec.ts"], workers: 1, retries: 0,
  outputDir: "artifacts/v2/browser-results", reporter: [["list"], ["html", { outputFolder: "artifacts/v2/browser-report", open: "never" }]],
  projects: (base.projects || []).filter(project => project.name === "chromium" || project.name === "mobile-chromium"),
});
