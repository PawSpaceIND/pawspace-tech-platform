/*
 * Round-2 staging defect: the public /contact form timed out in 2 of 6 submissions (no answer within its
 * 15 s deadline, "Your enquiry may already be saved") and took 9.5-14 s otherwise.
 *
 * Measured on staging with an idle database the same route answered in ~0.5 s after 31 timed D1 calls
 * plus 17 untimed DDL batches (Server-Timing). The time is not in any one query: every call waits its
 * turn on D1, so while the other suites were writing bookings each of ~48 strictly sequential calls
 * waited too. The number of sequential calls on the answer path is therefore the thing to pin.
 *
 * These tests run the real route against node:sqlite and count every D1 call it makes (a batch is one
 * call, as it is one round trip on D1). The Worker's waitUntil is supplied the way worker/index.ts
 * supplies it, through the request's D1 scope (lib/request-d1-metrics.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, runWithWorkersDb } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CONTACT_RT_DB__", "__CONTACT_RT_ENV__");
const route = await import("../app/api/public-contact/route.ts");
const scope = await import("../lib/request-d1-metrics.ts");

const sample = { name: "Round Trip Lead", phone: "9000000871", email: "round-trip@example.test", area: "Bengaluru", service: "Boarding", message: "Synthetic enquiry", whatsappConsent: false };

function world() {
  const sqlite = new DatabaseSync(":memory:");
  const calls = [];
  const execute = (sql, args) => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; };
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...values) => statement(sql, values),
    first: async () => { calls.push(sql); return sqlite.prepare(sql).get(...args) ?? null; },
    all: async () => { calls.push(sql); return { results: sqlite.prepare(sql).all(...args) }; },
    run: async () => { calls.push(sql); return execute(sql, args); },
  });
  const db = {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      calls.push(`BATCH(${items.length}) ${items[0]?.sql ?? ""}`);
      sqlite.exec("BEGIN");
      try { const out = items.map((item) => execute(item.sql, item.args)); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    exec: async (sql) => sqlite.exec(sql),
  };
  return { sqlite, db, calls };
}

/** One POST as the Worker runs it: the answer, plus the work handed to waitUntil. */
async function submit(w, body, ip) {
  const deferred = [];
  const request = new Request("https://pawspace.test/api/public-contact", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) });
  const metrics = scope.createRequestD1Metrics(request, true, (promise) => deferred.push(promise));
  const before = w.calls.length;
  const response = await runWithWorkersDb(w.db, () => scope.runWithRequestD1Metrics(metrics, () => route.POST(request)));
  const answered = w.calls.slice(before);
  return { status: response.status, body: await response.json(), answered, deferred };
}

test("a warm-isolate enquiry answers after five D1 round trips; routing and automation finish after the answer", async () => {
  const w = world();
  const warm = await submit(w, { ...sample, phone: "9000000870", requestId: "round-trip-warm-0000000001" }, "198.51.100.90");
  assert.equal(warm.status, 201, JSON.stringify(warm.body));
  await Promise.all(warm.deferred);

  const first = await submit(w, { ...sample, requestId: "round-trip-lead-00000000001" }, "198.51.100.91");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  // abuse gate (2) + receipt lookup (1) + identity plan (1) + the one intake transaction (1). The route
  // used to make ~48 sequential calls here: 22 of them schema set-up, the rest follow-up work.
  assert.equal(first.answered.length, 5, `answer path must stay at 5 D1 round trips:\n${first.answered.map((sql) => sql.slice(0, 90)).join("\n")}`);
  assert.equal(first.answered.filter((sql) => /^(BATCH\(\d+\) )?(CREATE|ALTER|PRAGMA)/i.test(sql)).length, 0, "no schema set-up on a warm isolate");
  assert.equal(first.deferred.length, 1, "the follow-up is handed to the request's waitUntil");

  // The lead is durably saved before the answer...
  const lead = w.sqlite.prepare("SELECT id FROM lead_work_items WHERE id=?").get(first.body.leadId);
  assert.ok(lead, "the answer is only given once the enquiry is saved");
  const receipt = () => w.sqlite.prepare("SELECT response_json FROM public_contact_submissions WHERE lead_id=?").get(first.body.leadId);
  assert.equal(receipt().response_json, null, "the replay receipt is completed by the follow-up, not before the answer");

  // ...and the follow-up really runs to completion afterwards.
  await Promise.all(first.deferred);
  assert.ok(receipt().response_json, "the follow-up stores the replay receipt");
  const trigger = w.sqlite.prepare("SELECT status,reason FROM whatsapp_ai_lead_triggers WHERE lead_id=?").get(first.body.leadId);
  assert.deepEqual({ ...trigger }, { status: "blocked", reason: "explicit_whatsapp_consent_required" }, "no WhatsApp without consent");
  assert.deepEqual(first.body.whatsappAi, { status: "blocked", reason: "explicit_whatsapp_consent_required" }, "the answer states the same WhatsApp outcome");

  // A retry after the follow-up finished replays the stored answer without new writes.
  const replayed = await submit(w, { ...sample, requestId: "round-trip-lead-00000000001" }, "198.51.100.91");
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.duplicatePrevented, true);
  assert.equal(replayed.body.leadId, first.body.leadId);
  assert.ok(replayed.answered.length <= 3, `a replay is the gate plus the receipt read: ${replayed.answered.length}`);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM lead_work_items").get().n, 2, "warm-up lead plus this one; the replay wrote none");
});

test("without a Worker waitUntil the follow-up is finished before answering, so nothing is lost", async () => {
  const w = world();
  const request = new Request("https://pawspace.test/api/public-contact", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.92" }, body: JSON.stringify({ ...sample, phone: "9000000872", requestId: "round-trip-inline-00000001" }) });
  const response = await runWithWorkersDb(w.db, () => route.POST(request));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(w.sqlite.prepare("SELECT response_json FROM public_contact_submissions").get().response_json, "receipt completed before the answer");
  assert.ok(w.sqlite.prepare("SELECT id FROM whatsapp_ai_lead_triggers WHERE lead_id=?").get(body.leadId), "automation decision recorded before the answer");
});
