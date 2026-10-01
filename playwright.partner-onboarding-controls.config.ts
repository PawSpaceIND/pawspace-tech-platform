import {defineConfig} from '@playwright/test';
import base from './playwright.ui-successor.config';
export default defineConfig({...base,testMatch:'partner-onboarding-controls.spec.ts',outputDir:'test-results/partner-onboarding-controls',reporter:[['list'],['json',{outputFile:'test-results/partner-onboarding-controls-results.json'}]]});
