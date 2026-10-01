import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
 ...base,testDir:'./e2e',testMatch:'ui-staff-finish.spec.ts',workers:1,retries:0,
 outputDir:'artifacts/ui-staff-finish',reporter:[['list'],['json',{outputFile:'artifacts/ui-staff-finish/results.json'}]],
 projects:(base.projects||[]).filter(p=>p.name==='chromium'),
 webServer:base.webServer && !Array.isArray(base.webServer)?{...base.webServer,url:`${base.use?.baseURL}/team/operations`,reuseExistingServer:false}:base.webServer,
});
