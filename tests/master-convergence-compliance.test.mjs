import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("DPDP retention uses a calendar three-year cutoff", async () => {
  const source = await readFile("lib/dpdp-retention.ts", "utf8");
  assert.match(source, /setUTCFullYear\(cutoff\.getUTCFullYear\(\) - THREE_YEARS\)/);
});

test("retention sweep uses CRM and canonical booking activity and certified erasure", async () => {
  const source = await readFile("lib/dpdp-retention.ts", "utf8");
  assert.match(source, /FROM crm_contacts c/);
  assert.match(source, /LEFT JOIN canonical_bookings b ON b\.customer_id=c\.id/);
  assert.match(source, /HAVING last_activity_at<\?/);
  assert.match(source, /eraseCustomerPersonalData/);
  assert.match(source, /retention-v1:/);
});

test("Worker wraps handlers with Sentry and rate-limits only governed public paths", async () => {
  const worker = await readFile("worker/index.ts", "utf8");
  const wrangler = await readFile("wrangler.toml", "utf8");
  assert.match(worker, /Sentry\.withSentry/);
  assert.match(worker, /SENTRY_DSN/);
  assert.match(worker, /\/api\/public-contact/);
  assert.match(worker, /\/api\/ai-voice-uat/);
  assert.match(worker, /PUBLIC_API_RATE_LIMITER\.limit/);
  assert.match(wrangler, /limit = 100/);
  assert.match(wrangler, /period = 60/);
});

test("executive autonomy remains passive by default after convergence", async () => {
  const source = await readFile("lib/executive/ceo-orchestrator.ts", "utf8");
  assert.match(source, /PAWSPACE_AI_EXECUTIVE_ACTIVE\|\|"false"/);
});

test("daily DPDP cron is wired into Worker and Vite schedules", async () => {
  const worker = await readFile("worker/index.ts", "utf8");
  const vite = await readFile("vite.config.ts", "utf8");
  assert.match(worker, /controller\.cron==="30 2 \* \* \*"\?runDpdpRetentionSweep/);
  assert.match(vite, /"30 2 \* \* \*"/);
});
