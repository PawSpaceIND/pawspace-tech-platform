import {defineConfig,devices} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({...base,testDir:'./e2e',testMatch:'pr1275-pointer-focused.spec.ts',workers:1,retries:0,outputDir:'artifacts/pr1275-pointer-focused/results',reporter:[['list'],['json',{outputFile:'artifacts/pr1275-pointer-focused/report.json'}]],use:{...base.use,launchOptions:{},trace:'on',video:'off'},projects:[{name:'iphone-390',use:{...devices['iPhone 13']}},{name:'tablet-768-touch-control',use:{...devices['Desktop Safari'],viewport:{width:768,height:1024},hasTouch:true}}]});
