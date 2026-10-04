import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({...base,webServer:base.webServer?{...base.webServer,url:String(base.use?.baseURL)+'/team/customer-experience'}:undefined,testMatch:['e2e/staff-inbox.spec.ts'],workers:1,retries:0,projects:[{name:'chromium',use:{browserName:'chromium'}}],outputDir:'test-results/staff-inbox',reporter:[['list'],['json',{outputFile:'test-results/staff-inbox/results.json'}]]});
