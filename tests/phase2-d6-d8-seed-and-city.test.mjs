/**
 * Phase 2 remediation D6 & D8 — reproduction-first, converted to assert the SECURE result.
 *
 * D6 (public synthetic seeding): app/api/host-profile/route.ts GET used to call seedDemoHostProfiles()
 *   UNCONDITIONALLY on a public, unauthenticated endpoint — so the six named demo host/sitter rows were
 *   inserted in production. Seeding is now gated on PAWSPACE_UAT_LOGIN==="on" (the established staging
 *   flag, same convention as finance-control seed()). With the flag unset, a GET inserts ZERO synthetic
 *   rows; the public read still works (schema is ensured, profile just not found). With the flag "on",
 *   seeding still works.
 *
 * D8 (silent BLR default in live-money quotes): lib/live-commercial-quotes.ts used
 *   `cityId ?? "blr"` / `zoneId ?? "blr-east"`, so a non-BLR (or no-city) Boarding/Sitting quote —
 *   both liveMoney:true — was silently priced against the Bengaluru rate card. The fallback is removed:
 *   a missing/unknown city (e.g. maa / Chennai, which Boarding & Pet-sitting are not launched in) is now
 *   rejected 400. An explicit BLR quote still prices as before.
 *
 * Requests are made on a NON-localhost host (https://app.pawspace.in/...) so nothing short-circuits to a
 * development-preview code path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// The shim reads globalThis.__D68_DB__ for DB and globalThis.__D68_ENV__ for every other env var
// (PAWSPACE_UAT_LOGIN in particular). Left at {} => production-bound (no UAT/staging flag).
installWorkersHooks("__D68_DB__", "__D68_ENV__");

// Minimal faithful D1 shim over node:sqlite (node's real SQLite engine), mirroring the pattern the
// repo's own real-execution suites use (tests/repro-finding-08-09.test.mjs).
function makeD1(sqlite) {
  // Uses the transactional D1 shim (BEGIN/COMMIT/ROLLBACK) from helpers/d1.mjs so a
  // failing batch() rolls back, exactly as Cloudflare D1 does.
  return createD1(sqlite);
}

const hostRoute = await import("../app/api/host-profile/route.ts");
const boardingRoute = await import("../app/api/boarding-commercial/route.ts");
const sittingRoute = await import("../app/api/sitting-commercial/route.ts");

function fresh(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__D68_DB__ = makeD1(sqlite);
  globalThis.__D68_ENV__ = env;
  return sqlite;
}

// Always in the future regardless of the runner's wall clock (createBoardingQuote/createSittingQuote
// reject a non-future window).
const future = (days, hour) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

const DEMO_IDS = ["host_sana", "host_maya_rohan", "host_arjun_tara", "sit_sana", "sit_neha", "sit_asha"];
const demoCount = (sqlite) => {
  try { return sqlite.prepare(`SELECT COUNT(*) c FROM host_profiles WHERE provider_id IN (${DEMO_IDS.map(() => "?").join(",")})`).get(...DEMO_IDS).c; }
  catch { return 0; }
};
const totalRows = (sqlite) => { try { return sqlite.prepare("SELECT COUNT(*) c FROM host_profiles").get().c; } catch { return 0; } };

const HOST_BASE = "https://app.pawspace.in/api/host-profile";
const BOARD_BASE = "https://app.pawspace.in/api/boarding-commercial";
const SIT_BASE = "https://app.pawspace.in/api/sitting-commercial";

async function post(route, base, body) {
  const res = await route.POST(new Request(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json().catch(() => null) };
}

// -------------------------------------------------------------------------------------------------
// D6 — ungated public synthetic seeding
// -------------------------------------------------------------------------------------------------

test("D6 FIXED: a public GET with PAWSPACE_UAT_LOGIN unset inserts ZERO synthetic demo host rows", async () => {
  const sqlite = fresh({}); // no PAWSPACE_UAT_LOGIN — production-bound
  assert.equal(globalThis.__D68_ENV__.PAWSPACE_UAT_LOGIN, undefined, "no UAT flag set");

  const res = await hostRoute.GET(new Request(`${HOST_BASE}?providerId=host_sana`));
  assert.equal(res.status, 404, "the read still works (schema ensured); the unseeded provider is simply not found, not fabricated");

  assert.equal(demoCount(sqlite), 0, "NONE of the six named demo host/sitter rows were seeded on a public endpoint");
  assert.equal(totalRows(sqlite), 0, "host_profiles is empty in production mode");
  console.log("D6 EVIDENCE (flag unset): demo rows seeded =", demoCount(sqlite), "; GET status =", res.status);
});

test("D6 FIXED: with PAWSPACE_UAT_LOGIN='on' the demo seed still works (staging convenience preserved)", async () => {
  const sqlite = fresh({ PAWSPACE_UAT_LOGIN: "on" });

  const res = await hostRoute.GET(new Request(`${HOST_BASE}?providerId=host_sana`));
  assert.equal(res.status, 200, "under the staging flag the seeded provider resolves");
  const { data } = await res.json();
  assert.equal(data.providerId, "host_sana");
  assert.equal(demoCount(sqlite), 6, "all six demo host/sitter profiles are seeded under the UAT flag");
  console.log("D6 EVIDENCE (flag on): demo rows seeded =", demoCount(sqlite));
});

test("D6 source: seeding is gated on PAWSPACE_UAT_LOGIN==='on' and the read stays public", () => {
  const src = readFileSync(new URL("../app/api/host-profile/route.ts", import.meta.url), "utf8");
  assert.match(src, /PAWSPACE_UAT_LOGIN[\s\S]*?==="on"/, "the seed side effect is gated on PAWSPACE_UAT_LOGIN==='on'");
  assert.match(src, /if\s*\(\s*await seedEnabled\(\)\s*\)\s*await seedDemoHostProfiles\(db\)/, "seedDemoHostProfiles only runs behind the flag");
  assert.doesNotMatch(src, /authorize\(/, "the read itself remains public (no staff auth added)");
  assert.doesNotMatch(src, /resolveActor\(/, "the read itself remains public (no staff auth added)");
});

// -------------------------------------------------------------------------------------------------
// D8 — silent BLR default in live-money Boarding/Sitting quotes
// -------------------------------------------------------------------------------------------------

const boardingBody = () => ({ packageCode: "boarding-24h", petCount: 1, scheduledStart: future(30, 3), scheduledEnd: future(32, 3), paymentMode: "prepaid" });
const sittingBody = () => ({ packageCode: "sitting-visit-60", petCount: 1, scheduledStart: future(30, 3), scheduledEnd: future(30, 10), paymentMode: "prepaid" });

test("D8 FIXED (boarding): a NON-BLR (maa) quote is rejected, not silently priced as BLR", async () => {
  fresh({});
  const r = await post(boardingRoute, BOARD_BASE, { ...boardingBody(), cityId: "maa" });
  assert.equal(r.status, 400, `maa Boarding quote must be rejected, not returned (got ${r.status}: ${JSON.stringify(r.body)})`);
  assert.match(r.body.error, /serviceable city/i, "the rejection names the unserviceable city, not a blr fallback");
  console.log("D8 EVIDENCE (boarding maa):", r.status, JSON.stringify(r.body));
});

test("D8 FIXED (boarding): a quote with NO city is rejected, not silently defaulted to BLR", async () => {
  fresh({});
  const r = await post(boardingRoute, BOARD_BASE, boardingBody()); // no cityId at all
  assert.equal(r.status, 400, `a no-city Boarding quote must be rejected, not silently become blr (got ${r.status}: ${JSON.stringify(r.body)})`);
  console.log("D8 EVIDENCE (boarding no-city):", r.status, JSON.stringify(r.body));
});

test("D8 FIXED (boarding): an explicit BLR quote still returns a valid live quote (no regression)", async () => {
  fresh({});
  const r = await post(boardingRoute, BOARD_BASE, { ...boardingBody(), cityId: "blr", zoneId: "blr-east" });
  assert.equal(r.status, 201, `an explicit blr Boarding quote must still succeed (got ${r.status}: ${JSON.stringify(r.body)})`);
  assert.ok(r.body.data.quoteId, "a real server quote id is returned");
  assert.ok(r.body.data.totalAmount > 0, "a positive total amount is priced");
  assert.equal(r.body.data.liveMoney, true, "still a live-money quote");
  console.log("D8 EVIDENCE (boarding blr): 201 quoteId=", r.body.data.quoteId, "total=", r.body.data.totalAmount);
});

test("D8 FIXED (sitting): a NON-BLR (maa) quote is rejected, not silently priced as BLR", async () => {
  fresh({});
  const r = await post(sittingRoute, SIT_BASE, { ...sittingBody(), cityId: "maa" });
  assert.equal(r.status, 400, `maa Sitting quote must be rejected, not returned (got ${r.status}: ${JSON.stringify(r.body)})`);
  assert.match(r.body.error, /serviceable city/i);
  console.log("D8 EVIDENCE (sitting maa):", r.status, JSON.stringify(r.body));
});

test("D8 FIXED (sitting): a quote with NO city is rejected, not silently defaulted to BLR", async () => {
  fresh({});
  const r = await post(sittingRoute, SIT_BASE, sittingBody()); // no cityId at all
  assert.equal(r.status, 400, `a no-city Sitting quote must be rejected (got ${r.status}: ${JSON.stringify(r.body)})`);
  console.log("D8 EVIDENCE (sitting no-city):", r.status, JSON.stringify(r.body));
});

test("D8 FIXED (sitting): an explicit BLR quote still returns a valid live quote (no regression)", async () => {
  fresh({});
  const r = await post(sittingRoute, SIT_BASE, { ...sittingBody(), cityId: "blr", zoneId: "blr-east" });
  assert.equal(r.status, 201, `an explicit blr Sitting quote must still succeed (got ${r.status}: ${JSON.stringify(r.body)})`);
  assert.ok(r.body.data.quoteId, "a real server quote id is returned");
  assert.ok(r.body.data.totalAmount > 0, "a positive total amount is priced");
  assert.equal(r.body.data.liveMoney, true, "still a live-money quote");
  console.log("D8 EVIDENCE (sitting blr): 201 quoteId=", r.body.data.quoteId, "total=", r.body.data.totalAmount);
});

test("D8 source: the silent BLR fallback is removed from the live-money quote path", () => {
  const src = readFileSync(new URL("../lib/live-commercial-quotes.ts", import.meta.url), "utf8");
  // Strip comments so the explanatory note (which quotes the old pattern) is not mistaken for live code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /input\.cityId\s*\?\?/, 'no silent `input.cityId ?? "blr"` default remains in code');
  assert.doesNotMatch(code, /input\.zoneId\s*\?\?/, 'no silent `input.zoneId ?? "blr-east"` default remains in code');
  assert.doesNotMatch(code, /\?\?\s*"blr/, "no `?? \"blr...\"` fallback remains anywhere in code");
  assert.match(code, /resolveQuoteLocation/, "a validated serviceable-city resolver gates both live quotes");
});
