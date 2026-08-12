import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const helper = await read("../lib/api-fetch.ts");
const CRITICAL = [
  "../lib/canonical-lifecycle-client.ts",   // booking
  "../lib/grooming-booking-change-client.ts", // reschedule / cancel
  "../lib/sitting-payment-client.ts",        // payment
  "../lib/training-cancellation-client.ts",  // cancellation / refund
];

test("shared api-fetch helper checks status first, parses safely, handles timeout/offline", () => {
  assert.match(helper, /export async function apiSend/);
  assert.match(helper, /export async function apiRequest/);
  assert.match(helper, /export class ApiError/);
  assert.match(helper, /export function friendlyHttpMessage/);
  // status checked, JSON parsed safely (never a raw SyntaxError on an error body)
  assert.match(helper, /if \(res\.ok\) throw new ApiError\("parse"/);
  assert.match(helper, /if \(!ok\) throw new ApiError\("http", status, env\.error \|\| friendlyHttpMessage\(status\)/);
  // timeout + offline + network handling
  assert.match(helper, /"timeout", 0, "The request took too long/);
  assert.match(helper, /"offline", 0, "You appear to be offline/);
  assert.match(helper, /"network", 0, "We couldn't reach the server/);
});

test("critical customer flows go through the hardened helper (no parse-before-ok)", async () => {
  for (const path of CRITICAL) {
    const src = await read(path);
    assert.match(src, /from "\.\/api-fetch"/, `${path} imports the shared api-fetch helper`);
    assert.match(src, /apiSend</, `${path} uses apiSend`);
    // the old anti-pattern (parse the body before checking res.ok) must be gone from these flows
    assert.doesNotMatch(src, /await response\.json\(\)/, `${path} no longer parses JSON before checking res.ok`);
    assert.doesNotMatch(src, /!response\.ok\|\|!body\.data/, `${path} no longer hand-rolls the ok/data check`);
  }
});
