import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("marketing command center renders canonical data and exposes direct + Supermetrics sync",()=>{
 const ui=readFileSync("app/control/marketing-control-panel.tsx","utf8");
 assert.match(ui,/CANONICAL DATA/);
 assert.match(ui,/sync_ad_metrics/);
 assert.match(ui,/sync_supermetrics_metrics/);
 assert.match(ui,/dashboard\?\.platforms/);
 assert.match(ui,/webAnalytics\.sessions/);
 assert.doesNotMatch(ui,/const channels=\[/);
 assert.doesNotMatch(ui,/24\.8L|61,420|₹1,126 CAC|Illustrative sample — no live spend connected/);
});

test("marketing API exposes canonical dashboard, GA4 web metrics and Supermetrics readiness",()=>{
 const api=readFileSync("app/api/marketing-control/route.ts","utf8");
 assert.match(api,/marketingDashboardSnapshot/);
 assert.match(api,/supermetricsWebAnalyticsSnapshot/);
 assert.match(api,/supermetricsConnectorStatus/);
 assert.match(api,/syncSupermetricsMarketing/);
 assert.match(api,/marketing\.supermetrics\.sync/);
});

test("marketing closure workflow certifies connector and dashboard regressions",()=>{
 const workflow=readFileSync(".github/workflows/marketing-attribution-closure.yml","utf8");
 assert.match(workflow,/marketing-supermetrics-connector\.test\.mjs/);
 assert.match(workflow,/marketing-ad-connectors\.test\.mjs/);
});
