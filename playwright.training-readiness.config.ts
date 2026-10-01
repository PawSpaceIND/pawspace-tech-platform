import {defineConfig,devices} from '@playwright/test';
import base from './playwright.config';
/** Isolated local API fixtures; never deploys or creates a hosted record. */
export default defineConfig({
 ...base,testDir:'./e2e',testMatch:'training-readiness.spec.ts',workers:1,retries:0,
 projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile390',use:{...devices['Desktop Chrome'],viewport:{width:390,height:844}}}],
});
