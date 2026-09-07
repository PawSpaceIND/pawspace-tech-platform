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

test("Walking completion delegates the guarded durable transaction to the canonical lifecycle engine", () => {
  const start = walkingSource.indexOf('if(input.action==="complete_walk")');
  const end = walkingSource.indexOf('throw new Response("Unsupported Dog Walking lifecycle action"');
  const block = walkingSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /acquireProviderLifecycleLease/);
  assert.match(block, /finalizeProviderLifecycleLease/);
  assert.match(block, /providerLifecycleAssertionStatement/);
  assert.match(block, /walking_session_payment_events/);
  assert.match(block, /walk_completed/);
  assert.match(block, /walking_session_events/);
  assert.match(block, /resolveServiceCompletionFinance/);
  assert.match(block, /Your PawSpace Walking programme is complete/);
  assert.match(block, /Your PawSpace walk is complete/);
  assert.match(block, /walking_action_keys/);
  /*
   * The shared lifecycle lease owns the compare-and-set claim. finalizeProviderLifecycleLease builds one
   * D1 batch containing the guarded session/booking writes plus payment, event, notifications and replay
   * key, then advances the canonical lifecycle version in that same batch. The dedicated lifecycle D1
   * suite proves rollback when a dependent CAS fails; this test pins Walking's delegation and payload.
   */
  assert.match(block, /UPDATE walking_sessions SET status='completed',completion_status='complete'/);
  assert.match(block, /UPDATE canonical_bookings SET status=\?,updated_at=\?/);
  assert.match(block, /AND \$\{ctx\.guardSql\}/);
  assert.match(block, /INSERT INTO walking_action_keys/);
  assert.match(block, /buildAssertion:ctx=>providerLifecycleAssertionStatement/);
  assert.doesNotMatch(block, /await event\(/);
  assert.doesNotMatch(block, /await notify\(/);
  assert.doesNotMatch(block, /return remember\(/);
  const paymentIndex = block.indexOf("walking_session_payment_events");
  const replayIndex = block.indexOf("walking_action_keys");
  assert.ok(paymentIndex >= 0 && replayIndex > paymentIndex, "payment and replay key remain ordered in the canonical transaction");
  assert.match(block, /walking_customer_notifications/);
  assert.match(block, /gpsConnected:true/);
  assert.match(block, /payout:finance\?\.payoutStatus/);
  assert.match(block, /tax:finance\?\.taxStatus/);
});

test("Walking client rejects parsed null or non-object JSON safely", () => {
  assert.match(clientSource, /parsed&&typeof parsed==="object"&&!Array\.isArray\(parsed\)/);
  assert.match(clientSource, /Walking lifecycle request failed/);
});