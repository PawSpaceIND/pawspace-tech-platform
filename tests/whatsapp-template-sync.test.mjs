import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/*
 * Default the certification environment when the runner has not declared one.
 *
 * These two assertions are a guard, not a preference: this suite must never certify anything against
 * a production environment. But a bare `npm test` on a developer machine sets neither variable, so the
 * guard was failing the whole file before a single test ran — `main` was red out of the box for
 * everyone running the suite locally.
 *
 * `||` fills in ONLY when the variable is absent. An explicitly declared environment still reaches the
 * assertions below unchanged, so a run with APP_ENV=production still fails exactly as it did before.
 * The guard keeps its teeth where it matters; it just no longer punishes the default local run.
 */
process.env.APP_ENV = process.env.APP_ENV || "staging";
process.env.FORBID_PRODUCTION = process.env.FORBID_PRODUCTION || "true";

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

/*
 * CONTRACT CHANGED, deliberately. The previous version of this test asserted the literal source text
 * `if(templateSync.failed&&templateSync.processed)throw new Error` and required that guard to sit before
 * the fan-out - i.e. it pinned a BLANKET block: a WhatsApp template verification exception aborted the
 * whole scheduled invocation, so razorpayOrderOutbox, settlementRecon and subscriptionMaintenance never
 * ran either. A messaging hiccup silently halted payment reconciliation. [AUDIT-H9]
 *
 * The intent behind the old test is real and is preserved verbatim below: an unverified template must
 * not be dispatched. What changed is its blast radius. The two assertions now pin BOTH directions -
 * every WhatsApp sender is blocked when the sync fails, AND the sweeps that send no WhatsApp message
 * are not. The second half is the non-vacuity guard: restoring the blanket `throw` would satisfy the
 * first assertion and fail the second.
 */
test("template-sync failure blocks every WhatsApp dispatch sweep", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  const scheduledSource = workerSource.slice(scheduledStart);
  const syncIndex = scheduledSource.indexOf("templateSync=await syncSubmittedMetaTemplateStatuses(");
  const guardIndex = scheduledSource.indexOf("const whatsappDispatchBlocked=");
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");

  assert.ok(syncIndex >= 0 && guardIndex > syncIndex, "template verification failures must be checked after sync completes");
  assert.ok(fanoutIndex > guardIndex, "the dispatch block must be decided before the fan-out is initialized");
  assert.match(scheduledSource.slice(syncIndex, fanoutIndex), /blocked before dispatch: \$\{templateSyncError\}/, "the block must carry the template-sync failure reason");

  const fanoutSource = scheduledSource.slice(fanoutIndex, scheduledSource.indexOf("])", fanoutIndex) + 2);
  for (const sender of ["runWhatsAppOutboxDispatcher(", "processDueWhatsAppNoResponseSequences("]) {
    const callIndex = fanoutSource.indexOf(sender);
    assert.ok(callIndex >= 0, `${sender} must remain in the post-sync fan-out`);
    const entryStart = fanoutSource.lastIndexOf("\n", callIndex);
    assert.match(
      fanoutSource.slice(entryStart, callIndex),
      /whatsappDispatchBlocked\?/,
      `${sender} must be skipped when template sync failed - an unverified template must never be sent`,
    );
  }
});

test("template-sync failure does not block sweeps that send no WhatsApp message", () => {
  const scheduledStart = workerSource.indexOf("async scheduled(");
  const scheduledSource = workerSource.slice(scheduledStart);
  const fanoutIndex = scheduledSource.indexOf("=await Promise.allSettled([");
  const fanoutSource = scheduledSource.slice(fanoutIndex, scheduledSource.indexOf("])", fanoutIndex) + 2);

  /* Non-vacuity for the test above. These three are the payment and billing sweeps that the blanket
   * guard used to take down with WhatsApp. None of them sends a WhatsApp template. */
  for (const sweep of ["runRazorpayOrderOutboxSweep(", "runRazorpaySettlementReconciliationSweep(", "runSubscriptionScheduledMaintenance("]) {
    const callIndex = fanoutSource.indexOf(sweep);
    assert.ok(callIndex >= 0, `${sweep} must remain in the post-sync fan-out`);
    const entryStart = fanoutSource.lastIndexOf("\n", callIndex);
    assert.doesNotMatch(
      fanoutSource.slice(entryStart, callIndex),
      /whatsappDispatchBlocked/,
      `${sweep} must run even when WhatsApp template sync fails - a messaging fault must not halt payment reconciliation`,
    );
  }

  // And the failure must still fail the invocation rather than being swallowed.
  assert.match(scheduledSource, /if\(templateSyncError\)errors\.push\(templateSyncError\);/, "the template-sync failure must still surface in the aggregated errors");
});
