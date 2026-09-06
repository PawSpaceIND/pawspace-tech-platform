import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.APP_ENV = process.env.APP_ENV || "staging";
process.env.FORBID_PRODUCTION = process.env.FORBID_PRODUCTION || "true";

assert.equal(process.env.APP_ENV, "staging", "template-sync certification must run in APP_ENV=staging");
assert.equal(process.env.FORBID_PRODUCTION, "true", "template-sync certification must run with FORBID_PRODUCTION=true");

await import("./whatsapp-template-lifecycle-execution.test.mjs");

const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("scheduled worker completes Meta template sync before scheduler and WhatsApp dispatch fan-out", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  assert.ok(scheduledStart >= 0, "scheduled worker entrypoint must exist");

  const scheduledSource = workerSource.slice(scheduledStart);
  const syncIndex = scheduledSource.indexOf("templateSync=await syncSubmittedMetaTemplateStatuses(");
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");
  assert.ok(syncIndex >= 0, "template sync must be explicitly awaited");
  assert.ok(fanoutIndex > syncIndex, "template sync must finish before downstream fan-out is initialized");

  const fanoutSource = scheduledSource.slice(fanoutIndex, scheduledSource.indexOf("])", fanoutIndex) + 2);
  assert.doesNotMatch(fanoutSource, /syncSubmittedMetaTemplateStatuses/, "template sync must not remain concurrent inside Promise.allSettled");
  assert.match(fanoutSource, /runBackgroundScheduler\(/, "background scheduler must remain in the post-sync fan-out");
  assert.match(fanoutSource, /runWhatsAppOutboxDispatcher\(/, "WhatsApp dispatch must remain in the post-sync fan-out");
});

test("template-sync failure is recorded without blocking scheduler and dispatch initialization", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  const scheduledSource = workerSource.slice(scheduledStart);
  const syncIndex = scheduledSource.indexOf("templateSync=await syncSubmittedMetaTemplateStatuses(");
  const catchIndex = scheduledSource.indexOf("catch(error){templateSyncError=", syncIndex);
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");
  const recordIndex = scheduledSource.indexOf("if(templateSyncError)errors.push(templateSyncError)", fanoutIndex);

  assert.ok(syncIndex >= 0 && catchIndex > syncIndex, "template-sync exceptions must be isolated into templateSyncError");
  assert.ok(fanoutIndex > catchIndex, "downstream sweeps must initialize after the isolated template-sync attempt");
  assert.doesNotMatch(scheduledSource.slice(syncIndex, fanoutIndex), /blocked before dispatch|throw new Error/, "template-sync failure must not abort payment/reconciliation fan-out");
  assert.ok(recordIndex > fanoutIndex, "the isolated template-sync failure must still be reported after all sweeps settle");
});