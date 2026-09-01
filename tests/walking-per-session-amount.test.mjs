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

test("Walking completion commits state, payment, audit, notifications and idempotency in one batch", () => {
  const start = walkingSource.indexOf('if(input.action==="complete_walk")');
  const end = walkingSource.indexOf('throw new Response("Unsupported Dog Walking lifecycle action"');
  const block = walkingSource.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /await db\.batch\(\[/);
  assert.match(block, /walking_session_payment_events/);
  assert.match(block, /walking_session_events/);
  assert.match(block, /const eventId=await event\(db,booking,sessionId,"walk_completed"/);
  assert.match(block, /await notify\(db,booking,eventId,allComplete\?/);
  assert.match(block, /return remember\(db,input,\{/);
  assert.match(block, /SELECT COUNT\(\*\) count FROM walking_sessions WHERE booking_id=\? AND status!='completed'/);
});

test("Walking client rejects parsed null or non-object JSON safely", () => {
  assert.match(clientSource, /parsed&&typeof parsed==="object"&&!Array\.isArray\(parsed\)/);
  assert.match(clientSource, /Walking lifecycle request failed/);
});
