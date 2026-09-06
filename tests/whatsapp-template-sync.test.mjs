import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.APP_ENV = process.env.APP_ENV || "staging";
process.env.FORBID_PRODUCTION = process.env.FORBID_PRODUCTION || "true";

assert.equal(process.env.APP_ENV, "staging", "template-sync certification must run in APP_ENV=staging");
assert.equal(process.env.FORBID_PRODUCTION, "true", "template-sync certification must run with FORBID_PRODUCTION=true");

await import("./whatsapp-template-lifecycle-execution.test.mjs");

const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("scheduled worker isolates Meta template sync inside the scheduler and payment/reconciliation fan-out", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  assert.ok(scheduledStart >= 0, "scheduled worker entrypoint must exist");

  const scheduledSource = workerSource.slice(scheduledStart);
  const taskIndex = scheduledSource.indexOf("templateSyncTask=syncSubmittedMetaTemplateStatuses(");
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");
  assert.ok(taskIndex >= 0, "template sync must be represented as its own promise task");
  assert.ok(fanoutIndex > taskIndex, "the fan-out must consume the isolated template sync task");

  const fanoutSource = scheduledSource.slice(fanoutIndex, scheduledSource.indexOf("]);", fanoutIndex) + 3);
  assert.match(fanoutSource, /templateSyncTask/, "template sync must participate in Promise.allSettled rather than block before it");
  assert.match(fanoutSource, /runBackgroundScheduler\(/, "background scheduler must start in the same all-settled fan-out");
  assert.match(fanoutSource, /runRazorpayOrderOutboxSweep\(/, "Razorpay order sweep must not be gated by template verification");
  assert.match(fanoutSource, /runRazorpaySettlementReconciliationSweep\(/, "settlement reconciliation must not be gated by template verification");
});

test("template-sync failure is reported only after independent sweeps have been initialized", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  const scheduledSource = workerSource.slice(scheduledStart);
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");
  const templateFailureIndex = scheduledSource.indexOf("if(templateSync.status===\"rejected\")");

  assert.ok(fanoutIndex >= 0, "scheduled worker must use Promise.allSettled");
  assert.ok(templateFailureIndex > fanoutIndex, "template failure must be inspected after the all-settled fan-out resolves");
  assert.match(scheduledSource.slice(fanoutIndex, templateFailureIndex), /runWhatsAppOutboxDispatcher\(/);
  assert.match(scheduledSource.slice(fanoutIndex, templateFailureIndex), /runRazorpaySettlementReconciliationSweep\(/);
});
