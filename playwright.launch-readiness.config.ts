import {defineConfig, devices} from "@playwright/test";
import base from "./playwright.config";

/** Deliberately separate from V1's Chromium-only suites. Fixture-backed browser evidence, not device certification. */
export default defineConfig({
  ...base,
  testDir: "./e2e",
  testMatch: ["v2-customer-shell.spec.ts", "v2-offline-launch.spec.ts", "v2-partner-offline-app.spec.ts", "v2-grooming.spec.ts", "v2-ui-theme-closure.spec.ts"],
  workers: 1,
  retries: 0,
  outputDir: "artifacts/launch-readiness/browser-results",
  reporter: [["list"], ["json", {outputFile: process.env.PW_LAUNCH_REPORT_PATH || "artifacts/launch-readiness/browser-results.json"}]],
  use: {...base.use, launchOptions: {}},
  projects: [...[
    {name: "desktop-chromium", use: {...devices["Desktop Chrome"]}},
    {name: "desktop-firefox", use: {...devices["Desktop Firefox"]}},
    {name: "desktop-webkit", use: {...devices["Desktop Safari"]}},
    {name: "android-360", use: {...devices["Pixel 7"], viewport: {width:360,height:740}}},
    {name: "iphone-390", use: {...devices["iPhone 13"]}},
    {name: "small-320", use: {...devices["Desktop Chrome"], viewport: {width:320,height:640}}},
    {name: "tablet-768", use: {...devices["Desktop Safari"], viewport: {width:768,height:1024}}},
  ].map(project => ({...project, testIgnore:"v2-ui-theme-closure.spec.ts"})),
    // This suite sets its own four desktop/mobile/theme variants and enumerates all V2 routes.
    // Execute those variants once, not seven redundant times under unrelated outer device names.
    {name:"all-route-visual-matrix",testMatch:"v2-ui-theme-closure.spec.ts",testIgnore:[],use:{...devices["Desktop Chrome"]}},
    {name:"firefox-route-matrix",testMatch:"v2-ui-theme-closure.spec.ts",testIgnore:[],grep:/V2 route matrix: desktop-brand-professional-light/,use:{...devices["Desktop Firefox"]}},
    {name:"webkit-route-matrix",testMatch:"v2-ui-theme-closure.spec.ts",testIgnore:[],grep:/V2 route matrix: mobile-brand-professional-light/,use:{...devices["Desktop Safari"]}},
  ],
});
