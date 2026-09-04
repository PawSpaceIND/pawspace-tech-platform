import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

assert.equal(process.env.APP_ENV, "staging", "template-sync certification must run in APP_ENV=staging");
assert.equal(process.env.FORBID_PRODUCTION, "true", "template-sync certification must run with FORBID_PRODUCTION=true");

// Reuse the established lifecycle execution suite under the exact certification filename.
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

test("template-sync failure blocks scheduler and dispatch initialization", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  const scheduledSource = workerSource.slice(scheduledStart);
  const syncIndex = scheduledSource.indexOf("templateSync=await syncSubmittedMetaTemplateStatuses(");
  const failureGuardIndex = scheduledSource.indexOf("if(templateSync.failed&&templateSync.processed)throw new Error");
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");

  assert.ok(syncIndex >= 0 && failureGuardIndex > syncIndex, "template verification failures must be checked after sync completes");
  assert.ok(fanoutIndex > failureGuardIndex, "no downstream scheduler/dispatch work may initialize before the template-sync failure guard");
  assert.match(scheduledSource.slice(syncIndex, fanoutIndex), /blocked before dispatch: whatsapp template sync/);
});
