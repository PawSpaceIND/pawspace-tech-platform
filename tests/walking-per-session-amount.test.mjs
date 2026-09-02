import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const walkingSource = await readFile(new URL("../lib/walking-lifecycle.ts", import.meta.url), "utf8");
const clientSource = await readFile(new URL("../lib/walking-lifecycle-client.ts", import.meta.url), "utf8");

test("Walking completion accepts only paise-safe configured pricing", () => {
  assert.match(walkingSource, /pricing\?\.perWalkAmount/);
  assert.match(walkingSource, /configuredPaise=Math\.round\(configured\*100\)/);
  assert.match(walkingSource, /Math\.abs\(configured\*100-configuredPaise\)<1e-9/);
  assert.match(walkingSource, /return configuredPaise\/100/);
});

test("Walking demo fallback divides only when total paise divides exactly", () => {
  assert.match(walkingSource, /pricing\?\.demoSeed===true/);
  assert.match(walkingSource, /totalPaise=Math\.round\(total\*100\)/);
  assert.match(walkingSource, /totalPaise%count===0/);
  assert.match(walkingSource, /return totalPaise\/count\/100/);
  assert.doesNotMatch(walkingSource, /return total\/count/);
});

test("Walking pricing parser tolerates null pricing", () => {
  assert.match(walkingSource, /pricing:Record<string,unknown>\|null\|undefined/);
  assert.match(walkingSource, /pricing\?\.perWalkAmount/);
});

test("Walking completion commits payment, audit, notification, idempotency and governed finance in one batch", () => {
  const start = walkingSource.indexOf('if(input.action==="complete_walk")');
  const end = walkingSource.indexOf('throw new Response("Unsupported Dog Walking lifecycle action"');
  const block = walkingSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /await db\.batch\(\[/);
  assert.match(block, /walking_session_payment_events/);
<<<<<<< Updated upstream
  assert.match(block, /walk_completed/);
  assert.match(block, /resolveServiceCompletionFinance/);
  assert.match(block, /Your PawSpace Walking programme is complete/);
  assert.match(block, /Your PawSpace walk is complete/);
  /*
   * The whole completion commits in ONE batch. walking_session_payment_events.session_id is UNIQUE, so
   * while the idempotency key was written after the batch through remember(), a worker lost between the
   * two left a DUE payment row with no key: the retry re-executed, hit that UNIQUE constraint, and the
   * walk could never be completed through the API again. The key, the payment row, the audit event and
   * both notifications must therefore land together, and none of them may be a separate awaited call.
   */
=======
  assert.match(block, /walking_session_events/);
  assert.match(block, /Your PawSpace walking is complete/);
  assert.match(block, /walking_action_keys/);
>>>>>>> Stashed changes
  assert.match(block, /CASE WHEN EXISTS \(SELECT 1 FROM walking_sessions/);
  assert.doesNotMatch(block, /await event\(/);
  assert.doesNotMatch(block, /await notify\(/);
  assert.doesNotMatch(block, /return remember\(/);
  // The invariant is not "one batch exists" but that the idempotency key is committed together with the
  // payment row it describes - that pairing is what makes a lost worker replayable instead of wedged on
  // the UNIQUE session_id. Checked on the completion batch itself, not on the whole block, so the
  // post-commit ledger reconciliation below it cannot satisfy this by accident.
  const commitBatch = block.slice(block.indexOf("await db.batch(["), block.indexOf("]);"));
  assert.match(commitBatch, /walking_session_payment_events/);
  assert.match(commitBatch, /walking_action_keys/);
  assert.match(commitBatch, /walking_customer_notifications/);
  assert.match(block, /gpsConnected:true/);
  assert.match(block, /payout:finance\?\.payoutStatus/);
  assert.match(block, /tax:finance\?\.taxStatus/);
});

test("Walking client rejects parsed null or non-object JSON safely", () => {
  assert.match(clientSource, /parsed&&typeof parsed==="object"&&!Array\.isArray\(parsed\)/);
  assert.match(clientSource, /Walking lifecycle request failed/);
});