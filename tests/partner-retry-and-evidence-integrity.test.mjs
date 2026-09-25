import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, seedBoardingStay } from "./helpers/stay-harness.mjs";
import { createIntentKeyStore, intentOf } from "../lib/use-intent-idempotency.ts";

installWorkersHooks("__PARTNER_RETRY_DB__", "__PARTNER_RETRY_ENV__");
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a retried intent reuses its idempotency key until the action is confirmed", () => {
  let minted = 0;
  const store = createIntentKeyStore("walker", () => `k${++minted}`);
  const startWalk = intentOf(["BKG-1", "start_walk", "SESSION-1"]);
  const first = store.keyFor(startWalk);
  assert.equal(store.keyFor(startWalk), first, "a retry after a lost response must replay the same key");
  store.settle(startWalk);
  assert.notEqual(store.keyFor(startWalk), first, "a new intent after confirmation gets a fresh key");
  assert.equal(minted, 2);
});

test("different actions, sessions or chosen details never share a key", () => {
  const store = createIntentKeyStore("walker", () => crypto.randomUUID());
  const pee = store.keyFor(intentOf(["BKG-1", "walk_event", "S1"], { walkEventType: "pee" }));
  const poop = store.keyFor(intentOf(["BKG-1", "walk_event", "S1"], { walkEventType: "poop" }));
  const otherSession = store.keyFor(intentOf(["BKG-1", "walk_event", "S2"], { walkEventType: "pee" }));
  const otherBooking = store.keyFor(intentOf(["BKG-2", "walk_event", "S1"], { walkEventType: "pee" }));
  assert.equal(new Set([pee, poop, otherSession, otherBooking]).size, 4);
  assert.match(pee, /^walker:BKG-1:walk_event:S1:/);
});

test("walker, driver and sitter lifecycle actions key retries by intent, not by clock", () => {
  for (const [path, prefix] of [["app/walker/page.tsx", "walker"], ["app/driver/canonical-driver-page.tsx", "taxi-driver"], ["app/sitter/sitting-workspace.tsx", "sitter"]]) {
    const page = source(path);
    assert.match(page, new RegExp(`useIntentIdempotency\\("${prefix}"\\)`), path);
    assert.match(page, /idempotencyKey:intents\.keyFor\(intent\)/, path);
    assert.match(page, /await refresh\(\);intents\.settle\(intent\)\}/, `${path}: the key is released only after the action and the follow-up refresh are confirmed`);
    assert.doesNotMatch(page, new RegExp(`\`${prefix}:\\$\\{bookingId\\}:\\$\\{action\\}[^\`]*Date\\.now\\(\\)`), `${path}: a clock-based lifecycle key defeats retry replay`);
  }
});

test("Sitting proof keeps a prepared asset per evidence purpose", () => {
  const page = source("app/sitter/proof/page.tsx");
  assert.match(page, /type MediaPurpose="sitting_update"\|"sitting_medication"\|"sitting_incident"/);
  assert.match(page, /setMediaRef\(purpose,String\(result\.mediaRef\|\|""\)\)/, "a prepared asset is filed under the purpose it was prepared for");
  assert.match(page, /async function recordUpdate\(\)\{const mediaRef=mediaRefs\.sitting_update;/);
  assert.match(page, /async function medication\(\)\{const mediaRef=mediaRefs\.sitting_medication;/);
  assert.match(page, /async function incident\(\)\{const mediaRef=mediaRefs\.sitting_incident;/);
  assert.doesNotMatch(page, /\[mediaRef,setMediaRef\]=useState/, "one shared ref would submit update or medication assets as incident evidence");
});

function countingSelects(db) {
  const seen = [];
  return {
    seen,
    db: new Proxy(db, { get(target, key) { if (key === "prepare") return (sql) => { seen.push(String(sql)); return target.prepare(sql); }; const value = target[key]; return typeof value === "function" ? value.bind(target) : value; } }),
  };
}
const childReads = (seen) => seen.filter((sql) => /FROM (\(SELECT[^)]*FROM )?boarding_(care_plan_snapshots|extension_requests|stay_events) /.test(sql) && /^SELECT/.test(sql)).length;

test("listing Boarding stays reads child tables a fixed number of times, whatever the stay count", async (t) => {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  t.after(() => sqlite.close());
  globalThis.__PARTNER_RETRY_DB__ = db;
  globalThis.__PARTNER_RETRY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  const { listBoardingStays } = await import("../lib/boarding-stay-lifecycle.ts");
  const first = await seedBoardingStay(db, sqlite, { bookingId: "BKG-BOARD-N1", customerId: "CUST-N1" });
  const now = Date.now();
  sqlite.prepare("INSERT INTO boarding_care_plan_snapshots (stay_id,booking_id,plan_json,status,updated_by,updated_at) VALUES (?,?,?,?,?,?)").run(first.stayId, first.bookingId, JSON.stringify({ feeding: "Twice daily" }), "ready", "owner", now);
  for (const [id, at] of [["EXT-OLD", now - 5000], ["EXT-SAME-MS-FIRST", now], ["EXT-NEW", now]]) sqlite.prepare("INSERT INTO boarding_extension_requests (id,stay_id,booking_id,requested_end,status,reason,actor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, first.stayId, first.bookingId, "2030-01-02T10:00:00.000Z", "commercial_quote_required", id, "owner", at, at);
  for (let index = 0; index < 35; index++) sqlite.prepare("INSERT INTO boarding_stay_events (id,stay_id,booking_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").run(`EV-${index}`, first.stayId, first.bookingId, "care_meal", "host", JSON.stringify({ index }), now + index);

  const probe = countingSelects(db);
  const [one] = await listBoardingStays(probe.db, { bookingId: first.bookingId });
  const readsForOne = childReads(probe.seen);
  assert.equal(one.carePlan.status, "ready");
  assert.deepEqual(one.carePlan.plan, { feeding: "Twice daily" });
  assert.equal(one.extension.id, "EXT-NEW", "only the latest extension is returned, with same-millisecond requests broken by insertion order");
  assert.equal("stay_id" in one.extension, false, "the batched read does not leak its grouping column");
  assert.equal(one.events.length, 30, "events stay capped at the newest 30");
  assert.equal(one.events[0].id, "EV-34");
  assert.deepEqual(one.events[0].detail, { index: 34 });
  assert.equal("stay_id" in one.events[0], false);

  for (let index = 2; index <= 6; index++) await seedBoardingStay(db, sqlite, { bookingId: `BKG-BOARD-N${index}`, customerId: `CUST-N${index}` });
  probe.seen.length = 0;
  const all = await listBoardingStays(probe.db, {});
  assert.equal(all.length, 6);
  assert.equal(childReads(probe.seen), readsForOne, "child reads must not grow with the number of stays");
  const empty = all.find((stay) => stay.booking_id === "BKG-BOARD-N2");
  assert.equal(empty.carePlan, null);
  assert.equal(empty.extension, null);
  assert.deepEqual(empty.events, []);
});
