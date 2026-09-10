'use strict';
// Guest-only visual parity. No booking, OTP, payment or provider transaction is submitted.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = process.env.GITHUB_WORKSPACE;
const evidence = path.join(root, 'pencils-down-evidence');
const file = path.join(evidence, 'report.json');
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
if (report.outcome !== 'ISOLATED_APPLICATION_HTTP_READY' || report.candidate !== '29142163c9934d373d2603fe8ceced6afae3f811') throw new Error('No verified corrected UI deployment.');
const cli = path.join(root, 'candidate/node_modules/@playwright/test/cli.js');
const result = spawnSync(process.execPath, [cli, 'test', '--config', path.join(__dirname, 'playwright.ui.cjs')], {cwd: root, env: process.env, stdio: 'inherit', timeout: 300000});
let stats;
try { stats = JSON.parse(fs.readFileSync(path.join(evidence, 'hosted-ui.json'), 'utf8')).stats; } catch {}
report.checks.reviewed_ui_browser = {exit: result.status, stats, uiSource: '5f12f6efbe4545894f38f817154d798131145f16', viewports: ['desktop', 'mobile'], styles: ['professional', 'cartoon'], bookingPerformed: false, paymentPerformed: false};
const pass = !result.error && result.status === 0 && stats?.expected === 2 && stats?.unexpected === 0 && stats?.skipped === 0;
report.outcome = pass ? 'ISOLATED_REVIEWED_UI_DEPLOYMENT_AND_BROWSER_PARITY_PASS' : 'REVIEWED_UI_BROWSER_FAILED';
report.reviewed_ui = 'unified-5f12f6ef';
report.source_manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-source-manifest.json'), 'utf8'));
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
if (!pass) { console.error('Reviewed UI browser parity did not pass; see sanitized evidence.'); process.exitCode = 1; }
else console.log('Both viewports passed: approved design marker, both styles, artwork, eight service entries, search, location and preference persistence. Not a hosted payment test.');
