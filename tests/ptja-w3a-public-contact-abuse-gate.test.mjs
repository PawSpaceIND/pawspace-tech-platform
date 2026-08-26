/**
 * WAVE 3 TIER A - adversarial verification of W2-B3-R03. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "the public contact-form abuse gate is not off-by-one or bypassable by a
 * missing IP header - it admits exactly 5 per window and fails closed without an IP".
 *
 * It was reproduced by the hunter with real probe output, but the probe lived under /tmp and is gone,
 * and the ledger names no committed test. An unreproducible refutation on a PUBLIC, unauthenticated
 * intake route is worth exactly as much as no refutation. This is that probe, committed.
 *
 * The off-by-one is the interesting half. enforceAbuseGate INCREMENTS and then tests
 * `attempts > RATE_LIMIT` with RATE_LIMIT=5. `>` rather than `>=` is only correct because the increment
 * precedes the read - swap either and the boundary moves. So the test pins the exact boundary (5 in,
 * 6th out), not merely "some requests are refused".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_PC_DB__", "__W3A_PC_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function freshDb() {
  sqlite = new DatabaseSync(":memory:");
  globalThis.__W3A_PC_DB__ = makeD1(sqlite);
  globalThis.__W3A_PC_ENV__ = {};
}

const route = await import("../app/api/public-contact/route.ts");

const LEAD = { name: "Spam Bot", phone: "9845012345", email: "a@b.co", area: "Indiranagar", petNames: "X", service: "Grooming", message: "hi" };

async function submit({ ip = "203.0.113.9", omitIp = false, body = LEAD } = {}) {
  const headers = { "content-type": "application/json" };
  if (!omitIp) headers["cf-connecting-ip"] = ip;
  const response = await route.POST(new Request("https://pawspace.test/api/public-contact", { method: "POST", headers, body: JSON.stringify(body) }));
  let parsed = null;
  try { parsed = await response.json(); } catch { parsed = null; }
  return { status: response.status, body: parsed };
}

const leadCount = () => {
  try { return Number(sqlite.prepare("SELECT COUNT(*) c FROM crm_contacts").get().c); } catch { return 0; }
};

test("R03-01: the gate admits EXACTLY five in a window and refuses the sixth", async () => {
  freshDb();
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await submit()).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429, 429],
    "the boundary is five accepted then refused - `attempts > 5` is only correct because the increment precedes the read");
  assert.equal(leadCount(), 5, "the three refused attempts must not have written leads");
});

test("R03-02: a missing cf-connecting-ip fails CLOSED, not into a shared bucket", async () => {
  freshDb();
  const res = await submit({ omitIp: true });
  assert.equal(res.status, 429, "an unverifiable origin must be refused");
  assert.match(String(res.body?.error ?? ""), /origin could not be verified/i);
  assert.equal(leadCount(), 0, "an origin-less submission must not create a lead");
});

test("R03-03: an exhausted IP does not poison a different IP's bucket", async () => {
  freshDb();
  for (let i = 0; i < 6; i++) await submit({ ip: "203.0.113.9" });
  const other = await submit({ ip: "203.0.113.10" });
  assert.equal(other.status, 201, "the limit is per-IP, so an unrelated visitor is unaffected");
  assert.equal(leadCount(), 6, "five from the flooder plus one from the second IP");
});

test("R03-04: refused attempts keep counting, so a client cannot ride the limit back down", async () => {
  freshDb();
  for (let i = 0; i < 8; i++) await submit();
  const row = sqlite.prepare("SELECT attempts FROM public_contact_rate_limits").get();
  assert.equal(Number(row.attempts), 8, "the counter increments on refused attempts too");
  assert.equal((await submit()).status, 429, "and the ninth is still refused");
});

test("R03-05: the gate runs BEFORE the body is read, so a malformed body cannot skip it", async () => {
  // If the gate ran after parsing, a flood of unparseable bodies would never touch the counter.
  freshDb();
  for (let i = 0; i < 6; i++) {
    const response = await route.POST(new Request("https://pawspace.test/api/public-contact", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" }, body: "{not json",
    }));
    if (i === 5) assert.equal(response.status, 429, "the sixth malformed submission is refused by the gate, not by the parser");
  }
  assert.equal(Number(sqlite.prepare("SELECT attempts FROM public_contact_rate_limits").get().attempts), 6,
    "unparseable bodies still count against the limit");
});

test("R03-06 (non-vacuity): a first honest submission from a fresh IP is accepted and does write a lead", async () => {
  // Without this, every case above would pass on a route that refuses everything.
  freshDb();
  const res = await submit({ ip: "198.51.100.7" });
  assert.equal(res.status, 201, `an honest first submission must be accepted, got ${JSON.stringify(res.body)}`);
  assert.ok(String(res.body?.leadId ?? "").length > 0, "and must return a lead id");
  assert.equal(leadCount(), 1, "and must persist exactly one lead");
});
