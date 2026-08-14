import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D6 & D8 (P2), covered separately.
//
// D6: public/ungated synthetic seeding. GET /api/host-profile (a public, unauthenticated endpoint)
//     calls seedDemoHostProfiles unconditionally — no PAWSPACE_UAT_LOGIN / NODE_ENV gate — so a normal
//     production read writes demo host rows into the DB.
//
// D8: silent Bengaluru fallback in live-money boarding/sitting quotes. createLiveBoardingQuote /
//     createLiveSittingQuote substitute cityId:"blr" / zoneId:"blr-east" when the request omits them
//     (lib/live-commercial-quotes.ts). Combined with the fact that the resolved city drives real
//     pricing, a missing/non-BLR-city request is silently priced by the Bengaluru rule.
//
// Run against the frozen target SHA 0d8b885.
// =============================================================================
installWorkersHooks("__D68_DB__", "__D68_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}
function freshDb() { const sqlite = new DatabaseSync(":memory:"); globalThis.__D68_DB__ = makeD1(sqlite); globalThis.__D68_ENV__ = {}; return sqlite; } // production-bound: no PAWSPACE_UAT_LOGIN
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const hostProfileCount = (sqlite) => { try { return sqlite.prepare("SELECT COUNT(*) c FROM host_profiles").get().c; } catch { return -1; } };

// -----------------------------------------------------------------------------
// D6 — public/ungated synthetic seeding
// -----------------------------------------------------------------------------
test("D6 REPRODUCED — a public, production-like GET /api/host-profile SEEDS demo host rows (no env gate)", async () => {
  const sqlite = freshDb();
  const route = await import("../app/api/host-profile/route.ts");
  const before = hostProfileCount(sqlite);
  // Anonymous request; env has no PAWSPACE_UAT_LOGIN (production-bound).
  await route.GET(new Request("https://uat.pawspace.in/api/host-profile?providerId=host_maya_rohan"));
  const after = hostProfileCount(sqlite);
  assert.equal(before <= 0 ? 0 : before, 0, "the DB started empty of host_profiles");
  assert.ok(after > 0, `a public GET seeded ${after} synthetic host profile row(s) with no environment gate`);
  // Source corroboration: the seed is not gated on any environment flag.
  assert.match(read("app/api/host-profile/route.ts"), /await seedDemoHostProfiles\(db\)/, "GET seeds unconditionally");
  assert.doesNotMatch(read("lib/host-profiles.ts").split("seedDemoHostProfiles")[1] || "", /PAWSPACE_UAT_LOGIN|NODE_ENV/, "seedDemoHostProfiles has no env gate");
});

test("D6 SECURE INVARIANT (post-fix gate) — a normal production read must seed ZERO synthetic fixtures", async () => {
  const sqlite = freshDb();
  const route = await import("../app/api/host-profile/route.ts");
  await route.GET(new Request("https://uat.pawspace.in/api/host-profile?providerId=host_maya_rohan"));
  // Expected after remediation: synthetic seeding is gated (staging/UAT only), so production reads write nothing.
  // FAILS on 0d8b885 — the public GET currently seeds demo rows.
  assert.equal(hostProfileCount(sqlite), 0, "a production-config public read must not write synthetic host_profiles");
});

// -----------------------------------------------------------------------------
// D8 — silent Bengaluru fallback in live-money quotes
// -----------------------------------------------------------------------------
const SVC = "d8_test_svc", PKG = "d8_pkg", BASE = 1000, BLR_OVERRIDE = 9999;
async function seedPricing(sqlite) {
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(globalThis.__D68_DB__); // creates service_packages + dynamic_pricing_rules
  const now = Date.now();
  sqlite.prepare("INSERT INTO service_packages (id,service_code,package_code,name,description,base_price,currency,tax_inclusive,slot_minutes,blocking_minutes,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,'INR',1,60,60,1,1,'2000-01-01',NULL,'tester',?)")
    .run("sp-d8", SVC, PKG, "D8 Package", "test", BASE, now);
  // A published Bengaluru (blr / blr-east) override rule for this service. It applies ONLY when the
  // resolved city is exactly "blr" (matches() requires rule.cityId===cityId).
  sqlite.prepare("INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,NULL,?,?,?,?,?,?,?,?)")
    .run("dpr-d8-blr", "BLR surge", SVC, PKG, "blr", "blr-east", "season", "[]", "2000-01-01", "override", BLR_OVERRIDE, "stackable", 1, "published", 1, "tester", now);
}

test("D8 REPRODUCED (executed) — the resolved city drives real pricing: blr/blr-east is priced differently from another city", async () => {
  const sqlite = freshDb();
  await seedPricing(sqlite);
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  const blr = await resolveLivePrice(globalThis.__D68_DB__, { packageCode: PKG, fallbackPrice: BASE, scheduledStart: "2026-09-01T10:00:00.000Z", cityId: "blr", zoneId: "blr-east" });
  const maa = await resolveLivePrice(globalThis.__D68_DB__, { packageCode: PKG, fallbackPrice: BASE, scheduledStart: "2026-09-01T10:00:00.000Z", cityId: "maa", zoneId: "maa-central" });
  assert.equal(blr.price, BLR_OVERRIDE, "the Bengaluru rule sets the price when the resolved city is blr");
  assert.equal(maa.price, BASE, "another city (maa) gets no Bengaluru surge — the base price");
  assert.notEqual(blr.price, maa.price, "which city a request is resolved as materially changes the money");
});

test("D8 REPRODUCED (source) — the live quote functions SILENTLY substitute blr / blr-east for a missing city", () => {
  const src = read("lib/live-commercial-quotes.ts");
  const boarding = /createLiveBoardingQuote[\s\S]*?cityId:input\.cityId\?\?"blr"[\s\S]*?zoneId:input\.zoneId\?\?"blr-east"/.test(src);
  const sitting = /createLiveSittingQuote[\s\S]*?cityId:input\.cityId\?\?"blr"[\s\S]*?zoneId:input\.zoneId\?\?"blr-east"/.test(src);
  assert.ok(boarding, "createLiveBoardingQuote defaults a missing city to blr / blr-east");
  assert.ok(sitting, "createLiveSittingQuote defaults a missing city to blr / blr-east");
  // Together with the executed test above: a missing/non-blr-city request is priced by the Bengaluru rule.
});

test("D8 SECURE INVARIANT (post-fix gate) — a missing/non-BLR city must NOT be silently priced as blr / blr-east", () => {
  const src = read("lib/live-commercial-quotes.ts");
  // Expected after remediation: the quote requires an explicit serviceable city (or returns
  // not-serviceable) — it must not fall back to "blr"/"blr-east". FAILS on 0d8b885.
  assert.doesNotMatch(src, /cityId:input\.cityId\?\?"blr"/, "no silent blr city fallback in live quotes");
  assert.doesNotMatch(src, /zoneId:input\.zoneId\?\?"blr-east"/, "no silent blr-east zone fallback in live quotes");
});
