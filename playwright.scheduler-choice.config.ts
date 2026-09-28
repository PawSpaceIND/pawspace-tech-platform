import {defineConfig,devices} from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({...base,testDir:"./e2e",testMatch:["v2-grooming.spec.ts","v2-training-choice.spec.ts"],workers:1,retries:0,
 outputDir:"artifacts/scheduler-choice/browser-results",reporter:[["list"],["json",{outputFile:"artifacts/scheduler-choice/browser-results.json"}]],
 use:{...base.use,launchOptions:{}},projects:[
  {name:"chromium",use:{...devices["Desktop Chrome"]}},
  {name:"firefox",grep:/V2 auto groomer|V2 specific groomer|V2 Training|G03:/,use:{...devices["Desktop Firefox"]}},
  {name:"webkit",grep:/V2 auto groomer|V2 specific groomer|V2 Training|G03:/,use:{...devices["Desktop Safari"]}},
  {name:"android-360",grep:/V2 auto groomer|V2 specific groomer|V2 Training|G03:/,use:{...devices["Pixel 7"],viewport:{width:360,height:740}}},
  {name:"iphone-390",grep:/V2 auto groomer|V2 specific groomer|V2 Training|G03:/,use:{...devices["iPhone 13"]}},
 ]});
