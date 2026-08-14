import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D4 (P2): /api/host-trust POST is public and unauthenticated. Its
// `action:"seed"` plants fabricated host reviews (reputation seeding) with no auth and no data
// validation — the confirmed defect (same public-seed class as fixed finding #11). The path is in the
// gateway PUBLIC null-list and the handler does no resolveActor/same-origin.
// SCOPE CORRECTION vs the earlier discovery note: the review-SUBMIT path is NOT an open IDOR —
// submitHostReview validates booking existence + customer/provider ownership + completed status at the
// data layer, so a forged/foreign booking is rejected (proven below).
// Run against the frozen target SHA 0d8b885.
// =============================================================================
installWorkersHooks("__D4_DB__", "__D4_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}
function freshDb() { const sqlite = new DatabaseSync(":memory:"); globalThis.__D4_DB__ = makeD1(sqlite); globalThis.__D4_ENV__ = {}; return sqlite; }
const anon = (body) => new Request("https://uat.pawspace.in/api/host-trust", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (res) => { try { return await res.clone().json(); } catch { return null; } };
async function driveGateway(request, db) {
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, db);
  if (sessionAccess instanceof Response) return sessionAccess;
  return sessionAccess ?? await authorizeApiRequest(request, { DB: db });
}
const route = await import("../app/api/host-trust/route.ts");
const reviewCount = (sqlite) => { try { return sqlite.prepare("SELECT COUNT(*) c FROM host_reviews").get().c; } catch { return -1; } };

test("D4 REPRODUCED — the gateway PERMITS an anonymous host-trust POST (public null-list)", async () => {
  freshDb();
  const access = await driveGateway(anon({ action: "seed" }), globalThis.__D4_DB__);
  assert.ok(!(access instanceof Response), "gateway lets an anonymous host-trust POST through (public)");
  assert.equal(access.permission, null, "no permission required — public for all methods");
});

test("D4 REPRODUCED — anonymous POST {action:'seed'} PLANTS fabricated host reviews", async () => {
  const sqlite = freshDb();
  const res = await route.POST(anon({ action: "seed" }));
  assert.equal(res.status, 200, `anonymous seed currently succeeds: ${JSON.stringify(await bodyOf(res))}`);
  const n = reviewCount(sqlite);
  assert.ok(n > 0, `synthetic reviews were seeded by an anonymous caller (rows=${n})`);
});

test("D4 SCOPE CORRECTION — the review-SUBMIT path DOES validate booking ownership (not an open IDOR)", async () => {
  // Correcting the earlier discovery note: submitHostReview verifies the booking exists and that
  // customer_id/provider_id match and status='completed'. So a forged/foreign booking is rejected — the
  // submit path is data-validated. The D4 defect is specifically the unauthenticated SEED action below,
  // plus the endpoint carrying no session auth at all; it is NOT arbitrary review injection.
  const sqlite = freshDb();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, provider_id TEXT, status TEXT, service_code TEXT)");
  const res = await route.POST(anon({ hostProviderId: "host_maya_rohan", customerId: "attacker-controlled", bookingId: "BK-FORGED-1", rating: 5, title: "Amazing", body: "Padded five-star review from nobody" }));
  const body = await bodyOf(res);
  assert.equal(res.status, 400, "a forged booking is rejected");
  assert.match(String(body?.error || ""), /Booking not found/, "the submit path validates the booking at the data layer");
  assert.equal(reviewCount(sqlite), 0, "no review row persisted for a forged booking");
});

test("D4 SECURE INVARIANT (post-fix gate) — anonymous POST {action:'seed'} must be REFUSED; no public synthetic-seed path", async () => {
  const sqlite = freshDb();
  const seedRes = await route.POST(anon({ action: "seed" }));
  // Expected after remediation: seeding is not reachable through this public endpoint (server-authoritative
  // authorization / staff tooling only). FAILS on 0d8b885 — the anonymous seed currently returns 200 and plants rows.
  assert.ok([401, 403, 404, 405].includes(seedRes.status), `anonymous seed must be refused; got ${seedRes.status}`);
  assert.equal(reviewCount(sqlite), 0, "a refused seed must plant no reviews");
});
