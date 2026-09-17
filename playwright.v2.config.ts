import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./e2e", testMatch: "v2-grooming.spec.ts", workers: 1, retries: 0,
  outputDir: "artifacts/v2/browser-results", reporter: [["list"], ["html", { outputFolder: "artifacts/v2/browser-report", open: "never" }]],
  projects: (base.projects || []).filter(project => project.name === "chromium" || project.name === "mobile-chromium"),
});
