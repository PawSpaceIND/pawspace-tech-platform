import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Regression: /team/pricing-rules was unusable — a free-text date field that the API
// rejected ("effectiveFrom must be YYYY-MM-DD"), a free-text city, and no inputs at all
// for what each rule type means. Because lib/pricing-engine.ts matches on days/times/dates
// and IGNORES rule_type, a rule saved without them applied to EVERY slot.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl = ${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const pricingRulesRoute = await import("../app/api/pricing-rules/route.ts");
const { createPricingRule, listPricingCities, ensurePricingRuleTables } = await import("../lib/pricing-rule-governance.ts");
const { calculatePrice } = await import("../lib/pricing-engine.ts");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function stack() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  await ensurePricingRuleTables(db);
  return { sqlite, db };
}

const base = { name: "Test rule", serviceCode: "grooming", cityId: "blr", adjustmentType: "percent", adjustmentValue: 15, effectiveFrom: "2026-08-01", actorId: "test@pawspace.in" };

// --- server: each rule type must carry the fields the engine matches on ---------------

test("regression: a time_band rule cannot be saved without a time band", async () => {
  const { db } = await stack();
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "time_band" }), /needs a start and end time/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "time_band", startTime: "12:00", endTime: "09:00" }), /startTime must be earlier than endTime/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "time_band", startTime: "9am", endTime: "12:00" }), /startTime must be HH:MM/);
  const ok = await createPricingRule(db, { ...base, ruleType: "time_band", startTime: "09:00", endTime: "12:00" });
  assert.equal(ok.ruleType, "time_band");
});

test("regression: weekday/weekend rules cannot be saved without days, season/date_range without an end date", async () => {
  const { db } = await stack();
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "weekday" }), /needs at least one selected day/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "weekend" }), /needs at least one selected day/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "season" }), /needs an end date/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "date_range" }), /needs an end date/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "season", effectiveTo: "2026-07-01" }), /cannot be before effectiveFrom/);
  await assert.rejects(createPricingRule(db, { ...base, ruleType: "season", effectiveTo: "01/09/2026" }), /effectiveTo must be YYYY-MM-DD/);
  assert.equal((await createPricingRule(db, { ...base, ruleType: "weekend", days: [0, 6] })).ruleType, "weekend");
  assert.equal((await createPricingRule(db, { ...base, name: "Season rule", ruleType: "season", effectiveTo: "2026-12-31" })).ruleType, "season");
});

test("regression: the saved rule actually narrows the price — it no longer applies to every slot", async () => {
  const { db, sqlite } = await stack();
  await createPricingRule(db, { ...base, name: "Weekend morning uplift", ruleType: "time_band", days: [0, 6], startTime: "09:00", endTime: "12:00", adjustmentValue: 20 });
  sqlite.prepare("UPDATE dynamic_pricing_rules SET status='published'").run();
  const stored = sqlite.prepare("SELECT * FROM dynamic_pricing_rules").get();
  assert.deepEqual(JSON.parse(String(stored.days_json)), [0, 6], "the selected days are persisted");
  assert.equal(String(stored.start_time), "09:00");
  assert.equal(String(stored.end_time), "12:00");

  const pkg = { id: "P1", serviceCode: "grooming", packageCode: "groom-basic", name: "Basic", description: "", basePrice: 1000, slotMinutes: 60, blockingMinutes: 0, taxInclusive: true, active: true, version: 1, effectiveFrom: "2026-01-01", effectiveTo: null };
  const rule = { id: String(stored.id), name: String(stored.name), serviceCode: "grooming", packageCode: null, cityId: "blr", zoneId: null, ruleType: "time_band", days: [0, 6], startTime: "09:00", endTime: "12:00", effectiveFrom: "2026-08-01", effectiveTo: null, adjustmentType: "percent", adjustmentValue: 20, couponPolicy: "stackable", priority: 100, status: "published", version: 1 };
  const quoteAt = (iso) => calculatePrice({ pkg, rules: [rule], scheduledStart: iso, cityId: "blr" }).finalPrice;
  // 2026-08-15 is a Saturday. 10:00 IST is inside the band; 15:00 IST is outside it.
  assert.equal(quoteAt("2026-08-15T04:30:00.000Z"), 1200, "Saturday 10:00 IST is inside the band → +20%");
  assert.equal(quoteAt("2026-08-15T09:30:00.000Z"), 1000, "Saturday 15:00 IST is outside the band → unchanged");
  assert.equal(quoteAt("2026-08-12T04:30:00.000Z"), 1000, "Wednesday 10:00 IST is not a selected day → unchanged");
});

// --- server: the city list is loaded from real data ------------------------------------

test("the city picker is fed from real platform data, never a hardcoded list", async () => {
  const { db, sqlite } = await stack();
  assert.deepEqual(await listPricingCities(db), [], "cold platform: no invented cities");
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,updated_by,created_at,updated_at) VALUES ('C1','blr','Bengaluru','KA','Live','test',1,1)").run();
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id) VALUES ('p1','hyd')").run();
  const cities = await listPricingCities(db);
  const ids = cities.map((c) => c.cityId);
  assert.deepEqual(ids, ["blr", "hyd"], "launch cities first, then cities that actually carry providers");
  assert.match(cities[0].label, /Bengaluru/, "the picker shows a human city name, not just the code");
  assert.equal(cities[0].source, "city_launch_configs");

  // and it is served under pricing.view through the real route
  const response = await pricingRulesRoute.GET(new Request("http://localhost/api/pricing-rules?mode=cities"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map((c) => c.cityId), ["blr", "hyd"]);
});

test("the create route forwards every rule-shape field to the governance lib", async () => {
  await stack();
  const response = await pricingRulesRoute.POST(new Request("http://localhost/api/pricing-rules", {
    method: "POST",
    body: JSON.stringify({ action: "create_rule", name: "Route rule", serviceCode: "grooming", cityId: "blr", ruleType: "time_band", days: [1, 2], startTime: "08:00", endTime: "10:00", effectiveFrom: "2026-08-01", effectiveTo: "2026-09-30", adjustmentType: "percent", adjustmentValue: 12 }),
  }));
  assert.equal(response.status, 201, await response.clone().text());
  const { data } = await response.json();
  assert.equal(data.ruleType, "time_band");
  assert.equal(data.effectiveTo, "2026-09-30");
  // a rule missing its band is refused at the route too, with the reason shown to the operator
  const bad = await pricingRulesRoute.POST(new Request("http://localhost/api/pricing-rules", {
    method: "POST",
    body: JSON.stringify({ action: "create_rule", name: "Bad", serviceCode: "grooming", cityId: "blr", ruleType: "time_band", effectiveFrom: "2026-08-01", adjustmentType: "percent", adjustmentValue: 5 }),
  }));
  assert.equal(bad.status, 500);
  assert.match(JSON.stringify(await bad.json()), /needs a start and end time/);
});

// --- page: real pickers, real city list, type-driven inputs ---------------------------

test("the pricing-rules page uses native date/time pickers and a loaded city list", () => {
  const page = fs.readFileSync("app/team/pricing-rules/page.tsx", "utf8");
  assert.match(page, /name="effectiveFrom" type="date"/, "the start date must be a real date picker (calendar), not free text");
  assert.match(page, /name="effectiveTo" type="date"/, "the end date must be a real date picker");
  assert.match(page, /type="time"/, "time band must use real time pickers");
  assert.match(page, /mode=cities/, "cities are loaded from the API");
  assert.match(page, /cities\.map\(c => <option/, "the city input is a dropdown of loaded cities");
  assert.doesNotMatch(page, /<input name="cityId"/, "city must never be free text again");
  assert.doesNotMatch(page, /placeholder="2026-01-01"/, "the free-text date placeholder is gone");
});

test("the page shows exactly the inputs each rule type needs, mirroring server validation", () => {
  const page = fs.readFileSync("app/team/pricing-rules/page.tsx", "utf8");
  assert.match(page, /const NEEDS: Record<RuleType, \{ days: boolean; times: boolean; endDate: boolean; hint: string \}>/);
  for (const type of ["weekend", "weekday", "time_band", "season", "date_range"]) assert.ok(page.includes(`${type}:`), `${type} must have a declared input shape`);
  assert.match(page, /weekend: \{ days: true/, "weekend needs day selection");
  assert.match(page, /time_band: \{ days: false, times: true/, "time band needs times");
  assert.match(page, /season: \{ days: false, times: false, endDate: true/, "season needs an end date");
  assert.match(page, /function validate\(/, "the form validates before calling the API");
  assert.match(page, /toggleDay/, "days are selectable");
  // day numbering must match the engine's Sunday-indexed isoDay
  assert.match(page, /\{ n: 0, s: "Sun" \}/);
  assert.match(page, /WEEKEND_DAYS = \[0, 6\]/);
  const engine = fs.readFileSync("lib/pricing-engine.ts", "utf8");
  assert.match(engine, /weekdayNames=\["Sun","Mon","Tue","Wed","Thu","Fri","Sat"\]/, "engine day order the page mirrors");
});
