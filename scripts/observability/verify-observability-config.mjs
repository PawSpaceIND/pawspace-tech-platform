import fs from "node:fs";
import assert from "node:assert/strict";

const worker=fs.readFileSync(new URL("../../worker/index.ts",import.meta.url),"utf8");
const wrangler=fs.readFileSync(new URL("../../wrangler.toml",import.meta.url),"utf8");

assert.match(worker,/@sentry\/cloudflare/);
assert.match(worker,/Sentry\.withSentry/);
assert.match(worker,/sendDefaultPii:false/);
assert.match(worker,/SENTRY_DSN/);
assert.match(worker,/controlled_staging_sentry_self_test/);
assert.match(worker,/controlled_staging_sentry_unhandled_self_test/);
assert.match(worker,/api_unhandled_failure/);
assert.match(worker,/financial_ledger_discrepancy/);
assert.match(wrangler,/\[observability\]/);
assert.match(wrangler,/invocation_logs = true/);
assert.match(wrangler,/\[observability\.traces\]/);

console.log(JSON.stringify({
  ok:true,
  sentryGlobalWrapper:true,
  defaultPiiDisabled:true,
  stagingSelfTest:true,
  stagingUnhandledSelfTest:true,
  structuredApiFailures:true,
  financialDiscrepancyEvents:true,
  invocationLogs:true,
  traces:true
}));
