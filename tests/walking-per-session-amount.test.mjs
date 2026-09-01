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

test("Walking completion records payment, audit, notification, idempotency and governed final finance", () => {
  const start = walkingSource.indexOf('if(input.action==="complete_walk")');
  const end = walkingSource.indexOf('throw new Response("Unsupported Dog Walking lifecycle action"');
  const block = walkingSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /await db\.batch\(\[/);
  assert.match(block, /walking_session_payment_events/);
  assert.match(block, /walk_completed/);
  assert.match(block, /resolveServiceCompletionFinance/);
  assert.match(block, /Your PawSpace Walking programme is complete/);
  assert.match(block, /Your PawSpace walk is complete/);
  assert.match(block, /await event\(/);
  assert.match(block, /await notify\(/);
  assert.match(block, /return remember\(/);
  assert.match(block, /gpsConnected:true/);
  assert.match(block, /payout:finance\?\.payoutStatus/);
  assert.match(block, /tax:finance\?\.taxStatus/);
});

test("Walking client rejects parsed null or non-object JSON safely", () => {
  assert.match(clientSource, /parsed&&typeof parsed==="object"&&!Array\.isArray\(parsed\)/);
  assert.match(clientSource, /Walking lifecycle request failed/);
});