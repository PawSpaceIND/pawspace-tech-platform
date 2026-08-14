import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D5 (P1): OTP code disclosed in the API response, no gate
// -----------------------------------------------------------------------------
// `lib/customer-otp.ts:30` (and `lib/partner-otp.ts`) return `sandboxCode:code` in the request
// response, and the route hands it to the caller (`app/api/customer-otp/route.ts` action:"request" →
// `json({data:result})`). There is NO environment gate: with PAWSPACE_UAT_LOGIN unset, a non-localhost
// host and NODE_ENV=production, the one-time code is still returned. Knowing a phone number is then
// enough to read its OTP from the JSON and mint an 8-hour platform session (account takeover).
//
// Run against the PRE-FIX SHA ca09d06. These tests demonstrate the vulnerable behaviour AND assert the
// secure invariant expected after remediation (disclosure allowed only in an explicitly gated
// non-production/UAT mode).
// =============================================================================
installWorkersHooks("__D5_DB__", "__D5_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}

// Production-like: no UAT flag in env, non-localhost URL, NODE_ENV=production (no dev-preview superuser).
function productionLikeDb() {
  const sqlite = new DatabaseSync(":memory:");
  // canonical_customers is normal app schema the verify path expects to already exist (it SELECT/INSERTs,
  // it does not CREATE). Seeding it lets the end-to-end takeover complete; it is not part of the defect.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  globalThis.__D5_DB__ = makeD1(sqlite);
  globalThis.__D5_ENV__ = {};
  return sqlite;
}
const post = (path, body) => new Request(`https://uat.pawspace.in${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (res) => { try { return await res.clone().json(); } catch { return null; } };
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const priorNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
test.after(() => { if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv; });

test("D5 REPRODUCED — production-like customer-otp request DISCLOSES the code in the response body", async () => {
  productionLikeDb();
  const route = await import("../app/api/customer-otp/route.ts");
  const res = await route.POST(post("/api/customer-otp", { action: "request", phone: "+919900000001" }));
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  // The vulnerability: an out-of-band factor (the OTP) is returned in-band to the anonymous caller.
  assert.ok(body?.data && typeof body.data.sandboxCode === "string" && /^\d{6}$/.test(body.data.sandboxCode),
    `expected the OTP code disclosed as sandboxCode in production-like config; got ${JSON.stringify(body)}`);
});

test("D5 REPRODUCED — the disclosed code is a usable auth factor: verify ACCEPTS it (takeover primitive)", async () => {
  productionLikeDb();
  const route = await import("../app/api/customer-otp/route.ts");

  // Control: a WRONG code for a fresh challenge is rejected as an OTP mismatch.
  const c1 = (await bodyOf(await route.POST(post("/api/customer-otp", { action: "request", phone: "+919900000041" })))).data;
  const wrong = await bodyOf(await route.POST(post("/api/customer-otp", { action: "verify", challengeId: c1.challengeId, code: "000000" })));
  assert.match(String(wrong?.error || ""), /Incorrect OTP code/, "a wrong code is rejected — so verification genuinely checks the code");

  // The DISCLOSED code satisfies verification: it passes the OTP check (the error, if any, is downstream
  // session plumbing — never 'Incorrect OTP code'). The anonymous caller thus holds a valid factor for an
  // arbitrary phone using only what the request call returned. Full session issuance is the deterministic
  // downstream step once the (production-configured) identity-assertion secret is present.
  const c2 = (await bodyOf(await route.POST(post("/api/customer-otp", { action: "request", phone: "+919900000042" })))).data;
  const accepted = await bodyOf(await route.POST(post("/api/customer-otp", { action: "verify", challengeId: c2.challengeId, code: c2.sandboxCode, name: "Anon Caller" })));
  assert.doesNotMatch(String(accepted?.error || ""), /Incorrect OTP code/, "the disclosed code is ACCEPTED as the OTP factor for an arbitrary phone");
});

test("D5 SECURE INVARIANT (post-fix gate) — outside an explicit UAT/non-production mode the code MUST NOT be returned", async () => {
  productionLikeDb(); // env carries no PAWSPACE_UAT_LOGIN → production-bound
  const route = await import("../app/api/customer-otp/route.ts");
  const body = await bodyOf(await route.POST(post("/api/customer-otp", { action: "request", phone: "+919900000002" })));
  // Expected after remediation: production responses carry NO OTP code (disclosure gated behind
  // PAWSPACE_UAT_LOGIN==="on"). This assertion FAILS on ca09d06 (documenting the vuln) and passes once gated.
  assert.ok(!(body?.data && "sandboxCode" in body.data),
    `SECURE INVARIANT VIOLATED on ca09d06 — production OTP response still discloses the code: ${JSON.stringify(body?.data)}`);
});

test("D5 — partner-otp shares the class (source returns sandboxCode with no env gate)", () => {
  const src = read("lib/partner-otp.ts");
  assert.match(src, /sandboxCode/, "partner-otp also returns sandboxCode");
  assert.doesNotMatch(src, /PAWSPACE_UAT_LOGIN|NODE_ENV/, "partner-otp does not gate the disclosure on any environment flag");
});
