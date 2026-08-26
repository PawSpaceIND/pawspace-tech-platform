/**
 * The wait-list channel is disabled until a wait-list exists. [PTJA-W3-WL]
 *
 * THE APPROVED RULE, supplied by the business:
 *   A full wait-list is NOT part of the current closure scope. Until a real join, consent, ordering,
 *   notification and conversion workflow exists: disable `waitlist_conversion` as a selectable or
 *   claimable booking channel, do not report wait-list conversion metrics, and never claim that a
 *   customer has joined a wait-list. A request from a paused city may remain an ordinary CRM lead or
 *   service-interest record.
 *
 * WHAT WAS MEASURED BEFORE. `waitlist_conversion` was a first-class member of BOOKING_CHANNELS, gated
 * only by city status. In a Live city it was ACCEPTED - a booking could arrive claiming to be a
 * wait-list conversion when no wait-list has ever existed: no table, no module, no route, no join, no
 * consent, no ordering. That is a channel the platform cannot honour and a conversion metric that would
 * count something that never happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_WL_DB__", "__PTJA_WL_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_WL_DB__ = db;
  globalThis.__PTJA_WL_ENV__ = {};
  const city = await import("../lib/city-status-authority.ts");
  const governance = await import("../lib/city-governance.ts");
  await governance.seedDefaultCityLaunchConfigs(db);
  await db.prepare("UPDATE city_launch_configs SET status='Live' WHERE city_code='blr'").run();
  return { sqlite, db, city };
}

test("WL-01: a wait-list conversion is refused even in a fully Live city", async () => {
  const { db, city } = await world();
  const result = await city.cityBookingVerdict(db, { cityId: "blr", serviceCode: "grooming", channel: "waitlist_conversion" });
  assert.equal(result.allowed, false, `there is no wait-list to convert from: ${JSON.stringify(result).slice(0, 300)}`);
  assert.match(String(result.reason), /waitlist/i, `and the reason must name the wait-list, not blame the city: ${JSON.stringify(result).slice(0, 300)}`);
});

test("WL-02: the other channels still book normally in a Live city", async () => {
  // Non-vacuity. Refusing every channel would satisfy WL-01 and close the platform.
  const { db, city } = await world();
  for (const channel of ["customer_app", "ops_assisted", "subscription_renewal", "partner_app"]) {
    const result = await city.cityBookingVerdict(db, { cityId: "blr", serviceCode: "grooming", channel });
    assert.equal(result.allowed, true, `${channel} must still book: ${JSON.stringify(result).slice(0, 250)}`);
  }
});

test("WL-03: the wait-list channel is not offered as a selectable channel", async () => {
  const { city } = await world();
  assert.equal(city.SELECTABLE_BOOKING_CHANNELS.includes("waitlist_conversion"), false,
    `it must not be offered: ${JSON.stringify(city.SELECTABLE_BOOKING_CHANNELS)}`);
  for (const channel of ["customer_app", "ops_assisted", "subscription_renewal", "partner_app"]) {
    assert.ok(city.SELECTABLE_BOOKING_CHANNELS.includes(channel), `${channel} is still selectable`);
  }
});

test("WL-04: the channel name is still KNOWN, so a future wait-list cannot route around the city gate", async () => {
  // Deleting the name would be the wrong fix: the day a wait-list is built it would arrive as an
  // unrecognised channel rather than as one the city gate already refuses.
  const { city } = await world();
  assert.ok(city.BOOKING_CHANNELS.includes("waitlist_conversion"), "the channel is still a known name");
  assert.equal(city.waitlistAvailable(), false, "and the platform says plainly that no wait-list exists");
});

test("WL-05: a paused city still answers city_paused, for every channel", async () => {
  // The city gate is the OUTER gate. Making the wait-list refusal jump ahead of it would change what a
  // paused city reports and break the pause contract, which is a different rule with its own tests.
  const { db, city } = await world();
  await db.prepare("UPDATE city_launch_configs SET status='Paused' WHERE city_code='blr'").run();
  for (const channel of ["customer_app", "ops_assisted", "waitlist_conversion", "subscription_renewal"]) {
    const result = await city.cityBookingVerdict(db, { cityId: "blr", serviceCode: "grooming", channel });
    assert.equal(result.allowed, false, `${channel} is blocked while paused`);
    assert.equal(result.reason, "city_paused", `and reports the pause: ${JSON.stringify(result).slice(0, 200)}`);
  }
});

test("WL-06: no wait-list conversion metric is published anywhere", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const roots = ["lib", "app/api"];
  const offenders = [];
  for (const root of roots) {
    const walk = async (dir) => {
      for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const source = await readFile(new URL(`../${dir}/${entry.name}`, import.meta.url), "utf8");
        // A metric that COUNTS wait-list conversions, as opposed to the channel name being refused.
        if (/waitlist[_A-Za-z]*(Conversions|Converted|ConversionRate|_conversions)/.test(source)) offenders.push(`${dir}/${entry.name}`);
      }
    };
    await walk(root);
  }
  assert.deepEqual(offenders, [], "nothing may report a wait-list conversion figure while no wait-list exists");
});
