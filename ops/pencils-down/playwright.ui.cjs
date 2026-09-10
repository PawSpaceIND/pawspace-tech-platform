'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.GITHUB_WORKSPACE;
if (!root) throw new Error('Missing isolated runner workspace.');
const {defineConfig} = createRequire(path.join(root, 'candidate/package.json'))('@playwright/test');
const evidence = path.join(root, 'pencils-down-evidence');
const report = JSON.parse(fs.readFileSync(path.join(evidence, 'report.json'), 'utf8'));
if (report.candidate !== '29142163c9934d373d2603fe8ceced6afae3f811' || report.outcome !== 'ISOLATED_APPLICATION_HTTP_READY') throw new Error('No verified UI candidate deployment.');
const origin = new URL(report.origin);
if (!/^pawspace-beta-ui-5f12f6ef\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname) || origin.protocol !== 'https:') throw new Error('Unapproved test origin.');
module.exports = defineConfig({
  testDir: path.join(root, 'candidate/tests/e2e'),
  testMatch: '12-reviewed-ui-parity.spec.ts',
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', {outputFile: path.join(evidence, 'hosted-ui.json')}]],
  outputDir: path.join(evidence, 'ui'),
  use: {baseURL: origin.origin, actionTimeout: 20000, navigationTimeout: 60000, serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'off', video: 'off'},
  projects: [
    {name: 'desktop', use: {viewport: {width: 1365, height: 900}}},
    {name: 'mobile', use: {viewport: {width: 390, height: 844}}}
  ]
});
